// PreToolUse guard for the Agent tool: Janet's main thread gives a worker the goal, what proves it done and hard
// constraints, not a step-by-step plan; the worker plans. Denies a prompt that holds an ordered procedure:
//   - a run of 3+ consecutively numbered lines (1. / 1) / (1) / Step 1) whose items mostly open with an imperative verb, or
//   - 3+ sentence- or line-initial sequencers (first, second, third, then, next, after that, finally, lastly).
// Passes: bullets, numbered facts/questions/deliverables (items that do not open with a verb, or open with a
// constraint word like Never/Do not/Only), and subagent_type planner. Subagents (agent_id present) are exempt:
// the hook runs for them too, and only the main thread must not plan for workers. Fails open on bad input.
//
// One file with no dependencies, so Node runs it straight from the source tree: `node agent-brief-guard.ts < payload.json`.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERBS = new Set(
	`add apply approve ask audit back bake bring build bump call capture check clone collect commit compare configure confirm
copy create define delete deploy design diff disable document draft drive enable ensure evaluate export extract fetch find fix get grep
identify implement import inspect install investigate land launch list load log look make measure merge migrate mint move open parse pick
pin plan post prepare prove pull push query read rebase record register remove rename replace report reproduce research restart retry review
rewrite run save scan schedule search send set ship show spawn split start stop store summarize switch tag tell test trace transcribe
trigger try update use verify wait wire write if before after once immediately also now`.split(
		/\s+/u,
	),
);
const CONSTRAINT = /^(never|do not|don't|dont|no|only|must|always|keep|avoid|without|leave)\b/iu;
const SEQ =
	/(?:^|[.;:!?]\s+|\n)\s*(?:[-*>]\s+|\d+[.)]\s+)?(?:first|second|third|then|next|after that|finally|lastly)(?=[,:]|\s+(?!opinion|principles?\b))/giu;
const NUM = /^\s*(?:(\d+)[.)]|\((\d+)\)|step\s+(\d+)\s*[:.)-]?)\s+(.*)$/iu;
// A numbered list under one of these lead-ins states criteria or facts, not a procedure.
const CRITERIA =
	/^\W*(constraints?|hard constraints|done when|done means|deliverables?|return|returns|facts|context|requirements?|acceptance|questions?|must|rules|findings)\b[^.]*:\s*$/iu;
const FIX =
	"Give the goal, what proves it done, and hard constraints; let the worker plan. If it needs a plan, spawn subagent_type planner first.";

const LEADING_MARKUP = /^[\s*_`>"'(]+/u;
const firstWord = (item: string) =>
	/^[A-Za-z']+(?:\s+not)?/u.exec(item.replace(LEADING_MARKUP, ""))?.[0].toLowerCase() ?? "";
// Conditional and sequencing openers (if/before/after/once) start a step too; facts and deliverables do not.
const isStep = (item: string) =>
	VERBS.has(firstWord(item)) && !CONSTRAINT.test(item.replace(LEADING_MARKUP, ""));

// Longest-run scan: the length of the longest consecutively numbered run (1, 2, 3, ...) whose items mostly are imperative.
function numberedSteps(text: string) {
	let best = 0;
	let expect = 1;
	let items: string[] = [];
	let lead = "";
	let exempt = false;
	const flush = () => {
		const steps = items.filter(isStep).length;

		if (!exempt && items.length >= 3 && steps >= Math.ceil(items.length / 2)) {
			best = Math.max(best, items.length);
		}

		items = [];
		expect = 1;
	};

	for (const line of text.split(/\r?\n/u)) {
		const match = NUM.exec(line);

		if (match) {
			const n = Number(match[1] ?? match[2] ?? match[3]);

			if (n === 1) {
				flush();
				exempt = CRITERIA.test(lead);
			}

			if (n === expect) {
				items.push(match[4] ?? "");
				expect += 1;
			}

			continue;
		}

		if (/^\s*$/u.test(line)) {
			continue;
		}

		if (/^\s{2,}\S/u.test(line) && items.length > 0) {
			continue; // wrapped continuation of the current item
		}

		flush();
		lead = line;
	}

	flush();

	return best;
}

interface HookInput {
	readonly tool_name?: unknown;
	readonly agent_id?: unknown;
	readonly tool_input?: { readonly prompt?: unknown; readonly subagent_type?: unknown };
}

/** Why a brief is denied, or `null` when it may pass. */
export function verdict(input: HookInput | null): string | null {
	if (!["Agent", "Task"].includes(String(input?.tool_name)) || input?.agent_id) {
		return null;
	}

	const tool = input?.tool_input ?? {};

	if (["planner", "Plan"].includes(String(tool.subagent_type)) || typeof tool.prompt !== "string") {
		return null;
	}

	const prompt = tool.prompt.replace(/```[\s\S]*?```/gu, ""); // code and log excerpts are not instructions
	const steps = numberedSteps(prompt);
	const sequencers = (prompt.match(SEQ) ?? []).length;

	if (steps >= 3) {
		return `${String(steps)} numbered steps`;
	}

	if (sequencers >= 3) {
		return `${String(sequencers)} first/then/next/finally steps`;
	}

	return null;
}

function denial(why: string) {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `BLOCKED: this Agent brief contains an ordered procedure (${why}). Janet's main thread does not plan for workers. Fix: ${FIX}`,
		},
	};
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	let input: HookInput | null;

	try {
		input = JSON.parse(readFileSync(0, "utf8")) as HookInput | null;
	} catch {
		process.exit(0);
	}

	const why = verdict(input);

	if (why !== null) {
		process.stdout.write(JSON.stringify(denial(why)));
	}

	process.exit(0);
}
