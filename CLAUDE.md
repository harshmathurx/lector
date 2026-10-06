# Lector — Full Project Context for Claude Code

## Product Vision

A Chrome extension that reads any web article aloud with natural AI voices. Built for regular people — not developers, not AI enthusiasts. The person who has 47 tabs of articles they want to read but can't focus long enough. The person with ADHD who absorbs better by listening. The person who wants to hear a Substack post while cooking.

**Name: Lector** (locked 2026-10-06; repo dir is still `voicebox-extension`, Voicebox is credited as inspiration only).

**Language support: English only (28 US/UK voices).** State this wherever the product is described. Multilingual is deferred (last on the roadmap).

**Core principles:**
- Zero setup. Install, click, listen.
- No server. No account. No data leaves the browser.
- Natural voices, not robotic screen readers.
- Fast. Lightweight. Doesn't heat up the machine.
- Feels like a product, not a demo.

## Design system (A×F, locked)

Spec: `scratchpad/05-axf-build-spec.md` (git-ignored; copy the essentials here if the scratchpad is lost).
- Monochrome, light + dark via `prefers-color-scheme`. The ONLY colour is error orange (#C2410C / #FB923C).
- Two typefaces, bundled in `static/fonts/` (no runtime font requests): **Gloock** only for the wordmark, the article title and the sentence being read; **Instrument Sans** for everything else (timers use tabular-nums).
- Icon: Gloock “ on a rounded tile. `static/icons/icon-light-*` (black tile, manifest default) and `icon-dark-*`; the popup swaps them with `chrome.action.setIcon` to match the system theme.
- Motion carries meaning (no colour to do it): ink-in words in the popup sentence (driven by `PlayerState.segProgress`, interpolated with rAF), a growing underline on the page (`lector-read`) over a neutral sentence wash (`lector-seg`), the "speaking" quote icon, shimmer for preparing states. All off under reduced motion.
- Copy: one plain status line; no jargon outside Settings; errors say what happened and what to do.

## Current Architecture (v0.3)

```
Popup (popup.html + popup.ts)         ONLY UI. Holds no playback state: polls background `VB_GET_STATE` every 300ms
│                                      and renders PlayerState. Voice sheet (search/tabs/favorites), speed, seek bar,
│                                      prev/next paragraph, settings (clear cache), first-run banner.
Background SW (background.ts)         Lifecycle + routing only. Extracts article via content script, owns the offscreen
│                                      doc (ping handshake, recreate once), relays timed highlight events to the tab (VB_HIGHLIGHT with durationMs/offsetMs, VB_HIGHLIGHT_PAUSE), processes engine events strictly in order, persists
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

## Status (v0.3)

Shipped in v0.3 (all committed): Lector rebrand + A×F popup (light/dark), word-by-word ink-in (popup) and growing page
underline synced to speech, robust page highlighting across sites (fallback text search, stale-DOM recovery), Show on page /
Scroll to follow toggles, low-end performance tiers (threaded WASM via COEP/COOP, q4/q8/fp32 per device, adaptive lookahead,
keep-alive while loading), accessibility pass (0 axe violations), macOS/Windows Now Playing metadata + position, keyboard
"listen from here", Voice quality setting.

Shortcuts (suggested; customisable at chrome://extensions/shortcuts): Alt+Shift+R start/pause, Alt+Shift+. next paragraph,
Alt+Shift+, previous paragraph, Alt+Shift+H listen from here; stop / speed-up / speed-down exist unbound. (Moved off
Alt+Shift+←/→ which is macOS word selection.)

**Verified automatically:** tsc, `bun test` (22), `scripts/e2e.mjs` on WebGPU and NO_GPU with real Kokoro (playback, pause,
resume, next/prev, seek, speed, voice, recovery, stop, Now Playing metadata/position, listen-from-here, quality switch),
axe-core on all popup views, CDP keyboard walk, highlight hit-rates on saved real pages.
**Needs the owner by hand:** audible quality (WASM q4, 16-bit cache replays, keep-alive silence), macOS Now Playing and
Windows media flyout, VoiceOver/NVDA scripts in `scratchpad/06-a11y-audit.md`, Windows High Contrast, shortcut strings on Mac.
**Harness gotcha:** Chrome caches the service-worker script per profile; always use a fresh profile (or clear
`Service Worker/ScriptCache`) or a stale background silently runs.

## Open / next
- Speed change regenerates (cached after first time). Could pre-generate neighbors.
- Non-English pages/voices: unsupported (see Model section). Spanish/French/etc. pages read with an English voice sound wrong; consider a clear notice on non-`en` pages.
- No per-site extraction tuning (some SPAs/Substack variants may need fallbacks).
- Chrome Web Store assets/listing, onboarding page.

## Text Chunking

`src/shared/chunker.ts` is the source of truth (Intl.Segmenter sentences → clause → word splits, ≤300 chars, short first segment for fast start). Segments are offsets into the ORIGINAL paragraph text so the page can highlight them; `speech.ts` cleans text per segment AFTER chunking. Pauses are baked into each buffer as trailing silence (clause 100ms, sentence 180ms, paragraph 450ms, heading 700ms).

## Architecture Decisions Made (and why)

1. **Offscreen document, not content script** — Chrome MV3 service workers can't use AudioContext. Content scripts can't run heavy ML without blocking the page. Offscreen documents get full DOM + Web Audio + no page interference.

2. **Ping handshake, not a job queue** — `chrome.offscreen.createDocument()` returns before the document's JS has parsed. The background pings (`TTS_PING`) until the offscreen listener answers, recreating the document once if it never does. (v0.1 used a storage-based job queue; replaced in v0.2.)

3. **No floating player on the page** — was causing CSS conflicts, pointer-events bugs, and drag issues. All controls live in the extension popup. Simpler, more reliable.

4. **Static MP3 voice previews** — pre-generated so previews never need the model loaded. 28 clips, one per supported voice. Instant.

5. **Kokoro's speed parameter, not playbackRate** — `playbackRate` on AudioBufferSourceNode shifts pitch (Mickey Mouse effect). Kokoro's `speed` parameter adjusts tempo at the model level without pitch shift.

6. **Bun as bundler** — fast, no config needed, handles TypeScript natively.

## File Structure

```
voicebox-extension/   (product: Lector)
├── src/
│   ├── popup/popup.ts          # Popup UI (polls background for state)
│   ├── content/content.ts      # Extraction + highlight + Alt+click (injected on demand)
│   ├── background/background.ts # Lifecycle, routing, session recovery
│   ├── offscreen/{offscreen,engine,engine.worker,tier,cache}.ts # Player/session, engine client, Kokoro worker, device tiers, IDB cache
│   └── shared/                 # protocol, chunker, speech, title, voices (+ tests)
├── static/
│   ├── manifest.json           # Chrome MV3 manifest
│   ├── popup/popup.html        # Popup UI markup + styles
│   ├── offscreen/offscreen.html # Offscreen entry point
│   ├── icons/                  # icon-light-* / icon-dark-* (16/32/48/128)
│   ├── fonts/                  # Gloock, Instrument Sans (OFL)
│   ├── content/highlight.css   # ::highlight(lector-seg / lector-read)
│   ├── previews/               # Voice preview MP3s (28 files)
│   └── wasm/                   # ONNX Runtime WASM files
├── scripts/
│   ├── e2e.mjs                 # Real-browser end-to-end test (see header)
│   ├── bench.mjs               # Performance bench: TTFA, RTF, stalls, memory
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
Commands: toggle/pause/resume/stop/next/prev/seek/jump/voice/speed. Additive since v0.3: `Article.image/site`, `TTS_START/TTS_WARM.quality`, `PlayerState.segProgress/threads/lang`, segment `durationMs/offsetMs`, `VB_HIGHLIGHT_PAUSE`, a `progress` event. `src/shared/protocol.ts` is the source of truth.

## Dependencies

```json
{
  "kokoro-js": "^1.2.1",
  "@mozilla/readability": "^0.6.0"
}
```

WASM files from `onnxruntime-web` are bundled locally in `static/wasm/` because Chrome extensions can't load modules from CDN in offscreen documents.
