#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

type Trust = "owner" | "untrusted";

interface Provenance {
	readonly event: string;
	readonly sender: string;
	readonly trust: Trust;
}

const REFUSED = 1;
const FAILED = 2;

function fail(exitCode: typeof REFUSED | typeof FAILED, message: string): never {
	console.error(`selfedit: ${message}`);
	process.exit(exitCode);
}

const USAGE =
	"usage: selfedit write <note.md> --event <event-id> --sender <mxid> [--repo <dir>] < content";
const NOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const EVENT_ID = /^\$[A-Za-z0-9_\-+/=.:]+$/;
const MXID = /^@[a-z0-9._=/+-]+:[A-Za-z0-9.:-]+$/;
const UNTRUSTED_TYPES = new Set(["project", "reference", "user"]);

function defaultRepo(): string {
	const home = homedir();

	return path.join(home, ".claude", "projects", home.replaceAll("/", "-"), "memory");
}

function readOwners(): ReadonlySet<string> {
	const file =
		process.env["SELFEDIT_OWNERS"] ?? path.join(homedir(), ".config", "selfedit", "owners");

	if (!existsSync(file)) {
		return new Set();
	}

	const lines = readFileSync(file, "utf8")
		.split("\n")
		.map((line) => line.trim());

	return new Set(lines.filter((line) => line !== "" && !line.startsWith("#")));
}

type Outcome = { readonly refused: string } | { readonly printed: string };

// An untrusted sender may only write a note whose frontmatter declares a
// non-rule type. Anything this regex reading cannot classify the way a YAML
// parser or a model would (no frontmatter, quoted or escaped keys, YAML tags,
// multi-line values) is treated as a possible rule.
function ruleReason(content: string, label: string): string | undefined {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];

	if (/\btype["']?\s*:\s*["']?feedback/i.test(content)) {
		return `${label} mentions type: feedback`;
	}

	if (frontmatter === undefined) {
		return `${label} has no frontmatter`;
	}

	if (/\\[xuU]/.test(frontmatter)) {
		return `${label} frontmatter contains a hex or unicode escape`;
	}

	const types = [...frontmatter.matchAll(/\btype["']?\s*:([^\n,}]*)/gi)].map((m) =>
		(m[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2"),
	);

	if (types.length === 0) {
		return `${label} declares no type`;
	}

	const rule = types.find((type) => !UNTRUSTED_TYPES.has(type));

	return rule === undefined ? undefined : `${label} has type "${rule}"`;
}

const GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function git(repo: string, args: readonly string[], input?: string): string {
	return execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], {
		encoding: "utf8",
		env: GIT_ENV,
		input,
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function trailers(provenance: Provenance): string {
	return [
		`Selfedit-Event: ${provenance.event}`,
		`Selfedit-Sender: ${provenance.sender}`,
		`Selfedit-Trust: ${provenance.trust}`,
	].join("\n");
}

function commit(repo: string, note: string, content: string, provenance: Provenance): Outcome {
	const file = path.join(repo, note);

	if (git(repo, ["status", "--porcelain", "--untracked-files=all", "--", note]) !== "") {
		throw new Error(`${note} has uncommitted changes; commit or discard them first`);
	}

	const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;

	if (provenance.trust === "untrusted") {
		const reason =
			note === "MEMORY.md"
				? "MEMORY.md is always loaded"
				: ((previous === undefined ? undefined : ruleReason(previous, `existing ${note}`)) ??
					ruleReason(content, note));

		if (reason !== undefined) {
			return { refused: `${reason}; only an owner can write it` };
		}
	}

	if (previous === content) {
		return { printed: "unchanged" };
	}

	try {
		writeFileSync(file, content);
		git(repo, ["add", "--", note]);

		git(
			repo,
			["commit", "--quiet", "--file=-", "--", note],
			`memory: write ${note}\n\n${trailers(provenance)}\n`,
		);
	} catch (error) {
		if (previous === undefined) {
			rmSync(file, { force: true });
		} else {
			writeFileSync(file, previous);
		}

		git(repo, ["reset", "--quiet", "--", note]);

		throw error;
	}

	const sha = git(repo, ["rev-parse", "HEAD"]);
	const verified =
		git(repo, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha]) === note &&
		git(repo, ["rev-parse", `${sha}:${note}`]) ===
			git(repo, ["hash-object", "--no-filters", "--stdin"], content) &&
		git(repo, ["log", "-1", "--format=%(trailers:only,unfold)", sha]) === trailers(provenance);

	if (!verified) {
		throw new Error(`commit ${sha} does not match the requested write`);
	}

	return { printed: sha };
}

function write(repo: string, note: string, content: string, provenance: Provenance): Outcome {
	const lock = path.join(git(repo, ["rev-parse", "--absolute-git-dir"]), "selfedit.lock");

	closeSync(openSync(lock, "wx"));

	try {
		return commit(repo, note, content, provenance);
	} finally {
		rmSync(lock);
	}
}

function main(argv: readonly string[]): string {
	const { positionals, values } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: { event: { type: "string" }, sender: { type: "string" }, repo: { type: "string" } },
	});
	const [command, note] = positionals;
	const { event, sender } = values;

	if (command !== "write" || note === undefined || positionals.length !== 2) {
		fail(FAILED, USAGE);
	}

	if (!NOTE_NAME.test(note)) {
		fail(FAILED, `note must be a bare file name ending in .md: ${note}`);
	}

	if (event === undefined || !EVENT_ID.test(event)) {
		fail(FAILED, `--event must be a Matrix event id`);
	}

	if (sender === undefined || !MXID.test(sender)) {
		fail(FAILED, `--sender must be a Matrix user id`);
	}

	const trust: Trust = readOwners().has(sender) ? "owner" : "untrusted";

	const outcome = write(values.repo ?? defaultRepo(), note, readFileSync(0, "utf8"), {
		event,
		sender,
		trust,
	});

	if ("refused" in outcome) {
		fail(REFUSED, outcome.refused);
	}

	return outcome.printed;
}

try {
	console.log(main(process.argv.slice(2)));
} catch (error) {
	fail(FAILED, error instanceof Error ? error.message : String(error));
}
