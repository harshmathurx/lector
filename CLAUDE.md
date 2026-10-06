# Voicebox Reader — Full Project Context for Claude Code

## Product Vision

A Chrome extension that reads any web article aloud with natural AI voices. Built for regular people — not developers, not AI enthusiasts. The person who has 47 tabs of articles they want to read but can't focus long enough. The person with ADHD who absorbs better by listening. The person who wants to hear a Substack post while cooking.

**Core principles:**
- Zero setup. Install, click, listen.
- No server. No account. No data leaves the browser.
- Natural voices, not robotic screen readers.
- Fast. Lightweight. Doesn't heat up the machine.
- Feels like a product, not a demo.

## Current Architecture

```
Chrome Extension (MV3)
├── Popup (popup.html + popup.ts)
│   → ONLY UI surface. Voice picker, speed, play/pause, stop, progress.
│   → Voice previews via pre-generated static MP3 files (instant, no model needed)
│   → Saves default voice/speed to chrome.storage.local
│
├── Background Service Worker (background.ts)
│   → Message router between popup ↔ offscreen
│   → Creates offscreen document on demand
│   → Handles keyboard shortcut (Alt+Shift+R)
│   → Injects content script if not already on page
│
├── Content Script (content.ts)
│   → MINIMAL: only extracts article text via Mozilla Readability
│   → No DOM injection, no floating player, no styles
│   → Returns { title, textContent, url, paragraphs[] }
│   → Paragraph splitting: double-newline → single-newline → sentence-chunked
│
└── Offscreen Document (offscreen.html + offscreen.ts)
    → Runs Kokoro 82M TTS via kokoro-js (ONNX Runtime Web)
    → WebGPU (fp32) with WASM (q8) fallback
    → Web Audio API playback (AudioContext → GainNode → destination)
    → IndexedDB cache for generated audio (24h TTL, LRU eviction at 200 entries)
    → Picks up work from chrome.storage.local 'pendingJob' (avoids race condition)
    → Pre-generates next paragraph while playing current
```

## Model: Kokoro 82M

- ONNX export: `onnx-community/Kokoro-82M-v1.0-ONNX`
- We use `kokoro-js` npm package (wraps transformers.js + ONNX Runtime Web)
- 512 phoneme token context limit (~250-400 chars of English text)
- Speed parameter built into the model — adjusts tempo WITHOUT pitch shift
- 54 voices across 9 languages (US, UK, JP, CN, ES, FR, IN, IT, BR)
- Voice files are `.bin` embeddings (511×256 float32) fetched from HuggingFace
- **IMPORTANT:** The phonemizer (G2P) only supports English. Non-English voices ONLY work with text in their language. Using a Japanese voice on English text produces garbage.

## Voice Catalog

54 voices total. Key ones:
- Best quality: `af_heart` (A grade), `af_bella` (A- grade)
- US Female: Heart, Alloy, Aoede, Bella, Jessica, Kore, Nicole, Nova, River, Sarah, Sky
- US Male: Adam, Echo, Eric, Fenrir, Liam, Michael, Onyx, Puck, Santa
- UK Female: Alice, Emma, Isabella, Lily
- UK Male: Daniel, Fable, George, Lewis
- Japanese: Alpha, Gongitsune, Nezumi, Tebukuro (F), Kumo (M)
- Mandarin: Xiaobei, Xiaoni, Xiaoxiao, Xiaoyi (F), Yunjian, Yunxi, Yunxia, Yunyang (M)
- Spanish: Dora (F), Alex, Santa (M)
- French: Siwis (F)
- Hindi: Alpha, Beta (F), Omega, Psi (M)
- Italian: Sara (F), Nicola (M)
- Brazilian Portuguese: Dora (F), Alex, Santa (M)

Voice previews: 54 pre-generated MP3 files (~25KB each, 1.3MB total) in `static/previews/`. Generated via the Voicebox Python backend. Each says "Hi, I'm [name], and I'll be reading to you."

## What's Been Built and Works

