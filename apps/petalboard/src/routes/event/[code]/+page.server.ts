/* oxlint-disable eslint/no-await-in-loop -- Playlist sync runs one question at a time against the same Spotify session. */
import {
	BUSY_MESSAGE,
	checkPotluckAnswers,
	isBusyTransaction,
	oneSignupAtATime,
	potluckView,
} from "$lib/server/potluck";
import { prisma } from "$lib/server/prisma";
import { clientIp, IP_LIMIT, isLimited } from "$lib/server/rateLimit";
import {
	clearRsvpCookie,
	createSession,
	inBackground,
	readSession,
	sendEditLink,
	setRsvpCookie,
} from "$lib/server/rsvpAccess";
import {
	refreshAccessToken,
	createPlaylist,
	replacePlaylistTracks,
	getSpotifyProfile,
} from "$lib/server/spotify";
import type { SpotifyTrack } from "$lib/server/spotify";
import { editLinkSchema, rsvpSchema } from "$lib/server/validation";
import { error, fail, type Cookies } from "@sveltejs/kit";

export const load = async ({ params, locals, cookies }) => {
	const event = await prisma.event.findUnique({
		where: { publicCode: params.code },
		select: {
			id: true,
			userId: true,
			title: true,
			description: true,
			date: true,
			endDate: true,
			timezone: true,
			location: true,
			publicCode: true,
			rsvpLimit: true,
			theme: true,
			primaryColor: true,
			secondaryColor: true,
			backgroundImage: true,
			emoji: true,
			questions: {
				orderBy: { order: "asc" },
				select: {
					id: true,
					label: true,
					description: true,
					type: true,
					options: true,
					quantity: true,
					required: true,
					isPublic: true,
					spotifyPlaylistId: true,
					songsPerUser: true,
					potluckConfig: true,
					responses: {
						select: {
							id: true,
							value: true,
							rsvp: {
								select: {
									name: true,
									status: true,
								},
							},
						},
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
					createdAt: true,
					responses: {
						select: {
							id: true,
							value: true,
							question: { select: { id: true, label: true, type: true } },
						},
					},
				},
			},
		},
	});

	if (!event) {
		throw error(404, "Event not found");
	}

	// Check if current user is the event owner
	const isOwner = locals.user?.id === event.userId;

	const myRsvpId = await readSession(cookies, event.id);
	const mine = myRsvpId ? event.rsvps.find((rsvp) => rsvp.id === myRsvpId) : undefined;
	const rsvpCount = event.rsvps.length;
	const totalGuests = event.rsvps.reduce((sum, r) => sum + r.guestCount, 0);

	return {
		event: {
			id: event.id,
			title: event.title,
			description: event.description,
			date: event.date,
			endDate: event.endDate,
			timezone: event.timezone,
			location: event.location,
			publicCode: event.publicCode,
			rsvpLimit: event.rsvpLimit,
			rsvpCount,
			totalGuests,
			theme: event.theme,
			primaryColor: event.primaryColor,
			secondaryColor: event.secondaryColor,
			backgroundImage: event.backgroundImage,
			emoji: event.emoji,
			questions: event.questions.map((question) => ({
				id: question.id,
				label: question.label,
				description: question.description,
				type: question.type,
				options: question.options ? JSON.parse(question.options) : null,
				quantity: question.quantity,
				required: question.required,
				isPublic: question.isPublic,
				spotifyPlaylistId: question.spotifyPlaylistId,
				songsPerUser: question.songsPerUser,
				responseCount: question.responses.length,
				potluck: question.potluckConfig
					? potluckView(question.potluckConfig, question.responses, question.isPublic)
					: null,
				publicResponses:
					question.isPublic && question.type !== "potluck"
						? question.responses.map((r) => ({
								name: r.rsvp.name,
								value: r.value,
								status: r.rsvp.status,
							}))
						: [],
			})),
		},
		isOwner,
		myRsvp: mine
			? {
					id: mine.id,
					name: mine.name,
					email: mine.email,
					status: mine.status,
					guestCount: mine.guestCount,
					responses: Object.fromEntries(mine.responses.map((r) => [r.question.id, r.value])),
				}
			: null,
		rsvps: event.rsvps.map((rsvp) => ({
			id: rsvp.id,
			name: rsvp.name,
			email: isOwner ? rsvp.email : null, // Only show email to owner
			status: rsvp.status,
			guestCount: rsvp.guestCount,
			createdAt: rsvp.createdAt,
			responses: rsvp.responses.map((r) => ({
				questionId: r.question.id,
				questionLabel: r.question.label,
				questionType: r.question.type,
				answer: r.value,
			})),
		})),
	} as const;
};

function parseSpotifySelection(raw: string | null | undefined): SpotifyTrack[] {
	if (!raw) {
		return [];
	}

	try {
		const parsed = JSON.parse(raw);

		if (Array.isArray(parsed)) {
			return parsed.filter(
				(item): item is SpotifyTrack =>
					typeof item === "object" && item !== null && typeof item.uri === "string",
			);
		}

		if (typeof parsed === "object" && parsed !== null && "uri" in parsed) {
			return [parsed as SpotifyTrack];
		}
	} catch (cause) {
		console.warn("Failed to parse Spotify response value", cause);
	}

	return [];
}

async function getSpotifyAccessTokenForUser(userId: string) {
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: {
			spotifyAccessToken: true,
			spotifyRefreshToken: true,
			spotifyTokenExpiry: true,
		},
	});

	if (!user?.spotifyAccessToken || !user.spotifyRefreshToken) {
		return null;
	}

	let accessToken = user.spotifyAccessToken;
	let refreshToken = user.spotifyRefreshToken;

	if (user.spotifyTokenExpiry && new Date() >= user.spotifyTokenExpiry) {
		try {
			const refreshed = await refreshAccessToken(user.spotifyRefreshToken);

			accessToken = refreshed.access_token;
			refreshToken = refreshed.refresh_token ?? refreshToken;

			await prisma.user.update({
				where: { id: userId },
				data: {
					spotifyAccessToken: accessToken,
					spotifyRefreshToken: refreshToken,
					spotifyTokenExpiry: new Date(Date.now() + refreshed.expires_in * 1000),
				},
			});
		} catch (cause) {
			console.error("Failed to refresh Spotify access token", cause);

			return null;
		}
	}

	return { accessToken, refreshToken };
}

