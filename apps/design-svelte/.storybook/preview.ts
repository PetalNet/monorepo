import type { Preview } from "@storybook/sveltekit";

// Load the design system's compiled stylesheet so components render in their
// real paper/ink context inside Storybook (same styles.css the app ships).
import "../src/lib/styles.css";

const preview: Preview = {
	parameters: {
		controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
		backgrounds: { disable: true },
	},
};

export default preview;
