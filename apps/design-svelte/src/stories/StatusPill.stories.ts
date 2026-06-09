import StatusPill from "$lib/components/StatusPill.svelte";
import type { Meta, StoryObj } from "@storybook/sveltekit";

const meta = {
	title: "Design System/StatusPill",
	component: StatusPill,
	tags: ["autodocs"],
	argTypes: {
		state: { control: "select", options: ["ok", "warn", "down"] },
		pulse: { control: "boolean" },
	},
} satisfies Meta<typeof StatusPill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = { args: { state: "ok", label: "Healthy" } };
export const Checking: Story = { args: { state: "warn", pulse: true, label: "Checking" } };
export const Down: Story = { args: { state: "down", label: "Down" } };