async function syncSpotifyPlaylists(eventId: string) {
	const event = await prisma.event.findUnique({
		where: { id: eventId },
		select: {
			title: true,
			user: { select: { id: true, name: true } },
			questions: {
				where: { type: "spotify_playlist" },
				select: {
					id: true,
					label: true,
					spotifyPlaylistId: true,
					responses: {
						orderBy: { createdAt: "asc" },
						select: { value: true, createdAt: true },
					},
				},
			},
		},
	});

	if (!event || event.questions.length === 0) {
		return;
	}

	const spotifyAuth = await getSpotifyAccessTokenForUser(event.user.id);

	if (!spotifyAuth) {
		return;
	}

	let spotifyUserId: string | null = null;

	for (const question of event.questions) {
		try {
			const collected = question.responses.flatMap((response) => {
				const tracks = parseSpotifySelection(response.value);
				const baseTime = new Date(response.createdAt).getTime();

				return tracks.map((track, index) => ({
					uri: track.uri,
					order: baseTime + index / 10,
				}));
			});

			collected.sort((a, b) => a.order - b.order);

			const seen = new Set<string>();
			const desiredUris: string[] = [];

			for (const item of collected) {
				if (!item.uri || seen.has(item.uri)) {
					continue;
				}

				seen.add(item.uri);
				desiredUris.push(item.uri);
			}

			if (!question.spotifyPlaylistId) {
				if (desiredUris.length === 0) {
					continue;
				}

				if (!spotifyUserId) {
					const profile = await getSpotifyProfile(spotifyAuth.accessToken);

					spotifyUserId = profile.id;
				}

				if (spotifyUserId) {
					const playlist = await createPlaylist(
						spotifyUserId,
						`${event.title} - ${question.label}`,
						"Automatically collected tracks from PetalBoard RSVP responses.",
						spotifyAuth.accessToken,
					);

					await prisma.question.update({
						where: { id: question.id },
						data: { spotifyPlaylistId: playlist.id },
					});

					question.spotifyPlaylistId = playlist.id;
				}
			}

			if (question.spotifyPlaylistId) {
				await replacePlaylistTracks(
					question.spotifyPlaylistId,
					desiredUris,
					spotifyAuth.accessToken,
				);
			}
		} catch (cause) {
			console.error(`Failed to sync Spotify playlist for question ${question.id}`, cause);
		}
	}
}

