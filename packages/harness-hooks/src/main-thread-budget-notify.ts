// Completion notice for commands that main-thread-budget-run.ts promoted to the background. Registered on
// PostToolUse and UserPromptSubmit: on the next tool call or prompt after a promoted command exits, it returns
// additionalContext naming the exit code and the output files. Each job is announced once, only to the session that
// started it (the run script records MTB_SESSION in the .job file). Subagents never consume a notice. Fails open.
import { readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";

interface NotifyInput {
	readonly agent_id?: unknown;
	readonly session_id?: unknown;
	readonly hook_event_name?: unknown;
}
interface Job {
	readonly session?: unknown;
	readonly words?: unknown;
	readonly pid?: unknown;
}

const TAIL_BYTES = 400;
let input: NotifyInput = {};

try {
	input = JSON.parse(readFileSync(0, "utf8") || "{}") as NotifyInput;
} catch {
	process.exit(0);
}

if (input.agent_id) {
	process.exit(0);
}

const homeDir = (() => {
	const h = process.env["HOME"];

	return h === undefined || h === "" ? "/tmp" : h;
})();
const dir = path.join(homeDir, ".claude/shared/main-thread-budget-out");
const read = (f: string) => {
	try {
		return readFileSync(f, "utf8");
	} catch {
		return null;
	}
};

const tail = (f: string) => {
	const s = read(f) ?? "";

	return s.length > TAIL_BYTES ? `...${s.slice(-TAIL_BYTES)}` : s;
};

const jobWords = (j: Job) => (typeof j.words === "string" && j.words ? j.words : "unknown");
const notes: string[] = [];
let files: string[] = [];

try {
	files = readdirSync(dir).filter((f) => f.endsWith(".job"));
} catch {
	process.exit(0);
}

for (const f of files.toSorted()) {
	const base = path.join(dir, f.slice(0, -4));
	let job: Job;

	try {
		job = JSON.parse(read(path.join(dir, f)) ?? "") as Job;
	} catch {
		continue;
	}

	if (job.session && job.session !== input.session_id) {
		continue;
	}

	const code = read(`${base}.exit`);

	if (code === null) {
		continue;
	}

	try {
		renameSync(path.join(dir, f), path.join(dir, `${f}.done`));
	} catch {
		continue; // lost the race to another hook run
	}

	try {
		unlinkSync(path.join(dir, `${f}.done`));
	} catch {
		/* ignore */
	}

	const out = tail(`${base}.out`).trim();
	const err = tail(`${base}.err`).trim();

	notes.push(
		`Background command (${jobWords(job)}, pid ${String(job.pid)}) finished with exit code ${String(Number(code))}. Full output: ${base}.out, stderr: ${base}.err.${out ? `\nstdout tail:\n${out}` : ""}${err ? `\nstderr tail:\n${err}` : ""}`,
	);
}

if (notes.length === 0) {
	process.exit(0);
}

process.stdout.write(
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName:
				input.hook_event_name === "UserPromptSubmit" ? "UserPromptSubmit" : "PostToolUse",
			additionalContext: `Main-thread budget: ${notes.join("\n\n")}`,
		},
	}),
);
