<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { SvelteMap } from "svelte/reactivity";

	import {
		createTagScanner,
		idleTagMessage,
		nfcError,
		supportsNfc,
		writeVerifiedTag,
		type NfcState,
	} from "../web-nfc";

	let {
		url,
		number,
		disabled,
		written,
		alreadyWritten,
		finished,
		prepare,
		onactive,
	}: {
		url: string;
		number: number;
		disabled: boolean;
		written: readonly { url: string; number: number }[];
		alreadyWritten: boolean;
		finished: boolean;
		prepare: () => () => Promise<boolean>;
		onactive: (active: boolean) => void;
	} = $props();
	type State =
		| { kind: "idle" }
		| { kind: "read"; message: string }
		| NfcState
		| { kind: "saving" }
		| { kind: "done"; number: number }
		| { kind: "unsaved"; number: number; url: string; save: () => Promise<boolean> }
		| { kind: "error"; message: string };
	let supported = $state(false);
	let phase = $state<State>({ kind: "idle" });
	let controller: AbortController | undefined;
	let granted = false;
	let scanner: ReturnType<typeof createTagScanner> | undefined;
	const verified = new SvelteMap<string, number>();
	let approve: (() => void) | undefined;
	let active = $derived(
		["permission", "waiting", "overwrite", "confirming", "writing", "verifying", "saving"].includes(
			phase.kind,
		),
	);
	onMount(() => {
		supported = supportsNfc();

		if (!supported) {
			return;
		}

		let mounted = true;

		scanner = createTagScanner(
			(event) => {
				if (active || phase.kind === "unsaved") {
					return;
				}

				phase = {
					kind: "read",
					message: idleTagMessage(event, number, [
						...written,
						...Array.from(verified, ([url, number]) => ({ url, number })),
					]),
				};
			},
			() => {
				if (!active && phase.kind !== "unsaved") {
					phase = {
						kind: "error",
						message: "This tag could not be read. Hold one NDEF tag still, or try another tag.",
					};
				}
			},
		);

		const resume = () => {
			if (!mounted || document.hidden || !granted) {
				return;
			}

			void scanner?.start().catch((error: unknown) => {
				if (mounted && !document.hidden && !active && phase.kind !== "unsaved") {
					phase = { kind: "error", message: nfcError(error, false) };
				}
			});
		};

		const stop = () => {
			controller?.abort(new DOMException("Cancelled", "AbortError"));
			scanner?.stop();
		};

		const visibility = () => {
			if (document.hidden) {
				stop();
			} else {
				resume();
			}
		};

		let permission: PermissionStatus | undefined;

		// Web NFC's permission name is not yet included in TypeScript's DOM library.
		void navigator.permissions
			.query({ name: "nfc" as PermissionName })
			.then((status) => {
				if (!mounted) {
					return;
				}

				permission = status;

				const changed = () => {
					granted = status.state === "granted";

					if (granted) {
						resume();
					} else if (status.state === "denied") {
						controller?.abort(new DOMException("NFC permission denied", "NotAllowedError"));
						scanner?.stop();
					} else {
						stop();
					}
				};

				status.onchange = changed;
				changed();
			})
			.catch(() => undefined);

		window.addEventListener("pagehide", stop);
		document.addEventListener("visibilitychange", visibility);

		return () => {
			mounted = false;
			stop();

			if (permission) {
				permission.onchange = null;
			}

			window.removeEventListener("pagehide", stop);
			document.removeEventListener("visibilitychange", visibility);
		};
	});
	$effect(() => {
		if (url) {
			const pending = untrack(() => phase);

			if (pending.kind === "unsaved" && pending.url !== url) {
				phase = { kind: "idle" };
			}

			return () => {
				controller?.abort(new DOMException("Selection changed", "AbortError"));
			};
		}
	});
	async function saveVerified(
		save: () => Promise<boolean>,
		targetNumber: number,
		targetUrl: string,
	) {
		phase = { kind: "saving" };
		let saved: boolean;

		try {
			saved = await save();
		} catch {
			saved = false;
		}

		phase = saved
			? { kind: "done", number: targetNumber }
			: { kind: "unsaved", number: targetNumber, url: targetUrl, save };

		if (saved && typeof navigator.vibrate === "function") {
			navigator.vibrate(100);
		}
	}
	async function retryChecklist() {
		if (phase.kind !== "unsaved" || disabled) {
			return;
		}

		const pending = phase;

		onactive(true);

		try {
			await saveVerified(pending.save, pending.number, pending.url);
		} finally {
			onactive(false);
		}
	}
	async function start() {
		if (active || disabled) {
			return;
		}

		const session = new AbortController();

		controller = session;
		const targetUrl = url;
		const targetNumber = number;
		const save = prepare();
		let writing = false;

		onactive(true);

		const timeout = window.setTimeout(() => {
			session.abort(new DOMException("Timed out", "TimeoutError"));
		}, 90_000);

		try {
			await writeVerifiedTag({
				url: targetUrl,
				signal: session.signal,
				reader: scanner?.reader,
				onState: (next) => {
					phase = next;

					if (next.kind === "waiting") {
						granted = true;
					}

					if (next.kind === "writing") {
						writing = true;
					}
				},
				confirmOverwrite: () =>
					new Promise<void>((resolve) => {
						approve = resolve;
					}),
			});

			session.signal.throwIfAborted();
			window.clearTimeout(timeout);
			// Finish the write session while the foreground scan keeps receiving tags.
			session.abort();
			verified.set(targetUrl, targetNumber);
			await saveVerified(save, targetNumber, targetUrl);
		} catch (error) {
			phase = { kind: "error", message: nfcError(error, writing) };
		} finally {
			window.clearTimeout(timeout);
			session.abort();
			approve = undefined;
			controller = undefined;
			onactive(false);
		}
	}