const ALREADY_REGISTERED = "You're already on the list. We emailed you a link to edit your RSVP.";
const ACCESS_EXPIRED = "Your edit access has expired. Use Edit my RSVP to get a new link.";
const LINK_SENT =
	"If that email is on the list for this event, we've sent it a link to edit the RSVP. The link works for 1 hour.";

type RsvpFormType = "rsvp" | "updateRsvp";

async function findEvent(code: string) {
	const event = await prisma.event.findUnique({
		where: { publicCode: code },
		select: {
			id: true,
			title: true,
			publicCode: true,
			rsvpLimit: true,
			questions: {
				select: {
					id: true,
					label: true,
					required: true,
					type: true,
					quantity: true,
					songsPerUser: true,
					_count: { select: { responses: true } },
				},
			},
		},
	});

	if (!event) {
		throw error(404, "Event not found");
	}

	return event;
}

type RsvpEvent = Awaited<ReturnType<typeof findEvent>>;

function readRsvpForm(formData: FormData) {
	const responses: Record<string, string> = {};
	const values: Record<string, string> = {};

	for (const [key, value] of formData.entries()) {
		if (key.startsWith("response_")) {
			responses[key.replace("response_", "")] = value as string;
		} else {
			values[key] = value as string;
		}
	}

	return { values, responses };
}

interface RsvpInput {
	name: string;
	status: "attending" | "maybe" | "not_attending";
	guestCount: number;
	responses: Record<string, string>;
}

interface ExistingRsvp {
	id: string;
	guestCount: number;
	responses: { questionId: string }[];
}

// A new RSVP carries the email it was made with; an existing one keeps its email, the guest's identity.
type SaveTarget = { existing: ExistingRsvp } | { email: string };

function answered(responses: Record<string, string>) {
	return Object.entries(responses)
		.filter(([, value]) => value && value.trim() !== "")
		.map(([questionId, value]) => ({ questionId, value }));
}

// Returns the saved RSVP's id, or the failure to show on `type`'s form.
async function saveRsvp(
	event: RsvpEvent,
	target: SaveTarget,
	input: RsvpInput,
	type: RsvpFormType,
	values: Record<string, string>,
) {
	const { name, status, guestCount, responses } = input;
	const existing = "existing" in target ? target.existing : null;
	const reject = (message: string, httpStatus = 400) =>
		fail(httpStatus, { success: false, type, message, values });
	const hadAnswer = (questionId: string) =>
		existing?.responses.some((r) => r.questionId === questionId) ?? false;

	if (event.rsvpLimit && guestCount > (existing?.guestCount ?? 0)) {
		const totals = await prisma.rsvp.aggregate({
			where: { eventId: event.id, id: existing ? { not: existing.id } : undefined },
			_sum: { guestCount: true },
		});
		const othersTotal = totals._sum.guestCount ?? 0;

		if (othersTotal + guestCount > event.rsvpLimit) {
			return reject(
				guestCount > 1
					? `Sorry, there are only ${event.rsvpLimit - othersTotal} spot(s) left, but you requested ${guestCount}.`
					: "Sorry, this event has reached its RSVP limit.",
			);
		}
	}

	// Checked before required questions, so a full required question reports as full.
	for (const question of event.questions) {
		if (
			responses[question.id] &&
			question.quantity &&
			!hadAnswer(question.id) &&
			question._count.responses >= question.quantity
		) {
			return reject(`Sorry, "${question.label}" is full (all ${question.quantity} slots taken).`);
		}
	}

	for (const question of event.questions) {
		if (question.type !== "spotify_playlist" || !question.songsPerUser) {
			continue;
		}

		if (parseSpotifySelection(responses[question.id]).length > question.songsPerUser) {
			return reject(
				`You can add at most ${question.songsPerUser} song${
					question.songsPerUser === 1 ? "" : "s"
				} for "${question.label}".`,
			);
		}
	}

	if (status !== "not_attending") {
		const missingRequired = event.questions.some(
			(q) =>
				q.required && !(q.quantity && q._count.responses >= q.quantity) && !responses[q.id]?.trim(),
		);

		if (missingRequired) {
			return reject("Please answer all required questions.");
		}
	}

	const saved = await oneSignupAtATime(event.id, () =>
		prisma.$transaction(async (tx) => {
			const rejection =
				status === "not_attending"
					? null
					: await checkPotluckAnswers(tx, event.id, responses, existing?.id ?? null);

			if (rejection) {
				return { rejection, id: null };
			}

			const rsvp =
				"existing" in target
					? await tx.rsvp.update({
							where: { id: target.existing.id },
							data: {
								name,
								status,
								guestCount,
								responses: { deleteMany: {}, create: answered(responses) },
							},
							select: { id: true },
						})
					: await tx.rsvp.create({
							data: {
								name,
								email: target.email,
								status,
								guestCount,
								eventId: event.id,
								responses: { create: answered(responses) },
							},
							select: { id: true },
						});

			return { rejection: null, id: rsvp.id };
		}),
	).catch((cause: unknown) => {
		if (isBusyTransaction(cause)) {
			return "busy" as const;
		}

		throw cause;
	});

	if (saved === "busy") {
		return reject(BUSY_MESSAGE, 503);
	}

	if (saved.rejection) {
		return fail(409, {
			success: false,
			type,
			message: saved.rejection.message,
			potluck: saved.rejection,
			values,
		});
	}

	await syncSpotifyPlaylists(event.id).catch((cause) => {
		console.error("Spotify sync failed after RSVP save", cause);
	});

	return saved.id;
}

