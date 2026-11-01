import { keepOverrides, parsePotluckConfig, potluckConfigSchema } from "$lib/potluck";
import { potluckView } from "$lib/server/potluck";
import { prisma } from "$lib/server/prisma";
import { eventSchema, questionSchema } from "$lib/server/validation";
import { parseLocalDateTimeInTimezone } from "$lib/utils/timezones";
import { fail, error, redirect } from "@sveltejs/kit";
import { z } from "zod";

const questionUpdateSchema = questionSchema.extend({
	questionId: z.string().cuid(),
});
const questionTargetSchema = z.object({ questionId: z.string().cuid() });
const potluckOverrideSchema = z.object({
	questionId: z.string().cuid(),
	categoryId: z.string().min(1),
	forceOpen: z.enum(["true", "false"]).transform((v) => v === "true"),
});

function parsePotluckField(type: string, raw: string | undefined, previous: string | null = null) {
	if (type !== "potluck") {
		return { ok: true, value: null } as const;
	}

	let json: unknown;

	try {
		json = JSON.parse(raw ?? "");
	} catch {
		return { ok: false, errors: { potluckConfig: ["Add the dish categories"] } } as const;
	}

	const parsed = potluckConfigSchema.safeParse(json);

	if (!parsed.success) {
		return {
			ok: false,
			errors: { potluckConfig: parsed.error.issues.map((i) => i.message) },
		} as const;
	}

	const stored = previous ? parsePotluckConfig(previous) : null;

	return { ok: true, value: JSON.stringify(keepOverrides(stored, parsed.data)) } as const;
}

async function getEventId(token: string) {
	const event = await prisma.event.findUnique({
		where: { manageToken: token },
		select: { id: true },
	});

	if (!event) {
		throw error(404, "Event not found");
	}

	return event.id;
}

export const load = async ({ params, locals }) => {
	const event = await prisma.event.findUnique({
		where: { manageToken: params.token },
		select: {
			id: true,
			userId: true,
			title: true,
			description: true,
			date: true,
			endDate: true,
			timezone: true,
			location: true,
			rsvpLimit: true,
			maxPlusOnes: true,
			publicCode: true,
			theme: true,
			primaryColor: true,
			secondaryColor: true,
			backgroundImage: true,
			emoji: true,
			questions: {
				orderBy: { order: "asc" },
				select: {
					id: true,
					type: true,
					label: true,
					description: true,
					required: true,
					options: true,
					quantity: true,
					isPublic: true,
					spotifyPlaylistId: true,
					songsPerUser: true,
					potluckConfig: true,
					order: true,
					_count: { select: { responses: true } },
					responses: {
						where: { question: { type: "potluck" } },
						select: { value: true, rsvp: { select: { name: true, status: true } } },
					},
				},
			},
			rsvps: {
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					name: true,
					email: true,
					status: true,
					guestCount: true,
					guests: { orderBy: { position: "asc" }, select: { name: true } },
					createdAt: true,
					responses: {
						select: {
							questionId: true,
							value: true,
							question: { select: { label: true, type: true } },
						},
					},
				},
			},
		},
	});

	if (!event) {
		throw error(404, "Event not found");
	}

	// Verify the user owns this event
	if (locals.user?.id !== event.userId) {
		throw error(403, "You don't have permission to manage this event");
	}

	// Check if user has Spotify connected
	const user = await prisma.user.findUnique({
		where: { id: locals.user.id },
		select: { spotifyAccessToken: true },
	});

	return {
		hasSpotifyConnected: Boolean(user?.spotifyAccessToken),
		event: {
			id: event.id,
			title: event.title,
			description: event.description,
			date: event.date,
			endDate: event.endDate,
			timezone: event.timezone,
			location: event.location,
			rsvpLimit: event.rsvpLimit,
			maxPlusOnes: event.maxPlusOnes,
			publicCode: event.publicCode,
			theme: event.theme,
			primaryColor: event.primaryColor,
			secondaryColor: event.secondaryColor,
			backgroundImage: event.backgroundImage,
			emoji: event.emoji,
			questions: event.questions.map((question) => ({
				id: question.id,
				type: question.type,
				label: question.label,
				description: question.description,
				required: question.required,
				options: question.options ? JSON.parse(question.options) : null,
				quantity: question.quantity,
				isPublic: question.isPublic,
				order: question.order,
				responseCount: question._count.responses,
				spotifyPlaylistId: question.spotifyPlaylistId ?? null,
				songsPerUser: question.songsPerUser ?? null,
				potluck: question.potluckConfig
					? potluckView(question.potluckConfig, question.responses, true)
					: null,
			})),
		},
		rsvps: event.rsvps.map((rsvp) => ({
			id: rsvp.id,
			name: rsvp.name,
			email: rsvp.email,
			status: rsvp.status,
			guestCount: rsvp.guestCount,
			guestNames: rsvp.guests.map((g) => g.name),
			createdAt: rsvp.createdAt,
			responses: rsvp.responses.map(
				(r: { questionId: string; value: string; question: { label: string; type: string } }) => ({
					questionId: r.questionId,
					questionLabel: r.question.label,
					questionType: r.question.type,
					value: r.value,
				}),
			),
		})),
	} as const;
};

