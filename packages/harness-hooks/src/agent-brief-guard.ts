// PreToolUse guard for the Agent tool: Janet's main thread gives a worker the goal, what proves it done and hard
// constraints, not a step-by-step plan; the worker plans. Denies a prompt that holds an ordered procedure:
//   - a run of 3+ consecutively numbered lines (1. / 1) / (1) / Step 1) whose items mostly open with an imperative verb, or
//   - 3+ sentence- or line-initial sequencers (first, second, third, then, next, after that, finally, lastly).
// Passes: bullets, numbered facts/questions/deliverables (items that do not open with a verb, or open with a
// constraint word like Never/Do not/Only), and subagent_type planner. Subagents (agent_id present) are exempt:
// the hook runs for them too, and only the main thread must not plan for workers. Fails open on bad input.
//
// It also enforces the effect-sveltekit/effect-api default for new web and API surfaces. A brief that builds a new service,
// API, endpoint, server, daemon or web app and does not mention either package is denied when it names a JS/TS stack
// (express, hono, fastify, koa, a bare +server.ts, SvelteKit, TypeScript), and gets an advisory note otherwise, unless it
// is plainly something else (model inference, ML or data work, hooks, CLIs, Flutter, Rust). Naming either package, or
// "not effect-sk because: ...", passes. Read-only subagent types (planner, reviewers, finders) and research briefs are exempt.
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

// A creation verb, a determiner, up to four plain words (no preposition or conjunction), then the thing created:
// "build a small FastAPI service", "stand up the new bridge daemon". "build fails", "build it into the website",
// "create the repo via the GitHub API" and "review the new service" do not match.
const MAKE = String.raw`(?:build|builds|building|create|creates|creating|implement|implementing|stand up|spin up|scaffold|scaffolding|set up|setting up|develop|developing|bootstrap|ship)`;
const DET = String.raw`(?:an?|the|new|another|our|small|tiny|simple|standalone|minimal)`;
const WORDS = String.raw`(?:(?!(?:in|into|on|at|to|from|via|with|for|of|by|against|as|and|or|vs|that|which|it)\b)[\w/+.'“”"-]+ +){0,4}?`;
const MAKE_A = String.raw`\b${MAKE} +${DET} +${WORDS}`;
const NEW_SURFACE = new RegExp(
	String.raw`${MAKE_A}(?:service|api|endpoint|server|daemon|web ?app|web demo|website|microservice|sidecar|connector|bot)s?\b(?! +(?:keys?|tokens?|credentials?|secrets?|calls?|requests?|clients?))`,
	"iu",
);
// A JS/TS server or web stack other than effect-sveltekit: the case that is blocked outright.
const JS_STACK =
	/\b(?:express(?:\.js)?|hono|fastify|koa|nestjs|next\.js|nuxt|elysia|sveltekit|typescript|node(?:\.js)? +(?:http +)?(?:server|service|app|api))\b|\+server\.ts/iu;
// Work that is not a JS web or API surface: model inference, ML and data, hooks, CLIs, mobile, other chosen languages.
const NOT_JS_WEB =
	/\b(?:inference|machine learning|ml|embeddings?|whisper|tts|stt|fine-?tun\w*|pytorch|cuda|hooks?|cli|flutter|android|ios|swift|rust|cargo|haskell|wyoming|home assistant|voice|data[- ]lake|exporters?)\b/iu;
// A brief that investigates, reviews or verifies is not asking for a build, even if it discusses one.
const READ_ONLY_OPENING =
	/\b(?:research|review(?:er)?|audit|investigat\w*|evaluator|verifier|adversarial|diagnos\w*|study|validation only)\b/iu;
const EFFECT_STACK = /effect[- ]?(?:sveltekit|sk|api)\b/iu;
const READ_ONLY_TYPES = new Set([
	"planner",
	"Plan",
	"code-reviewer",
	"Explore",
	"finder",
	"librarian",
	"claude-code-guide",
]);
const EFFECT_FIX =
	'Rewrite the brief to build on packages/effect-sveltekit and packages/effect-api in PetalNet/monorepo (Effect services and layers, typed errors, SvelteKit remote functions), and tell the builder to read both packages plus one app that uses them (apps/grove) first. If it truly cannot be built that way, state why in the brief: "not effect-sk because: ...".';

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

	const prompt = instructions(tool.prompt);
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

// Code and log excerpts are not instructions; markdown emphasis would split "a **/fetch endpoint**" from its verb.
const instructions = (prompt: string) =>
	prompt.replace(/```[\s\S]*?```/gu, "").replace(/[*_`]/gu, "");

/**
 * How a brief relates to the effect-sveltekit/effect-api default: `deny` for a new JS/TS web or API
 * surface on another stack, `nudge` for a new service, API or web app in some other language that
 * does not say why, else `null`.
 */
export function newSurfaceVerdict(input: HookInput | null): "deny" | "nudge" | null {
	if (!["Agent", "Task"].includes(String(input?.tool_name)) || input?.agent_id) {
		return null;
	}

	const tool = input?.tool_input ?? {};

	if (READ_ONLY_TYPES.has(String(tool.subagent_type)) || typeof tool.prompt !== "string") {
		return null;
	}

	const prompt = instructions(tool.prompt);

	if (
		EFFECT_STACK.test(prompt) ||
		READ_ONLY_OPENING.test(prompt.slice(0, 250)) ||
		!NEW_SURFACE.test(prompt)
	) {
		return null;
	}

	if (JS_STACK.test(prompt)) {
		return "deny";
	}

	return NOT_JS_WEB.test(prompt) ? null : "nudge";
}

function effectDenial() {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `BLOCKED: this Agent brief asks for a new JS/TS web app, API or server on a stack other than effect-sveltekit and effect-api. New PetalNet web and API surfaces in JS/TS are built on those packages, not on Express, Hono, Fastify or a bare +server.ts. Fix: ${EFFECT_FIX}`,
		},
	};
}

function effectNudge() {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			additionalContext: `NOTE: this brief builds a new service, API or web app and does not mention effect-sveltekit or effect-api. PetalNet's default for a JS/TS web or API surface is packages/effect-sveltekit and packages/effect-api (see apps/grove); if the work is JS/TS, rewrite the brief to build on them. A different language is fine when there is a reason (model inference, ML or data work, hooks, CLIs, Flutter, Rust): state it in the brief, for example "not effect-sk because: ...".`,
		},
	};
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

	if (why === null) {
		const surface = newSurfaceVerdict(input);

		if (surface === "deny") {
			process.stdout.write(JSON.stringify(effectDenial()));
		} else if (surface === "nudge") {
			process.stdout.write(JSON.stringify(effectNudge()));
		}
	} else {
		process.stdout.write(JSON.stringify(denial(why)));
	}

	process.exit(0);
}
