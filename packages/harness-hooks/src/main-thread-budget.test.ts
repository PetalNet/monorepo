import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { firstWords, isLong } from "./main-thread-budget-classify.ts";

const hook = fileURLToPath(new URL("main-thread-budget.ts", import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), "mtb-"));

mkdirSync(path.join(home, ".claude/shared"), { recursive: true });
const env = { ...process.env, HOME: home, MTB_WAIT_MS: "2000" };

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});

interface Output {
	permissionDecision: string;
	additionalContext?: string;
	updatedInput: { command: string; run_in_background?: boolean; timeout?: number };
}

const run = (toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
	const r = spawnSync(process.execPath, ["--no-warnings", hook], {
		input: JSON.stringify({ tool_name: "Bash", tool_input: toolInput, ...extra }),
		env,
	});

	return r.stdout.length > 0
		? (JSON.parse(r.stdout.toString()) as { hookSpecificOutput: Output }).hookSpecificOutput
		: null;
};

// Executes the rewritten command the way Claude Code's shell would.
const exec = (command: string) => {
	const r = run({ command });

	expect(r?.updatedInput.run_in_background, command).toBeUndefined();

	const t0 = Date.now();
	const p = spawnSync("bash", ["-c", r?.updatedInput.command ?? ""], {
		env,
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});

	return { ...p, ms: Date.now() - t0 };
};

// Invented commands: one per branch of the classifier.
const FOREGROUND = [
	"grep -c x f; ls -la dir",
	"cat >> file <<'EOF'\nsleep 300\nnix build .#x\nEOF",
	"python3 - <<'EOF'\nimport json\nprint(json.dumps({'a': 1}))\nEOF",
	'tail -c 3000 f | python3 -c "import sys; print(len(sys.stdin.read()))"',
	"cp a b && python3 x.py",
	"ssh box1 'ls /srv'",
	'python3 -c "print(1)"',
	"timeout 5 sleep 100",
	"curl -s -o /dev/null -w %{http_code} http://example.test",
	"git status --short",
	"curl -s https://example.test/a.json | jq .a",
	"docker ps",
	"nix eval .#x",
	"sleep 1",
	"VAR=1 ls",
	"cargo check",
	"nix run .#tool",
	"rsync -an src/ host:/dst/",
	"make --help",
	"npm ls",
	"docker compose up -d",
	"echo 'unbalanced",
	"",
];
const BACKGROUND = [
	"sleep 300",
	"nix build .#x",
	"pnpm install",
	"docker build .",
	"pytest -q",
	"timeout 600 ./run.sh",
	"ssh box1 'sleep 300'",
	"ssh box1 docker build /srv/x",
	"ssh -N -L 80:localhost:80 box1",
	"tail -f log",
	"npm test",
	"cargo build --release",
	"pip install requests",
	"wget https://example.test/big.iso",
	"curl -O https://example.test/big.iso",
	"rsync -a src/ host:/dst/",
	"while true; do sleep 5; done",
	"python3 -m http.server 8000",
	"home-manager switch --flake .#x",
	"node --test t.mjs",
	"sudo apt-get install foo",
	"bash -c 'sleep 90'",
	"env FOO=1 make all",
	"wait",
	"docker compose up",
	"pnpm run dev",
	"npx vitest",
	"flask run",
];

describe("classifier", () => {
	it.each(FOREGROUND)("keeps %j in the foreground", (c) => {
		expect(isLong(c)).toBe(false);
	});

	it.each(BACKGROUND)("moves %j to the background", (c) => {
		expect(isLong(c)).toBe(true);
	});

	it("reports the command words of each segment, never their arguments", () => {
		expect(firstWords("FOO=1 sudo ls -l /secret | grep tok && /usr/bin/true")).toEqual([
			"ls",
			"grep",
			"true",
		]);

		expect(firstWords(undefined)).toEqual([]);
	});
});

