// Lets a non-Claude worker (Gemini through agy, GPT through Codex, a local model on Ollama) draft a chat post in
// Janet's voice, and checks the draft before Janet publishes it, so the writing is paid for by that worker's plan.
//
// The style pack is skills/janet-voice/SKILL.md. agy and Codex load it as the AGENTS.md of a writer workspace (they
// read AGENTS.md from the working directory); Ollama takes it as the system prompt.
//
//   node janet-voice.ts write --harness agy --model gemini-4-argon-medium --workspace DIR < brief
//   node janet-voice.ts check [--judge] [--brief FILE] [--pack FILE] < draft     exit 1 when the draft fails
//
// The check has two parts. `lint` is deterministic: the markdown the Matrix hook rejects (plain.ts) plus the
// punctuation, link and stock-phrase rules that a regex can decide. `judge` is one model call for what a regex
// cannot decide: the order of the post, padding, tone and, when the brief is given, whether the facts match. The
// judge never sees who wrote the draft.
//
// One file with no dependencies beyond plain.ts, so Node runs it from the source tree.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { detect } from "./plain.ts";

interface Finding {
	readonly rule: string;
	readonly quote: string;
}

const WORDS =
	"additionally|crucial|delve|delves|delving|enhance|enhances|enhanced|enhancing|foster|fosters|fostering|garner|intricate|pivotal|robust|seamless|seamlessly|showcase|showcases|showcasing|testament|underscore|underscores|vibrant|comprehensive|streamline|streamlines|streamlined|utilize|utilizes|utilized|utilizing|leverage|leverages|leveraged|leveraging|facilitate|facilitates";
const STOCK =
	"i hope this helps|let me know if|would you like me to|you're welcome|certainly|of course|great question|you're absolutely right|here's the thing|let's be honest|real talk|let's dive|here's what you need to know|without further ado|it is important to note|in order to|due to the fact that|serves as|stands as|a testament to|game.changer|next.level|cutting.edge|at its core";

