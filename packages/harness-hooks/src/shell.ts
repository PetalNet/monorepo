// A small POSIX-ish shell tokenizer for the guards. splitCommands(src) returns every simple command in src as
// { argv, env }: quotes and escapes resolved, leading VAR=value assignments in env. A guard can then ask "what is the
// program and what are its real flags" instead of grepping text. Handles '..', "..", $'..', backslash escapes and line
// continuations, the separators ; & && || | newline ( ) { }, here-strings, heredocs (quoted bodies skipped, unquoted
// bodies scanned for $( ) and backticks, which the shell would run), and command substitution $( ) and backticks
// (parsed as further commands, also inside double quotes). Not a full shell: no aliases, functions, variable
// expansion or eval; guards recurse into `bash -c`, `eval` etc. themselves. Throws on nesting deeper than MAX_DEPTH so
// a caller can fail closed.

const MAX_DEPTH = 40;

export interface SimpleCommand {
	readonly argv: string[];
	readonly env: Record<string, string>;
}

export function splitCommands(src: unknown): SimpleCommand[] {
	const out: SimpleCommand[] = [];

	parse(String(src), 0, null, out, 0);

	return out;
}

function parse(
	s: string,
	start: number,
	closer: ")" | "`" | null,
	out: SimpleCommand[],
	depth: number,
): number {
	if (depth > MAX_DEPTH) {
		throw new Error("shell nesting too deep");
	}

	let i = start;
	let argv: string[] = [];
	let env: Record<string, string> = {};
	let word: string | null = null;
	let parens = 0;
	const heredocs: { d: string; quoted: boolean }[] = [];
	const endWord = () => {
		if (word === null) {
			return;
		}

		if (argv.length === 0 && /^[A-Za-z_]\w*=/u.test(word)) {
			const k = word.indexOf("=");

			env[word.slice(0, k)] = word.slice(k + 1);
		} else {
			argv.push(word);
		}

		word = null;
	};

	const endCmd = () => {
		endWord();

		if (argv.length > 0 || Object.keys(env).length > 0) {
			out.push({ argv, env });
		}

		argv = [];
		env = {};
	};

	// An unquoted heredoc body still runs $( ) and backticks.
	const expansions = (body: string) => {
		let j = 0;

		while (j < body.length) {
			if (body.charAt(j) === "\\") {
				j += 2;
			} else if (body.charAt(j) === "$" && body.charAt(j + 1) === "(") {
				j = parse(body, j + 2, ")", out, depth + 1);
			} else if (body.charAt(j) === "`") {
				j = parse(body, j + 1, "`", out, depth + 1);
			} else {
				j++;
			}
		}
	};

	while (i < s.length) {
		const c = s.charAt(i);

		if (closer === ")" && c === ")" && parens === 0) {
			endCmd();

			return i + 1;
		}

		if (closer === "`" && c === "`") {
			endCmd();

			return i + 1;
		}

		if (c === "\\") {
			if (s.charAt(i + 1) === "\n") {
				i += 2;

				continue;
			}

			word = (word ?? "") + s.charAt(i + 1);
			i += 2;
		} else if (c === "'") {
			const j = s.indexOf("'", i + 1);
			const e = j === -1 ? s.length : j;

			word = (word ?? "") + s.slice(i + 1, e);
			i = e + 1;
		} else if (c === "$" && s.charAt(i + 1) === "'") {
			// ANSI-C quoting
			let w: string = word ?? "";

			i += 2;

			while (i < s.length && s.charAt(i) !== "'") {
				if (s.charAt(i) === "\\") {
					const n = s.charAt(i + 1);

					w += n === "n" ? "\n" : n === "t" ? "\t" : n;
					i += 2;
				} else {
					w += s.charAt(i++);
				}
			}

			word = w;
			i++;
		} else if (c === '"') {
			let w: string = word ?? "";

			i++;

			while (i < s.length && s.charAt(i) !== '"') {
				if (s.charAt(i) === "\\") {
					const n = s.charAt(i + 1);

					if (n === "\n") {
						i += 2;

						continue;
					}

					w += n !== "" && '$`"\\'.includes(n) ? n : `\\${n}`;
					i += 2;
				} else if (s.charAt(i) === "$" && s.charAt(i + 1) === "(") {
					i = parse(s, i + 2, ")", out, depth + 1);
				} else if (s.charAt(i) === "`") {
					i = parse(s, i + 1, "`", out, depth + 1);
				} else {
					w += s.charAt(i++);
				}
			}

			word = w;
			i++;
		} else if (c === "$" && s.charAt(i + 1) === "(") {
			i = parse(s, i + 2, ")", out, depth + 1);
			word ??= "";
		} else if (c === "`") {
			i = parse(s, i + 1, "`", out, depth + 1);
			word ??= "";
		} else if (c === "<" && s.startsWith("<<<", i)) {
			// here-string: the next word is an ordinary argument
			endWord();
			i += 3;
		} else if (c === "<" && s.charAt(i + 1) === "<") {
			endWord();

			let j = i + 2;

			if (s.charAt(j) === "-") {
				j++;
			}

			while (s.charAt(j) === " " || s.charAt(j) === "\t") {
				j++;
			}

			let d = "";
			let quoted = false;

			while (j < s.length && !/[\s;&|()<>]/u.test(s.charAt(j))) {
				const ch = s.charAt(j);

				if (ch === "'" || ch === '"' || ch === "\\") {
					quoted = true;
				} else {
					d += ch;
				}

				j++;
			}

			heredocs.push({ d, quoted });
			i = j;
		} else if (c === "\n") {
			endCmd();
			i++;

			for (const { d, quoted } of heredocs.splice(0)) {
				let body = "";

				while (i < s.length) {
					let e = s.indexOf("\n", i);

					if (e < 0) {
						e = s.length;
					}

					const line = s.slice(i, e);

					i = e + 1;

					if (line.replace(/^\t+/u, "") === d) {
						break;
					}

					body += `${line}\n`;
				}

				if (!quoted) {
					expansions(body);
				}
			}
		} else if (c === "(") {
			endCmd();
			parens++;
			i++;
		} else if (c === ")") {
			endCmd();

			if (parens > 0) {
				parens--;
			}

			i++;
		} else if (
			c === ";" ||
			c === "&" ||
			c === "|" ||
			(c === "{" && /\s/u.test(s[i + 1] ?? " ")) ||
			(c === "}" && word === null)
		) {
			endCmd();
			i++;
		} else if (c === "#" && word === null) {
			while (i < s.length && s.charAt(i) !== "\n") {
				i++;
			}
		} else if (/\s/u.test(c)) {
			endWord();
			i++;
		} else {
			word = (word ?? "") + c;
			i++;
		}
	}

	endCmd();

	return i;
}
