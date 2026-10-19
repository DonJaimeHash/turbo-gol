// Resolve hook for running the TypeScript sources directly with Node >= 24 (native type stripping).
// The repo's modules use extensionless relative imports (bundler style: "../sim/types"), which Node
// does not complete on its own, so "./x" falls back to "./x.ts" (and "./x.js" to "./x.ts").
// Same hook the repo's own tests register. Load it first:
//   node --import ./dev/ts-resolve.mjs node/main.ts
// or, inside a test file, `import '../dev/ts-resolve.mjs'` and then dynamic-import the .ts modules.
// Release builds do not need it: scripts/build-node.mjs bundles everything into one file.
import { registerHooks } from 'node:module';

if (!globalThis.__tgnTsResolve) {
  globalThis.__tgnTsResolve = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        const relative = specifier.startsWith('./') || specifier.startsWith('../');
        if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
          if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
          if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
        }
        throw err;
      }
    },
  });
}