// Each rule is something a regex can decide with no judgment. The skill states the same rule in words.
const RULES: readonly (readonly [string, RegExp])[] = [
	["code fence", /^\s*(?:```|~~~)/mu],
	// An en dash between two numbers is a range ("2\u20134 runs"), which Janet writes. Any other dash fails.
	["em or en dash", /\u2014|(?<!\d)\u2013|\u2013(?!\d)|(?<=\w) -{1,2} (?=\w)/u],
	["curly quote", /[\u2018\u2019\u201C\u201D]/u],
	["emoji", /\p{Extended_Pictographic}/u],
	["exclamation mark", /!(?=\s|$)/mu],
	["arrow", /->|=>|[\u2190-\u21FF]/u],
	["doubled apostrophe", /\w''\w/u],
	// The client links only a full address, and punctuation or brackets touching it break the link.
	["link not bare", /[([<"']https?:\/\/|https?:\/\/[^\s]*[.,;:)\]>"'!?](?=\s|$)/mu],
	[
		"link without https://",
		/(?<![\w/.@-])(?!ghcr\.io|docker\.io)(?:[a-z0-9-]+\.)+(?:dev|com|org|net|io|app)\/[^\s]/iu,
	],
	[
		"label or wrapper",
		/^\s*(?:subject|message|post|draft|update)\s*:|^\s*here(?:'s| is) (?:the|a|your) /iu,
	],
	["not just X but Y", /\bnot (?:just|only|merely)\b[^.?\n]{0,80}\b(?:but|it's|it is)\b/iu],
	["stock phrase", new RegExp(`(?<![\\w-])(?:${STOCK})(?![\\w-])`, "iu")],
	// A hyphenated compound is a name ("morning-showcase"), not the word.
	["inflated word", new RegExp(`(?<![\\w-])(?:${WORDS})(?![\\w-])`, "iu")],
];

/**
 * Every deterministic rule the draft breaks, with the words that broke it. Empty when the draft may
 * go to the judge.
 */
export function lint(text: string): Finding[] {
	const found: Finding[] = detect(text).map((rule) => ({ rule: `markdown: ${rule}`, quote: "" }));

	for (const [rule, re] of RULES) {
		const match = re.exec(text);

		if (match !== null) {
			found.push({
				rule,
				quote: text.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20).trim(),
			});
		}
	}

	return found;
}

/** The skill's body: what a harness loads as its rules. The frontmatter is for skill discovery only. */
export const packBody = (skill: string): string => skill.replace(/^---\n[\s\S]*?\n---\n+/u, "");

// The tells of a default model voice, each from the skill. The judge looks for these and nothing else: Janet's real
// posts are casual and compact, and a judge asked to grade prose in general fails most of them.
const CRITERIA = `opener: the post opens with a greeting, praise, or a sentence that announces or frames what it will say ("Here's an update", "I wanted to let you know", "I acknowledge"). Opening with the answer or a short reaction ("Yes", "Fair", "On it", "Honestly, nothing yet") is right.
closer: the post ends with an offer of more help, a recap of itself, a sign-off, or a generic conclusion. Ending on a fact, a question or Janet's next step is right.
corporate: the post reads like an announcement or a press release where a person would just say it: "we are pleased", "the team", "going forward", "enabling", "ensures", "is planned", "I acknowledge". An ordinary passive or an "our" is not this tell.
performed: the post performs enthusiasm, urgency, gratitude or apology beyond one plain "Sorry".
filler: a sentence that states no fact, restates a fact already given, or tells the reader something they did not need ("No further action is needed", "This ensures the correct result").
decode: the whole post is telegraphic notes or symbol shorthand that the reader has to decode.
asks: the post asks the reader more than one question, or a question that cannot be answered with a word or a pick.`;

/** The prompt for the one judge call. `brief` adds the two fact criteria. */
export function judgePrompt(pack: string, draft: string, brief?: string): string {
	const facts =
		brief === undefined
			? ""
			: `\nfaithful: a number, name, cause or promise in the post that the BRIEF does not support fails. Rewording a fact from the BRIEF, or drawing its plain consequence, is fine.\ncomplete: a fact in the BRIEF that changes what the reader knows or does, and that the post leaves out, fails.`;

	return `You are checking one chat post against a written style standard. The post is published as is when it passes, and is rejected when it fails. Format rules (markdown, punctuation, links) are checked by a separate program. You look only for the tells listed here.

Tells:
${CRITERIA}${facts}

Fail the post only when you can quote the words that show one of these tells (for "complete", quote the missing fact from the BRIEF). Everything else passes. Janet writes the way a blunt engineer talks to colleagues, so none of these is a tell: casual or wry words, a colon before a list or an explanation, a numbered item that opens with a short label, compact technical detail, a parenthesis, a short sentence fragment among full sentences, a long post, a short post.

Answer with one JSON object and nothing else: {"pass": true or false, "fails": [{"rule": "<criterion name>", "quote": "<the words>"}]}

STANDARD
${pack}
${brief === undefined ? "" : `\nBRIEF\n${brief}\n`}
POST
${draft}
`;
}

/** The judge's verdict, or `null` when its answer is not the JSON object asked for. */
export function parseVerdict(answer: string): { pass: boolean; fails: Finding[] } | null {
	const start = answer.indexOf("{");
	const end = answer.lastIndexOf("}");

	if (start === -1 || end <= start) {
		return null;
	}

	try {
		const raw = JSON.parse(answer.slice(start, end + 1)) as { pass?: unknown; fails?: unknown };
		const fails = Array.isArray(raw.fails)
			? raw.fails.map((f: { rule?: unknown; quote?: unknown }) => ({
					rule: typeof f.rule === "string" ? f.rule : "judge",
					quote: typeof f.quote === "string" ? f.quote : "",
				}))
			: [];

		return typeof raw.pass === "boolean" ? { pass: raw.pass && fails.length === 0, fails } : null;
	} catch {
		return null;
	}
}

type Harness = "agy" | "codex" | "ollama";

/** The command line for one headless call. `cwd` is the directory whose AGENTS.md the harness loads. */
export function argv(harness: "agy" | "codex", model: string, prompt: string): string[] {
	// agy: its terminal sandbox, and no --dangerously-skip-permissions, so a tool call that needs approval does not run.
	// `-p` takes the next argument as the prompt, so it goes last.
	return harness === "agy"
		? ["agy", "--model", model, "--sandbox", "-p", prompt]
		: [
				"codex",
				"exec",
				"--skip-git-repo-check",
				"--sandbox",
				"read-only",
				"--model",
				model,
				prompt,
			];
}

const ENV_KEEP = /^(?:HOME|PATH|USER|LANG|TERM|TMPDIR|SHELL|XDG_.*|LC_.*|OLLAMA_HOST)$/u;

function run(cmd: string[], cwd: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_KEEP.test(k)));
		const [exe, ...args] = cmd;
		const child = spawn(exe ?? "", args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let out = "";
		let err = "";
		// The harness leads its own process group, so the timeout kills what it started too.
		const timer = setTimeout(() => {
			try {
				process.kill(-(child.pid ?? 0), "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeoutMs);

		child.stdout.on("data", (d: Buffer) => (out += d.toString()));
		child.stderr.on("data", (d: Buffer) => (err += d.toString()));

		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});

		child.on("close", (code) => {
			clearTimeout(timer);

			if (code === 0 && out.trim() !== "") {
				resolve(out.trim());
			} else {
				reject(
					new Error(`${String(exe)} exited ${String(code)}: ${(err || out).trim().slice(-300)}`),
				);
			}
		});
	});
}

interface CallOptions {
	readonly harness: Harness;
	readonly model: string;
	/** Agy and Codex: the directory to run in. Ollama: unused. */
	readonly workspace?: string;
	/** Ollama only: the system prompt. agy and Codex take their rules from the workspace's AGENTS.md. */
	readonly system?: string;
	readonly timeoutMs?: number;
}

/**
 * One model call through the worker's own harness. With no workspace it runs in a new empty
 * directory, so no rules load.
 */
async function call(prompt: string, o: CallOptions): Promise<string> {
	const timeoutMs = o.timeoutMs ?? 180_000;

	if (o.harness === "ollama") {
		const host = process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
		const messages = [
			...(o.system === undefined ? [] : [{ role: "system", content: o.system }]),
			{ role: "user", content: prompt },
		];
		const res = await fetch(`${host}/api/chat`, {
			method: "POST",
			body: JSON.stringify({ model: o.model, stream: false, messages }),
			signal: AbortSignal.timeout(timeoutMs),
		});

		if (!res.ok) {
			throw new Error(`ollama answered ${String(res.status)}`);
		}

		return ((await res.json()) as { message: { content: string } }).message.content.trim();
	}

	const cwd = o.workspace ?? mkdtempSync(path.join(tmpdir(), "janet-voice-"));

	mkdirSync(cwd, { recursive: true });

	return run(argv(o.harness, o.model, prompt), cwd, timeoutMs);
}

/**
 * The prompt a writer gets. It is the same with and without the pack: the pack arrives through the
 * harness. The harness has tools, and a brief that names a next step ("I can try it on the build
 * box") has made a model start on that step and wait for a permission nobody grants, so the prompt
 * says the facts are material, not a request.
 */
const writePrompt = (brief: string): string =>
	`Write the chat post that tells the people in the room the facts below. The facts are material for the post, not a request to you: do not act on them and do not use tools. Answer with the post only.\n\nFacts:\n${brief.trim()}\n`;

interface Verdict {
	readonly pass: boolean;
	readonly lint: Finding[];
	readonly judge: Finding[] | null;
}

/**
 * Lint, then one judge call when the lint is clean and a judge is given. A judge answer that cannot
 * be parsed fails.
 */
async function check(
	draft: string,
	pack: string,
	judge?: CallOptions,
	brief?: string,
): Promise<Verdict> {
	const found = lint(draft);

	if (found.length > 0 || judge === undefined) {
		return { pass: found.length === 0, lint: found, judge: null };
	}

	const verdict = parseVerdict(await call(judgePrompt(pack, draft, brief), judge));

	return verdict === null
		? {
				pass: false,
				lint: [],
				judge: [{ rule: "judge", quote: "the judge did not answer with the JSON object" }],
			}
		: { pass: verdict.pass, lint: [], judge: verdict.fails };
}

const HARNESSES: ReadonlySet<string> = new Set(["agy", "codex", "ollama"]);

async function main(args: string[]): Promise<number> {
	const { values: f, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			harness: { type: "string", default: "agy" },
			model: { type: "string" },
			workspace: { type: "string" },
			pack: { type: "string" },
			brief: { type: "string" },
			judge: { type: "boolean", default: false },
			"judge-model": { type: "string", default: "claude-opus-5-5-low" },
		},
	});
	const [command] = positionals;
	const pack = packBody(
		readFileSync(
			f.pack ?? new URL("../../../skills/janet-voice/SKILL.md", import.meta.url),
			"utf8",
		),
	);
	const input = readFileSync(0, "utf8");

	if (command === "write") {
		if (!HARNESSES.has(f.harness) || f.model === undefined) {
			throw new Error("write needs --harness agy|codex|ollama and --model");
		}

		if (f.harness !== "ollama" && f.workspace === undefined) {
			throw new Error("write needs --workspace: the directory whose AGENTS.md is the pack");
		}

		const draft = await call(writePrompt(input), {
			harness: f.harness as Harness,
			model: f.model,
			...(f.harness === "ollama" ? { system: pack } : {}),
			...(f.workspace === undefined ? {} : { workspace: f.workspace }),
		});

		process.stdout.write(`${draft}\n`);

		return 0;
	}

	if (command === "check") {
		const verdict = await check(
			input.trim(),
			pack,
			f.judge ? { harness: "agy", model: f["judge-model"] } : undefined,
			f.brief === undefined ? undefined : readFileSync(f.brief, "utf8"),
		);

		process.stdout.write(`${JSON.stringify(verdict)}\n`);

		return verdict.pass ? 0 : 1;
	}

	throw new Error("usage: janet-voice.ts write|check [flags] < text");
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}
