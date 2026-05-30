// Source index — exposes a stub re-export so `tsc -b` has something to compile
// and downstream packages can `import {} from "@petalnet/tokens"` against the
// types before the generated dist/ exists. The actual runtime export comes
// from tools/build.mjs writing dist/index.js.
//
// Once `pnpm --filter @petalnet/tokens build` has run, dist/index.{js,d.ts}
// override this for both runtime and types via package.json exports.

export {};
