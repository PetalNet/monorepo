import Card from "$lib/components/Card.svelte";
import type { Meta, StoryObj } from "@storybook/sveltekit";

const meta = {
	title: "Design System/Card",
	component: Card,
	tags: ["autodocs"],
	argTypes: {
		variant: { control: "select", options: ["filled", "outlined"] },
	},
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Filled: Story = {
	args: {
		variant: "filled",
		variantLabel: "Filled · content",
		title: "Lab health",
		body: "Tunnel connected, 14 days uninterrupted. Storage pool healthy. No alerts in 48 hours.",
	},
};

export const Outlined: Story = {
	args: {
		variant: "outlined",
		variantLabel: "Outlined · tappable",
		title: "Hover me",
		body: "A 1px outline. On hover a faint accent state-layer appears; the outline holds. No lift.",
	},
};
