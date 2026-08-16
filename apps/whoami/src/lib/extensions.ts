// Extension / mod detection, client-side, via CSS style-injection (Laperdrix et al.,
// "Fingerprinting in Style," USENIX Security 2021). A page can't read an extension's
// injected stylesheet, but it CAN observe the STYLE'S EFFECT: plant a decoy element
// matching the selector an extension targets, plant an identical baseline sibling
// that doesn't match, and diff getComputedStyle. The baseline is the positive
// control — it's what makes "was a style applied?" a decidable question instead of
// a guess.
//
// Two honesty caveats baked into the reporting:
//   1. A CLEAN result is ambiguous — it means "no extension" OR "a defense (e.g.
//      routing getComputedStyle through a Shadow DOM) is active." We say so.
//   2. This ships a small, hand-seeded bait list. Real breadth needs a maintained,
//      versioned trigger corpus (the published one is Chrome-only and from 2021);
//      the METHOD is browser-agnostic and works on Firefox, the SELECTORS rot.

export type ExtConfidence = "detected" | "likely" | "observed";

export interface ExtFinding {
	id: string;
	name: string;
	method: string;
	detail: string;
	confidence: ExtConfidence;
}

interface Bait {
	id: string;
	name: string;
	/** Class/id applied to the trigger element (the thing an extension's CSS targets) */
	trigger: { tag?: string; id?: string; className?: string; html?: string };
	/** Which computed properties to compare against the baseline */
	props: string[];
	method: string;
	detail: string;
}

// Hand-seeded baits. Each targets a selector a known extension class injects CSS for.
const BAITS: Bait[] = [
	{
		id: "content-blocker.ad-slot",
		name: "Content blocker (uBlock Origin / AdGuard / ABP)",
		trigger: { className: "ad-slot banner_ad sponsored-ad adsbox" },
		props: ["display", "visibility", "height", "opacity"],
		method: "cosmetic-filter bait",
		detail:
			"An element carrying common ad-slot classes was hidden by an injected cosmetic filter, while an identical element without those classes stayed visible. That's an element-hiding blocker. (Distinguishing uBO from AdGuard/ABP needs filter-list-specific bait.)",
	},
	{
		id: "content-blocker.pubad",
		name: "Content blocker (element hiding)",
		trigger: { id: "pub_300x250", className: "adsbygoogle" },
		props: ["display", "visibility", "height"],
		method: "ad-unit id bait",
		detail:
			"A canonical ad-unit id was hidden by an injected rule while its baseline twin was not — a second, independent element-hiding signal.",
	},
];

function applyTrigger(el: HTMLElement, t: Bait["trigger"]): void {
	if (t.id) el.id = t.id;
	if (t.className) el.className = t.className;
	if (t.html) el.innerHTML = t.html;
}

/**
 * Run the probes. Returns findings plus a `clean` flag whose meaning is explicitly ambiguous (see
 * the module note). Async because injected styles need a paint tick to take effect.
 */
export async function detectExtensions(): Promise<{ findings: ExtFinding[]; ran: boolean }> {
	if (typeof document === "undefined") return { findings: [], ran: false };

	const host = document.createElement("div");
	// Off-screen but still laid out and styled — display:none would suppress the very
	// effects we're trying to read.
	host.style.cssText =
		"position:absolute;left:-99999px;top:0;width:400px;height:400px;pointer-events:none;";
	document.body.appendChild(host);

	const findings: ExtFinding[] = [];

	// A MutationObserver catches <style>/<link> nodes injected after we mount — a
	// browser-agnostic corroborating signal (some extensions inject page-wide styles).
	let injectedNodes = 0;
	const obs = new MutationObserver((records) => {
		for (const r of records) {
			for (const node of Array.from(r.addedNodes)) {
				if (
					node.nodeType === 1 &&
					((node as Element).tagName === "STYLE" || (node as Element).tagName === "LINK")
				) {
					injectedNodes++;
				}
			}
		}
	});
	obs.observe(document.documentElement, { childList: true, subtree: true });

	for (const bait of BAITS) {
		const trigger = document.createElement(bait.trigger.tag ?? "div");
		const baseline = document.createElement(bait.trigger.tag ?? "div");
		trigger.textContent = baseline.textContent = "​";
		trigger.style.cssText = baseline.style.cssText = "width:80px;height:40px;display:block;";
		applyTrigger(trigger, bait.trigger);
		host.appendChild(baseline);
		host.appendChild(trigger);
	}

	// Let injected stylesheets apply.
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

	// Re-read: children are [baseline, trigger] pairs in order.
	const kids = Array.from(host.children) as (HTMLElement | undefined)[];
	let ci = 0;
	for (const bait of BAITS) {
		const baseline: HTMLElement | undefined = kids[ci++];
		const trigger: HTMLElement | undefined = kids[ci++];
		if (!baseline || !trigger) continue;
		const cbase = getComputedStyle(baseline);
		const ctrig = getComputedStyle(trigger);
		const diffs: string[] = [];
		for (const p of bait.props) {
			const a = cbase.getPropertyValue(p);
			const b = ctrig.getPropertyValue(p);
			if (a !== b) diffs.push(`${p}: ${b || "(empty)"} vs baseline ${a || "(empty)"}`);
		}
		// Geometry check catches height/collapse that computed style might report as auto.
		if (trigger.offsetHeight === 0 && baseline.offsetHeight > 0) {
			diffs.push("collapsed to zero height while baseline kept its size");
		}
		if (diffs.length) {
			findings.push({
				id: bait.id,
				name: bait.name,
				method: bait.method,
				detail: `${bait.detail}  [${diffs.join("; ")}]`,
				confidence: "detected",
			});
		}
	}

	obs.disconnect();
	host.remove();

	if (injectedNodes > 0) {
		findings.push({
			id: "injected-stylesheets",
			name: "Page-wide style injection",
			method: "MutationObserver",
			detail: `${String(injectedNodes)} <style>/<link> node(s) were injected into the page after load — consistent with an extension (a theming or blocking add-on) rewriting the page. This is a hint, not an identification.`,
			confidence: "observed",
		});
	}

	return { findings, ran: true };
}
