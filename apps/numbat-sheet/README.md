# Numbat sheet

A browser spreadsheet whose cells are [Numbat](https://numbat.dev) expressions,
evaluated by the `numbat` crate compiled to WebAssembly.

Building the engine needs Rust with the `wasm32-unknown-unknown` target and a
`wasm-bindgen` CLI that matches the crate's `wasm-bindgen` version:

```sh
pnpm --filter @petalnet/numbat-sheet build:wasm
pnpm --filter @petalnet/numbat-sheet dev
```
