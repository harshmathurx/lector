// Background service worker: lifecycle and routing only. It extracts the
// article (via the content script), owns the offscreen document, relays
// highlight events to the tab, and recovers sessions if Chrome closes the
// offscreen document (it does so after 30s without audio).

import type {
  Article,
  BackgroundRequest,
  Command,
  ContentRequest,
  OffscreenEvent,
  OffscreenRequest,
  PlayerState,
  Quality,
  StoredSession,
} from '../shared/protocol';
import { IDLE_STATE, QUALITIES, SPEEDS } from '../shared/protocol';
import { DEFAULT_VOICE, findVoice } from '../shared/voices';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const IDLE_CLOSE_ALARM = 'vb-close-offscreen';
const IDLE_CLOSE_MINUTES = 5;

class UserFacingError extends Error {}
const GENERIC_ERROR = 'Lector hit a problem. Please try again.';
/** True once audio has played this session (so a later "buffering" reads as Reading, not Preparing). */
let heardAudio = false;

// ─── Offscreen document ─────────────────────────────────────────────────────

let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

async function sendToOffscreen<T = unknown>(msg: OffscreenRequest): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

async function pingOffscreen(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await sendToOffscreen<{ pong?: boolean }>({ target: 'offscreen', type: 'TTS_PING' });
      if (res?.pong) return true;
    } catch {
      /* listener not registered yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function createOffscreen(): Promise<void> {
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Plays synthesized speech while the user reads articles aloud.',
  });
}

/** Create the offscreen document and wait until it actually answers. */
async function ensureOffscreen(): Promise<void> {
  await chrome.alarms.clear(IDLE_CLOSE_ALARM);
  if (creating) return creating;
  creating = (async () => {
    try {
      if (!(await hasOffscreen())) await createOffscreen();
      if (await pingOffscreen(8000)) return;
      // Document exists but never answered: recreate once.
      console.warn('[Lector bg] Offscreen did not answer, recreating');
      if (await hasOffscreen()) await chrome.offscreen.closeDocument();
      await createOffscreen();
      if (!(await pingOffscreen(8000))) {
        throw new UserFacingError('Lector could not start. Reload the extension from the puzzle-piece menu, then try again.');
      }
    } finally {
      creating = null;
    }
  })();
  return creating;
}

async function closeOffscreen(): Promise<void> {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

// ─── Prefs & session persistence ────────────────────────────────────────────

async function getPrefs(): Promise<{ voice: string; speed: number; quality: Quality }> {
  const r = await chrome.storage.local.get(['defaultVoice', 'defaultSpeed', 'lectorQuality']);
  return {
    quality: QUALITIES.includes(r.lectorQuality as Quality) ? (r.lectorQuality as Quality) : 'auto',
    // Ignore saved voices we no longer offer (e.g. from before v0.2.1).
    voice: typeof r.defaultVoice === 'string' && findVoice(r.defaultVoice) ? r.defaultVoice : DEFAULT_VOICE,
    speed: typeof r.defaultSpeed === 'number' && r.defaultSpeed > 0 ? r.defaultSpeed : 1,
  };
}

async function loadSession(): Promise<StoredSession | null> {
  const r = await chrome.storage.session.get('session');
  return (r.session as StoredSession | undefined) ?? null;
}

async function saveSession(s: StoredSession | null): Promise<void> {
  if (s) await chrome.storage.session.set({ session: s });
  else await chrome.storage.session.remove('session');
}

// ─── Tab access ─────────────────────────────────────────────────────────────

async function contentCall<T>(tabId: number, msg: ContentRequest): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>;
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await contentCall(tabId, { type: 'VB_PING' });
    return;
  } catch {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/highlight.css'] });
  } catch {
    throw new UserFacingError(
      "Chrome doesn't let extensions read this kind of page. Open an article or web page and try again."
    );
  }
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new UserFacingError('No active tab found.');
  return tab.id;
}

