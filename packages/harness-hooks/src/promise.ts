// promise: the command line of the promise ledger (promise-ledger.ts).
//
//   promise sweep                       one run of ingest, record, remind and vault outbox (the scheduled job)
//   promise list [--all]                open items, or with --all the 50 most recent of any state
//   promise show <id>                   one item in full
//   promise done <id[,id...]> [evidence]    close: it was delivered
//   promise drop <id[,id...]> <reason>      close: it no longer applies
//   promise snooze <id[,id...]> <when>      new due time: 90m, 2h, 3d, tomorrow, "friday 9", 2026-01-02T09:00
//   promise remind <name> <when> [prompt]   a timed reminder; the prompt is read from stdin when omitted
//   promise pause | resume              stop or restart reminders (capture and closing keep running)
//   promise status                      the session-start line and the last sweep
//
// Times without a zone are read in PROMISE_TZ. Configuration is in the environment (configFromEnv).
import { readFileSync } from "node:fs";

import { instant, parseDue } from "./promise-due.ts";
import type { Config, Item } from "./promise-ledger.ts";
import { clip, configFromEnv, depsFromEnv, Ledger, span, statusLine } from "./promise-ledger.ts";

function fail(message: string): never {
	process.stderr.write(`promise: ${message}\n`);
	process.exit(2);
}

/** A due time from "90m", "2h", "3d", a local ISO time, or words the promise parser knows. */
export function when(text: string, now: number, config: Config): number | undefined {
	const rel = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)[a-z]*$/iu.exec(text.trim());

	if (rel) {
		const unit = rel[2]?.toLowerCase().startsWith("m")
			? 60_000
			: rel[2]?.toLowerCase() === "d"
				? 86_400_000
				: 3_600_000;

		return now + Number(rel[1]) * unit;
	}

	const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/u.exec(text.trim());

	if (iso) {
		return instant(
			config.timeZone,
			Number(iso[1]),
			Number(iso[2]),
			Number(iso[3]),
			Number(iso[4] ?? 9),
			Number(iso[5] ?? 0),
		);
	}

	const zoned = Date.parse(text);

	return Number.isNaN(zoned) ? parseDue(text, now, config)?.at : zoned;
}

function line(item: Item, now: number, config: Config) {
	const local = new Intl.DateTimeFormat("sv-SE", {
		timeZone: config.timeZone,
		dateStyle: "short",
		timeStyle: "short",
	});
	const open =
		item.due > now
			? `due in ${span(item.due - now)}`
			: `OVERDUE ${span(now - item.due)}${item.escalated ? ", out of reminders" : ""}`;
	const state = item.state === "open" ? open : `${item.state} by ${item.closed_by ?? "?"}`;
	const where =
		item.kind === "reminder"
			? `reminder ${item.name ?? ""}`
			: `${item.surface} ${item.room}`.trim();

	return `#${String(item.id)} ${state} (${local.format(item.due)}) ${where}: ${clip(item.text, 110)}`;
}

function ids(text: string | undefined): number[] {
	const list = (text ?? "").split(",").map((s) => Number(s.replace(/^#/u, "")));

	return list.length > 0 && list.every((n) => Number.isInteger(n) && n > 0)
		? list
		: fail("give an id, or ids separated by commas");
}

function main(argv: string[]) {
	const [command, ...rest] = argv;
	const config = configFromEnv();

	if (command === "status") {
		const text = statusLine(config.store, Date.now());

		process.stdout.write(`${text || "Promise ledger: no store yet."}\n`);

		if (text) {
			const ledger = new Ledger(config, depsFromEnv());

			process.stdout.write(
				`last sweep: ${ledger.meta("last_sweep") ?? "never"}\npaused: ${ledger.meta("paused") === "1" ? "yes" : "no"}\n`,
			);

			ledger.close();
		}

		return;
	}

	const ledger = new Ledger(config, depsFromEnv());
	const now = ledger.deps.now();

	try {
		switch (command ?? "") {
			case "sweep": {
				// Quiet on stdout: the scheduler delivers whatever a job prints.
				process.stderr.write(`${JSON.stringify(ledger.sweep())}\n`);

				break;
			}

			case "list": {
				const items = rest.includes("--all")
					? ledger.items("1 = 1 ORDER BY id DESC LIMIT 50 --")
					: ledger.items();

				process.stdout.write(
					items.length > 0
						? `${items.map((i) => line(i, now, config)).join("\n")}\n`
						: "nothing open\n",
				);

				break;
			}

			case "show": {
				const item = ledger.item(ids(rest[0])[0] ?? 0);

				process.stdout.write(`${item ? JSON.stringify(item, null, 1) : "no such item"}\n`);

				break;
			}

			case "done":
			case "drop": {
				const evidence = rest.slice(1).join(" ").trim();

				if (command === "drop" && !evidence) {
					fail("drop needs a reason");
				}

				for (const id of ids(rest[0])) {
					process.stdout.write(
						`${line(ledger.closeItem(id, command === "done" ? "done" : "dropped", "command", evidence), now, config)}\n`,
					);
				}

				break;
			}

			case "snooze": {
				const due = when(rest.slice(1).join(" "), now, config);

				if (due === undefined || due <= now) {
					fail("snooze needs a time ahead: 90m, 2h, 3d, tomorrow, 2026-01-02T09:00");
				}

				for (const id of ids(rest[0])) {
					process.stdout.write(`${line(ledger.snooze(id, due), now, config)}\n`);
				}

				break;
			}

			case "remind": {
				const [name, at, ...words] = rest;
				const due = when(at ?? "", now, config);

				if (!name || !/^[\w.-]{1,56}$/u.test(name) || due === undefined) {
					fail("usage: promise remind <name> <when> [prompt]");
				}

				const prompt = (words.length > 0 ? words.join(" ") : readFileSync(0, "utf8")).trim();

				if (!prompt) {
					fail("empty prompt");
				}

				process.stdout.write(`${line(ledger.addReminder(name, due, prompt), now, config)}\n`);

				break;
			}

			case "pause":
			case "resume": {
				ledger.setMeta("paused", command === "pause" ? "1" : "0");
				process.stdout.write(command === "pause" ? "reminders paused\n" : "reminders resumed\n");

				break;
			}

			default: {
				fail("commands: sweep, list, show, done, drop, snooze, remind, pause, resume, status");
			}
		}
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	} finally {
		ledger.close();
	}
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
	main(process.argv.slice(2));
}
