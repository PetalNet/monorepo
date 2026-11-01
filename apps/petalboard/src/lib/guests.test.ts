import { describe, expect, it } from "vitest";

import { partyLabel } from "./guests";

describe("partyLabel", () => {
	it("lists named people", () => {
		expect(partyLabel(2, ["Sam"])).toBe("Sam");
		expect(partyLabel(3, ["Sam", "Alex"])).toBe("Sam and Alex");
		expect(partyLabel(4, ["Sam", "Alex", "Jo"])).toBe("Sam, Alex and Jo");
	});

	it("counts the unnamed slots of an RSVP from before names", () => {
		expect(partyLabel(3, [])).toBe("2 more");
		expect(partyLabel(3, ["Sam"])).toBe("Sam and 1 more");
	});

	it("does not add unnamed slots when names fill the party", () => {
		expect(partyLabel(1, ["Sam"])).toBe("Sam");
	});
});
