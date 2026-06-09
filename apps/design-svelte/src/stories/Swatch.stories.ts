import Swatch from "$lib/components/Swatch.svelte";
import type { Meta, StoryObj } from "@storybook/sveltekit";

const meta = {
	title: "Design System/Swatch",
	component: Swatch,
	tags: ["autodocs"],
} satisfies Meta<typeof Swatch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Accent: Story = {
	args: { swatch: { cls: "chip-bg-petal", name: "--petal", hex: "#BC5638 · the accent" } },
};

export const Paper: Story = {
	args: { swatch: { cls: "chip-bg-bg", name: "--bg", hex: "#FFFFFF · paper", ring: true } },
};

export const StatusDanger: Story = {
	args: { swatch: { cls: "chip-bg-danger", name: "--danger", hex: "#C5374B · status only" } },
};
