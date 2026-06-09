<script lang="ts">
	import Icon from "./Icon.svelte";
	import { reducedMotion } from "../theme.svelte";
	import { toasts } from "../toasts.svelte";

	/**
	 * The real modal dialog — ported from the source page's IIFE. Escape closes,
	 * focus is trapped, the background <main> goes inert. Enhancement-only: the
	 * backdrop is hidden by default and only the Open button (also enhancement)
	 * reveals it. open()/close() drive the same enter/open classes + transitions.
	 */
	let backdrop = $state<HTMLDivElement>();
	let dialog = $state<HTMLDivElement>();
	let okBtn = $state<HTMLButtonElement>();
	let hidden = $state(true);
	let openClass = $state(false);
	let lastFocus: HTMLElement | null = null;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	function mainEl() {
		return document.querySelector("main.wrap");
	}
	function focusables(): HTMLElement[] {
		if (!dialog) return [];
		return Array.from(
			dialog.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])'),
		).filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
	}

	export function open() {
		if (closeTimer) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
		lastFocus = document.activeElement as HTMLElement;
		hidden = false;
		if (backdrop) {
			backdrop.classList.add("enter");
			void backdrop.offsetWidth;
			backdrop.classList.remove("enter");
		}
		openClass = true;
		const main = mainEl();
		if (main) {
			main.setAttribute("inert", "");
			main.setAttribute("aria-hidden", "true");
		}
		document.addEventListener("keydown", onKey, true);
		okBtn?.focus();
	}

	function close() {
		openClass = false;
		const done = () => {
			hidden = true;
			closeTimer = null;
			backdrop?.removeEventListener("transitionend", done);
		};
		if (reducedMotion()) done();
		else {
			backdrop?.addEventListener("transitionend", done);
			closeTimer = setTimeout(done, 320);
		}
		const main = mainEl();
		if (main) {
			main.removeAttribute("inert");
			main.removeAttribute("aria-hidden");
		}
		document.removeEventListener("keydown", onKey, true);
		try {
			lastFocus?.focus();
		} catch {}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === "Escape") {
			close();
			return;
		}
		if (e.key !== "Tab") return;
		const f = focusables();
		if (!f.length) return;
		const first = f[0],
			last = f[f.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	function onBackdropClick(e: MouseEvent) {
		if (e.target === backdrop) close();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
<div
	class="dialog-backdrop{openClass ? ' open' : ''}"
	id="dialog-backdrop"
	bind:this={backdrop}
	{hidden}
	onclick={onBackdropClick}>
	<div
		class="dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby="dialog-title"
		bind:this={dialog}>
		<div class="dialog-icon">
			<span aria-hidden="true"><Icon name="bell" /></span>
		</div>
		<h3 id="dialog-title">A new question arrived</h3>
		<p>Someone asked the lab something. Open it now, or come back later.</p>
		<div class="dialog-actions">
			<button class="btn btn-ghost" id="dialog-cancel" onclick={close}>Later</button>
			<button
				class="btn btn-primary"
				id="dialog-ok"
				bind:this={okBtn}
				onclick={() => {
					close();
					toasts.fire("Opened the question.");
				}}>Open it</button>
		</div>
	</div>
</div>
