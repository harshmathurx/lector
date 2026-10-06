# Voicebox Reader

Read any web article aloud with natural AI voices — running entirely in your browser. No server, no account, no data leaves your machine.

Powered by [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) TTS via [kokoro-js](https://github.com/hexgrad/kokoro) (ONNX + WebGPU/WASM).

## Install

### From source (developer)

```bash
git clone https://github.com/YOUR_USERNAME/voicebox-extension.git
cd voicebox-extension
bun install
bun run build
```

Then load in Chrome:
1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `dist/` folder

## Usage

1. Navigate to any article
2. Click the extension icon → **Read Aloud** (or press `Alt+Shift+R`)
3. First run downloads the model (~92MB, cached after that)
4. Floating player appears bottom-right — play/pause, speed, voice

### Controls

| Control | Action |
|---------|--------|
| Play/Pause | Toggle playback |
| Speed chip | Cycle 0.75x – 2x |
| Voice chip | Pick from 19 voices (US/UK, male/female) |
| × | Stop and close player |
| `Alt+Shift+R` | Start reading from keyboard |

## How it works

```
Popup (launcher)
  → Background SW (message router, tab management)
    → Content Script (Readability extraction, floating player UI)
    → Offscreen Document (Kokoro TTS inference + Web Audio playback)
```

- **Kokoro 82M** runs in an offscreen document via ONNX Runtime Web
- **WebGPU** on supported browsers, **WASM SIMD** fallback
- **Mozilla Readability** extracts article text, splits into paragraphs
- **IndexedDB** caches generated audio (24h TTL, LRU eviction at 200 entries)
- Pre-generates next paragraph while playing current

## Development

```bash
bun install       # install deps
bun run build     # build to dist/
bun run watch     # watch mode
```

### Stack

- TypeScript, Bun (bundler)
- [kokoro-js](https://github.com/hexgrad/kokoro) — TTS engine
- [@mozilla/readability](https://github.com/mozilla/readability) — article extraction
- Chrome MV3 (offscreen document, service worker, content scripts)

## License

MIT — see [LICENSE](LICENSE)
