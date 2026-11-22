<script lang="ts">
	import { onMount } from "svelte";

	import { nfcError, supportsNfc, writeVerifiedTag, type NfcState } from "../web-nfc";

	let {
		url,
		number,
		disabled,
		prepare,
		onactive,
	}: {
		url: string;
		number: number;
		disabled: boolean;
		prepare: () => () => Promise<boolean>;
		onactive: (active: boolean) => void;
	} = $props();
	type State =
		| { kind: "idle" }
		| NfcState
		| { kind: "saving" }
		| { kind: "done"; number: number }
		| { kind: "error"; message: string };
	let supported = $state(false);
	let phase = $state<State>({ kind: "idle" });
	let controller: AbortController | undefined;
	let approve: (() => void) | undefined;
	let active = $derived(
		["permission", "waiting", "overwrite", "confirming", "writing", "verifying", "saving"].includes(
			phase.kind,
		),
	);
	onMount(() => {
		supported = supportsNfc();
		const stop = () => controller?.abort(new DOMException("Cancelled", "AbortError"));

		window.addEventListener("pagehide", stop);

		return () => {
			stop();
			window.removeEventListener("pagehide", stop);
		};
	});
	$effect(() => {
		if (url) {
			return () => {
				controller?.abort(new DOMException("Selection changed", "AbortError"));
			};
		}
	});
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
				onState: (next) => {
					phase = next;

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
			// End NFC access before saving; the server mutation cannot be cancelled.
			session.abort();
			phase = { kind: "saving" };
			let saved = false;

			try {
				saved = await save();
			} catch {
				saved = false;
			}

			phase = saved
				? { kind: "done", number: targetNumber }
				: {
						kind: "error",
						message: `Tag #${String(targetNumber)} was verified, but its checklist could not be saved. Keep this tag aside and retry, or use Mark written after checking its page.`,
					};

			if (saved && typeof navigator.vibrate === "function") {
				navigator.vibrate(100);
			}
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
	<div class="browser-writer">
		<button class="btn btn-primary write-button" disabled={disabled || active} onclick={start}
			>Write tag #{number}</button
		>
		<div aria-live="polite" aria-atomic="true">
			{#if phase.kind === "idle"}<p>
					Write here, then read back the exact URL. Your checklist saves automatically.
				</p>
			{:else if phase.kind === "permission"}<p>Allow NFC when Chrome asks. Keep this page open.</p>
			{:else if phase.kind === "waiting"}<p>Hold a blank tag to the back of your phone.</p>
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
			{:else if phase.kind === "done"}<p>
					Tag #{phase.number} verified and saved. Set it aside for labeling.
				</p>
			{:else if phase.kind === "error"}<p role="alert">{phase.message}</p>{/if}
		</div>
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
		margin-block: 24px;
	}
	.write-button {
		width: 100%;
		min-height: 56px;
		height: auto;
		white-space: normal;
	}
	.existing {
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	p {
		margin-block: 16px;
	}
</style>