export const actions = {
	updateEvent: async ({ params, request }) => {
		const eventId = await getEventId(params.token);
		const formData = await request.formData();
		const raw = Object.fromEntries(formData) as Record<string, string>;

		console.log("Form data received:", raw);
		console.log("Primary color:", raw.primaryColor);
		console.log("Secondary color:", raw.secondaryColor);

		const parsed = eventSchema.safeParse(raw);

		if (!parsed.success) {
			console.log("Validation errors:", parsed.error.flatten().fieldErrors);

			return fail(400, {
				success: false,
				errors: parsed.error.flatten().fieldErrors,
				values: raw,
				type: "updateEvent",
			});
		}

		console.log("Parsed data:", parsed.data);
		console.log("Parsed primary color:", parsed.data.primaryColor);

		const { title, date, endDate, timezone, location, description, rsvpLimit, maxPlusOnes } =
			parsed.data;

		await prisma.event.update({
			where: { id: eventId },
			data: {
				title,
				date: parseLocalDateTimeInTimezone(date, timezone),
				endDate: endDate ? parseLocalDateTimeInTimezone(endDate, timezone) : null,
				timezone,
				location: location ?? null,
				description: description ?? null,
				rsvpLimit: rsvpLimit ?? null,
				maxPlusOnes: maxPlusOnes ?? null,
				primaryColor: parsed.data.primaryColor ?? null,
				secondaryColor: parsed.data.secondaryColor ?? null,
				backgroundImage: parsed.data.backgroundImage ?? null,
				emoji: parsed.data.emoji ?? null,
			},
		});

		console.log("Event updated successfully");

		return {
			success: true,
			type: "updateEvent",
		} as const;
	},
	addQuestion: async ({ params, request }) => {
		const eventId = await getEventId(params.token);
		const formData = await request.formData();
		const raw = Object.fromEntries(formData) as Record<string, string>;
		const parsed = questionSchema.safeParse(raw);

		if (!parsed.success) {
			return fail(400, {
				success: false,
				errors: parsed.error.flatten().fieldErrors,
				values: raw,
				type: "addQuestion",
			});
		}

		const { type, label, description, required, options, quantity, isPublic } = parsed.data;
		const potluck = parsePotluckField(type, raw.potluckConfig);

		if (!potluck.ok) {
			return fail(400, {
				success: false,
				errors: potluck.errors,
				values: raw,
				type: "addQuestion",
			});
		}

		// Extract Spotify-specific fields
		const spotifyPlaylistId = raw.spotifyPlaylistId || null;
		const songsPerUser = (() => {
			if (!raw.songsPerUser) {
				return null;
			}

			const count = Number.parseInt(raw.songsPerUser, 10);

			return Number.isNaN(count) || count <= 0 ? null : count;
		})();

		// Get the highest order value for this event
		const maxOrder = await prisma.question.findFirst({
			where: { eventId },
			orderBy: { order: "desc" },
			select: { order: true },
		});

		const question = await prisma.question.create({
			data: {
				type,
				label,
				description: description ?? null,
				required: required ?? false,
				options: options ?? null,
				quantity: quantity ?? null,
				isPublic: isPublic ?? false,
				spotifyPlaylistId,
				songsPerUser,
				potluckConfig: potluck.value,
				order: (maxOrder?.order ?? -1) + 1,
				eventId,
			},
			select: {
				id: true,
				type: true,
				label: true,
				description: true,
				required: true,
				options: true,
				quantity: true,
				isPublic: true,
				spotifyPlaylistId: true,
				songsPerUser: true,
				potluckConfig: true,
				order: true,
				_count: { select: { responses: true } },
			},
		});

		return {
			success: true,
			type: "addQuestion",
			question: {
				...question,
				responseCount: question._count.responses,
				potluck: question.potluckConfig ? potluckView(question.potluckConfig, [], true) : null,
			},
		} as const;
	},
	updateQuestion: async ({ params, request }) => {
		const eventId = await getEventId(params.token);
		const formData = await request.formData();
		const raw = Object.fromEntries(formData) as Record<string, string>;
		const parsed = questionUpdateSchema.safeParse(raw);

		if (!parsed.success) {
			return fail(400, {
				success: false,
				errors: parsed.error.flatten().fieldErrors,
				values: raw,
				type: "updateQuestion",
			});
		}

		const { questionId, type, label, description, required, options, quantity, isPublic } =
			parsed.data;

		// Spotify-specific fields from form
		const spotifyPlaylistId = raw.spotifyPlaylistId || null;
		const songsPerUser = (() => {
			if (!raw.songsPerUser) {
				return null;
			}

			const count = Number.parseInt(raw.songsPerUser, 10);

			return Number.isNaN(count) || count <= 0 ? null : count;
		})();

		// Read and write together so a "Force open" from another tab cannot land in between.
		const outcome = await prisma.$transaction(async (tx) => {
			const question = await tx.question.findFirst({
				where: { id: questionId, eventId },
			});

			if (!question) {
				return { kind: "missing" } as const;
			}

			const potluck = parsePotluckField(type, raw.potluckConfig, question.potluckConfig);

			if (!potluck.ok) {
				return { kind: "invalid", errors: potluck.errors } as const;
			}

			await tx.question.update({
				where: { id: questionId },
				data: {
					type,
					label,
					description: description ?? null,
					required: required ?? false,
					options: options ?? null,
					quantity: quantity ?? null,
					spotifyPlaylistId,
					songsPerUser,
					potluckConfig: potluck.value,
					isPublic: isPublic ?? false,
				},
			});

			return { kind: "saved" } as const;
		});

		if (outcome.kind === "missing") {
			return fail(404, {
				success: false,
				message: "Question not found.",
				type: "updateQuestion",
			});
		}

		if (outcome.kind === "invalid") {
			return fail(400, {
				success: false,
				errors: outcome.errors,
				values: raw,
				type: "updateQuestion",
			});
		}

		return { success: true, type: "updateQuestion" } as const;
	},
	setPotluckOverride: async ({ params, request }) => {
		const eventId = await getEventId(params.token);
		const parsed = potluckOverrideSchema.safeParse(Object.fromEntries(await request.formData()));

		if (!parsed.success) {
			return fail(400, { success: false, message: "Invalid request.", type: "setPotluckOverride" });
		}

		const { questionId, categoryId, forceOpen } = parsed.data;
		const updated = await prisma.$transaction(async (tx) => {
			const question = await tx.question.findFirst({
				where: { id: questionId, eventId, type: "potluck" },
				select: { potluckConfig: true },
			});

			if (!question?.potluckConfig) {
				return null;
			}

			const config = parsePotluckConfig(question.potluckConfig);

			if (!config.categories.some((c) => c.id === categoryId)) {
				return null;
			}

			const next = {
				...config,
				categories: config.categories.map((c) => (c.id === categoryId ? { ...c, forceOpen } : c)),
			};

			return tx.question.update({
				where: { id: questionId },
				data: { potluckConfig: JSON.stringify(next) },
				select: {
					potluckConfig: true,
					responses: { select: { value: true, rsvp: { select: { name: true, status: true } } } },
				},
			});
		});

		if (!updated?.potluckConfig) {
			return fail(404, {
				success: false,
				message: "Category not found.",
				type: "setPotluckOverride",
			});
		}

		return {
			success: true,
			type: "setPotluckOverride",
			questionId,
			potluck: potluckView(updated.potluckConfig, updated.responses, true),
		} as const;
	},
	deleteQuestion: async ({ params, request }) => {
		const eventId = await getEventId(params.token);
		const formData = await request.formData();
		const raw = Object.fromEntries(formData) as Record<string, string>;
		const parsed = questionTargetSchema.safeParse(raw);

		if (!parsed.success) {
			return fail(400, {
				success: false,
				message: "Invalid request.",
				type: "deleteQuestion",
			});
		}

		const { questionId } = parsed.data;

		const question = await prisma.question.findFirst({
			where: { id: questionId, eventId },
		});

		if (!question) {
			return fail(404, {
				success: false,
				message: "Question not found.",
				type: "deleteQuestion",
			});
		}

		await prisma.question.delete({ where: { id: questionId } });

		return { success: true, type: "deleteQuestion" } as const;
	},
	deleteRsvp: async ({ params, request }) => {
		const eventId = await getEventId(params.token);
		const formData = await request.formData();
		const raw = Object.fromEntries(formData) as Record<string, string>;
		const parsed = z.object({ rsvpId: z.string().cuid() }).safeParse(raw);

		if (!parsed.success) {
			return fail(400, {
				success: false,
				message: "Invalid request.",
				type: "deleteRsvp",
			});
		}

		const { rsvpId } = parsed.data;

		const rsvp = await prisma.rsvp.findFirst({
			where: { id: rsvpId, eventId },
		});

		if (!rsvp) {
			return fail(404, {
				success: false,
				message: "RSVP not found.",
				type: "deleteRsvp",
			});
		}

		await prisma.rsvp.delete({ where: { id: rsvpId } });

		return { success: true, type: "deleteRsvp" } as const;
	},
	deleteEvent: async ({ params }) => {
		const eventId = await getEventId(params.token);

		// Delete the event (cascading deletes will handle questions and responses)
		await prisma.event.delete({ where: { id: eventId } });

		// Redirect to dashboard
		throw redirect(303, "/dashboard");
	},
};
