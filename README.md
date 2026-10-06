# Voicebox Reader

**Listen to any web page with natural AI voices, entirely on your device.**

Install, click, listen. **English only for now** (American and British voices). No account, no server, and nothing you read ever leaves your browser. Voicebox runs the [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) speech model locally with WebGPU (or WASM on machines without a GPU).

## Features

- **Starts fast.** Audio begins after the first sentence is ready, while the rest generates ahead of you.
- **Follows along on the page.** The sentence being read is highlighted and scrolled into view (and it stays out of your way if you scroll yourself).
- **Read from anywhere.** Select text and right-click → *Read aloud from here*, or Alt+click any paragraph while listening.
- **Full control.** Seek bar with time left, previous/next paragraph, 0.75×–2× speed without pitch change, 28 English voices (US and UK) with search and favorites.
- **Resilient.** If Chrome shuts down the audio engine, your place, voice and speed are restored when you press play.
- **Private by design.** Uses `activeTab`, so it only touches a page when you ask it to. The only network access is the one-time model download from Hugging Face.

## Install

Chrome Web Store listing: coming soon. For now, from source:

```bash
git clone <this repository>
cd voicebox-extension
bun install
bun run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose the `dist/` folder.

The first time you listen, the voice model downloads once (roughly 90 MB on CPU, larger on GPU) and is cached by the browser. After that, Voicebox works offline.

## Using it

| Do this | To get this |
|---------|-------------|
| Click the toolbar icon → **Listen to this page** | Read the whole article |
| `Alt+Shift+R` | Start, or play/pause, from any tab |
| `Alt+Shift+→` / `Alt+Shift+←` | Next / previous paragraph |
| Select text → right-click → **Read aloud from here** | Start from that spot |
| Select text → right-click → **Read only the selection aloud** | Read just the selection |
| `Alt+click` a paragraph while listening | Jump there |
| Hardware media keys | Play/pause, next/previous |

Shortcuts can be changed at `chrome://extensions/shortcuts`.

**Language support:** English only. Voicebox reads English pages with 28 American and British voices. Other languages are not supported yet and will not read well.

## How it works

```
Popup ──────────────┐   polls state, sends commands
Content script ─────┤   extracts the article, highlights the spoken sentence
Background worker ──┤   lifecycle, routing, session recovery
Offscreen document ─┘   Kokoro TTS + Web Audio playback
```

Articles are split into sentence-sized segments (`src/shared/chunker.ts`) that stay within Kokoro's 512-token limit. A small lookahead pump generates a few segments ahead of the playhead; each segment's pause is baked in as trailing silence, so pause, seek and skip are all segment-based. Generated audio is cached in IndexedDB. The heavy ONNX/Kokoro code is loaded lazily so a failure surfaces as an error message instead of a silently dead page. See [CLAUDE.md](CLAUDE.md) for the full architecture and design decisions.

## Development

```bash
bun install
bun run build         # build to dist/
bun run watch         # rebuild on change
bun run typecheck     # tsc --noEmit
bun test              # unit tests (chunker, speech cleanup)
```

`scripts/e2e.mjs` is a real-browser end-to-end test (loads the built extension in Chromium with the real model); its header explains the setup. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits and licenses

Voicebox Reader is MIT licensed ([LICENSE](LICENSE)). It builds on [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0), [kokoro-js](https://github.com/hexgrad/kokoro) and [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0), [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT) and [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
