import type { Meta, StoryObj } from "@storybook/svelte-vite";

import Welcome from "./Welcome.svelte";

const meta = {
	title: "Example/Welcome",
	component: Welcome,
	tags: ["autodocs"],
} satisfies Meta<typeof Welcome>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CustomName: Story = {
	args: {
		name: "Component",
	},
};