1. ✅ Article extraction (Mozilla Readability, multi-strategy paragraph splitting)
2. ✅ Kokoro TTS in browser via WebGPU/WASM (model cached in IndexedDB after first download)
3. ✅ Audio playback via Web Audio API (AudioContext, GainNode, resampling from 24kHz to context rate)
4. ✅ Pause/Resume with correct buffer position tracking
5. ✅ Voice switching mid-playback (regenerates current paragraph with new voice)
6. ✅ Speed control via Kokoro's native speed parameter (0.75x-2x, no pitch shift)
7. ✅ Voice preview MP3s (instant, no model download needed)
8. ✅ Audio caching in IndexedDB (24h TTL, LRU eviction)
9. ✅ Pre-generation of next paragraph while playing current
10. ✅ Storage-based job queue for offscreen (avoids race condition on creation)
11. ✅ Keyboard shortcut (Alt+Shift+R)
12. ✅ Long paragraph chunking (>400 chars split at sentence boundaries)

## Known Bugs and Issues

### Critical
1. **Paragraph 22 failure on Substack** — long paragraphs fail even with chunking. The chunking is naive — it splits at sentence boundaries but doesn't handle:
   - Commas needing brief pauses
   - Question marks and exclamation points affecting intonation
   - Quotes and dialogue markers
   - Em dashes, ellipses
   - Parenthetical asides
   - The silence gap between concatenated audio chunks (currently zero — sounds robotic)
   - The chunk boundary may split mid-clause, losing prosody

2. **Offscreen document sometimes doesn't load** — the 5MB JS bundle (ONNX Runtime + kokoro-js) occasionally crashes silently. No error in console. The `checkPendingJob` poll may not run. Needs investigation into whether it's a memory issue, a WASM compilation timeout, or a module evaluation error.

### UX Issues
3. **No seek within paragraph** — the state tracks currentTime/duration but there's no scrub bar in the popup
4. **No "read from here"** — always starts from paragraph 0. Should be able to right-click any paragraph and start reading from there
5. **No progress indication when generating** — the popup shows "Generating..." but not which paragraph or how long it'll take
6. **Voice change mid-read regenerates from scratch** — could pre-cache common voices
7. **No way to see what's currently being read** — the popup shows paragraph text preview but you can't see which paragraph in the page
8. **Speed change regenerates everything** — could use playbackRate as a quick-and-dirty option for small adjustments, or pre-generate at multiple speeds

### Polish
9. **No onboarding flow** — first-run experience needs to be smooth: pick a voice, hear a preview, understand the shortcut
10. **No settings page** — model quality selection (fp32 vs q8), cache management, voice favorites
11. **Error messages are generic** — "Failed on paragraph 22" doesn't tell the user what to do
12. **No paragraph navigation** — can't skip to a specific paragraph or go back

## Text Chunking Requirements (CRITICAL — needs rewrite)

The current chunking is too naive. Here's what proper TTS chunking needs:

### Chunking Rules
1. **Primary split:** sentence boundaries (`.`, `!`, `?`, `...`) — these get natural pauses from the model
2. **Secondary split:** clause boundaries (`,`, `;`, `:`, `—`, `–`) — when a sentence is too long
3. **Tertiary split:** conjunction boundaries (`and`, `but`, `or`, `which`, `that`) — last resort
4. **NEVER split:** mid-word, mid-quote, between a name and its title, between a number and its unit

