// Re-export the vendored lucide iconDataUri so the live tile rebuild uses the
// exact same data-URI builder the source page imports from /vendor/icons.js.
// vendor-icons.js is a plain-JS module (checkJs typed it from its literals).
export { iconDataUri } from "./vendor/icons.js";
