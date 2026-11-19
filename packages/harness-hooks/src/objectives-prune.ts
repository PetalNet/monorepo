// objectives-prune LEDGER ARCHIVE [--write]
// Moves finished ledger items (a finished marker and no open marker anywhere in the item) to ARCHIVE, appended under
// a dated header, and prints the item-ID diff. Without --write it only reports.
// Before writing it re-parses the exact texts it is about to write and refuses unless every original line is in one of
// them and no item with an open marker left the ledger. It writes the ledger through a temp file and rename, and only
// if the ledger is byte-identical to what it read, so a concurrent append is never lost.
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { prunePlan, verify } from "./objectives-index-ledger.ts";

const [ledgerPath, archivePath, flag] = process.argv.slice(2);

if (!ledgerPath || !archivePath) {
	console.error("usage: objectives-prune LEDGER ARCHIVE [--write]");
	process.exit(2);
}

const original = readFileSync(ledgerPath, "utf8");
const { moved, newLedger, archived } = prunePlan(original);
const report = verify(original, newLedger, archived);

console.log(JSON.stringify({ ...report, archivedIds: moved.map((b) => b.id) }, null, 1));

if (report.lost.length > 0 || report.openDropped.length > 0 || !report.linesKept) {
	console.error("refusing: invariant broken");
	process.exit(1);
}

if (flag === "--write" && moved.length > 0) {
	if (readFileSync(ledgerPath, "utf8") !== original) {
		console.error("refusing: the ledger changed while pruning; rerun");
		process.exit(1);
	}

	const stamp = new Date().toISOString().slice(0, 10);

	const entry = `\n## Archived ${stamp} by objectives-prune\n\n${archived}\n`;
	const header =
		"# Open Objectives Archive\n\nFinished items moved out of open-objectives.md. Nothing here is live.\n";

	try {
		// "ax" creates the file and fails if it already exists, so no check-then-write gap.
		appendFileSync(archivePath, header + entry, { flag: "ax" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}

		appendFileSync(archivePath, `\n${entry}`);
	}

	writeFileSync(`${ledgerPath}.prune-tmp`, newLedger);
	renameSync(`${ledgerPath}.prune-tmp`, ledgerPath);
}
