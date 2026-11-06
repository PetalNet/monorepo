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

// The frontmatter subset this tool reads: `key: value` lines at column 0, and
// `key:` opening one map of `key: value` lines at a single indentation, with
// blank and comment lines between them. A value is plain text or one closed
// quoted string on the same line. Anything else (quoted keys, flow collections,
// block scalars, tags, anchors, aliases, continuation lines, deeper nesting,
// tab indentation, control characters) is refused rather than guessed at.
type Frontmatter = ReadonlyMap<string, string | ReadonlyMap<string, string>>;

const SUPPORTED = new Set(["type", "metadata.type"]);
const KEY_LINE = /^( *)([A-Za-z0-9_][A-Za-z0-9_.-]*):(?: +(.*))?$/;
const QUOTED = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?: +#.*)?$/;
const TYPE_VALUE = /^(["']?)([a-z]+)\1(?: +#.*)?$/;

function parseFrontmatter(text: string): Frontmatter | string {
	if (/(?![\t\n])[\p{Cc}\u2028\u2029\uFEFF]/u.test(text.replaceAll("\r\n", "\n"))) {
		return "contains a control or line-separator character";
	}

	const root = new Map<string, string | Map<string, string>>();
	let parent: Map<string, string> | undefined;
	let indent: number | undefined;

	for (const line of text.split(/\r?\n/)) {
		if (/^ *(?:#.*)?$/.test(line)) {
			continue;
		}

		const match = KEY_LINE.exec(line);

		if (match === null) {
			return `has an unsupported line: ${JSON.stringify(line)}`;
		}

		const [, lead = "", key = "", raw = ""] = match;
		const value = raw.startsWith("#") ? "" : raw;

		if (
			/^[[\]{}&*!|>%@`,]|^[-?:](?: |$)/.test(value) ||
			(/^["']/.test(value) && !QUOTED.test(value))
		) {
			return `has an unsupported value for ${key}`;
		}

		const map = lead === "" ? root : parent;

		if (map === undefined || (lead !== "" && (indent ??= lead.length) !== lead.length)) {
			return `has unexpected indentation at ${key}`;
		}

		if (map.has(key)) {
			return `repeats the key ${key}`;
		}

		if (value !== "") {
			map.set(key, value);
			parent = lead === "" ? undefined : parent;
		} else if (lead === "") {
			parent = new Map();
			indent = undefined;
			root.set(key, parent);
		} else {
			return `nests deeper than one level at ${key}`;
		}
	}

	return root;
}

// An untrusted sender may only write a note whose frontmatter declares a
// non-rule type, either as a top-level `type` or as `metadata.type`.
function ruleReason(content: string, label: string): string | undefined {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];

	if (/\btype["']?\s*:\s*["']?feedback/i.test(content)) {
		return `${label} mentions type: feedback`;
	}

	if (frontmatter === undefined) {
		return `${label} has no frontmatter`;
	}

	const parsed = parseFrontmatter(frontmatter);

	if (typeof parsed === "string") {
		return `${label} frontmatter ${parsed}`;
	}

	const names = [...parsed].flatMap(([key, value]) => [
		key,
		...(typeof value === "string" ? [] : [...value.keys()].map((child) => `${key}.${child}`)),
	]);
	const stray = names.find((name) => /(?:^|\.)type$/i.test(name) && !SUPPORTED.has(name));

	if (stray !== undefined) {
		return `${label} frontmatter has an unsupported type key ${stray}`;
	}

	const metadata = parsed.get("metadata");
	const declarations = [
		parsed.get("type"),
		typeof metadata === "string" ? undefined : metadata?.get("type"),
	].filter((value) => value !== undefined);

	if (declarations.length !== 1) {
		return `${label} declares ${declarations.length === 0 ? "no type" : "more than one type"}`;
	}

	const [declared] = declarations;

	if (typeof declared !== "string") {
		return `${label} frontmatter has a type that is not a single value`;
	}

	const type = TYPE_VALUE.exec(declared)?.[2];

	return type !== undefined && UNTRUSTED_TYPES.has(type)
		? undefined
		: `${label} has type ${JSON.stringify(declared)}`;
}

const GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function git(repo: string, args: readonly string[], input?: string, index?: string): string {
	return execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], {
		encoding: "utf8",
		env: index === undefined ? GIT_ENV : { ...GIT_ENV, GIT_INDEX_FILE: index },
		input,
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

// An unborn branch has no HEAD commit. Any other failure surfaces later, when
// the compare-and-swap update of HEAD refuses to create an existing ref.
function currentHead(repo: string): string | undefined {
	try {
		return git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
	} catch {
		return undefined;
	}
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

	// The commit is built from the exact bytes with plumbing, so no autocrlf,
	// eol or filter setting can change what lands, and it is checked before
	// HEAD moves.
	const head = currentHead(repo);
	const staged = git(repo, ["ls-files", "--stage", "--", note]);
	const mode = staged === "" ? "100644" : staged.slice(0, staged.indexOf(" "));

	if (mode !== "100644" && mode !== "100755") {
		throw new Error(`${note} is not a regular file in the index`);
	}

	const blob = git(repo, ["hash-object", "-w", "--no-filters", "--stdin"], content);
	const index = path.join(git(repo, ["rev-parse", "--absolute-git-dir"]), "selfedit.index");
	let sha: string;

	try {
		git(
			repo,
			head === undefined ? ["read-tree", "--empty"] : ["read-tree", head],
			undefined,
			index,
		);

		git(
			repo,
			["update-index", "--add", "--cacheinfo", `${mode},${blob},${note}`],
			undefined,
			index,
		);

		const tree = git(repo, ["write-tree"], undefined, index);

		sha = git(
			repo,
			["commit-tree", tree, ...(head === undefined ? [] : ["-p", head])],
			`memory: write ${note}\n\n${trailers(provenance)}\n`,
		);
	} finally {
		rmSync(index, { force: true });
	}

	const verified =
		git(repo, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha]) === note &&
		git(repo, ["rev-parse", `${sha}:${note}`]) === blob &&
		git(repo, ["log", "-1", "--format=%(trailers:only,unfold)", sha]) === trailers(provenance);

	if (!verified) {
		throw new Error(`commit ${sha} does not match the requested write`);
	}

	let moved = false;

	try {
		writeFileSync(file, content);

		git(repo, [
			"update-ref",
			"-m",
			`selfedit: write ${note}`,
			"HEAD",
			sha,
			head ?? "0".repeat(sha.length),
		]);

		moved = true;
		git(repo, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${note}`]);
	} catch (error) {
		if (moved) {
			git(
				repo,
				head === undefined
					? ["update-ref", "-d", "HEAD", sha]
					: ["update-ref", "-m", `selfedit: roll back ${note}`, "HEAD", head, sha],
			);
		}

		if (previous === undefined) {
			rmSync(file, { force: true });
		} else {
			writeFileSync(file, previous);
		}

		throw error;
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
