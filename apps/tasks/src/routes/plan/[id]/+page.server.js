import {
	addComment,
	answerQuestion,
	canWrite,
	deepScrub,
	getTask,
	listComments,
	planQuestions,
} from "$lib/server/db.js";
import { renderPlanMd, renderMd } from "$lib/server/md.js";
import { error, fail } from "@sveltejs/kit";

const gate = (id, me) => {
	if (!canWrite(id, me)) throw error(403, "Not allowed");
};

// Keep the plan's answer controls on the same {value,label} contract as task detail.
// Bad legacy JSON must not make the page (or action) trust an arbitrary shape.
function normalizeOptions(raw) {
	let parsed = [];
	try {
		parsed = JSON.parse(raw || "[]");
	} catch {}
	if (!Array.isArray(parsed)) return [];
	return parsed
		.filter((o) => o != null)
		.map((o) =>
			o && typeof o === "object"
				? { value: o.value ?? o.label ?? "", label: o.label ?? o.value ?? "" }
				: { value: String(o), label: String(o) },
		)
		.filter((o) => o.value !== "");
}

export function load({ params, locals }) {
	const id = Number(params.id);
	const plan = getTask(id);
	if (!plan || plan.kind !== "doc") throw error(404, "No such plan");
	if (plan.visibility === "private" && plan.owner && plan.owner !== locals.user)
		throw error(404, "No such plan");
	const questions = planQuestions(id, locals.user);
	return deepScrub({
		plan,
		bodyHtml: renderPlanMd(plan.body),
		decisions: questions
			.filter((item) => item.answer)
			.map((item) => ({ ...item, rationaleHtml: renderMd(item.body) })),
		questions: questions
			.filter((item) => !item.answer)
			.map((item) => {
				return {
					...item,
					options: normalizeOptions(item.options),
					contextHtml: renderMd(item.body),
				};
			}),
		comments: listComments(id),
		canWrite: canWrite(id, locals.user),
	});
}

export const actions = {
	answer: async ({ request, params, locals }) => {
		const id = Number(params.id);
		gate(id, locals.user);
		const f = await request.formData();
		const questionId = Number(f.get("question_id"));
		const question = planQuestions(id, locals.user).find((item) => item.id === questionId);
		if (!question) throw error(400, "Question is not in this plan");
		if (question.answer || ["done", "dropped"].includes(question.status))
			throw error(400, "Question is no longer active");
		const value = String(f.get("value") || "");
		const options = normalizeOptions(question.options);
		if (options.length && !options.some((option) => option.value === value)) {
			throw error(400, "Answer must be one of the configured options");
		}
		const result = answerQuestion(questionId, value);
		if (result?.ok === false) return fail(400, result);
		return { ok: true };
	},
	comment: async ({ request, params, locals }) => {
		const id = Number(params.id);
		gate(id, locals.user);
		const body = String((await request.formData()).get("body") || "").trim();
		if (body) addComment(id, locals.user || "web", body);
		return { ok: true };
	},
};
