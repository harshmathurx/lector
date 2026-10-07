# Third-party notices

Lector bundles or downloads the following. Each is used under its own license.

| Component | License | Use |
|-----------|---------|-----|
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (model + voices) | Apache-2.0 | Speech synthesis. Downloaded from Hugging Face on first use; not bundled. |
| [kokoro-js](https://github.com/hexgrad/kokoro) | Apache-2.0 | Runs Kokoro in JavaScript. Bundled. |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 | Model loading (via kokoro-js). Bundled. |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | MIT | Inference engine. Bundled, including the WASM binaries in `static/wasm/`. |
| [misaki](https://github.com/hexgrad/misaki) | Apache-2.0 | Kokoro's official text frontend; number and currency reading rules in `src/shared/normalize.ts` are ported from it. |
| [sbd](https://github.com/Tessmore/sbd) | MIT | Abbreviation list used by the sentence splitter in `src/shared/chunker.ts`. |
| [number-to-words](https://github.com/marlun78/number-to-words) | MIT | Spells numbers as words. Bundled. |
| [Mozilla Readability](https://github.com/mozilla/readability) | Apache-2.0 | Article extraction. Bundled. |
| [Gloock](https://fonts.google.com/specimen/Gloock) | SIL OFL 1.1 | Display typeface. Bundled in `static/fonts/`. |
| [Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans) | SIL OFL 1.1 | Interface typeface. Bundled in `static/fonts/`. |

The 54 voice preview clips in `static/previews/` were generated with Kokoro.