async function guestList(eventId: string) {
	const event = await prisma.event.findUnique({
		where: { id: eventId },
		select: {
			questions: { select: { id: true, _count: { select: { responses: true } } } },
			rsvps: {
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					name: true,
					status: true,
					guestCount: true,
					createdAt: true,
					responses: {
						select: {
							value: true,
							question: { select: { id: true, label: true, type: true } },
						},
					},
				},
			},
		},
	});
	const rsvps = event?.rsvps ?? [];

	return {
		rsvpCount: rsvps.length,
		totalGuests: rsvps.reduce((sum, r) => sum + r.guestCount, 0),
		questionResponseCounts: Object.fromEntries(
			(event?.questions ?? []).map((q) => [q.id, q._count.responses]),
		),
		rsvps: rsvps.map((r) => ({
			id: r.id,
			name: r.name,
			email: null,
			status: r.status,
			guestCount: r.guestCount,
			createdAt: r.createdAt,
			responses: r.responses.map((resp) => ({
				questionId: resp.question.id,
				questionLabel: resp.question.label,
				questionType: resp.question.type,
				answer: resp.value,
			})),
		})),
	};
}

async function findOwnRsvp(cookies: Cookies, eventId: string) {
	const rsvpId = await readSession(cookies, eventId);

	return rsvpId
		? prisma.rsvp.findUnique({
				where: { id: rsvpId },
				select: { id: true, guestCount: true, responses: { select: { questionId: true } } },
			})
		: null;
}

function isUniqueViolation(cause: unknown) {
	return (cause as { code?: unknown } | null)?.code === "P2002";
}

