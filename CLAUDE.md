# Voicebox Reader — Full Project Context for Claude Code

## Product Vision

A Chrome extension that reads any web article aloud with natural AI voices. Built for regular people — not developers, not AI enthusiasts. The person who has 47 tabs of articles they want to read but can't focus long enough. The person with ADHD who absorbs better by listening. The person who wants to hear a Substack post while cooking.

**Language support: English only (28 US/UK voices).** State this wherever the product is described. Multilingual is deferred (last on the roadmap).

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
Offscreen (offscreen.ts, engine.ts, engine.worker.ts, cache.ts)
    offscreen.ts: session + player. Segments (≈sentences) → lookahead pump (4 ahead) → AudioBuffers with the pause baked
    in as trailing silence → one source at a time; pause/seek/skip are all segment based. Speed/voice change regenerates
    from the current segment. Tiny to evaluate: registers its listener first.
    engine.ts: thin client for engine.worker.ts. The worker owns the model (lazy `import()` of onnxruntime-web + kokoro-js,
    so a load failure = error state, not a dead doc), WebGPU→WASM fallback at load AND inference time, serial queue.
    Why a worker: on WASM, inference blocked the main thread (pause took 5-22s, voice change 15s). ORT's own proxy worker
    can't be used in a bundle; now commands answer in <15ms on both backends and offscreen.js is ~22KB.
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
- The model has 54 voices in 9 languages, but **kokoro-js only registers the 28 US/UK English ones** (its voice table). The other 26 throw `Voice "x" not found` before text is even read, so we ship only the 28.
- Voice files are `.bin` embeddings (511×256 float32) fetched from HuggingFace
- **IMPORTANT:** kokoro-js's phonemizer is an English-only espeak-ng build (8 `en*` voices; `es`, `fr-fr`, `hi`, `it`, `pt-br`, `cmn` throw "Invalid language identifier"). Non-English needs a multilingual phonemizer (full espeak-ng wasm; ja/zh need misaki-style G2P) + `generate_from_ids`. Not done.

## Voice Catalog

28 usable voices (English). Key ones:
- Best quality: `af_heart` (A grade), `af_bella` (A- grade)
- US Female: Heart, Alloy, Aoede, Bella, Jessica, Kore, Nicole, Nova, River, Sarah, Sky
- US Male: Adam, Echo, Eric, Fenrir, Liam, Michael, Onyx, Puck, Santa
- UK Female: Alice, Emma, Isabella, Lily
- UK Male: Daniel, Fable, George, Lewis

Voice previews: 28 pre-generated MP3 files (~25KB each) in `static/previews/`. Generated via the Voicebox Python backend. Each says "Hi, I'm [name], and I'll be reading to you."

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
death + recovery (keeps voice/speed), stop clears highlight, on both WebGPU and forced WASM (`NO_GPU=1`). Also verified live on
paulgraham.com/do.html (br-only markup) and worldstories.org.uk Hansel and Gretel (title "Page | Site" handled).
**NOT verified:** audible output quality (harness is headless), mediaSession media keys, context-menu flow, Alt+click,
the popup talking to a live background (popup was only rendered against a stub).

## Open / next
- Speed change regenerates (cached after first time). Could pre-generate neighbors.
- Non-English pages/voices: unsupported (see Model section). Spanish/French/etc. pages read with an English voice sound wrong; consider a clear notice on non-`en` pages.
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
│   ├── offscreen/{offscreen,engine,engine.worker,cache}.ts # Player/session, engine client, Kokoro worker, IDB cache
│   └── shared/                 # protocol, chunker, speech, voices (+ tests)
├── static/
│   ├── manifest.json           # Chrome MV3 manifest
│   ├── popup/popup.html        # Popup UI markup + styles
│   ├── offscreen/offscreen.html # Offscreen entry point
│   ├── icons/                  # Extension icons
│   ├── previews/               # Voice preview MP3s (28 files)
│   └── wasm/                   # ONNX Runtime WASM files
├── scripts/
│   ├── e2e.mjs                 # Real-browser end-to-end test (see header)
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
