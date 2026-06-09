// Small DOM enhancements ported from the source page: the button ripple (accent
// ink-in from the press point) and the motion-curve replay. Both are
// enhancement-only (no JS → no ripple, curves simply don't animate on demand).

import { reducedMotion } from "./theme.svelte";

function onPointerDown(e: PointerEvent) {
	if (reducedMotion()) return;
	const target = e.target as HTMLElement | null;
	const btn = target?.closest?.(".btn") as HTMLElement | null;
	if (!btn) return;
	const r = btn.getBoundingClientRect();
	const size = Math.max(r.width, r.height) * 2;
	const span = document.createElement("span");
	span.className = "ripple";
	span.style.width = span.style.height = size + "px";
	span.style.left = e.clientX - r.left - size / 2 + "px";
	span.style.top = e.clientY - r.top - size / 2 + "px";
	btn.appendChild(span);
	span.addEventListener("animationend", () => span.remove());
}

/** Attaches the global .btn ripple. Returns a teardown fn. */
export function attachRipple(): () => void {
	document.addEventListener("pointerdown", onPointerDown);
	return () => document.removeEventListener("pointerdown", onPointerDown);
}

/** Replays the .curve animations inside #token-table. */
export function replayCurves() {
	if (reducedMotion()) return;
	const curves = Array.from(document.querySelectorAll<HTMLElement>("#token-table .curve"));
	curves.forEach((c) => {
		c.classList.remove("run");
		void c.offsetWidth;
		c.classList.add("run");
	});
}