### Pause/Prosody Requirements
- Between sentences within a chunk: handled by the model (punctuation is in the text)
- Between concatenated chunks: insert 200-300ms of silence (24kHz: 4800-7200 samples of zeros)
- Paragraph breaks: insert 400-500ms of silence
- The text sent to each chunk should END with the punctuation mark (don't strip it)

### What NOT to do
- Don't split mid-sentence unless the sentence exceeds the token limit
- Don't remove punctuation from chunk boundaries
- Don't concatenate audio without silence gaps
- Don't split inside parentheses or quotes
- Don't split URLs, email addresses, or code blocks

## Architecture Decisions Made (and why)

1. **Offscreen document, not content script** — Chrome MV3 service workers can't use AudioContext. Content scripts can't run heavy ML without blocking the page. Offscreen documents get full DOM + Web Audio + no page interference.

2. **Storage-based job queue** — `chrome.offscreen.createDocument()` returns before the document's JS has parsed. Sending a message immediately loses it. Instead, background stores the job in `chrome.storage.local`, offscreen polls on startup.

3. **No floating player on the page** — was causing CSS conflicts, pointer-events bugs, and drag issues. All controls live in the extension popup. Simpler, more reliable.

4. **Static MP3 voice previews** — instead of generating previews via TTS (which requires the 92MB model to be loaded), we pre-generated all 54 voice samples and bundle them. 1.3MB total. Instant.

5. **Kokoro's speed parameter, not playbackRate** — `playbackRate` on AudioBufferSourceNode shifts pitch (Mickey Mouse effect). Kokoro's `speed` parameter adjusts tempo at the model level without pitch shift.

6. **Bun as bundler** — fast, no config needed, handles TypeScript natively.

## File Structure

```
voicebox-extension/
├── src/
│   ├── popup/popup.ts          # Popup UI logic
│   ├── content/content.ts      # Article extraction (minimal)
│   ├── background/background.ts # Service worker, message router
│   └── offscreen/offscreen.ts  # TTS engine + audio playback
├── static/
│   ├── manifest.json           # Chrome MV3 manifest
│   ├── popup/popup.html        # Popup UI markup + styles
│   ├── offscreen/offscreen.html # Offscreen entry point
│   ├── icons/                  # Extension icons
│   ├── previews/               # Voice preview MP3s (54 files)
│   └── wasm/                   # ONNX Runtime WASM files
├── scripts/
│   └── generate-previews.py    # Generates voice preview MP3s
├── package.json
├── tsconfig.json
├── LICENSE                     # MIT
└── README.md
```

## Message Protocol

| Type | Direction | Data | Purpose |
|------|-----------|------|---------|
| `START_READING` | popup → background | - | Start reading current page |
| `EXTRACT_ARTICLE` | background → content | - | Get article text |
| `TTS_START` | background → offscreen | ArticleData | Start TTS + playback |
| `TTS_PAUSE` | popup → offscreen | - | Pause playback |
| `TTS_RESUME` | popup → offscreen | - | Resume playback |
| `TTS_STOP` | popup → background → offscreen | - | Stop everything |
| `TTS_SET_SPEED` | popup → offscreen | `{ speed: number }` | Change speed |
| `TTS_SET_VOICE` | popup → offscreen | `{ voice: string }` | Change voice |
| `TTS_GET_STATE` | popup → offscreen | - | Get current state |
| `TTS_STATE_UPDATE` | offscreen → popup | TTSState | State broadcast |

## Dependencies

```json
{
  "kokoro-js": "^1.2.1",
  "@mozilla/readability": "^0.6.0"
}
```

WASM files from `onnxruntime-web` are bundled locally in `static/wasm/` because Chrome extensions can't load modules from CDN in offscreen documents.

## Commit History

```
3e44f6a fix: long paragraph chunking, non-English voice warning, popup error suppression
464cbb3 fix: handle long paragraphs and add generation error logging
f2ef3af fix: speed uses Kokoro's built-in speed param (no pitch shift), popup error on open
fdf1d2b fix: pause/resume position tracking, voice/speed change restart
edc9704 refactor: remove floating DOM player, all controls in extension popup
471a024 fix: eliminate offscreen race condition via storage-based job queue
e6c6ac1 fix: offscreen document race condition — TTS_START was lost
d060eb7 fix: player clicks dead (pointer-events:none), voice ordering, debug logging
b3dd0e5 fix: add host_permissions for content script injection
43d9742 feat: 54 voices, voice previews, draggable pill player, seek support
65da90b feat: pre-generated voice preview clips (54 voices, 1.3MB total)
78e56b6 fix: speed changes apply live, voice switching restarts playback
df61302 docs: add LICENSE (MIT) and README
26ba8bb feat: Chrome extension for article TTS with Kokoro in-browser
```
