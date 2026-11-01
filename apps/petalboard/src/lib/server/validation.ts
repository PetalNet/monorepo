import { MAX_PLUS_ONE_NAME_LENGTH, MAX_PLUS_ONES } from "$lib/guests";
import { z } from "zod";

const optionalText = (schema: z.ZodString) =>
	z
		.string()
		.transform((value) => value.trim())
		.transform((value) => (value.length === 0 ? undefined : value))
		.pipe(schema.optional());

export const eventSchema = z.object({
	title: z.string().trim().min(3, "Title must be at least 3 characters"),
	date: z
		.string()
		.trim()
		.refine((value) => !Number.isNaN(Date.parse(value)), {
			message: "Enter a valid date",
		}),
	endDate: optionalText(
		z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
			message: "Enter a valid end date",
		}),
	),
	rsvpLimit: z
		.string()
		.optional()
		.transform((value) => {
			if (!value || value.trim() === "" || value.trim() === "0") {
				return undefined;
			}

			const num = Number.parseInt(value.trim(), 10);

			return Number.isNaN(num) ? undefined : num;
		})
		.refine((value) => value === undefined || (value > 0 && value <= 10000), {
			message: "Must be between 1 and 10000",
		}),
	maxPlusOnes: z
		.string()
		.optional()
		.transform((value) => {
			if (!value || value.trim() === "") {
				return null;
			}

			return Number(value.trim());
		})
		.refine(
			(value) =>
				value === null || (Number.isInteger(value) && value >= 0 && value <= MAX_PLUS_ONES),
			{
				message: `Must be between 0 and ${MAX_PLUS_ONES}`,
			},
		),
	location: optionalText(z.string().max(120)),
	description: optionalText(z.string().max(5000)),
	timezone: z.string().min(1, "Timezone is required"),
	primaryColor: optionalText(z.string().regex(/^[a-z]+$/, "Invalid color name")),
	secondaryColor: optionalText(z.string().regex(/^[a-z]+$/, "Invalid color name")),
	backgroundImage: optionalText(z.string().url("Invalid URL")),
	emoji: optionalText(z.string().max(10)),
});

export const questionSchema = z.object({
	type: z.enum(["text", "multiple_choice", "checkbox", "slots", "spotify_playlist", "potluck"]),
	label: z.string().trim().min(2, "Question text is required"),
	description: optionalText(z.string().max(2000)),
	required: z
		.string()
		.optional()
		.transform((value) => value === "on" || value === "true"),
	options: z
		.string()
		.optional()
		.transform((value) => {
			if (!value || value.trim() === "") {
				return undefined;
			}

			try {
				const parsed = JSON.parse(value);

				return Array.isArray(parsed) ? JSON.stringify(parsed) : undefined;
			} catch {
				// Try parsing as newline-separated text
				const items = value
					.split("\n")
					.map((s) => s.trim())
					.filter((s) => s.length > 0);

				return items.length > 0 ? JSON.stringify(items) : undefined;
			}
		}),
	quantity: z
		.string()
		.optional()
		.transform((value) => {
			if (!value || value.trim() === "" || value.trim() === "0") {
				return undefined;
			}

			const num = Number.parseInt(value.trim(), 10);

			return Number.isNaN(num) ? undefined : num;
		})
		.refine((value) => value === undefined || (value > 0 && value <= 1000), {
			message: "Open slots must be between 1 and 1000",
		}),
	isPublic: z
		.string()
		.optional()
		.transform((value) => value === "on" || value === "true"),
});

const guestEmail = z.string().trim().toLowerCase().email("Enter a valid email").max(254);

export const editLinkSchema = z.object({ email: guestEmail });

export const rsvpSchema = z.object({
	name: z
		.string()
		.trim()
		.min(2, "Name is required")
		.max(100, "Name must be 100 characters or fewer"),
	email: guestEmail,
	status: z.enum(["attending", "maybe", "not_attending"]).default("attending"),
	// The people the guest is bringing; the headcount is these plus the guest.
	guestNames: z
		.array(
			z
				.string()
				.trim()
				.min(1, "Give each person you add a name, or remove them")
				.max(
					MAX_PLUS_ONE_NAME_LENGTH,
					`Names must be ${MAX_PLUS_ONE_NAME_LENGTH} characters or fewer`,
				),
		)
		.max(MAX_PLUS_ONES, `You can add up to ${MAX_PLUS_ONES} people`)
		.default([]),
	responses: z.record(z.string(), z.string()).optional().default({}),
});

export const registerSchema = z.object({
	email: z.string().trim().email("Enter a valid email").max(160),
	password: z.string().min(8, "Password must be at least 8 characters").max(100),
	name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
});

export const loginSchema = z.object({
	email: z.string().trim().email("Enter a valid email"),
	password: z.string().min(1, "Password is required"),
});
