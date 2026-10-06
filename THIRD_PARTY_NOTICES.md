# Third-party notices

Voicebox Reader bundles or downloads the following. Each is used under its own license.

| Component | License | Use |
|-----------|---------|-----|
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (model + voices) | Apache-2.0 | Speech synthesis. Downloaded from Hugging Face on first use; not bundled. |
| [kokoro-js](https://github.com/hexgrad/kokoro) | Apache-2.0 | Runs Kokoro in JavaScript. Bundled. |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 | Model loading (via kokoro-js). Bundled. |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | MIT | Inference engine. Bundled, including the WASM binaries in `static/wasm/`. |
| [Mozilla Readability](https://github.com/mozilla/readability) | Apache-2.0 | Article extraction. Bundled. |

The 54 voice preview clips in `static/previews/` were generated with Kokoro.
