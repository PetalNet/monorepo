const marker = "data-gh-plantuml";

function saveCodeState(code: HTMLElement): void {
	if (code.dataset["ghPumlSelected"] !== undefined) {
		return;
	}

	const button = code.querySelector<HTMLButtonElement>("button");

	code.dataset["ghPumlSelected"] = String(code.dataset["selected"] !== undefined);
	code.dataset["ghPumlPressed"] = button?.getAttribute("aria-pressed") ?? "";
	code.dataset["ghPumlSeparator"] = button?.style.getPropertyValue("--separator-color") ?? "";
}

function setSelected(item: HTMLElement, selected: boolean): void {
	const button = item.querySelector<HTMLButtonElement>("button");

	item.toggleAttribute("data-selected", selected);
	button?.setAttribute("aria-pressed", String(selected));

	button?.style.setProperty(
		"--separator-color",
		selected ? "transparent" : "var(--borderColor-default)",
	);
}

function restoreCodeState(code: HTMLElement): void {
	const button = code.querySelector<HTMLButtonElement>("button");

	code.toggleAttribute("data-selected", code.dataset["ghPumlSelected"] === "true");
	button?.setAttribute("aria-pressed", code.dataset["ghPumlPressed"] ?? "true");
	button?.style.setProperty("--separator-color", code.dataset["ghPumlSeparator"] ?? "");
}

export function setFileMode(
	section: HTMLElement,
	preview: HTMLElement,
	mode: "preview" | "code",
): void {
	for (const child of section.children) {
		if (child !== preview && child instanceof HTMLElement) {
			child.hidden = mode === "preview";
		}
	}

	preview.hidden = mode === "code";
	const item = document.querySelector<HTMLElement>(`[${marker}='preview-item']`);
	const controls = Array.from(
		document.querySelector<HTMLUListElement>("ul[aria-label='File view']")?.children ?? [],
	).filter((child): child is HTMLElement => child instanceof HTMLElement);
	const code = controls.find(
		(child) =>
			child.getAttribute(marker) !== "preview-item" &&
			child.querySelector("button[aria-pressed]") !== null,
	);

	if (item !== null) {
		setSelected(item, mode === "preview");
	}

	if (code !== undefined) {
		saveCodeState(code);

		if (mode === "preview") {
			setSelected(code, false);
		} else {
			restoreCodeState(code);
		}
	}
}