// ─── Start / recover ────────────────────────────────────────────────────────

type StartMode = 'article' | 'selection' | 'fromSelection';

async function startReading(mode: StartMode, tabIdArg?: number): Promise<void> {
  const tabId = tabIdArg ?? (await activeTabId());
  heardAudio = false;
  setBadge('…');
  setTitle('Preparing this page');
  try {
    await ensureContentScript(tabId);
    const article = await contentCall<Article | null>(tabId, { type: 'EXTRACT_ARTICLE', mode });
    if (!article || !article.paragraphs.length) {
      throw new UserFacingError(
        mode === 'selection'
          ? 'Select some text first, then try again.'
          : "Couldn't find an article to read on this page. Try selecting some text and using the right-click menu."
      );
    }
    await launch(article, tabId);
  } catch (e) {
    flashError(e);
    throw e;
  }
}

async function launch(article: Article, tabId: number): Promise<void> {
  const { voice, speed, quality } = await getPrefs();
  await ensureOffscreen();
  // Saved only once the offscreen document exists: a session with no document
  // is what getState() reports as "recoverable", which would flash "Paused".
  await saveSession({ article, tabId, paraIndex: article.startParagraph });
  await sendToOffscreen({ target: 'offscreen', type: 'TTS_START', article, voice, speed, quality });
}

/** The offscreen doc died (Chrome closes it after 30s without audio): restart from where we were. */
async function recoverSession(session: StoredSession): Promise<void> {
  await launch({ ...session.article, startParagraph: session.paraIndex }, session.tabId);
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function runCommand(command: Command): Promise<PlayerState> {
  // Remember voice/speed choices so a recovered session keeps them.
  if (command.cmd === 'voice') await chrome.storage.local.set({ defaultVoice: command.voice });
  if (command.cmd === 'speed') await chrome.storage.local.set({ defaultSpeed: command.speed });
  if (!(await hasOffscreen())) {
    const session = await loadSession();
    if (session && (command.cmd === 'toggle' || command.cmd === 'resume')) {
      await recoverSession(session);
    } else if (session && command.cmd === 'stop') {
      await endSession(session);
    }
    return getState();
  }
  return sendToOffscreen<PlayerState>({ target: 'offscreen', type: 'TTS_COMMAND', command });
}

async function toggleFromShortcut(): Promise<void> {
  if (await hasOffscreen()) {
    const state = await getState();
    if (state.status !== 'idle' && state.status !== 'error') {
      await runCommand({ cmd: 'toggle' });
      return;
    }
  } else {
    const session = await loadSession();
    if (session) {
      await runCommand({ cmd: 'toggle' });
      return;
    }
  }
  await startReading('article').catch(() => {});
}

/** Faster or slower by one step of the speed row, from the shortcut keys. */
async function stepSpeed(dir: 1 | -1): Promise<void> {
  const state = await getState();
  const current = state.status !== 'idle' ? state.speed : (await getPrefs()).speed;
  const i = SPEEDS.reduce((best, s, k) => (Math.abs(s - current) < Math.abs(SPEEDS[best] - current) ? k : best), 0);
  const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + dir))];
  if (next !== current) await runCommand({ cmd: 'speed', speed: next });
}

async function getState(): Promise<PlayerState> {
  if (await hasOffscreen()) {
    try {
      return await sendToOffscreen<PlayerState>({ target: 'offscreen', type: 'TTS_GET_STATE' });
    } catch {
      /* fall through to stored session */
    }
  }
  const session = await loadSession();
  if (session) {
    const { voice, speed } = await getPrefs();
    return {
      ...IDLE_STATE,
      status: 'paused',
      title: session.article.title,
      voice,
      speed,
      paraIndex: session.paraIndex,
      totalParas: session.article.paragraphs.length,
      recoverable: true,
    };
  }
  return IDLE_STATE;
}

// ─── Badge ──────────────────────────────────────────────────────────────────

