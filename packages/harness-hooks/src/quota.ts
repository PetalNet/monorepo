// quota: show current usage across every limited service the lab uses, and check thresholds.
//
//   quota [--json]           print one line per service (or JSON with --json)
//   quota check [--dry-run]  check limits against 88% / 98% and inject once per limit per reset window
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { defaultSourceDeps, readAllServices } from "./quota-sources.ts";
import { formatReport, runCheck, watchConfigFromEnv, watchDepsFromEnv } from "./quota-watch.ts";

const USAGE = ["usage: quota [--json]", "       quota check [--dry-run]"].join("\n");

async function main(argv: string[]): Promise<void> {
	const [first, ...rest] = argv;

	if (first === "-h" || first === "--help" || first === "help") {
		process.stdout.write(`${USAGE}\n`);

		return;
	}

	const config = watchConfigFromEnv();

	if (first === "check") {
		const dryRun = rest.includes("--dry-run");
		const unknown = rest.filter((arg) => arg !== "--dry-run");

		if (unknown.length > 0) {
			process.stderr.write(`quota check: unknown option ${unknown.join(" ")}\n${USAGE}\n`);
			process.exitCode = 2;

			return;
		}

		const result = await runCheck(config, watchDepsFromEnv(config), { dryRun });
		const summary = {
			checkedAt: result.checkedAt,
			crossed: result.crossed.map((c) => ({
				limitId: c.limitId,
				threshold: c.threshold,
				usedPct: c.usedPct,
				windowId: c.windowId,
			})),
			injected: result.injected.length,
			sourceErrors: result.sourceErrors,
			injectErrors: result.injectErrors,
		};

		process.stderr.write(`${JSON.stringify(summary)}\n`);

		if (dryRun) {
			process.stdout.write(`${formatReport(result.services)}\n`);

			if (result.crossed.length > 0) {
				for (const crossing of result.crossed) {
					process.stdout.write(`WOULD INJECT: ${crossing.prompt}\n`);
				}
			} else {
				process.stdout.write("no new threshold crossings\n");
			}
		} else if (result.injectErrors.length > 0) {
			// Quiet on stdout when all injections succeed: Hermes no_agent jobs deliver stdout.
			process.stdout.write(`quota check: ${result.injectErrors.join("; ")}\n`);
			process.exitCode = 1;
		}

		return;
	}

	if (first === undefined || first === "status" || first === "--json") {
		const args = first === "status" ? rest : argv;
		const asJson = args.includes("--json");
		const unknown = args.filter((arg) => arg !== "--json");

		if (unknown.length > 0) {
			process.stderr.write(`quota: unknown option ${unknown.join(" ")}\n${USAGE}\n`);
			process.exitCode = 2;

			return;
		}

		const reports = await readAllServices(config.source, defaultSourceDeps());

		if (asJson) {
			process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
		} else {
			process.stdout.write(`${formatReport(reports)}\n`);
		}

		if (reports.some((r) => r.status === "error")) {
			process.exitCode = 1;
		}

		return;
	}

	process.stderr.write(`quota: unknown command ${first}\n${USAGE}\n`);
	process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	try {
		await main(process.argv.slice(2));
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);

		process.stderr.write(`quota: ${msg}\n`);
		process.exitCode = 1;
	}
}
