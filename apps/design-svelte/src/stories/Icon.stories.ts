import Icon from "$lib/components/Icon.svelte";
import { ICONS } from "$lib/icons";
import type { Meta, StoryObj } from "@storybook/sveltekit";

const meta = {
	title: "Design System/Icon",
	component: Icon,
	tags: ["autodocs"],
	argTypes: {
		name: { control: "select", options: Object.keys(ICONS) },
	},
} satisfies Meta<typeof Icon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Sparkles: Story = { args: { name: "sparkles" } };
export const Palette: Story = { args: { name: "palette" } };
export const CircleCheck: Story = { args: { name: "circle-check" } };
