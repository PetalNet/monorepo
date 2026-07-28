import type { StorybookConfig } from "@storybook/svelte-vite";

export default {
	stories: ["../src/**/*.stories.@(js|jsx|mjs|ts|tsx|svelte)"],
	addons: ["@storybook/addon-a11y", "@storybook/addon-docs"],
	framework: {
		name: "@storybook/svelte-vite",
		options: {},
	},
} satisfies StorybookConfig;
