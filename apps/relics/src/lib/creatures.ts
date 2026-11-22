export const creatureModelIds = ["shroomling", "snail"] as const;
export type CreatureModelId = (typeof creatureModelIds)[number];
export const creatureModels = {
	shroomling: {
		label: "Shroomling",
		url: "/creatures/shroomling.glb",
		still: "/creatures/shroomling-still.webp",
		material: "cap",
		axis: "height",
		size: 2.43,
		rotation: -0.85,
	},
	snail: {
		label: "Snail",
		url: "/creatures/snail.glb",
		still: "/creatures/snail-still.webp",
		material: "shell",
		axis: "width",
		size: 2.85,
		rotation: -0.45,
	},
} satisfies Record<
	CreatureModelId,
	{
		label: string;
		url: string;
		still: string;
		material: string;
		axis: "height" | "width";
		size: number;
		rotation: number;
	}
>;