describe("hook", () => {
	it("starts a long command in the background, other arguments kept", () => {
		const input = {
			command: "nix build .#widget 2>&1 | tail -3",
			description: "Build",
			timeout: 30000,
		};
		const r = run(input);

		expect(r?.permissionDecision).toBe("allow");
		expect(r?.updatedInput).toEqual({ ...input, run_in_background: true });
		expect(r?.additionalContext).toMatch(/background/u);
		expect(run({ command: "ls", timeout: 120000 })?.updatedInput.run_in_background).toBe(true);
	});

	it("leaves already-backgrounded and subagent calls alone", () => {
		expect(run({ command: "nix build", run_in_background: true })).toBeNull();
		expect(run({ command: "ls" }, { agent_id: "a1", agent_type: "general-purpose" })).toBeNull();
		expect(run({ command: "nix build" }, { agent_id: "a1" })).toBeNull();

		expect(
			run({ command: "ls" }, { agent_type: "reviewer" })?.updatedInput.run_in_background,
		).toBeUndefined();
	});

	it("ignores other tools and bad input", () => {
		const other = spawnSync(process.execPath, ["--no-warnings", hook], {
			input: JSON.stringify({ tool_name: "Read", tool_input: { command: "sleep 300" } }),
			env,
		});
		const bad = spawnSync(process.execPath, ["--no-warnings", hook], { input: "not json", env });

		expect(other.stdout.length).toBe(0);
		expect(bad.stdout.length).toBe(0);
		expect(bad.status).toBe(0);
	});

	it("tags the wrapped command with the sanitised session id", () => {
		const r = run({ command: "ls" }, { session_id: "ab-12/../x" });

		expect(r?.updatedInput.command).toMatch(/^MTB_SESSION=ab-12x '/u);
	});

	it("raises an explicit short timeout so the wrapper itself is not killed", () => {
		expect(run({ command: "ls", timeout: 1000 })?.updatedInput.timeout).toBeGreaterThanOrEqual(
			7000,
		);
	});

	it("logs command words and length, never the command text", () => {
		run({ command: "vault get example-token | head -c 4" });

		const last = JSON.parse(
			readFileSync(path.join(home, ".claude/shared/main-thread-budget.log"), "utf8")
				.trim()
				.split("\n")
				.pop() ?? "",
		) as { words: string[]; len: number };

		expect(last.words).toEqual(["vault", "head"]);
		expect(last.len).toBe("vault get example-token | head -c 4".length);
		expect(JSON.stringify(last)).not.toContain("example-token");
	});
});

describe("wrapped execution", () => {
	it("returns a 1 s command inline with stdout, stderr and exit code intact", () => {
		const r = exec("echo out; echo err >&2; sleep 1; exit 7");

		expect(r.stdout).toBe("out\n");
		expect(r.stderr).toBe("err\n");
		expect(r.status).toBe(7);
		expect(r.ms).toBeLessThan(2500);
	});

	it("keeps heredocs, quotes and $ byte for byte", () => {
		const r = exec(
			"cat <<'EOF'\n$HOME `x` \"q\" 'single'\nEOF\npython3 - <<'PY'\nimport json\nprint(json.dumps({'a': \"it's\"}))\nPY\nprintf '%s\\n' \"a b\" | tail -c 3000 | python3 -c \"import sys; print(len(sys.stdin.read()))\"",
		);

		expect(r.stdout).toBe(`$HOME \`x\` "q" 'single'\n{"a": "it's"}\n4\n`);
		expect(r.status).toBe(0);
	});

	it("returns at once for a command that outlives the wait, and its output files end up complete", async () => {
		const r = exec("echo start; echo oops >&2; sleep 4; echo done; exit 3");

		expect(r.status).toBe(0);
		expect(r.ms).toBeLessThan(3500);

		const m =
			/pid (\d+), stdout at (\S+\.out), stderr at (\S+\.err), exit code will be written to (\S+\.exit)\./u.exec(
				r.stdout,
			);

		expect(m, r.stdout).not.toBeNull();
		expect(r.stdout).toMatch(/still running/u);
		const [, pid = "", outF = "", errF = "", exitF = ""] = m ?? [];

		expect(existsSync(exitF)).toBe(false);

		await vi.waitFor(
			() => {
				expect(existsSync(exitF)).toBe(true);
			},
			{ timeout: 8000, interval: 100 },
		);

		expect(readFileSync(exitF, "utf8").trim()).toBe("3");
		expect(readFileSync(outF, "utf8")).toBe("start\ndone\n");
		expect(readFileSync(errF, "utf8")).toBe("oops\n");

		expect(
			!existsSync(`/proc/${pid}`) ||
				!/^State:\s+Z/mu.test(readFileSync(`/proc/${pid}/status`, "utf8")),
			"no zombie left behind",
		).toBe(true);
	}, 20000);

	it("delivers large output whole through a pipe, and the caller timeout still kills a promoted command", () => {
		const r = exec('head -c 3000000 /dev/zero | tr "\\0" a');

		expect(r.stdout.length).toBe(3000000);
		const w = run({ command: "sleep 7; echo late", timeout: 3000 })?.updatedInput.command ?? "";

		expect(w).toMatch(/ 3000$/u);
		const p = spawnSync("bash", ["-c", w], { env, encoding: "utf8" });
		const exitF = /written to (\S+\.exit)/u.exec(p.stdout)?.[1] ?? "";
		const t0 = Date.now();

		while (!existsSync(exitF) && Date.now() - t0 < 12000) {
			spawnSync("sleep", ["0.2"]);
		}

		expect(readFileSync(exitF, "utf8").trim()).toBe("124");
	}, 30000);
});
