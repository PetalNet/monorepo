import Tile from "$lib/components/Tile.svelte";
import { TILES } from "$lib/data";
import type { Meta, StoryObj } from "@storybook/sveltekit";

const meta = {
	title: "Design System/Tile",
	component: Tile,
	tags: ["autodocs"],
} satisfies Meta<typeof Tile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = {
	args: { tile: TILES[0] },
};

export const Warning: Story = {
	args: { tile: TILES[3] },
};
