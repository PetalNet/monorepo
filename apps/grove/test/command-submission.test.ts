import { expect, it } from "vitest";

import { createCommandSubmission } from "../src/lib/projects/command-submission";

it("reuses an unchanged submitted command but distinguishes changed payloads and subsequent operations", () => {
	const command = createCommandSubmission();
	const data = (title: string, version = "v1") => {
		const fields = new FormData();

		fields.set("commandId", "stale-dom-value");
		fields.set("title", title);
		fields.set("expectedVersionId", version);

		return fields;
	};

	const first = data("Check drainage");

	command.prepare(first, "commandId");
	const firstId = first.get("commandId");

	expect(firstId).toMatch(/^[0-9a-f-]{36}$/);

	// Edits undone before submitting do not change the submitted payload.
	const retry = data("Temporary edit");

	retry.set("title", "Check drainage");
	retry.set("commandId", "another-dom-value");
	command.prepare(retry, "commandId");
	expect(retry.get("commandId")).toBe(firstId);

	const changedVersion = data("Check drainage", "v2");

	command.prepare(changedVersion, "commandId");
	expect(changedVersion.get("commandId")).not.toBe(firstId);

	const changedRetry = data("Check drainage", "v2");

	changedRetry.delete("title");
	changedRetry.set("title", "Check drainage");
	command.prepare(changedRetry, "commandId");
	expect(changedRetry.get("commandId")).toBe(changedVersion.get("commandId"));

	command.complete();
	const nextOperation = data("Check drainage", "v2");

	command.prepare(nextOperation, "commandId");
	expect(nextOperation.get("commandId")).not.toBe(changedVersion.get("commandId"));
});
