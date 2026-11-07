import type { Snippet } from "svelte";

/** Page-owned controls the shell places in its top bar (the editor's Print button). */
export const chrome = $state<{ actions: Snippet | null }>({ actions: null });
