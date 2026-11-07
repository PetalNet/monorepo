import { describe, expect, it } from "vitest";

import { isDarkTheme, isPlantUmlPath, parseBlobUrl, resolveInclude } from "./domain.ts";

describe("GitHub paths", () => {
	it("parses a blob URL and recognizes supported extensions", () => {
		expect(parseBlobUrl(new URL("https://github.com/a/b/blob/main/docs/A.PUML"))).toEqual({
			owner: "a",
			repository: "b",
			ref: "main",
			path: "docs/A.PUML",
		});

		expect(isPlantUmlPath("diagram.iuml")).toBe(true);
		expect(isPlantUmlPath("diagram.svg")).toBe(false);
	});

	it("resolves includes without allowing repository escapes", () => {
		const raw = new URL("https://github.com/a/b/raw/main/docs/diagrams/a.puml");

		expect(
			resolveInclude({ rawUrl: raw, path: "docs/diagrams/a.puml" }, "../style.puml")?.rawUrl
				.pathname,
		).toBe("/a/b/raw/main/docs/style.puml");

		expect(
			resolveInclude({ rawUrl: raw, path: "docs/diagrams/a.puml" }, "../../../../secret.puml"),
		).toBeNull();
	});

	it("resolves nested includes from the included file", () => {
		const root = new URL("https://github.com/a/b/raw/main/diagrams/main.puml");
		const common = resolveInclude(
			{ rawUrl: root, path: "diagrams/main.puml" },
			"styles/common.puml",
		);

		expect(common).toMatchObject({ path: "diagrams/styles/common.puml" });
		const icons = common === null ? null : resolveInclude(common, "icons.puml");

		expect(icons?.path).toBe("diagrams/styles/icons.puml");
		expect(icons?.rawUrl.pathname).toBe("/a/b/raw/main/diagrams/styles/icons.puml");
	});

	it("keeps same-named includes distinct by their containing directory", () => {
		const aStyle = resolveInclude(
			{
				rawUrl: new URL("https://github.com/a/b/raw/main/a/one.puml"),
				path: "a/one.puml",
			},
			"style.puml",
		);
		const bStyle = resolveInclude(
			{
				rawUrl: new URL("https://github.com/a/b/raw/main/b/two.puml"),
				path: "b/two.puml",
			},
			"style.puml",
		);

		if (aStyle === null || bStyle === null) {
			throw new Error("Expected same-named includes to resolve.");
		}

		expect(aStyle.path).toBe("a/style.puml");
		expect(aStyle.rawUrl.pathname).toBe("/a/b/raw/main/a/style.puml");
		expect(bStyle.path).toBe("b/style.puml");
		expect(bStyle.rawUrl.pathname).toBe("/a/b/raw/main/b/style.puml");
		expect(aStyle).not.toEqual(bStyle);

		const nested = resolveInclude(aStyle, "nested.puml");

		if (nested === null) {
			throw new Error("Expected nested include to resolve.");
		}

		expect(nested.path).toBe("a/nested.puml");
		expect(nested.rawUrl.pathname).toBe("/a/b/raw/main/a/nested.puml");
	});

	it("uses GitHub's selected color mode and theme slot", () => {
		const root = document.documentElement;

		root.dataset["lightTheme"] = "light";
		root.dataset["darkTheme"] = "dark";
		root.dataset["colorMode"] = "dark";
		expect(isDarkTheme(root, false)).toBe(true);
		root.dataset["colorMode"] = "light";
		expect(isDarkTheme(root, true)).toBe(false);
		root.dataset["colorMode"] = "auto";
		expect(isDarkTheme(root, false)).toBe(false);
		expect(isDarkTheme(root, true)).toBe(true);
		root.dataset["darkTheme"] = "dark_dimmed";
		expect(isDarkTheme(root, true)).toBe(true);
	});
});
