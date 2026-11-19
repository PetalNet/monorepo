// Decides whether a main-thread Bash command is clearly long-running and so belongs in the background.
// Everything else runs in the foreground (the hook still caps its timeout, so a misjudged slow command is moved to
// the background by Claude Code after 3 s instead of blocking). Backgrounding costs an extra model turn to read the
// output file, so only commands that match a rule below are backgrounded; this is a time budget, not a security boundary.
// Policy: a command under 1 second can run on the main thread; anything else is backgrounded with a timeout or
// given to a subagent. Foreground by default, background the long ones.

const LONG_SECONDS = 30;
const KEYWORDS = new Set([
	"do",
	"then",
	"else",
	"while",
	"until",
	"!",
	"{",
	"time",
	"sudo",
	"nohup",
	"nice",
	"command",
	"exec",
]);

// Removes heredoc bodies so text inside them is never read as commands (`python3 - <<'EOF' ... sleep 300 ... EOF`).
function stripHeredocs(cmd: string) {
	const out: string[] = [];
	let tag: string | null = null;
	let dash = false;

	for (const line of cmd.split("\n")) {
		if (tag !== null) {
			if ((dash ? line.trim() : line) === tag) {
				tag = null;
			}

			continue;
		}

		out.push(line);
		const m = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/u.exec(line);

		if (m) {
			dash = m[1] === "-";
			tag = m[2] ?? m[3] ?? m[4] ?? null;
		}
	}

	return out.join("\n");
}

// Splits on ; & && || | and newlines outside quotes. Never fails: an unbalanced quote just ends the last segment.
export function segments(cmd: string) {
	const s = stripHeredocs(cmd);
	const out: string[] = [];
	let cur = "";
	let q: string | null = null;

	for (let i = 0; i < s.length; i++) {
		const c = s[i] ?? "";

		if (q) {
			if (c === "\\" && q === '"') {
				cur += c + (s[i + 1] ?? "");
				i++;

				continue;
			}

			if (c === q) {
				q = null;
			}

			cur += c;

			continue;
		}

		if (c === "\\") {
			cur += c + (s[i + 1] ?? "");
			i++;

			continue;
		}

		if (c === "'" || c === '"') {
			q = c;
			cur += c;

			continue;
		}

		if ((c === ">" && s[i + 1] === "&") || (c === "&" && (s[i - 1] === ">" || s[i + 1] === ">"))) {
			cur += c;

			continue;
		}

		if (c === ";" || c === "|" || c === "&" || c === "\n") {
			out.push(cur);
			cur = "";

			continue;
		}

		cur += c;
	}

	out.push(cur);

	return out.map((x) => x.trim()).filter(Boolean);
}

