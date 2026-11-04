import type { FontId } from "$lib/doc";

/** The families the renderer bundles, in the order the font menu lists them. */
export const FONTS: readonly { id: FontId; name: string }[] = [
	{ id: "inter", name: "Inter" },
	{ id: "atkinson", name: "Atkinson Hyperlegible" },
	{ id: "barlow-condensed", name: "Barlow Condensed" },
	{ id: "nunito", name: "Nunito" },
	{ id: "source-serif", name: "Source Serif" },
	{ id: "jetbrains-mono", name: "JetBrains Mono" },
];
