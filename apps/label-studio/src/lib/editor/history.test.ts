import { describe, expect, it } from "vitest";

import { commit, redo, startHistory, undo } from "./history";

describe("history", () => {
	it("undoes and redoes snapshots", () => {
		let history = startHistory("a");

		history = commit(history, "b", null, 0);
		history = commit(history, "c", null, 10);
		history = undo(history);
		expect(history.present).toBe("b");
		history = undo(history);
		expect(history.present).toBe("a");
		history = redo(history);
		expect(history.present).toBe("b");
	});

	it("merges commits with the same key inside the window", () => {
		let history = startHistory("a");

		history = commit(history, "b", "drag", 0);
		history = commit(history, "c", "drag", 100);
		expect(history.past).toEqual(["a"]);
		expect(undo(history).present).toBe("a");
	});

	it("does not merge once the window passes", () => {
		let history = startHistory("a");

		history = commit(history, "b", "type", 0);
		history = commit(history, "c", "type", 5000);
		expect(history.past).toEqual(["a", "b"]);
	});

	it("drops the redo stack on a new edit", () => {
		let history = commit(startHistory("a"), "b", null, 0);

		history = undo(history);
		history = commit(history, "x", null, 1);
		expect(history.future).toEqual([]);
		expect(redo(history).present).toBe("x");
	});

	it("is a no-op at either end", () => {
		const history = startHistory("a");

		expect(undo(history)).toBe(history);
		expect(redo(history)).toBe(history);
	});
});
