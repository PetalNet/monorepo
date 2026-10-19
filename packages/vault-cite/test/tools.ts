import { spawnSync } from "node:child_process";

import type { TestContext } from "vitest";

export function requireTools(context: Pick<TestContext, "skip">, commands: string[]) {
	for (const command of commands) {
		const result = spawnSync(command, ["--version"], { stdio: "ignore" });

		if (result.error && "code" in result.error && result.error.code === "ENOENT") {
			context.skip(
				`Missing optional test dependency: ${command}. Install Poppler for PDF tests, Tesseract for OCR.`,
			);
		}

		if (result.error) {
			throw result.error;
		}
	}
}
