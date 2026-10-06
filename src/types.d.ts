// onnxruntime-web ships types that its package "exports" map hides from TS.
declare module 'onnxruntime-web' {
  export const env: { wasm: unknown };
}
