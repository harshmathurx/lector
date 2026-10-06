# Voicebox Reader — Full Project Context for Claude Code

## Product Vision

A Chrome extension that reads any web article aloud with natural AI voices. Built for regular people — not developers, not AI enthusiasts. The person who has 47 tabs of articles they want to read but can't focus long enough. The person with ADHD who absorbs better by listening. The person who wants to hear a Substack post while cooking.

**Core principles:**
- Zero setup. Install, click, listen.
- No server. No account. No data leaves the browser.
- Natural voices, not robotic screen readers.
- Fast. Lightweight. Doesn't heat up the machine.
- Feels like a product, not a demo.

## Current Architecture (v0.2)

```
Popup (popup.html + popup.ts)         ONLY UI. Holds no playback state: polls background `VB_GET_STATE` every 300ms
│                                      and renders PlayerState. Voice sheet (search/tabs/favorites), speed, seek bar,
│                                      prev/next paragraph, settings (clear cache), first-run banner.
Background SW (background.ts)         Lifecycle + routing only. Extracts article via content script, owns the offscreen
│                                      doc (ping handshake, recreate once), relays highlight events to the tab, persists
│                                      the session in chrome.storage.session so it can RECOVER if Chrome kills the
│                                      offscreen doc (it does after 30s without audio). Context menu, shortcuts, badge,
│                                      5-min idle alarm closes the offscreen doc.
Content script (content.ts)           Injected ON DEMAND (activeTab). Readability on a clone, but paragraph text comes from
│                                      the LIVE DOM (temporary data-vb-i attrs map clone→live) so we keep a text↔DOM map.
│                                      Highlights the spoken sentence via CSS Custom Highlight API (no DOM changes),
│                                      smart auto-scroll (yields to user scrolling), Alt+click paragraph = read from here.
Offscreen (offscreen.ts, engine.ts, cache.ts)
    offscreen.ts: session + player. Segments (≈sentences) → lookahead pump (4 ahead) → AudioBuffers with the pause baked
    in as trailing silence → one source at a time; pause/seek/skip are all segment based. Speed/voice change regenerates
    from the current segment. Tiny to evaluate: registers its listener first.
    engine.ts: lazy `import()` of onnxruntime-web + kokoro-js (load failure = error state, not a dead doc). WebGPU→WASM
    fallback at load AND at inference time. Serial inference queue.
    cache.ts: IndexedDB, sha256(voice|speed|text) key, Float32Array values, 48h TTL, 500 entries.
shared/: protocol.ts (types), chunker.ts (Intl.Segmenter sentence split → offsets into ORIGINAL text),
         speech.ts (display text → speakable text, applied per segment AFTER chunking), voices.ts.
```

**Why no `<all_urls>` / always-on content script:** privacy story ("nothing leaves your browser") and store review. We use
`activeTab` + `scripting`; host_permissions are limited to huggingface.co / hf.co for the model download.

**Offscreen 30s rule:** reason AUDIO_PLAYBACK docs are closed after 30s without audio (model download, long pause). This was
the likely cause of old bug "offscreen sometimes doesn't load". Mitigated by session recovery, not prevented.

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

## Status (v0.2)

**Fixed in the v0.2 rewrite:** voice/speed changes (payload shape mismatch popup↔offscreen), skip skipping two paragraphs,
pause position wrong at speed≠1, cache key collisions + Array.from(Float32Array) cache, seek hack, double message delivery,
offscreen eval failures being silent, no seek bar, no read-from-here, no progress/time-left, no paragraph navigation,
no "what's being read", no settings, no onboarding, `<all_urls>` permission.

**Added:** sentence streaming with lookahead (first audio ≈ first sentence), on-page sentence highlight + auto-scroll,
Alt+click / context-menu "Read aloud from here" / "Read selection", seek bar + time left, prev/next paragraph + shortcuts
(Alt+Shift+←/→), voice picker with search/favorites, media keys (mediaSession), badge status, session recovery, speech text
cleaning (citations, URLs, emoji, dashes), unit tests (`bun test src/shared`).

**Verified:** tsc clean, bun build, chunker/speech unit tests, content-script extraction + highlight mapping in headless Chrome
on a sample article, popup rendering (screenshots with a chrome stub).
**Verified end to end** (`scripts/e2e.mjs`, Chromium + real Kokoro on WebGPU): model load under lazy imports, HF download with the
narrowed host_permissions, playback, pause holds position, resume, next/prev, seek, speed, voice, on-page highlight, offscreen
death + recovery (keeps voice/speed), stop clears highlight. Also verified on paulgraham.com/do.html (br-only markup).
**NOT verified:** audible output quality (harness is headless), mediaSession media keys, context-menu flow, Alt+click,
the popup talking to a live background (popup was only rendered against a stub).

## Open / next
- Speed change regenerates (cached after first time). Could pre-generate neighbors.
- Non-English pages: phonemizer is English-only; no automatic voice/lang handling yet.
- No per-site extraction tuning (some SPAs/Substack variants may need fallbacks).
- Chrome Web Store assets/listing, onboarding page.

## Text Chunking (IMPLEMENTED)

The chunking algorithm in `offscreen.ts` handles Kokoro's 512-token limit:

### Splitting Strategy (three levels, recursive)
1. **Sentence boundaries** (`. ! ? …`) — primary split. 250ms silence after.
2. **Clause boundaries** (`, ; : — –`) — when a sentence exceeds the limit. 150ms after.
3. **Word boundaries** — last resort for very long clauses. 150ms after.

### Rules Enforced
- Never split mid-word, mid-quote, or inside parentheses
- Punctuation stays with the preceding text (not stripped)
- URLs and email addresses kept intact
- Paragraph breaks: 400ms silence between separate paragraphs in the playback loop

### Silence Between Chunks
- Sentence boundary: 250ms (6000 samples at 24kHz)
- Clause boundary: 150ms (3600 samples at 24kHz)
- Paragraph boundary: 400ms (9600 samples at 24kHz)
- Silence inserted as zero-filled Float32Array between concatenated audio chunks

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
│   ├── popup/popup.ts          # Popup UI (polls background for state)
│   ├── content/content.ts      # Extraction + highlight + Alt+click (injected on demand)
│   ├── background/background.ts # Lifecycle, routing, session recovery
│   ├── offscreen/{offscreen,engine,cache}.ts # Player/session, Kokoro engine, IDB cache
│   └── shared/                 # protocol, chunker, speech, voices (+ tests)
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

Typed in `src/shared/protocol.ts`. popup→background: `VB_START {mode}`, `VB_CMD {command}`, `VB_GET_STATE`, `VB_CLEAR_CACHE`;
content→background: `VB_JUMP`. background→offscreen (tagged `target:'offscreen'`): `TTS_PING/START/COMMAND/GET_STATE/CLEAR_CACHE`.
offscreen→background: `VB_EVENT {status|segment|finished}`. background→content: `VB_PING`, `EXTRACT_ARTICLE`, `VB_HIGHLIGHT`, `VB_HIGHLIGHT_CLEAR`.
Commands: toggle/pause/resume/stop/next/prev/seek/jump/voice/speed.

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
5148d37 fix: pause/resume deadlock + paragraph break pauses
adb5719 feat: proper TTS text chunking with prosody-aware splitting
dd20c1c docs: add CLAUDE.md with full project context for AI-assisted development
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
