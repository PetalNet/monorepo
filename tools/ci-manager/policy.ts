import { Record } from "effect";

export const nativeApps = {
	"manager-rust": "manager",
	"courier-rust": "courier",
	"dispatcher-rust": "dispatcher",
	"control-plane-rust": "control-plane",
	"box-agent-rust": "box-agent",
	point: "point",
} as const;

export type NativeSelection = { readonly [Job in keyof typeof nativeApps]: boolean } & {
	readonly rust: boolean;
};

export interface CodeQLSelection {
	readonly "codeql-js": boolean;
	readonly "codeql-python": boolean;
	readonly actions: boolean;
}

export function nativeSelection(paths: readonly string[]): NativeSelection {
	const shared = paths.some(
		(path) =>
			path.startsWith(".github/workflows/") ||
			path.startsWith(".github/actions/") ||
			path.startsWith(".github/codeql/") ||
			path.startsWith("tools/ci-manager/") ||
			/^mise\.(?:toml|lock)$/u.test(path),
	);
	// Rust apps have cross-app dependencies: a Rust input selects every native lane.
	const rust =
		shared ||
		paths.some((path) =>
			/(?:\.rs$|(?:^|\/)Cargo\.(?:toml|lock)$|(?:^|\/)rust-toolchain(?:\.toml)?$|(?:^|\/)\.cargo\/)/u.test(
				path,
			),
		);
	const apps = Record.map(
		nativeApps,
		(app) => rust || paths.some((path) => path.startsWith(`apps/${app}/`)),
	);
	return { ...apps, rust };
}

export function codeqlSelection(paths: readonly string[]): CodeQLSelection {
	const shared = paths.some(
		(path) =>
			path === ".github/workflows/ci.yml" ||
			/^\.github\/workflows\/codeql(?:-full)?\.yml$/u.test(path) ||
			path.startsWith(".github/codeql/") ||
			path.startsWith(".github/actions/") ||
			path.startsWith("tools/ci-manager/") ||
			/^mise\.(?:toml|lock)$/u.test(path),
	);
	return {
		"codeql-js":
			shared ||
			paths.some(
				(path) =>
					/\.(?:[cm]?[jt]sx?|svelte|vue|astro|html)$/u.test(path) ||
					path.startsWith("packages/tsconfig/") ||
					/(?:^|\/)(?:package\.json|pnpm-(?:lock|workspace)\.yaml|tsconfig(?:\.[^/]*)?\.json|turbo\.json|\.npmrc)$/u.test(
						path,
					),
			),
		"codeql-python":
			shared ||
			paths.some(
				(path) =>
					/\.pyi?$/u.test(path) ||
					/(?:^|\/)(?:pyproject\.toml|(?:requirements|constraints)(?:[-.][^/]*)?\.txt|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|setup\.cfg|tox\.ini|\.python-version)$/u.test(
						path,
					) ||
					path.startsWith("apps/manager/docs/contracts/schemas/"),
			),
		actions: shared || paths.some((path) => path.startsWith(".github/workflows/")),
	};
}
