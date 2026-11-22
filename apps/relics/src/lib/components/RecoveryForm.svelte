<script lang="ts">
	import { refreshAll } from "$app/navigation";
	import { Schema } from "effect";

	import { command } from "../client";
	import { Collection } from "../schema";
	let { kind, token = "" }: { kind: "legacy" | "restore" | "enroll"; token?: string } = $props();
	let name = $state(""),
		pin = $state(""),
		email = $state(""),
		busy = $state(false),
		message = $state(""),
		error = $state("");
	let recovered = $state<typeof Collection.Type | null>(null);
	async function showRelics() {
		const response = await fetch("/api/v1/collection");

		if (!response.ok) {
			throw new Error("Your relics moved, but the links couldn't load. Tap your tag again.");
		}

		recovered = Schema.decodeUnknownSync(Collection)(await response.json());
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = "";
		message = "";

		try {
			if (kind === "enroll") {
				await command("email", { email });
				message = "Check your email. Open the link to keep access on another phone.";
			} else if (kind === "legacy") {
				await command("migrate", { name, pin });
				pin = "";
				await refreshAll();
				await showRelics();
			} else if (token) {
				await command("restore/consume", { token });
				await refreshAll();
				await showRelics();
			} else {
				await command("restore/request", { email });

				message =
					"If this address is verified, a collection link is on its way. It expires in 15 minutes.";
			}
		} catch (e) {
			error = e instanceof Error ? e.message : "Could not complete this request. Try again.";
		} finally {
			busy = false;
		}
	}
</script>

<div class="form-panel">
	<h1>
		{kind === "enroll"
			? "Keep access to your friend."
			: kind === "legacy"
				? "Your relics are still yours."
				: token
					? "Welcome back."
					: "Restore your collection."}
	</h1>
	<p class="muted">
		{kind === "enroll"
			? "Save a recovery email for the relics named on this phone. We’ll send you a link to verify it."
			: kind === "legacy"
				? "Enter your old name and PIN once to move your relics to this device. After that, no PIN needed."
				: token
					? "Open your private collection on this device. This switches any collection currently open here."
					: "Use the email you verified with your collection. We’ll send a link to open it on this device."}
	</p>
	{#if recovered}
		<p class="message" role="status">
			Your relics are ready on this phone. Tap a tag or open its page below.
		</p>
		{#each recovered.relics as relic (relic.id)}
			<a class="back-link" href="/relics/{relic.id}"
				>{relic.friendName ?? relic.typeName} #{relic.indexNumber}</a
			>
		{/each}
	{:else}<form onsubmit={submit} aria-busy={busy}>
			{#if kind === "legacy"}<label class="field"
					><span>Old name</span><input
						class="input"
						required
						autocomplete="username"
						maxlength="80"
						bind:value={name}
					/></label
				><label class="field"
					><span>Old PIN</span><input
						class="input"
						type="password"
						inputmode="numeric"
						pattern={"[0-9]{4,6}"}
						minlength="4"
						maxlength="6"
						required
						autocomplete="current-password"
						bind:value={pin}
					/></label
				>{:else if !token}<label class="field"
					><span>Verified recovery email</span><input
						class="input"
						type="email"
						maxlength="254"
						required
						autocomplete="email"
						bind:value={email}
					/></label
				>{/if}<button class="btn btn-primary" disabled={busy}
				>{busy
					? "One moment…"
					: kind === "legacy"
						? "Move my relics"
						: token
							? "Open my collection"
							: kind === "enroll"
								? "Verify my email"
								: "Send recovery link"}</button
			>
		</form>{/if}
	{#if message}<p class="message" role="status">{message}</p>{/if}{#if error}<p
			class="message error"
			role="alert"
		>
			{error}
		</p>{/if}
	<p class="inline-help">
		{#if recovered !== null || kind === "restore"}<a href="/restore/enroll"
				>Save or change a recovery email</a
			>.
		{/if}
		{#if kind === "legacy"}Already moved them? <a href="/restore">Restore by email</a
			>.{:else if kind !== "enroll"}Used a name and PIN before? <a href="/legacy"
				>Move your old collection</a
			>.{/if}
	</p>
	<p class="muted small">Lost access? Ask a Petal Relics admin to reassign your relics.</p>
</div>