const words = (seg: string) =>
	(seg.match(/'[^']*'|"[^"]*"|\S+/gu) ?? []).map((w) => w.replace(/^(['"])(.*)\1$/u, "$2"));

// Command words of a segment with control keywords, variable assignments and wrappers removed.
function head(seg: string) {
	const w = words(seg);

	while (
		w.length > 0 &&
		(KEYWORDS.has(w[0] ?? "") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(w[0] ?? ""))
	) {
		w.shift();
	}

	if (w.length > 0) {
		w[0] = (w[0] ?? "").replace(/^.*\//u, "");
	}

	return w;
}

const UNIT: Readonly<Record<string, number>> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
const seconds = (v: string | undefined) => {
	const m = /^(\d+(?:\.\d+)?)([smhd]?)$/u.exec(v ?? "");

	return m ? Number(m[1]) * (UNIT[m[2] ?? ""] ?? NaN) : NaN;
};

const SSH_ARG_OPTS = new Set(
	"-p -i -l -o -L -R -D -J -F -b -c -E -e -m -O -Q -S -W -w -B -I".split(" "),
);
const LONG_VERBS: Readonly<Record<string, readonly string[] | null>> = {
	nix: ["build", "flake", "develop", "copy", "run", "store", "shell"],
	"nix-build": null,
	"nix-shell": null,
	"nix-collect-garbage": null,
	"nixos-rebuild": null,
	"home-manager": ["switch", "build"],
	docker: ["build", "buildx", "pull", "push", "compose"],
	podman: ["build", "pull", "push"],
	cargo: ["build", "install", "test", "bench", "check", "clippy"],
	go: ["build", "test", "install"],
	make: null,
	cmake: ["--build"],
	gradle: null,
	mvn: null,
	apt: ["install", "upgrade", "update"],
	"apt-get": ["install", "upgrade", "update", "dist-upgrade"],
	dnf: ["install", "upgrade"],
	pacman: ["-S", "-Syu"],
	brew: ["install", "upgrade"],
};
const INSTALLERS = new Set("npm pnpm yarn bun pip pip3 uv poetry pipx gem bundle".split(" "));
const INSTALL_VERBS = new Set(["install", "i", "ci", "add", "update", "upgrade", "sync"]);
const TEST_RUNNERS = new Set(
	`pytest py.test tox nox vitest jest playwright mocha hyperfine wrk ab iperf3 iperf
fio sysbench speedtest speedtest-cli stress stress-ng locust bonnie++`.split(/\s+/u),
);
const SERVERS = new Set(
	"uvicorn gunicorn hypercorn vite webpack-dev-server nodemon watch inotifywait mosh caddy nginx ngrok cloudflared".split(
		" ",
	),
);
const SCRIPT_VERBS = new Set([
	"test",
	"bench",
	"benchmark",
	"dev",
	"start",
	"serve",
	"watch",
	"preview",
	"e2e",
	"build",
]);

function docker(args: readonly string[]) {
	const i = args.findIndex((a) => !a.startsWith("-"));
	const verb = args[i];

	if (verb !== "compose") {
		return ["build", "buildx", "pull", "push"].includes(verb ?? "");
	}

	const sub = args.slice(i + 1).find((a) => !a.startsWith("-"));

	return (
		["build", "pull", "push"].includes(sub ?? "") ||
		(sub === "up" && !args.includes("-d") && !args.includes("--detach"))
	);
}

function ssh(args: readonly string[]) {
	let i = 0;

	while (i < args.length && (args[i] ?? "").startsWith("-")) {
		const a = args[i] ?? "";

		if (a === "-N" || /^-[LRD]/u.test(a)) {
			return true;
		}

		i += SSH_ARG_OPTS.has(a) ? 2 : 1;
	}

	return isLong(args.slice(i + 1).join(" "));
}

function longSegment(seg: string, wholeHasWaitLoop: boolean) {
	const w = head(seg);
	const name = w[0];
	const args = w.slice(1);
	const verb = args.find((a) => !a.startsWith("-"));

	if (!name) {
		return false;
	}

	if (name === "wait") {
		return true;
	}

	if (name === "sleep") {
		return wholeHasWaitLoop || args.some((a) => seconds(a) >= 10);
	}

	if (name === "timeout") {
		const d = args.find((a) => !a.startsWith("-"));

		return seconds(d) >= LONG_SECONDS; // the bound kills it sooner, whatever it runs
	}

	if (name === "ssh") {
		return ssh(args);
	}

	if (["bash", "sh", "zsh"].includes(name)) {
		const i = args.indexOf("-c");

		return i !== -1 && isLong(args[i + 1] ?? "");
	}

	if (name === "env") {
		return isLong(args.filter((a) => !/^-|=/u.test(a)).join(" "));
	}

	if (name === "rsync") {
		return !args.some((a) => /^--dry-run$|^-[a-zA-Z]*n[a-zA-Z]*$/u.test(a));
	}

	if (name === "scp" || name === "sftp") {
		return true;
	}

	if (name === "wget") {
		return (
			!args.some((a) => /^-[a-zA-Z]*O-$|^-O$|^--output-document=-$/u.test(a)) ||
			args.includes("--mirror")
		);
	}

	if (name === "curl") {
		return args.some(
			(a, i) =>
				/^(-[a-zA-Z]*[oOT]$|--output$|--remote-name|--upload-file$|-C$|--continue-at$)/u.test(a) &&
				!(/^(-[a-zA-Z]*o|--output)$/u.test(a) && args[i + 1] === "/dev/null"),
		);
	}

	if (name === "tail" || name === "journalctl") {
		return args.some((a) => /^-[a-zA-Z0-9]*[fF]|^--follow/u.test(a));
	}

	if (name === "docker" || name === "podman") {
		return docker(args);
	}

	if (name in LONG_VERBS) {
		const verbs = LONG_VERBS[name];

		if (verbs === null) {
			return !args.includes("--help") && !args.includes("-n") && !args.includes("--dry-run");
		}

		if (name === "nix" && verb === "flake") {
			return args.includes("check") || args.includes("update");
		}

		if (name === "nix" && verb === "run") {
			return false;
		}

		if (name === "nix" && (verb === "shell" || verb === "develop")) {
			return false;
		}

		if (name === "nix" && verb === "store") {
			return args.includes("gc");
		}

		if (name === "cargo" && ["check", "clippy"].includes(verb ?? "")) {
			return false;
		}

		return (verbs ?? []).some((x) => x === verb || (args.includes(x) && x.startsWith("-")));
	}

	if (INSTALLERS.has(name)) {
		if (INSTALL_VERBS.has(verb ?? "")) {
			return true;
		}

		if (name === "uv" || name === "pip" || name === "pip3") {
			return args.includes("install");
		}

		if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
			const v2 = verb === "run" ? args[args.indexOf("run") + 1] : verb;

			return SCRIPT_VERBS.has(v2 ?? "") || /^(test|bench|dev|start|serve|e2e)/u.test(v2 ?? "");
		}

		return false;
	}

	if (name === "python" || name === "python3") {
		const m = args.indexOf("-m");
		const mod = m === -1 ? "" : args[m + 1];

		if (mod === "pip") {
			return args.includes("install");
		}

		return ["pytest", "unittest", "http.server", "timeit", "tox"].includes(mod ?? "");
	}

	if (name === "node") {
		return args.includes("--test") || args.includes("--watch");
	}

	if (name === "npx") {
		return /^(vitest|jest|playwright|mocha|vite|next|nodemon|tsc-watch)$/u.test(verb ?? "");
	}

	if (TEST_RUNNERS.has(name) || SERVERS.has(name)) {
		return true;
	}

	if (/^(flask|next|nuxt|astro|vite|rails|hugo|jekyll|uvicorn)$/u.test(name)) {
		return /^(run|dev|start|serve|server|s)$/u.test(verb ?? "");
	}

	return false;
}

export function isLong(cmd: unknown): boolean {
	const segs = segments(typeof cmd === "string" ? cmd : "");
	const waitLoop =
		segs.some((s) => /^(while|until)\b/u.test(s)) && segs.some((s) => head(s)[0] === "sleep");

	return segs.some((s) => longSegment(s, waitLoop));
}

export const firstWords = (cmd: unknown) =>
	segments(typeof cmd === "string" ? cmd : "").map((s) => head(s)[0] ?? "");
