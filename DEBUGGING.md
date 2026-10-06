# Voicebox Reader — Chrome Extension Debugging Context

## What we're building

A Chrome MV3 extension that reads web articles aloud using Kokoro 82M TTS running entirely in-browser (no server). The user clicks the extension icon on any article page, picks a voice, and hears the article read aloud.

**Target user:** Regular people who want to listen to articles — not developers, not AI enthusiasts. It should just work.

## Architecture

```
Popup (popup.html/popup.ts)
  → Voice picker (54 voices with static MP3 previews)
  → Speed picker (0.75x - 2x)
  → Read Aloud button / playback controls
  → Sends chrome.runtime.sendMessage({ type: 'START_READING' })

Background SW (background.ts)
  → Receives START_READING
  → Gets active tab
  → Sends chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_ARTICLE' }) to content script
  → Falls back to chrome.scripting.executeScript if content script not loaded
  → Stores article in chrome.storage.local as 'pendingJob'
  → Creates offscreen document via chrome.offscreen.createDocument
  → Also tries direct chrome.runtime.sendMessage({ type: 'TTS_START', data: article })
  → Routes TTS_PAUSE, TTS_RESUME, TTS_STOP, etc. to offscreen

Content Script (content.ts)
  → Minimal: only handles EXTRACT_ARTICLE
  → Uses Mozilla Readability to extract article text
  → Returns { title, textContent, url, paragraphs[] }
  → No DOM injection, no floating player (removed — was causing too many bugs)

Offscreen Document (offscreen.html/offscreen.ts)
  → Runs Kokoro TTS (kokoro-js, ONNX Runtime Web, WebGPU/WASM fallback)
  → On startup: polls chrome.storage.local for 'pendingJob' (avoids race condition)
  → Also listens for direct TTS_START message
  → Generates audio paragraph by paragraph
  → Plays through AudioContext → GainNode → destination
  → Caches generated audio in IndexedDB
  → Broadcasts TTS_STATE_UPDATE messages
```

## Current bug

**"Could not establish connection. Receiving end does not exist."** — this error appears when clicking "Read Aloud" in the popup.

The background service worker tries to message the content script, and it fails. The content script should be auto-injected via the manifest's `content_scripts` declaration, but it's not responding.

## What we've tried

1. Added `host_permissions: ["<all_urls>"]` to manifest — still fails
2. Added fallback `chrome.scripting.executeScript` to inject content script — still fails
3. Added console.log at top of content.ts — doesn't appear in page console, meaning the content script never loads
4. Verified the built `dist/content/content.js` exists and is valid JS (66KB, includes Readability)
5. Verified manifest content_scripts path matches build output: `content/content.js` → `dist/content/content.js` ✓
6. Tried on paulgraham.com/do.html — a simple static HTML page, no CSP that would block extensions

## Manifest (dist/manifest.json)

```json
{
  "manifest_version": 3,
  "name": "Voicebox Reader",
  "version": "0.1.0",
  "permissions": ["activeTab", "scripting", "offscreen", "storage"],
  "host_permissions": ["<all_urls>"],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
  },
  "background": { "service_worker": "background/background.js", "type": "module" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content/content.js"],
    "run_at": "document_idle"
  }],
  "commands": {
    "read-article": {
      "suggested_key": { "default": "Alt+Shift+R", "mac": "Alt+Shift+R" },
      "description": "Read this article aloud"
    }
  },
  "web_accessible_resources": [{
    "resources": ["wasm/*", "previews/*"],
    "matches": ["<all_urls>"]
  }],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

## Build system

Bun bundler. Source in `src/`, static assets in `static/`, output in `dist/`.

Build command: `bun run build` which runs:
```
bun build ./src/popup/popup.ts --outdir dist/popup --target browser
bun build ./src/content/content.ts --outdir dist/content --target browser
bun build ./src/background/background.ts --outdir dist/background --target browser
bun build ./src/offscreen/offscreen.ts --outdir dist/offscreen --target browser
cp -r static/* dist/
```

## Key files

### src/content/content.ts (the one that's not loading)
```typescript
console.log('[VB-CS] Content script loaded on', window.location.href);

import { Readability } from '@mozilla/readability';

interface ArticleContent {
  title: string;
  textContent: string;
  url: string;
  paragraphs: string[];
}

function extractArticle(): ArticleContent | null {
  const documentClone = document.cloneNode(true) as Document;
  const reader = new Readability(documentClone);
  const article = reader.parse();
  if (!article || !article.textContent) return null;
  const paragraphs = article.textContent
    .split(/\n{2,}/)
    .map((p: string) => p.trim())
    .filter((p: string) => p.length > 10);
  return {
    title: article.title || document.title,
    textContent: article.textContent,
    url: window.location.href,
    paragraphs,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'EXTRACT_ARTICLE') {
    console.log('[VB-CS] Extract article requested');
    const article = extractArticle();
    console.log('[VB-CS] Extracted:', article ? `${article.paragraphs.length} paragraphs` : 'null');
    sendResponse(article);
    return true;
  }
  return false;
});
```

### src/background/background.ts (where the error occurs)
The background gets "Could not establish connection" when calling:
```typescript
article = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_ARTICLE' });
```

### src/offscreen/offscreen.ts
Large file (5MB bundled). Sets up ONNX Runtime WASM paths, imports kokoro-js, runs TTS engine. On startup, polls chrome.storage.local for 'pendingJob'. Also listens for TTS_START message.

## Previous bugs we fixed (working state before refactor)

We had a WORKING version before a big refactor. The working version had:
- A floating player injected into the DOM (we removed it because it was causing too many CSS/interaction bugs)
- Offscreen document for TTS + audio (this was working)
- The "Could not establish connection" error appeared after we simplified the content script and restructured the message flow

The offscreen document was working — TTS generation and audio playback worked. The issue was always the content script / DOM injection / message routing between components.

## What we need help with

1. **Why is the content script not loading?** The `console.log` at the top never appears in the page console. Manifest declares it, file exists, path matches. What could prevent a content script from loading on a page?

2. **Is there a better pattern for this architecture?** We need: extract article from any page → send to offscreen TTS engine → play audio. The current chain (popup → background → content script → background → offscreen) has too many failure points.

3. **Are there known Chrome MV3 issues** with content scripts not loading on pages that were already open before the extension was installed/reloaded?

4. **The offscreen document race condition** — we solved it with a storage-based job queue (background stores job in chrome.storage.local, offscreen polls on startup), but is there a more robust pattern?

## Repo location

`/Users/harsh.rajmathur/Desktop/harsh-builds/voicebox-extension/`

Key directories:
- `src/` — TypeScript source
- `static/` — manifest.json, HTML files, icons, preview MP3s, WASM files
- `dist/` — built output (loaded as Chrome extension)
- `scripts/generate-previews.py` — generates voice preview MP3s

## Dependencies

- kokoro-js 1.2.1 (TTS engine)
- @mozilla/readability 0.6.0 (article extraction)
- onnxruntime-web (bundled WASM files in static/wasm/)
- Chrome MV3 APIs: offscreen, scripting, storage, activeTab, commands
