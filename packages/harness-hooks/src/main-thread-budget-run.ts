// Foreground with auto-promote. usage: main-thread-budget-run.ts <wait-ms> <base64 command> [timeout-ms]
// Runs the command under bash with stdout/stderr going to files. If it finishes within wait-ms the real output,
// stderr and exit code are returned as if it had run inline; otherwise it keeps running detached and this returns
// at once, so no tool call blocks the main session (Matrix messages arrive only between tool calls).
import { spawn } from "node:child_process";
import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

const homeDir = () => {
	const h = process.env["HOME"];

	return h === undefined || h === "" ? "/tmp" : h;
};

const sessionId = () => {
	const s = process.env["MTB_SESSION"];

	return s === undefined || s === "" ? null : s;
};

const [waitArg, b64, limitArg] = process.argv.slice(2);
const limit = Math.ceil(Number(limitArg) / 1000) || 0; // the caller's own timeout still applies after promotion
const wait = Number(waitArg) || 5000;
const cmd = Buffer.from(b64 ?? "", "base64").toString("utf8");
const dir = path.join(homeDir(), ".claude/shared/main-thread-budget-out");

mkdirSync(dir, { recursive: true });
const now = Date.now();

for (const f of readdirSync(dir)) {
	// output files older than a week are not worth keeping
	try {
		if (now - statSync(path.join(dir, f)).mtimeMs > 7 * 864e5) {
			unlinkSync(path.join(dir, f));
		}
	} catch {
		/* raced */
	}
}

const base = path.join(dir, `${String(now)}-${String(process.pid)}`);
const out = openSync(`${base}.out`, "w");
const err = openSync(`${base}.err`, "w");
// The inner bash runs the command exactly as given (heredocs and quotes untouched); the outer one records the exit code.
const child = spawn(
	"bash",
	[
		"-c",
		'if [ "$3" -gt 0 ]; then timeout -k 5 "$3" bash -c "$1"; else bash -c "$1"; fi; echo $? > "$2.exit.tmp"; mv "$2.exit.tmp" "$2.exit"',
		"_",
		cmd,
		base,
		String(limit),
	],
	{ detached: true, stdio: ["ignore", out, err] },
);

child.unref();
closeSync(out);
closeSync(err);

const read = (f: string) => {
	try {
		return readFileSync(f);
	} catch {
		return Buffer.alloc(0);
	}
};

const deadline = now + wait;
const tick = () => {
	let code: number | null = null;

	try {
		code = Number(readFileSync(`${base}.exit`, "utf8"));
	} catch {
		/* not finished */
	}

	if (code !== null) {
		process.stdout.write(read(`${base}.out`));
		process.stderr.write(read(`${base}.err`));

		for (const ext of ["out", "err", "exit"]) {
			try {
				unlinkSync(`${base}.${ext}`);
			} catch {
				/* gone */
			}
		}

		process.exitCode = code; // not process.exit: it would cut off output still queued on a pipe

		return;
	}

	if (Date.now() >= deadline) {
		// The notify hook (PostToolUse/UserPromptSubmit) announces the finish from this record; command words only, never the text.
		try {
			writeFileSync(
				`${base}.job.tmp`,
				JSON.stringify({
					pid: child.pid,
					session: sessionId(),
					words: cmd
						.trim()
						.split(/\s+/u)
						.filter((w) => !/^[A-Za-z_]\w*=/u.test(w))
						.slice(0, 3)
						.join(" "),
				}),
			);

			renameSync(`${base}.job.tmp`, `${base}.job`);
		} catch {
			/* the notice is best effort */
		}

		process.stdout.write(
			`still running after ${String(wait / 1000)}s, pid ${String(child.pid)}, stdout at ${base}.out, stderr at ${base}.err, ` +
				`exit code will be written to ${base}.exit. It was moved to the background; do not poll. A notice arrives on a later tool call or prompt when it finishes.\n`,
		);

		return;
	}

	setTimeout(tick, 25);
};

tick();
