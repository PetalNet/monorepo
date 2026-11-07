import { defineContentScript } from "wxt/utils/define-content-script";

import { start } from "../src/content.ts";

export default defineContentScript({
	matches: ["https://github.com/*"],
	runAt: "document_idle",
	main: start,
});
