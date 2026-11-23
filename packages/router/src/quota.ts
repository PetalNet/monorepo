#!/usr/bin/env node
import { quotaMain } from "./quota-pacing-command.ts";

try {
	process.exitCode = await quotaMain(process.argv.slice(2));
} catch {
	process.stderr.write("quota: could not read pacing state\n");
	process.exitCode = 1;
}
