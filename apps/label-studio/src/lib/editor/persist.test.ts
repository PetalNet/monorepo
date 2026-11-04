import { describe, expect, it } from "vitest";

import { emptyDoc } from "./model";
import { loadSession, parseSession, resolveVars, saveSession } from "./persist";

function memory(): Storage {
	const map = new Map<string, string>();

	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
		removeItem: (key) => {
			map.delete(key);
		},
		clear: () => {
			map.clear();
		},
		key: () => null,
		get length() {
			return map.size;
		},
	};
}

describe("session persistence", () => {
	it("round-trips a session through storage", () => {
		const storage = memory();
		const session = { doc: emptyDoc(9), template: null, vars: { name: "x" }, tapePinned: true };

		saveSession(storage, session);
		expect(loadSession(storage)).toEqual(session);
	});

	it("rejects garbage and wrong versions", () => {
		expect(parseSession("{")).toBeNull();
		expect(parseSession(JSON.stringify({ doc: { ...emptyDoc(), version: 2 } }))).toBeNull();
		expect(parseSession(JSON.stringify({ doc: { ...emptyDoc(), tapeMm: 7 } }))).toBeNull();
		expect(parseSession(null)).toBeNull();
	});

	it("drops non-string vars", () => {
		const raw = JSON.stringify({ doc: emptyDoc(), vars: { a: "1", b: 2 } });

		expect(parseSession(raw)?.vars).toEqual({ a: "1" });
	});
});

describe("resolveVars", () => {
	it("layers values over field defaults", () => {
		const fields = [
			{ key: "a", label: "A", kind: "text" as const, default: "one" },
			{ key: "b", label: "B", kind: "text" as const, default: "two" },
		];

		expect(resolveVars(fields, { b: "mine" })).toEqual({ a: "one", b: "mine" });
	});
});
