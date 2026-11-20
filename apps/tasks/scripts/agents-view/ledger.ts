// Adapted from Claude Code agents-view hooks, 291069fa-3ac4-4e01-939f-5d8782460da4.
import { agent, type Agent, type Attempt } from "./model.ts";
import { json, number, short, string, time } from "./safe.ts";

export function applyLedger(agents: Map<string, Agent>, line: string, runs: string): void {
	const e = json(line);

	if (!e || !["launch", "attempt", "outcome", "import", "inject"].includes(string(e.event))) {
		return;
	}

	const runId = string(e.runId);

	if (!runId || e.event === "inject") {
		return;
	}

	const id = `router:${runId}`;
	const run = agents.get(id) ?? agent(id, "router");

	run.imported = e.event === "import" || run.imported;

	if (string(e.briefName)) {
		run.name = short(string(e.briefName).split(/[\\/]/).at(-1) ?? "", 80);
	} else if (run.name === id) {
		run.name = short(`${string(e.kind) || "agent"} ${runId.slice(0, 8)}`, 80);
	}

	for (const field of ["model", "effort", "plan", "kind", "tier", "branch"] as const) {
		if (string(e[field])) {
			run[field] = short(string(e[field]), 1024);
		}
	}

	// Paths stay private to the reader. Every UI path goes through redact too.
	run.cwd = string(e.cwd) || string(e.workdir) || run.cwd;
	run.briefPath = string(e.briefPath) || run.briefPath;

	run.outputPath =
		string(e.outputPath) ||
		run.outputPath ||
		(!run.imported && /^[\w-]+$/.test(runId) ? `${runs}/${runId}.out` : "");

	run.logPath =
		string(e.logPath) ||
		run.logPath ||
		(run.outputPath ? run.outputPath.replace(/\.out$/, ".log") : "");

	run.eventsPath =
		string(e.eventsPath) ||
		run.eventsPath ||
		(run.outputPath ? run.outputPath.replace(/\.out$/, ".events.jsonl") : "");

	const started = time(e.startedAt) || time(e.at);

	if (started && (!run.startedAt || started < run.startedAt)) {
		run.startedAt = started;
	}

	run.updatedAt = time(e.endedAt) || started || run.updatedAt;
	const attemptNum = number(e.attempt);
	const index = attemptNum === null ? 1 : Math.max(0, Math.trunc(attemptNum));
	let attempt = run.attempts.find((a) => a.number === index);

	if (!attempt) {
		attempt = {
			number: index,
			model: run.model,
			effort: run.effort,
			plan: run.plan,
			pool: "",
			startedAt: started,
			endedAt: null,
			exitCode: null,
			failureClass: "",
			handoff: false,
		};

		run.attempts.push(attempt);
	}

	Object.assign(attempt, {
		model: run.model,
		effort: run.effort,
		plan: run.plan,
		pool: short(string(e.pool), 1024) || attempt.pool,
	});

	if (started) {
		attempt.startedAt = started;
	}

	if (e.event === "outcome" || e.event === "import" || number(e.exitCode) !== null) {
		const durationMs = number(e.durationMs);

		attempt.endedAt =
			time(e.endedAt) || (durationMs === null ? null : Math.max(0, started + durationMs));

		const exitCode = number(e.exitCode);

		attempt.exitCode = exitCode === null ? null : Math.trunc(exitCode);
		attempt.failureClass = short(string(e.failureClass), 1024);
		attempt.handoff = e.status === "handoff" || attempt.exitCode === 5;

		if (!attempt.endedAt && attempt.exitCode !== null) {
			attempt.endedAt = time(e.at) || started;
		}
	}

	run.attempts.sort((a, b) => a.number - b.number);
	setStatus(run, run.attempts.at(-1) ?? attempt);
	run.indexed = true;
	agents.set(id, run);
}

function setStatus(run: Agent, last: Attempt): void {
	run.endedAt = last.endedAt;
	run.model = last.model;
	run.effort = last.effort;
	run.plan = last.plan;

	if (last.handoff) {
		run.status = "fell back";
		run.statusNote = "Claude handoff requested; launch is not confirmed";
	} else if (last.exitCode === null && last.endedAt === null) {
		run.status = "running";

		run.statusNote =
			run.attempts.length > 1 ? `Attempt ${last.number} running after fallback` : "Launch recorded";
	} else if (last.exitCode !== 0 || last.failureClass) {
		run.status = "failed";
		run.statusNote = last.failureClass || `Exit ${last.exitCode ?? "unknown"}`;
	} else {
		run.status = run.attempts.length > 1 ? "fell back" : "done";
		run.statusNote = run.attempts.length > 1 ? `Completed on attempt ${last.number}` : "Completed";
	}
}
