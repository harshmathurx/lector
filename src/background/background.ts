// Background service worker — creates offscreen document, routes messages.

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

let creatingOffscreen: Promise<void> | null = null;

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

// ─── Message Router ─────────────────────────────────────────────────────────

const BG_HANDLED = new Set([
  'START_READING',
  'TTS_STOP',
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
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (!BG_HANDLED.has(message.type)) return false;

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

          // Store job in chrome.storage for the offscreen to pick up
          await chrome.storage.local.set({
            pendingJob: {
              type: 'TTS_START',
              data: article,
              timestamp: Date.now(),
            },
          });

          await ensureOffscreenDocument();

          // Also try direct send (fast path if offscreen already running)
          try {
            await chrome.runtime.sendMessage({
              type: 'TTS_START',
              data: article,
            });
          } catch {}

          sendResponse({ status: 'started' });
          break;
        }

        case 'TTS_PAUSE':
        case 'TTS_RESUME':
        case 'TTS_SET_SPEED':
        case 'TTS_SET_VOICE':
        case 'TTS_SEEK':
        case 'TTS_GET_STATE': {
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
      await chrome.runtime.sendMessage({
        type: 'TTS_START',
        data: article,
      });
    } catch {}
  }
});
