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
	showNames: boolean,
): PotluckView {
	const config = parsePotluckConfig(rawConfig);
	const taken = responses.flatMap((r) => {
		if (r.rsvp.status === "not_attending") {
			return [];
		}

		const answer = parsePotluckAnswer(r.value);

		return answer ? [{ ...answer, name: showNames ? r.rsvp.name : null }] : [];
	});

	return { config, counts: countByCategory(taken), taken };
}

/**
 * Checks every potluck answer in a submission against the ratio rule. Call it inside the
 * prisma.$transaction that writes the RSVP: Prisma opens SQLite interactive transactions with BEGIN
 * IMMEDIATE, so concurrent signups queue on the write lock and each one counts committed dishes
 * only.
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
