// Ambient declarations for the Worker bundle (wrangler / esbuild).

/** A `.wasm` import is a compiled WebAssembly.Module in workerd (rule CompiledWasm in wrangler.jsonc). */
declare module '*.wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}