const BADGE_INK = '#0A0A0A';
const BADGE_ERROR = '#C2410C';

function setBadge(text: string, color = BADGE_INK): void {
  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  void chrome.action.setBadgeText({ text });
}

const TITLE = 'Lector';

/**
 * The toolbar button's tooltip doubles as its accessible name, so it says the
 * state in words ("Lector — Reading"); the badge is the same thing for eyes.
 */
function setTitle(state?: string): void {
  void chrome.action.setTitle({ title: state ? `${TITLE} — ${state}` : TITLE });
}

/** Errors stay on the toolbar until the next action: nobody should have to catch them in 6 seconds. */
function showToolbarError(message: string): void {
  setBadge('!', BADGE_ERROR);
  setTitle(`Couldn't read this page: ${message}`);
}

function flashError(e: unknown): void {
  console.error('[Lector bg]', e);
  showToolbarError(e instanceof UserFacingError ? e.message : GENERIC_ERROR);
}

// ─── Offscreen events ───────────────────────────────────────────────────────

let eventChain: Promise<void> = Promise.resolve();

async function onOffscreenEvent(event: OffscreenEvent): Promise<void> {
  if (event.kind === 'progress') {
    const pct = Math.min(100, Math.round(event.fraction * 100));
    if (event.fraction >= 1) {
      setBadge('…');
      setTitle('Starting the voice');
    } else {
      setBadge(`${pct}%`);
      setTitle(`Downloading voice ${pct}%`);
    }
    return;
  }

  const session = await loadSession();

  if (event.kind === 'segment') {
    if (session) {
      await saveSession({ ...session, paraIndex: event.paraIndex });
      contentCall(session.tabId, {
        type: 'VB_HIGHLIGHT',
        paraIndex: event.paraIndex,
        start: event.start,
        end: event.end,
        durationMs: event.durationMs,
        offsetMs: event.offsetMs,
      }).catch(() => {});
    }
    return;
  }

  if (event.kind === 'finished') {
    await endSession(session);
    return;
  }

  // status: anything that stops the audio freezes the ink on the page
  if (session && ['paused', 'buffering', 'loading', 'error'].includes(event.status)) {
    contentCall(session.tabId, { type: 'VB_HIGHLIGHT_PAUSE' }).catch(() => {});
  }
  switch (event.status) {
    case 'idle':
      await endSession(session);
      break;
    case 'playing':
      heardAudio = true;
      setBadge('');
      setTitle('Reading');
      await chrome.alarms.clear(IDLE_CLOSE_ALARM);
      await chrome.storage.local.set({ modelReady: true });
      break;
    case 'loading':
    case 'starting':
      setBadge('…');
      setTitle('Preparing this page');
      break;
    case 'buffering':
      setBadge('…');
      setTitle(heardAudio ? 'Reading' : 'Preparing this page');
      break;
    case 'paused':
      setBadge('❚❚');
      setTitle('Paused');
      break;
    case 'error':
      showToolbarError(event.error ?? GENERIC_ERROR);
      break;
  }
}

async function endSession(session: StoredSession | null): Promise<void> {
  heardAudio = false;
  setBadge('');
  setTitle();
  await saveSession(null);
  if (session) contentCall(session.tabId, { type: 'VB_HIGHLIGHT_CLEAR' }).catch(() => {});
  if (qualityDirty) {
    // The voice quality setting changed during this session: let the engine go so the next listen picks it up.
    qualityDirty = false;
    await closeOffscreen().catch(() => {});
    return;
  }
  // Keep the model warm for a few minutes so the next read starts instantly.
  await chrome.alarms.create(IDLE_CLOSE_ALARM, { delayInMinutes: IDLE_CLOSE_MINUTES });
}

/**
 * The Voice quality setting is read when the engine loads. A loaded engine would keep the old
 * choice for as long as the offscreen document lives, so drop it as soon as nothing is playing.
 */
