#!/usr/bin/env node
import { ScannerUnavailable } from "./errors.ts";
import { loadOutboundScanner, readScanInput } from "./outbound-scan.ts";

try {
	if (process.argv.length !== 2) {
		throw new ScannerUnavailable();
	}

	const scan = await loadOutboundScanner();
	const rules = scan([await readScanInput(process.stdin)]);

	if (rules.length > 0) {
		process.stderr.write(`${JSON.stringify({ rules })}\n`);
		process.exitCode = 1;
	}
} catch {
	process.stderr.write('{"error":"scanner-unavailable"}\n');
	process.exitCode = 2;
}
