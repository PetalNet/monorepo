import {
	countByCategory,
	offeredCategoryIds,
	parsePotluckAnswer,
	parsePotluckConfig,
	type PotluckAnswer,
	type PotluckView,
} from "$lib/potluck";

import type { Prisma } from "./generated/prisma/client";

export interface PotluckRejection {
	questionId: string;
	message: string;
	offered: string[];
}

interface ResponseWithRsvp {
	value: string;
	rsvp: { name: string; status: string };
}

export function potluckView(
	rawConfig: string,
	responses: readonly ResponseWithRsvp[],
	isPublic: boolean,
): PotluckView {
	const config = parsePotluckConfig(rawConfig);
	const taken = responses.flatMap((r) => {
		if (r.rsvp.status === "not_attending") {
			return [];
		}

		const answer = parsePotluckAnswer(r.value);

		return answer ? [{ ...answer, name: r.rsvp.name }] : [];
	});

	// A private question still shows how full each category is, but no dish or name leaves the server.
	return { config, counts: countByCategory(taken), taken: isPublic ? taken : [] };
}

const signupQueues = new Map<string, Promise<void>>();

/**
 * Runs one event's signup transactions one after another. Concurrent SQLite transactions wait on
 * the database lock while Prisma's 5 s transaction timer runs, so under load a burst of signups
 * timed out (seen in CI and on a half-CPU container). Queuing before the transaction starts keeps
 * each one short. PetalBoard runs as one Node process, so an in-process queue covers every writer.
 */
export function oneSignupAtATime<T>(eventId: string, run: () => Promise<T>): Promise<T> {
	const previous = signupQueues.get(eventId) ?? Promise.resolve();
	const result = previous.then(run);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);

	signupQueues.set(eventId, settled);

	void settled.finally(() => {
		if (signupQueues.get(eventId) === settled) {
			signupQueues.delete(eventId);
		}
	});

	return result;
}

/**
 * Checks every potluck answer in a submission against the ratio rule. Call it inside the
 * prisma.$transaction that writes the RSVP, run through oneSignupAtATime, so each signup counts
 * every dish committed before it.
 */
export async function checkPotluckAnswers(
	tx: Prisma.TransactionClient,
	eventId: string,
	submitted: Readonly<Record<string, string>>,
	rsvpId: string | null,
): Promise<PotluckRejection | null> {
	const questions = await tx.question.findMany({
		where: { eventId, type: "potluck" },
		select: { id: true, potluckConfig: true },
	});

	for (const question of questions) {
		const raw = submitted[question.id];

		if (!raw || raw.trim() === "" || !question.potluckConfig) {
			continue;
		}

		const config = parsePotluckConfig(question.potluckConfig);
		const answer = parsePotluckAnswer(raw);
		const category = config.categories.find((c) => c.id === answer?.category);

		if (!answer || !category) {
			return {
				questionId: question.id,
				message: "Pick a category and tell people what you're bringing.",
				offered: offeredCategoryIds(config, {}),
			};
		}

		// oxlint-disable-next-line eslint/no-await-in-loop -- Each question reads inside the same write lock.
		const existing = await tx.response.findMany({
			where: { questionId: question.id, rsvp: { status: { not: "not_attending" } } },
			select: { rsvpId: true, value: true },
		});
		const own = existing.find((r) => r.rsvpId === rsvpId);

		if (own && parsePotluckAnswer(own.value)?.category === answer.category) {
			continue;
		}

		const others = existing
			.filter((r) => r.rsvpId !== rsvpId)
			.map((r) => parsePotluckAnswer(r.value))
			.filter((a): a is PotluckAnswer => a !== null);
		const offered = offeredCategoryIds(config, countByCategory(others));

		if (!offered.includes(answer.category)) {
			const labels = config.categories.filter((c) => offered.includes(c.id)).map((c) => c.label);

			return {
				questionId: question.id,
				message: `${category.label} is full for now. Still needed: ${labels.join(", ")}.`,
				offered,
			};
		}
	}

	return null;
}

/** A signup rush can outlast Prisma's transaction wait; the guest should retry, not see a 500. */
export function isBusyTransaction(cause: unknown): boolean {
	const code = (cause as { code?: unknown } | null)?.code;
	const message = cause instanceof Error ? cause.message : "";

	// P1008 timeout, P2024 pool timeout, P2028 transaction API, P2034 write conflict.
	return (
		(typeof code === "string" && ["P1008", "P2024", "P2028", "P2034"].includes(code)) ||
		/SQLITE_BUSY|database is locked/i.test(message)
	);
}

export const BUSY_MESSAGE =
	"Lots of people are signing up right now. Please try again in a moment.";
