// Background service worker — coordinates between popup, content script,
// and offscreen TTS document.

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
//
// IMPORTANT: chrome.runtime.sendMessage broadcasts to ALL listeners
// (background, offscreen, popup). Each listener must return false for
// messages it doesn't handle so the channel closes properly.
//
// The background only handles messages that need tab operations
// (injecting content script, sending to the active tab).
// Pure offscreen messages (TTS_PAUSE, etc.) go directly via
// chrome.runtime.sendMessage and are picked up by the offscreen listener.

const BG_HANDLED = new Set([
  'START_READING',
  'VB_TOGGLE_PLAY',
  'TTS_STOP',
  'TTS_STATE_UPDATE',
]);

chrome.runtime.onMessage.addListener(
  (
    message: {
      type: string;
      data?: unknown;
    },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (!BG_HANDLED.has(message.type)) {
      return false;
    }

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

          await ensureOffscreenDocument();

          try {
            await chrome.tabs.sendMessage(tab.id, {
              type: 'VB_SHOW_PLAYER',
              data: { title: article.title },
            });
          } catch {}

          // Send to offscreen — it will be handled by the offscreen listener
          // (background doesn't handle TTS_START, so it won't loop)
          const result = await chrome.runtime.sendMessage({
            type: 'TTS_START',
            data: article,
          });

          sendResponse(result);
          break;
        }

        case 'VB_TOGGLE_PLAY': {
          // From the floating player. We need to check state first, then
          // send the right command. We talk DIRECTLY to the offscreen document
          // by NOT handling TTS_GET_STATE here in background — the offscreen
          // listener will pick it up since we return false for it.
          try {
            // Check if offscreen exists first
            const contexts = await chrome.runtime.getContexts({
              contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
            });
            if (contexts.length === 0) {
              sendResponse({ ok: false, reason: 'no_offscreen' });
              return;
            }

            // Get state from offscreen — background returns false for
            // TTS_GET_STATE, so only the offscreen listener responds.
            const state = (await chrome.runtime.sendMessage({
              type: 'TTS_GET_STATE',
            })) as Record<string, unknown>;

            if (state?.status === 'paused') {
              await chrome.runtime.sendMessage({ type: 'TTS_RESUME' });
            } else if (
              state?.status === 'playing' ||
              state?.status === 'generating'
            ) {
              await chrome.runtime.sendMessage({ type: 'TTS_PAUSE' });
            }
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, reason: String(e) });
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

    await ensureOffscreenDocument();

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'VB_SHOW_PLAYER',
        data: { title: article.title },
      });
    } catch {}

    await chrome.runtime.sendMessage({
      type: 'TTS_START',
      data: article,
    });
  }
});
