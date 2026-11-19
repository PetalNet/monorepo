import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../apps/fold-cards/bin/bundle.py", import.meta.url));

/** Resolve project pointers and scan the entire brief before a worker receives it. */
export function prepareDelegation(
	prompt: string,
):
	| { readonly kind: "ready"; readonly prompt: string }
	| { readonly kind: "refused"; readonly reason: string } {
	if (!/^Project:\s*[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}\s*$/mu.test(prompt)) {
		return {
			kind: "refused",
			reason: "Add a Project: <id> line registered in CONTEXT_BUNDLE_CONFIG.",
		};
	}

	const result = spawnSync("python3", ["-B", "-I", script], {
		input: prompt,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 128 * 1024,
	});

	if (result.status !== 0 || result.error || result.stderr || !result.stdout.startsWith(prompt)) {
		return {
			kind: "refused",
			reason:
				"Context bundle or shared secret scan failed. Check project registration, existing indexes, and scanner configuration locally.",
		};
	}

	return { kind: "ready", prompt: result.stdout };
}