export const actions = {
	rsvp: async ({ request, params, cookies, getClientAddress }) => {
		const event = await findEvent(params.code);
		const { values, responses } = readRsvpForm(await request.formData());
		const parsed = rsvpSchema.safeParse({ ...values, responses });

		if (!parsed.success) {
			return fail(400, {
				success: false,
				type: "rsvp" as const,
				errors: parsed.error.flatten().fieldErrors,
				values,
			});
		}

		const input = parsed.data;
		const ip = clientIp(request, getClientAddress);
		const alreadyRegistered = (rsvp: { id: string; name: string } | null) => {
			inBackground(() => sendEditLink("already", rsvp, input.email, event, ip));

			return fail(409, {
				success: false,
				type: "rsvp" as const,
				alreadyRegistered: true,
				message: ALREADY_REGISTERED,
			});
		};

		const existing = await prisma.rsvp.findUnique({
			where: { eventId_email: { eventId: event.id, email: input.email } },
			select: {
				id: true,
				name: true,
				guestCount: true,
				responses: { select: { questionId: true } },
			},
		});

		if (existing) {
			if ((await readSession(cookies, event.id)) !== existing.id) {
				return alreadyRegistered(existing);
			}

			const saved = await saveRsvp(event, { existing }, input, "rsvp", values);

			if (typeof saved !== "string") {
				return saved;
			}

			return {
				success: true,
				type: "updateRsvp" as const,
				message: "Your RSVP has been updated!",
				...(await guestList(event.id)),
			};
		}

		const saved = await saveRsvp(event, { email: input.email }, input, "rsvp", values).catch(
			(cause: unknown) => {
				if (isUniqueViolation(cause)) {
					return "taken" as const;
				}

				throw cause;
			},
		);

		if (saved === "taken") {
			return alreadyRegistered(
				await prisma.rsvp.findUnique({
					where: { eventId_email: { eventId: event.id, email: input.email } },
					select: { id: true, name: true },
				}),
			);
		}

		if (typeof saved !== "string") {
			return saved;
		}

		const created = { id: saved, name: input.name };

		setRsvpCookie(cookies, event.publicCode, await createSession(created.id));
		inBackground(() => sendEditLink("confirmation", created, input.email, event, ip));

		return { success: true, type: "rsvp" as const, ...(await guestList(event.id)) };
	},

	requestEditLink: async ({ request, params, getClientAddress }) => {
		const event = await findEvent(params.code);
		const parsed = editLinkSchema.safeParse({
			email: (await request.formData()).get("email") ?? "",
		});

		if (!parsed.success) {
			return fail(400, {
				success: false,
				type: "requestEditLink" as const,
				message: "Enter a valid email",
			});
		}

		const ip = clientIp(request, getClientAddress);

		if (isLimited(`ip:${ip}`, IP_LIMIT.limit, IP_LIMIT.windowMs)) {
			return fail(429, {
				success: false,
				type: "requestEditLink" as const,
				message: "Too many requests, try again in a few minutes",
			});
		}

		const { email } = parsed.data;

		inBackground(async () => {
			const rsvp = await prisma.rsvp.findUnique({
				where: { eventId_email: { eventId: event.id, email } },
				select: { id: true, name: true },
			});

			await sendEditLink("requested", rsvp, email, event, ip);
		});

		return { success: true, type: "requestEditLink" as const, message: LINK_SENT };
	},

	updateRsvp: async ({ request, params, cookies }) => {
		const event = await findEvent(params.code);
		const existing = await findOwnRsvp(cookies, event.id);

		if (!existing) {
			return fail(403, { success: false, type: "updateRsvp" as const, message: ACCESS_EXPIRED });
		}

		const { values, responses } = readRsvpForm(await request.formData());
		const parsed = rsvpSchema.omit({ email: true }).safeParse({ ...values, responses });

		if (!parsed.success) {
			return fail(400, {
				success: false,
				type: "updateRsvp" as const,
				message: Object.values(parsed.error.flatten().fieldErrors).flat()[0] ?? "Check your RSVP.",
			});
		}

		const saved = await saveRsvp(event, { existing }, parsed.data, "updateRsvp", values);

		if (typeof saved !== "string") {
			return saved;
		}

		return {
			success: true,
			type: "updateRsvp" as const,
			message: "Your RSVP has been updated!",
			...(await guestList(event.id)),
		};
	},

	cancelRsvp: async ({ params, cookies }) => {
		const event = await findEvent(params.code);
		const existing = await findOwnRsvp(cookies, event.id);

		if (!existing) {
			return fail(403, { success: false, type: "cancelRsvp" as const, message: ACCESS_EXPIRED });
		}

		await prisma.rsvp.delete({ where: { id: existing.id } });
		clearRsvpCookie(cookies, event.publicCode);

		await syncSpotifyPlaylists(event.id).catch((cause) => {
			console.error("Spotify sync failed after RSVP cancellation", cause);
		});

		return {
			success: true,
			type: "cancelRsvp" as const,
			message: "Your RSVP has been cancelled.",
			...(await guestList(event.id)),
		};
	},
};
