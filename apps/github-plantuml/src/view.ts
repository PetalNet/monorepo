export type DiffMode = "two-up" | "swipe" | "onion-skin";

function octicon(path: string): SVGSVGElement {
	const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");

	icon.setAttribute("viewBox", "0 0 16 16");
	icon.setAttribute("width", "16");
	icon.setAttribute("height", "16");
	icon.setAttribute("aria-hidden", "true");
	const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");

	shape.setAttribute("d", path);
	icon.append(shape);

	return icon;
}

export function sourceIcon(): SVGSVGElement {
	return octicon(
		"m11.28 3.22 4 4a.75.75 0 0 1 0 1.06l-4 4a.75.75 0 0 1-1.06-1.06L13.69 8l-3.47-3.22a.75.75 0 0 1 1.06-1.56ZM4.72 3.22a.75.75 0 0 1 0 1.06L1.25 8l3.47 3.22a.75.75 0 1 1-1.06 1.06l-4-4a.75.75 0 0 1 0-1.06l4-4a.75.75 0 0 1 1.06 0Z",
	);
}

export function richIcon(): SVGSVGElement {
	return octicon(
		"M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25V2.75A1.75 1.75 0 0 0 14.25 1Zm.75 2.5a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5ZM3 8h4v4H3Zm6 0h4v1H9Zm0 2h4v1H9Zm0 2h4v1H9Z",
	);
}

function image(src: string, alt: string): HTMLImageElement {
	const element = document.createElement("img");

	element.src = src;
	element.alt = alt;

	return element;
}

function setDiffMode(root: HTMLElement, mode: DiffMode): void {
	root.dataset["mode"] = mode;

	for (const view of root.querySelectorAll<HTMLElement>(".view")) {
		view.hidden = !view.classList.contains(mode);
	}

	for (const label of root.querySelectorAll<HTMLElement>(".js-view-mode-item")) {
		label.classList.toggle(
			"selected",
			label.querySelector<HTMLInputElement>("input")?.value === mode,
		);
	}
}

export function createError(message: string): HTMLElement {
	const error = document.createElement("div");

	error.className = "flash flash-error gh-puml-error";
	error.setAttribute("role", "alert");
	error.textContent = `PlantUML preview could not be rendered: ${message}`;

	return error;
}

export function createPreview(src: string, label: string): HTMLElement {
	const preview = document.createElement("div");

	preview.className = "gh-puml-preview Box-body";
	preview.append(image(src, `${label} PlantUML diagram`));

	return preview;
}

function frame(kind: "deleted" | "added", src: string, label: string): HTMLElement {
	const shell = document.createElement("span");

	shell.className = "shell";
	const title = document.createElement("span");

	title.className = `frame-label label-${kind}`;
	title.textContent = label;
	const border = document.createElement("span");

	border.className = `${kind}-frame`;
	const picture = image(src, `${label} PlantUML diagram`);

	border.append(picture);
	const meta = document.createElement("p");

	meta.className = `${kind}-meta`;
	meta.textContent = "W: …px | H: …px";

	picture.addEventListener("load", () => {
		meta.textContent = `W: ${String(picture.naturalWidth)}px | H: ${String(picture.naturalHeight)}px`;
	});

	shell.append(title, border, meta);

	return shell;
}

function pointerSlider(target: HTMLElement, update: (percent: number) => void): void {
	target.addEventListener("pointerdown", (event) => {
		target.setPointerCapture(event.pointerId);

		const move = (next: PointerEvent) => {
			const box = target.getBoundingClientRect();

			update(Math.max(0, Math.min(100, ((next.clientX - box.left) / box.width) * 100)));
		};

		move(event);
		target.addEventListener("pointermove", move);

		target.addEventListener(
			"pointerup",
			() => {
				target.removeEventListener("pointermove", move);
			},
			{
				once: true,
			},
		);
	});
}

function alignPairedImages(
	root: HTMLElement,
	before: HTMLImageElement,
	after: HTMLImageElement,
): void {
	const update = () => {
		if (before.naturalWidth === 0 || after.naturalWidth === 0) {
			return;
		}

		const maximumWidth = Math.max(before.naturalWidth, after.naturalWidth);
		const maximumHeight = Math.max(before.naturalHeight, after.naturalHeight);

		root.style.setProperty("--gh-puml-diff-width", `${String(maximumWidth)}px`);
		root.style.setProperty("--gh-puml-diff-height", `${String(maximumHeight)}px`);
		root.style.setProperty("--gh-puml-before-scale", String(before.naturalWidth / maximumWidth));
		root.style.setProperty("--gh-puml-after-scale", String(after.naturalWidth / maximumWidth));
	};

	before.addEventListener("load", update);
	after.addEventListener("load", update);
}

