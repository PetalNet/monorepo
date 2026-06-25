import { prisma } from "$lib/server/prisma";
import { eventSchema, questionSchema } from "$lib/server/validation";
import { parseLocalDateTimeInTimezone } from "$lib/utils/timezones";
import { fail, error, redirect } from "@sveltejs/kit";
import { z } from "zod";

const questionUpdateSchema = questionSchema.extend({
	questionId: z.string().cuid(),
});
const questionTargetSchema = z.object({ questionId: z.string().cuid() });

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
			location: true,
			rsvpLimit: true,
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
					order: true,
					_count: { select: { responses: true } },
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
	if (!locals.user || locals.user.id !== event.userId) {
		throw error(403, "You don't have permission to manage this event");
	}

	// Check if user has Spotify connected
	const user = await prisma.user.findUnique({
		where: { id: locals.user.id },
		select: { spotifyAccessToken: true },
	});

	return {
		hasSpotifyConnected: !!user?.spotifyAccessToken,
		event: {
			id: event.id,
			title: event.title,
			description: event.description,
			date: event.date,
			endDate: event.endDate,
			location: event.location,
			rsvpLimit: event.rsvpLimit,
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
			})),
		},
		rsvps: event.rsvps.map((rsvp) => ({
			id: rsvp.id,
			name: rsvp.name,
			email: rsvp.email,
			status: rsvp.status,
			guestCount: rsvp.guestCount,
			createdAt: rsvp.createdAt,
			responses: rsvp.responses.map(
				(r: { questionId: string; value: string; question: { label: string; type: string } }) => ({
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

		const { title, date, endDate, timezone, location, description, rsvpLimit } = parsed.data;

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

		// Extract Spotify-specific fields
		const spotifyPlaylistId = raw.spotifyPlaylistId || null;
		const songsPerUser = (() => {
			if (!raw.songsPerUser) return null;
			const parsedCount = Number.parseInt(raw.songsPerUser, 10);
			return Number.isNaN(parsedCount) || parsedCount <= 0 ? null : parsedCount;
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
			if (!raw.songsPerUser) return null;
			const parsedCount = Number.parseInt(raw.songsPerUser, 10);
			return Number.isNaN(parsedCount) || parsedCount <= 0 ? null : parsedCount;
		})();

		const question = await prisma.question.findFirst({
			where: { id: questionId, eventId },
		});
		if (!question) {
			return fail(404, {
				success: false,
				message: "Question not found.",
				type: "updateQuestion",
			});
		}

		await prisma.question.update({
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
				isPublic: isPublic ?? false,
			},
		});

		return { success: true, type: "updateQuestion" } as const;
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
