import { describe, expect, it } from "vitest";

import { eventSchema } from "./validation";

const event = {
	title: "Garden party",
	date: "2026-11-26T18:00",
	timezone: "America/Chicago",
	endDate: "",
	location: "",
	description: "",
	primaryColor: "",
	secondaryColor: "",
	backgroundImage: "",
	emoji: "",
};

describe("eventSchema maxPlusOnes", () => {
	it("treats blank and absent caps as null", () => {
		expect(eventSchema.parse(event).maxPlusOnes).toBeNull();
		expect(eventSchema.parse({ ...event, maxPlusOnes: "   " }).maxPlusOnes).toBeNull();
	});

	it("accepts only whole caps from zero through nineteen", () => {
		expect(eventSchema.parse({ ...event, maxPlusOnes: "0" }).maxPlusOnes).toBe(0);
		expect(eventSchema.parse({ ...event, maxPlusOnes: "19" }).maxPlusOnes).toBe(19);

		for (const maxPlusOnes of ["no-limit", "2.5", "2x", "-1", "20"]) {
			expect(eventSchema.safeParse({ ...event, maxPlusOnes }).success).toBe(false);
		}
	});
});
