// Background service worker — creates offscreen document, stores job in
// storage for the offscreen to pick up. No push-based messaging to offscreen.

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

let creatingOffscreen: Promise<void> | null = null;
let activeTabId: number | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existingContexts.length > 0) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'TTS audio playback via Kokoro engine',
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

async function closeOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existingContexts.length > 0) await chrome.offscreen.closeDocument();
}

// Forward TTS state updates to the content script on the active tab
async function forwardStateToTab(state: Record<string, unknown>): Promise<void> {
  if (!activeTabId) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: 'VB_UPDATE_STATE',
      data: state,
    });
  } catch {}
}

// ─── Message Router ─────────────────────────────────────────────────────────

const BG_HANDLED = new Set([
  'START_READING',
  'VB_TOGGLE_PLAY',
  'TTS_STOP',
  'TTS_STATE_UPDATE',
  'TTS_PAUSE',
  'TTS_RESUME',
  'TTS_SET_SPEED',
  'TTS_SET_VOICE',
  'TTS_SEEK',
  'TTS_GET_STATE',
]);

chrome.runtime.onMessage.addListener(
  (
    message: { type: string; data?: unknown },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (!BG_HANDLED.has(message.type)) return false;

    // TTS_STATE_UPDATE from offscreen → forward to content script tab
    if (message.type === 'TTS_STATE_UPDATE') {
      forwardStateToTab(message.data as Record<string, unknown>).then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    (async () => {
      switch (message.type) {
        case 'START_READING': {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab?.id) {
            sendResponse({ error: 'No active tab' });
            return;
          }

          activeTabId = tab.id;

          let article = null;
          try {
            article = await chrome.tabs.sendMessage(tab.id, {
              type: 'EXTRACT_ARTICLE',
            });
          } catch {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/content.js'],
              });
              article = await chrome.tabs.sendMessage(tab.id, {
                type: 'EXTRACT_ARTICLE',
              });
            } catch {
              sendResponse({
                error: 'Cannot read this page. Try refreshing the tab.',
              });
              return;
            }
          }

          if (!article || !article.paragraphs?.length) {
            sendResponse({ error: 'No readable article found on this page.' });
            return;
          }

          // Load saved preferences
          const prefs = await chrome.storage.local.get(['defaultVoice', 'defaultSpeed']);
          if (prefs.defaultVoice) article.voice = prefs.defaultVoice;
          if (prefs.defaultSpeed) article.speed = prefs.defaultSpeed;

          // Store the job in chrome.storage — the offscreen will poll for it.
          // This avoids the race condition where we send a message before the
          // offscreen's listener is registered.
          await chrome.storage.local.set({
            pendingJob: {
              type: 'TTS_START',
              data: article,
              timestamp: Date.now(),
            },
          });

          // Create the offscreen document — it will find the job in storage
          await ensureOffscreenDocument();

          // Show the floating player on the page
          try {
            await chrome.tabs.sendMessage(tab.id, {
              type: 'VB_SHOW_PLAYER',
              data: { title: article.title },
            });
          } catch {}

          // Also try to send directly (in case offscreen is already running)
          try {
            await chrome.runtime.sendMessage({
              type: 'TTS_START',
              data: article,
            });
          } catch {
            // Offscreen will pick it up from storage
          }

          sendResponse({ status: 'started' });
          break;
        }

        case 'VB_TOGGLE_PLAY':
        case 'TTS_PAUSE':
        case 'TTS_RESUME':
        case 'TTS_SET_SPEED':
        case 'TTS_SET_VOICE':
        case 'TTS_SEEK':
        case 'TTS_GET_STATE': {
          // Forward to offscreen — it may or may not be ready yet,
          // but these are user actions that happen after TTS_START
          // so the offscreen should exist by now.
          try {
            const result = await chrome.runtime.sendMessage(message);
            sendResponse(result);
          } catch (e) {
            sendResponse({ error: String(e) });
          }
          break;
        }

        case 'TTS_STOP': {
          try {
            await chrome.runtime.sendMessage({ type: 'TTS_STOP' });
          } catch {}
          await closeOffscreenDocument();
          if (activeTabId) {
            try {
              await chrome.tabs.sendMessage(activeTabId, {
                type: 'VB_HIDE_PLAYER',
              });
            } catch {}
            activeTabId = null;
          }
          sendResponse({ status: 'stopped' });
          break;
        }
      }
    })();
    return true;
  }
);

// Keyboard shortcut
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'read-article') {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) return;

    activeTabId = tab.id;

    let article = null;
    try {
      article = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXTRACT_ARTICLE',
      });
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/content.js'],
        });
        article = await chrome.tabs.sendMessage(tab.id, {
          type: 'EXTRACT_ARTICLE',
        });
      } catch {
        return;
      }
    }

    if (!article?.paragraphs?.length) return;

    const prefs = await chrome.storage.local.get(['defaultVoice', 'defaultSpeed']);
    if (prefs.defaultVoice) article.voice = prefs.defaultVoice;
    if (prefs.defaultSpeed) article.speed = prefs.defaultSpeed;

    await chrome.storage.local.set({
      pendingJob: {
        type: 'TTS_START',
        data: article,
        timestamp: Date.now(),
      },
    });

    await ensureOffscreenDocument();

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'VB_SHOW_PLAYER',
        data: { title: article.title },
      });
    } catch {}

    try {
      await chrome.runtime.sendMessage({
        type: 'TTS_START',
        data: article,
      });
    } catch {}
  }
});