</script>

{#if supported}
	<div class="browser-writer" class:active>
		{#if phase.kind === "error"}<p role="alert">{phase.message}</p>{/if}
		{#if active && phase.kind !== "overwrite" && phase.kind !== "saving"}
			<img
				class="holding-art"
				src="/storybook/hold-tag.svg"
				alt="Hold the NFC tag against the upper back of your phone"
			/>
			<div class="hold-copy">
				{#if phase.kind === "verifying" || phase.kind === "confirming"}
					<h2>Lift, then tap again.</h2>
					<p>Move the tag away, then bring it<br />back to the same spot.</p>
				{:else}
					<h2>Hold the tag here.</h2>
					<p>Hold the tag to the<br />back of your phone.</p>
					{#if phase.kind === "waiting" || phase.kind === "writing"}<p class="keep-still">
							Keep it still while we write.
						</p>{/if}
				{/if}
			</div>
		{:else if !active && phase.kind !== "unsaved"}
			<button
				class="btn write-button"
				class:btn-primary={!alreadyWritten}
				class:btn-neutral={alreadyWritten}
				{disabled}
				onclick={start}>{alreadyWritten ? "Rewrite" : "Write"} tag #{number}</button
			>
		{/if}
		<div aria-live="polite" aria-atomic="true">
			{#if phase.kind === "idle"}<p>
					{alreadyWritten
						? "This tag is already checked off. Rewrite only to replace a tag or fix a mistake."
						: "Write here, then read back the exact URL. Your checklist saves automatically."}
				</p>
			{:else if phase.kind === "read"}<p class="existing">{phase.message}</p>
			{:else if phase.kind === "permission"}<p>Allow NFC when Chrome asks. Keep this page open.</p>
			{:else if phase.kind === "waiting"}<p class="waiting">Ready to write #{number}</p>
			{:else if phase.kind === "overwrite"}
				<p>
					<strong
						>{phase.differentRelic
							? "This tag belongs to a different relic."
							: "This tag already contains data."}</strong
					> Replacing it will erase its current contents.
				</p>
				<p class="existing mono">{phase.existing}</p>
				<p>Keep only the tag you want to replace near your phone.</p>
			{:else if phase.kind === "confirming"}<p>
					Lift the tag away, then tap the same tag again to confirm replacement. Keep it still while
					writing.
				</p>
			{:else if phase.kind === "writing"}<p>
					Writing tag #{number}. Hold it still against your phone.
				</p>
			{:else if phase.kind === "verifying"}<p>
					Checking the URL. Lift the tag away, then tap the same tag again to verify.
				</p>
			{:else if phase.kind === "saving"}<p>URL verified. Saving your checklist…</p>
			{:else if phase.kind === "done"}<p class="success">
					Tag written! #{phase.number} is checked and saved. {finished
						? "This batch is finished. Set it aside."
						: "Set it aside, then tap Write for the next tag."}
				</p>
			{:else if phase.kind === "unsaved"}<p role="alert">
					Tag #{phase.number} is written and verified. Your checklist could not be saved. Check your internet
					connection, then save again. You do not need to rewrite the tag.
				</p>
			{/if}
		</div>
		{#if phase.kind === "unsaved"}<button
				class="btn btn-primary write-button"
				{disabled}
				onclick={retryChecklist}>Save checklist again</button
			>{/if}
		{#if active && phase.kind !== "saving"}<div class="actions">
				{#if phase.kind === "overwrite"}<button
						class="btn btn-neutral"
						onclick={() => {
							approve?.();
							approve = undefined;
						}}>Replace with tag #{number}</button
					>{/if}
				<button
					class="btn btn-ghost"
					onclick={() => controller?.abort(new DOMException("Cancelled", "AbortError"))}
					>Cancel</button
				>
			</div>{/if}
	</div>
{:else}
	<p class="message">
		Writing tags needs Chrome on an Android phone with NFC, over HTTPS. Open this page there, or use
		the URL or QR code below.
	</p>
{/if}

<style>
	.browser-writer {
		margin-block: 24px 16px;
		text-align: center;
	}
	.write-button {
		width: 100%;
		min-height: 56px;
		height: auto;
		white-space: normal;
		border-radius: 8px;
		font-weight: 700;
		font-size: 1.125rem;
	}
	.holding-art {
		display: block;
		width: 180px;
		max-width: 100%;
		height: 140px;
		object-fit: contain;
		margin: 8px auto;
		transform: rotate(-4deg);
	}
	.hold-copy h2 {
		font: 500 1.5625rem/1.2 var(--font-display, Lora, serif);
	}
	.hold-copy p {
		color: var(--muted);
		margin: 12px auto 0;
		font-size: 1.0625rem;
	}
	.hold-copy .keep-still {
		font-size: 0.9375rem;
		max-width: 290px;
	}
	.waiting {
		font-size: 0.875rem;
		font-weight: 700;
	}
	.waiting::before {
		content: "";
		display: inline-block;
		width: 8px;
		height: 8px;
		background: currentColor;
		border-radius: 50%;
		margin-inline-end: 8px;
	}
	.active :global(.actions) {
		justify-content: center;
		flex-direction: column;
		gap: 0;
	}
	.active :global(.btn-ghost) {
		min-height: 48px;
		text-decoration: underline;
		text-underline-offset: 4px;
	}
	.success {
		color: var(--color-primary);
		font-weight: 700;
	}
	.existing {
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	p {
		margin-block: 16px;
	}
</style>
