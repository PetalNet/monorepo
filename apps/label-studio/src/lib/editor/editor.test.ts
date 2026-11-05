import type { LabelDoc, Template, TemplateField } from "$lib/doc";
import { describe, expect, it } from "vitest";

import { editor } from "./editor.svelte";
import { emptyDoc } from "./model";
import { templateDraft } from "./persist";

const field = (key: string): TemplateField => ({ key, label: key, kind: "text", default: "" });

const templateWith = (id: string, key: string, extra: Partial<Template> = {}): Template => {
	const doc: LabelDoc = {
		...emptyDoc(12),
		elements: [
			{
				id: `${id}-text`,
				kind: "text",
				x: 0,
				y: 0,
				w: 100,
				h: 40,
				rotate: 0,
				invert: false,
				text: `{{${key}}}`,
				font: "inter",
				size: 40,
				bold: false,
				italic: false,
				align: "left",
				valign: "middle",
				lineHeight: 1.2,
				tracking: 0,
				fit: "fixed",
				widthMode: "fixed",
			},
		],
	};

	return {
		id,
		name: id,
		category: "home",
		description: "",
		doc,
		fields: [field(key)],
		builtin: false,
		updatedAt: "2026-01-01T00:00:00Z",
		...extra,
	};
};

describe("undoing a document load", () => {
	it("brings back the field values and template of a label replaced by a new one", () => {
		editor.loadTemplate(templateWith("asset-tag", "asset"));
		editor.vars.asset = "A-42";
		editor.startBlank(12);

		expect(editor.template).toBeNull();

		editor.undo();

		expect(editor.template?.id).toBe("asset-tag");
		expect(editor.resolvedVars.asset).toBe("A-42");

		editor.redo();

		expect(editor.template).toBeNull();
		expect(editor.vars).toEqual({});
	});

	it("restores each template's own fields when switching between templates", () => {
		editor.loadTemplate(templateWith("asset-tag", "asset"));
		editor.vars.asset = "A-42";
		editor.loadTemplate(templateWith("pantry", "item"));
		editor.vars.item = "Flour";
		editor.undo();

		expect(editor.template?.fields.map((each) => each.key)).toEqual(["asset"]);
		expect(editor.resolvedVars.asset).toBe("A-42");

		editor.redo();

		expect(editor.template?.id).toBe("pantry");
		expect(editor.resolvedVars.item).toBe("Flour");
	});

	it("keeps typed field values when undoing an ordinary edit", () => {
		editor.loadTemplate(templateWith("asset-tag", "asset"));
		editor.add("text");
		editor.vars.asset = "A-42";
		editor.undo();

		expect(editor.doc.elements).toHaveLength(1);
		expect(editor.resolvedVars.asset).toBe("A-42");
	});
});

describe("saving over a loaded template", () => {
	const draft = () => templateDraft(editor.template, editor.doc, editor.vars);

	it("starts from the template's own category and description", () => {
		editor.loadTemplate(
			templateWith("jar", "item", { category: "kitchen", description: "Pantry jars" }),
		);

		expect(draft()).toMatchObject({ name: "jar", category: "kitchen", description: "Pantry jars" });
	});

	it("resets to the next template's metadata when another one is opened", () => {
		editor.loadTemplate(templateWith("jar", "item", { category: "kitchen", description: "Jars" }));
		editor.loadTemplate(templateWith("rack", "host", { category: "lab", description: "" }));

		expect(draft()).toMatchObject({ name: "rack", category: "lab", description: "" });
	});
});
