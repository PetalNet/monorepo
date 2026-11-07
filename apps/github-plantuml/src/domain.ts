const plantUmlExtension = /\.(?:puml|plantuml|pu|iuml)$/iu;

export interface GitHubBlob {
	owner: string;
	repository: string;
	ref: string;
	path: string;
}

export interface IncludeSource {
	rawUrl: URL;
	path: string;
}

export interface ResolvedInclude {
	rawUrl: URL;
	path: string;
}

export function isPlantUmlPath(path: string): boolean {
	return plantUmlExtension.test(path);
}

export function parseBlobUrl(url: URL): GitHubBlob | null {
	const parts = url.pathname.split("/").filter(Boolean);
	const marker = parts.indexOf("blob");

	if (marker !== 2 || parts.length < 5) {
		return null;
	}

	const [owner, repository] = parts;

	if (owner === undefined || repository === undefined) {
		return null;
	}

	return { owner, repository, ref: parts[3] ?? "", path: parts.slice(4).join("/") };
}

export function rawUrlForCurrentBlob(): URL | null {
	if (!/^\/[^/]+\/[^/]+\/blob\//u.test(location.pathname)) {
		return null;
	}

	return new URL(location.pathname.replace("/blob/", "/raw/"), location.origin);
}

export function resolveInclude(source: IncludeSource, includePath: string): ResolvedInclude | null {
	if (includePath.startsWith("/") || /^[a-z]+:/iu.test(includePath)) {
		return null;
	}

	const normalized = includePath.replaceAll("\\", "/");
	const rawUrl = new URL(normalized, source.rawUrl);
	const root = /^\/([^/]+)\/([^/]+)\/raw\//u.exec(source.rawUrl.pathname)?.[0];
	const path = new URL(normalized, new URL(source.path, "https://github.invalid/")).pathname.slice(
		1,
	);

	return root !== undefined && rawUrl.pathname.startsWith(root) ? { rawUrl, path } : null;
}

export function isDarkTheme(root: HTMLElement, prefersDark: boolean): boolean {
	const mode = root.dataset["colorMode"];
	const theme =
		mode === "dark"
			? root.dataset["darkTheme"]
			: mode === "light"
				? root.dataset["lightTheme"]
				: prefersDark
					? root.dataset["darkTheme"]
					: root.dataset["lightTheme"];

	return theme?.startsWith("dark") ?? prefersDark;
}
