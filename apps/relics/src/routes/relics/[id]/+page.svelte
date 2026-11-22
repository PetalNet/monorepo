<script lang="ts">
	import { refreshAll } from "$app/navigation";
	import { ArrowLeft } from "@lucide/svelte";
	import { tick } from "svelte";

	import { command } from "#lib/client.ts";
	import RelicPhoto from "#lib/components/RelicPhoto.svelte";
	import { birthdayLabel, traitFor } from "#lib/story.ts";
	let { data }: import("./$types").PageProps = $props();
	let relic = $derived(data.relic);
	let editing = $state(false),
		busy = $state(false),
		relicName = $state(""),
		firstName = $state(""),
		error = $state(""),
		celebration = $state("");
	let nameInput = $state<HTMLInputElement>();
	let heading = $state<HTMLHeadingElement>();
	let releaseDialog: HTMLDialogElement;
	let currentId = $state("");
	$effect(() => {
		if (currentId !== relic.id) {
			currentId = relic.id;
			editing = false;
			error = "";
			celebration = "";
		}
	});
	async function openNaming() {
		relicName = relic.friendName ?? "";
		firstName = relic.firstName ?? data.firstName ?? "";
		error = "";
		editing = true;
		await tick();
		nameInput?.focus();
	}
	async function save(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = "";

		try {
			await command(relic.owned ? "name" : "claim", {
				relicId: relic.id,
				name: firstName.trim(),
				relicName: relicName.trim(),
			});

			await refreshAll();
			editing = false;
			celebration = "And so, our little story begins.";
			await tick();
			heading?.focus();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "That name didn't save. Please try again.";
		} finally {
			busy = false;
		}
	}
	async function release() {
		busy = true;
		error = "";

		try {
			await command("release", { relicId: relic.id });
			releaseDialog.close();
			await refreshAll();
			celebration = "Ready for a new little story.";
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Couldn't pass it on. Try again.";
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head
	><title
		>{relic.friendName ? `Hi, I'm ${relic.friendName}!` : "A little friend, a new story"} · Petal Relics</title
	></svelte:head
>
<article class:naming={editing} class:named={Boolean(relic.friendName)} data-relic-id={relic.id}>
	{#if editing}
		<div class="form-top">
			<button class="back-link" disabled={busy} onclick={() => (editing = false)}
				><ArrowLeft size={18} />Back</button
			><span>#{relic.indexNumber}</span>
		</div>
		<h1>What shall we<br />call this little one?</h1>
		<div class="mini-relic">
			<div class="thumbnail">
				<RelicPhoto src={relic.imageUrl} alt={`${relic.varietyName} ${relic.typeName}`} />
			</div>
			<p>{relic.typeName} #{relic.indexNumber}<span>{relic.varietyName}</span></p>
		</div>
		<form onsubmit={save} aria-busy={busy}>
			<label class="field"
				><span>Friend's name</span><input
					class="input"
					name="relicName"
					bind:this={nameInput}
					bind:value={relicName}
					required
					pattern=".*\S.*"
					maxlength="32"
					autocomplete="off"
					enterkeyhint="next"
					disabled={busy}
				/></label
			>
			<label class="field"
				><span>Your first name</span><input
					class="input"
					name="firstName"
					bind:value={firstName}
					required
					pattern=".*\S.*"
					maxlength="32"
					autocomplete="given-name"
					enterkeyhint="done"
					disabled={busy}
				/></label
			>
			<p class="privacy">Both names will be on my page for anyone to see.</p>
			{#if error}<p class="message error" role="alert">{error}</p>{/if}
			<button class="btn btn-primary primary" disabled={busy}
				>{busy ? "Saving my name…" : "That's my name!"}</button
			>
		</form>
	{:else}
		<h1 bind:this={heading} tabindex="-1">
			{#if relic.friendName}Hi, I'm<br />{relic.friendName}!{:else}A little friend,<br />a new
				story.{/if}
		</h1>
		{#if relic.friendName}<p class="owner">
				{relic.firstName
					? `${relic.firstName}'s ${relic.typeName}.`
					: `A little ${relic.typeName}.`}
			</p>{:else}<p class="intro">Every good story starts with a name.</p>
			<div class="flourish" aria-hidden="true"></div>{/if}
		<figure class="art" class:celebrating={Boolean(celebration)}>
			<RelicPhoto
				src={relic.imageUrl}
				alt={`${relic.varietyName} ${relic.typeName}`}
			/>{#if !relic.friendName}<span class="art-note">hello, you.</span>{/if}
		</figure>
		<div class="identity">
			<span>#{relic.indexNumber}</span><span>{relic.typeName}</span><span>{relic.varietyName}</span>
		</div>
		{#if relic.friendName}
			<dl class="details">
				{#if relic.birthday !== null}<div>
						<dt>Birthday</dt>
						<dd>{birthdayLabel(relic.birthday)}</dd>
					</div>{/if}
				<div>
					<dt>Little quirk</dt>
					<dd>{traitFor(relic.id)}</dd>
				</div>
			</dl>
			{#if celebration}<p class="celebrate" role="status">{celebration}</p>{/if}
			{#if relic.owned}<button class="rename" onclick={openNaming}>Rename {relic.friendName}</button
				>
				<p class="fine owner-note">You can change my name on this phone.</p>
			{/if}
		{:else if !relic.claimed || relic.owned}
			<div class="bottom-action">
				<button class="btn btn-primary primary" onclick={openNaming}>Name me!</button>
				<p class="fine action-note">No sign-up. Just a name.</p>
			</div>
		{:else}<p class="note">A name is the next chapter.</p>{/if}
		{#if relic.owned}<button
				class="pass-on"
				onclick={() => {
					error = "";
					releaseDialog.showModal();
				}}>Pass it on</button
			>{/if}
		{#if relic.lore}<p class="lore">{relic.lore}</p>{/if}
	{/if}
</article>
<dialog bind:this={releaseDialog}>
	<h2>Pass this little friend on?</h2>
	<p>The next person can give it a new name. This phone will no longer be able to rename it.</p>
	{#if error}<p class="message error" role="alert">{error}</p>{/if}
	<div class="actions">
		<button class="btn btn-primary" disabled={busy} onclick={release}
			>{busy ? "One moment…" : "Pass it on"}</button
		><button
			class="btn btn-ghost"
			disabled={busy}
			onclick={() => {
				releaseDialog.close();
			}}>Keep my friend</button
		>
	</div>
</dialog>

<style>
	article {
		max-width: 390px;
		margin-inline: auto;
	}
	h1 {
		font-size: 2.18rem;
		line-height: 1.14;
	}
	h1:focus {
		outline: none;
	}
	.intro {
		color: var(--muted);
		margin-block-start: 12px;
	}
	.art {
		position: relative;
		height: 260px;
		max-width: 310px;
		margin: 24px auto 20px;
		border-radius: 8px;
	}
	.art-note {
		position: absolute;
		inset-inline-end: 0;
		inset-block-start: 8px;
		transform: rotate(8deg);
		font: 23px var(--font-note);
		padding: 0 8px;
		background: var(--color-base-100);
		border-radius: 4px;
	}
	.identity {
		display: flex;
		justify-content: center;
		flex-wrap: wrap;
		gap: 6px;
		color: var(--muted);
		font-size: 15px;
	}
	.identity span + span::before {
		content: "·";
		margin-inline-end: 6px;
	}
	.bottom-action {
		padding-block-start: 27px;
	}
	.primary {
		width: 100%;
		min-height: 58px;
		font-size: 18px;
	}
	.fine {
		color: var(--muted);
		font-size: 14px;
	}
	.action-note {
		text-align: center;
		margin-block-start: 12px;
	}
	.owner {
		font: 23px/1.4 var(--font-note);
		margin-block-start: 8px;
	}
	.named h1 {
		font-size: 2.24rem;
	}
	.named .art {
		max-width: 290px;
		height: 232px;
		margin-block: 16px;
	}
	.details {
		margin-block: 24px 0;
		padding-inline: 4px;
		border-block: 1px solid var(--rule);
	}
	.details > div {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
		padding-block: 12px;
		font-size: 15px;
	}
	.details > div + div {
		border-block-start: 1px solid var(--rule);
	}
	dt {
		color: var(--muted);
		flex-shrink: 0;
	}
	dd {
		margin: 0;
		text-align: end;
		font-weight: 700;
	}
	.celebrate,
	.note {
		font: 22px/1.4 var(--font-note);
		text-align: center;
		margin-block-start: 16px;
	}
	.rename {
		overflow-wrap: anywhere;
		white-space: normal;
		display: block;
		width: 100%;
		min-height: 48px;
		font-size: 15px;
		font-weight: 700;
		text-decoration: underline;
		text-underline-offset: 4px;
		background: none;
		border: 0;
		margin-block-start: 8px;
	}
	.owner-note {
		text-align: center;
		font-size: 13px;
	}
	.pass-on {
		display: block;
		margin: 12px auto 0;
		min-height: 44px;
		padding: 8px 16px;
		background: none;
		border: none;
		color: var(--muted);
		font-size: 13px;
		text-decoration: underline;
		text-underline-offset: 4px;
	}
	.lore {
		margin-block-start: 24px;
		color: var(--muted);
		font-size: 15px;
	}
	.form-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-block: -12px 12px;
		font-size: 15px;
		font-weight: 700;
	}
	.back-link {
		background: none;
		border: none;
		padding: 0;
		margin: 0;
	}
	.naming h1 {
		font-size: 30px;
	}
	.mini-relic {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-block: 16px;
	}
	.thumbnail {
		width: 51px;
		height: 51px;
		border-radius: 6px;
		overflow: hidden;
		background: var(--color-base-200);
		flex-shrink: 0;
	}
	.thumbnail :global(.placeholder span) {
		display: none;
	}
	.mini-relic p {
		font-size: 14px;
		font-weight: 700;
	}
	.mini-relic span {
		display: block;
		font-size: 13px;
		color: var(--muted);
		font-weight: 400;
	}
	.field {
		margin-block: 12px;
	}
	.input {
		scroll-margin-block: 24px;
	}
	.privacy {
		font-size: 14px;
		color: var(--muted);
		margin-block-start: 8px;
	}
	.naming .primary {
		min-height: 53px;
		margin-block-start: 16px;
	}
	.celebrating {
		animation: hello 500ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	@keyframes hello {
		0% {
			transform: translateY(3px);
		}
		60% {
			transform: translateY(-3px);
		}
		100% {
			transform: none;
		}
	}
</style>