let qualityDirty = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.lectorQuality) return;
  void (async () => {
    const state = await getState().catch(() => IDLE_STATE);
    if (state.status === 'idle' || state.status === 'error') await closeOffscreen().catch(() => {});
    else qualityDirty = true;
  })();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== IDLE_CLOSE_ALARM) return;
  const state = await getState().catch(() => IDLE_STATE);
  if (state.status === 'idle' || state.status === 'error') await closeOffscreen();
});

// ─── Message router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  if (!raw || typeof raw !== 'object' || 'target' in raw) return false; // addressed to offscreen
  const message = raw as BackgroundRequest | OffscreenEvent;

  if (message.type === 'VB_EVENT') {
    // Strictly in order: handlers await storage, and a late "paused" landing
    // after a newer "playing" would freeze the page highlight by mistake.
    eventChain = eventChain.then(() => onOffscreenEvent(message)).catch((e) => console.error('[Lector]', e));
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'VB_START':
          await startReading(message.mode ?? 'article');
          sendResponse({ ok: true });
          break;
        case 'VB_CMD':
          sendResponse(await runCommand(message.command));
          break;
        case 'VB_GET_STATE':
          sendResponse(await getState());
          break;
        case 'VB_JUMP':
          sendResponse(await runCommand({ cmd: 'jump', paragraph: message.paragraph }));
          break;
        case 'VB_WARM': {
          // Only when the model is already on disk, and nothing is playing.
          const { modelReady } = await chrome.storage.local.get('modelReady');
          if (modelReady && (await getState()).status === 'idle') {
            await ensureOffscreen();
            await sendToOffscreen({ target: 'offscreen', type: 'TTS_WARM', quality: (await getPrefs()).quality });
            await chrome.alarms.create(IDLE_CLOSE_ALARM, { delayInMinutes: IDLE_CLOSE_MINUTES });
          }
          sendResponse({ ok: true });
          break;
        }
        case 'VB_CLEAR_CACHE': {
          let cleared = 0;
          if (await hasOffscreen()) {
            const res = await sendToOffscreen<{ cleared: number }>({ target: 'offscreen', type: 'TTS_CLEAR_CACHE' });
            cleared = res?.cleared ?? 0;
          } else {
            await ensureOffscreen();
            const res = await sendToOffscreen<{ cleared: number }>({ target: 'offscreen', type: 'TTS_CLEAR_CACHE' });
            cleared = res?.cleared ?? 0;
            await closeOffscreen();
          }
          sendResponse({ cleared });
          break;
        }
        default:
          sendResponse(undefined);
      }
    } catch (e) {
      sendResponse({
        error: e instanceof UserFacingError ? e.message : GENERIC_ERROR,
      });
    }
  })();
  return true;
});

// ─── Keyboard shortcuts & context menu ──────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'read-article') void toggleFromShortcut();
  else if (command === 'next-paragraph') void runCommand({ cmd: 'next' });
  else if (command === 'prev-paragraph') void runCommand({ cmd: 'prev' });
  else if (command === 'listen-from-here') void startReading('fromSelection').catch(() => {});
  else if (command === 'stop') void runCommand({ cmd: 'stop' });
  else if (command === 'speed-up') void stepSpeed(1);
  else if (command === 'speed-down') void stepSpeed(-1);
});

const MENU_FROM_HERE = 'vb-from-here';
const MENU_SELECTION = 'vb-selection';
const MENU_PAGE = 'vb-page';

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_FROM_HERE, title: 'Listen from here', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_SELECTION, title: 'Listen to selection', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: 'Listen to this page', contexts: ['page'] });
  });
  if (details.reason === 'install') void chrome.storage.local.set({ firstRun: true });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const mode: StartMode | null =
    info.menuItemId === MENU_FROM_HERE ? 'fromSelection'
    : info.menuItemId === MENU_SELECTION ? 'selection'
    : info.menuItemId === MENU_PAGE ? 'article'
    : null;
  if (mode) void startReading(mode, tab.id).catch(() => {});
});