export function createDiff(before: string | null, after: string | null): HTMLElement {
	const root = document.createElement("section");

	root.className = "gh-puml-diff render-shell";
	root.setAttribute("aria-label", "PlantUML rich diff");
	root.dataset["plantumlDiff"] = "";

	if (before === null || after === null) {
		root.append(createPreview(before ?? after ?? "", before === null ? "Added" : "Deleted"));

		return root;
	}

	const twoUp = document.createElement("div");

	twoUp.className = "two-up view";
	twoUp.append(frame("deleted", before, "Deleted"), frame("added", after, "Added"));
	const swipe = document.createElement("div");

	swipe.className = "swipe view";
	swipe.hidden = true;
	const swipeFrame = document.createElement("div");

	swipeFrame.className = "swipe-frame";
	const old = document.createElement("span");

	old.className = "deleted-frame";
	const beforeSwipeImage = image(before, "Deleted PlantUML diagram");

	old.append(beforeSwipeImage);
	const shell = document.createElement("span");

	shell.className = "swipe-shell";
	const added = document.createElement("span");

	added.className = "added-frame";
	const afterSwipeImage = image(after, "Added PlantUML diagram");

	added.append(afterSwipeImage);
	alignPairedImages(swipeFrame, beforeSwipeImage, afterSwipeImage);
	shell.append(added);
	const swipeBar = document.createElement("span");

	swipeBar.className = "swipe-bar";

	for (const handle of ["top-handle", "bottom-handle"]) {
		const element = document.createElement("span");

		element.className = handle;
		swipeBar.append(element);
	}

	pointerSlider(swipeFrame, (percent) => {
		shell.style.width = `${String(100 - percent)}%`;
		swipeBar.style.left = `${String(percent)}%`;
	});

	swipeFrame.append(old, shell, swipeBar);
	swipe.append(swipeFrame);
	const onion = document.createElement("div");

	onion.className = "onion-skin view";
	onion.hidden = true;
	const onionFrame = document.createElement("div");

	onionFrame.className = "onion-skin-frame";
	const onionOld = document.createElement("span");

	onionOld.className = "deleted-frame";
	const beforeOnionImage = image(before, "Deleted PlantUML diagram");

	onionOld.append(beforeOnionImage);
	const onionNew = document.createElement("span");

	onionNew.className = "added-frame";
	const afterOnionImage = image(after, "Added PlantUML diagram");

	onionNew.append(afterOnionImage);
	alignPairedImages(onionFrame, beforeOnionImage, afterOnionImage);
	const controls = document.createElement("div");

	controls.className = "controls";
	const transparent = document.createElement("span");

	transparent.className = "transparent";
	const slider = document.createElement("div");

	slider.className = "slider";
	const track = document.createElement("span");

	track.className = "slider-track";
	const dragger = document.createElement("span");

	dragger.className = "dragger";
	track.append(dragger);
	slider.append(track);
	const opaque = document.createElement("span");

	opaque.className = "opaque";

	pointerSlider(slider, (percent) => {
		onionNew.style.opacity = String(percent / 100);
		dragger.style.left = `${String(percent)}%`;
	});

	controls.append(transparent, slider, opaque);
	onionFrame.append(onionOld, onionNew, controls);
	onion.append(onionFrame);
	const bar = document.createElement("div");

	bar.className = "render-bar render-bar-with-modes";
	const fieldset = document.createElement("fieldset");

	fieldset.className = "render-view-modes";
	fieldset.setAttribute("aria-label", "View mode");
	const group = `plantuml-${crypto.randomUUID()}`;

	for (const [mode, label] of [
		["two-up", "2-up"],
		["swipe", "Swipe"],
		["onion-skin", "Onion Skin"],
	] as const) {
		const labelElement = document.createElement("label");

		labelElement.className = "js-view-mode-item";
		const input = document.createElement("input");

		input.type = "radio";
		input.name = group;
		input.value = mode;
		input.checked = mode === "two-up";

		input.addEventListener("change", () => {
			setDiffMode(root, mode);
		});

		labelElement.append(input, label);
		fieldset.append(labelElement);
	}

	bar.append(fieldset);
	root.append(twoUp, swipe, onion, bar);
	setDiffMode(root, "two-up");

	return root;
}
