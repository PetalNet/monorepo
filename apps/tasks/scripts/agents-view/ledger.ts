// Adapted from Claude Code agents-view hooks, 291069fa-3ac4-4e01-939f-5d8782460da4.
import { agent, type Agent, type Attempt } from "./model.ts";
import { json, number, redact, short, string, time } from "./safe.ts";

export function applyLedger(agents: Map<string, Agent>, line: string, runs: string): void {
	const e = json(line);

	if (!e || !["launch", "attempt", "outcome", "import", "inject"].includes(string(e.event))) return;

	const runId = string(e.runId);

	if (!runId || e.event === "inject") return;

	const id = `router:${runId}`;
	const run = agents.get(id) ?? agent(id, "router");

	run.imported = e.event === "import" || run.imported;

	if (string(e.briefName)) run.name = short(string(e.briefName).split(/[\\/]/).at(-1) ?? "", 80);
	else if (run.name === id)
		run.name = short(`${string(e.kind) || "agent"} ${runId.slice(0, 8)}`, 80);

	for (const field of ["model", "effort", "plan", "kind", "tier", "branch"] as const) {
		if (string(e[field])) run[field] = redact(string(e[field]));
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

	if (started && (!run.startedAt || started < run.startedAt)) run.startedAt = started;

	run.updatedAt = time(e.endedAt) || started || run.updatedAt;
	const index = number(e.attempt) ?? 1;
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
		pool: redact(string(e.pool)) || attempt.pool,
	});

	if (started) attempt.startedAt = started;

	if (e.event === "outcome" || e.event === "import" || number(e.exitCode) !== null) {
		attempt.endedAt =
			time(e.endedAt) ||
			(number(e.durationMs) !== null ? started + (number(e.durationMs) ?? 0) : null);

		attempt.exitCode = number(e.exitCode);
		attempt.failureClass = redact(string(e.failureClass));
		attempt.handoff = e.status === "handoff" || attempt.exitCode === 5;

		if (!attempt.endedAt && attempt.exitCode !== null) attempt.endedAt = time(e.at) || started;
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

export function applyLegacy(run: Agent, text: string): void {
	const start = /^started (\S+) model=(\S+) workdir=(.*?) brief=(.*)$/m.exec(text);

	if (start) {
		run.startedAt = time(start[1]);
		run.model = redact(start[2] ?? "unknown");
		run.cwd = start[3] ?? "";
		run.briefPath = start[4] ?? "";
		run.status = "running";
		run.statusNote = "No end marker recorded";
	}

	const ends = [...text.matchAll(/^ended (\S+) rc=(-?\d+)/gm)];
	const end = ends.at(-1);

	if (end) {
		run.endedAt = time(end[1]);
		run.status = Number(end[2]) === 0 ? "done" : "failed";
		run.statusNote = `Exit ${end[2]}`;
	}

	run.indexed = true;
}

export function deduplicateImports(agents: Iterable<Agent>): Agent[] {
	const list = [...agents];
	const legacy = list.filter((a) => a.source === "legacy" && a.indexed);

	return list.filter((a) => {
		if (!a.imported) return true;

		const matches = legacy.filter((b) => b.model === a.model && b.startedAt === a.startedAt);

		// Imported rows are snapshots. The log may have acquired an end marker since.
		return matches.length !== 1 && !matches.some((b) => b.endedAt === a.endedAt);
	});
}
