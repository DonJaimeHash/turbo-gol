/**
 * SHA-256 of rocketsim.wasm, the file next to this one. Community nodes get matches only when
 * their wasm has this hash (the control plane compares builds), and the Worker cannot compute it:
 * it imports the wasm already compiled (server/src/wasm.ts). So the hash is committed with the
 * wasm: native/build.ps1 rewrites the line below after every build, and tests/wasm-hash.test.mjs
 * fails when the two disagree.
 */
export const ROCKETSIM_WASM_SHA256 = 'c137f952a57395e81e97a187c1a14bed0f034131418deb4bdd4a7b3fdf3f3c92';
