import { Record } from "effect";

import type { SelectionDecisions } from "./workflow.ts";

interface JobRule {
	readonly inputs: readonly RegExp[];
	readonly packages?: readonly RegExp[];
}

const checkInfrastructure =
	/^(?:\.github\/(?:workflows|actions|codeql)\/|tools\/ci-manager\/|turbo\.json$|mise\.(?:toml|lock)$)/u;
const cargoInputs = /^(?:Cargo\.(?:toml|lock)$|rust-toolchain(?:\.toml)?$|\.cargo\/)/u;
const scanInfrastructure =
	/^(?:\.github\/workflows\/(?:ci|codeql(?:-full)?)\.yml$|\.github\/(?:actions|codeql)\/|tools\/ci-manager\/|mise\.(?:toml|lock)$)/u;

// These app workflows consume Cargo configuration and their affected package graph.
const appCheck = (owner: RegExp): JobRule => ({
	inputs: [checkInfrastructure, cargoInputs, owner],
	packages: [owner],
});

const rules: Record<Exclude<keyof SelectionDecisions, "js" | "build" | "test">, JobRule> = {
	"manager-rust": appCheck(/^apps\/manager(?:\/|$)/u),
	"courier-rust": appCheck(/^apps\/courier(?:\/|$)/u),
	"dispatcher-rust": appCheck(/^apps\/dispatcher(?:\/|$)/u),
	"control-plane-rust": appCheck(/^apps\/control-plane(?:\/|$)/u),
	"box-agent-rust": appCheck(/^apps\/box-agent(?:\/|$)/u),
	point: appCheck(/^apps\/point(?:\/|$)/u),
	"codeql-js": {
		inputs: [
			scanInfrastructure,
			// CodeQL source discovery: FileType.JS, TYPESCRIPT and HTML.
			// https://github.com/github/codeql/blob/codeql-cli/v2.27.1/javascript/extractor/src/com/semmle/js/extractor/FileExtractor.java#L104-L226
			/\.(?:js|jsx|mjs|cjs|es6|es|xsjs|xsjslib|ts|tsx|mts|cts|htm|html|xhtm|xhtml|vue|hbs|ejs|njk|jsp|html\.erb|html\.dot)$/u,
			// Framework inputs and build/configuration inputs are conservative scan triggers.
			/\.(?:svelte|astro)$/u,
			/^packages\/tsconfig\//u,
			/(?:^|\/)(?:package\.json|pnpm-(?:lock|workspace)\.yaml|tsconfig(?:\.[^/]*)?\.json|turbo\.json|\.npmrc)$/u,
		],
	},
	"codeql-python": {
		inputs: [
			scanInfrastructure,
			// Python default discovery: PY_EXTENSIONS; .pyi is a conservative stub trigger.
			// https://github.com/github/codeql/blob/codeql-cli/v2.27.1/python/extractor/semmle/util.py#L11-L17
			/\.(?:py|pyw|pyi)$/u,
			/(?:^|\/)(?:pyproject\.toml|(?:requirements|constraints)(?:[-.][^/]*)?\.txt|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|setup\.cfg|tox\.ini|\.python-version)$/u,
			/^apps\/manager\/docs\/contracts\/schemas\//u,
		],
	},
	actions: { inputs: [scanInfrastructure, /^\.github\/workflows\//u] },
	rust: {
		inputs: [
			scanInfrastructure,
			/(?:\.rs$|(?:^|\/)Cargo\.(?:toml|lock)$|(?:^|\/)rust-toolchain(?:\.toml)?$|(?:^|\/)\.cargo\/)/u,
		],
	},
};

export function selectJobs(paths: readonly string[], affectedPackages: readonly string[] = []) {
	return Record.map(
		rules,
		(rule) =>
			paths.some((path) => rule.inputs.some((input) => input.test(path))) ||
			affectedPackages.some((path) => rule.packages?.some((owner) => owner.test(path))),
	);
}
