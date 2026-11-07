import type { TemplateCategory } from "$lib/doc";

/** Gallery order and names for `TemplateCategory`. */
export const CATEGORIES: readonly { id: TemplateCategory; name: string }[] = [
	{ id: "lab", name: "Lab and network" },
	{ id: "home", name: "Home" },
	{ id: "kitchen", name: "Kitchen" },
	{ id: "office", name: "Office" },
	{ id: "school", name: "School" },
	{ id: "safety", name: "Safety" },
	{ id: "garden", name: "Garden" },
	{ id: "personal", name: "Personal" },
	{ id: "qr", name: "QR and codes" },
];
