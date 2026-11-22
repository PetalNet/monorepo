<script lang="ts">
	import { page } from "$app/state";
	import { Copy, Check } from "@lucide/svelte";
	import QRCode from "qrcode";
	import { untrack } from "svelte";

	import BrowserTagWriter from "#lib/components/BrowserTagWriter.svelte";

	import type { PageData } from "../../routes/admin/[...path]/$types";
	import type { AdminCommand } from "../schema";
	let nfcActive = $state(false);
	let {
		catalog,
		save,
		busy,
	}: {
		catalog: PageData["catalog"];
		save: (input: AdminCommand) => Promise<boolean>;
		busy: boolean;
	} = $props();
	let varietyId = $state(
		untrack(
			() => Number(page.url.searchParams.get("variety")) || (catalog.varieties.at(0)?.id ?? 0),
		),
	);
	let batchId = $state(
			untrack(
				() =>
					catalog.ranges.find(
						(r) =>
							r.varietyId === varietyId &&
							String(r.startIndex) === page.url.searchParams.get("start") &&
							String(r.endIndex) === page.url.searchParams.get("end"),
					)?.id ?? 0,
			),
		),
		selected = $state(""),
		copyMessage = $state("");
	let qr = $state(""),
		qrError = $state("");
	let batches = $derived(catalog.ranges.filter((r) => r.varietyId === varietyId));
	let range = $derived(batches.find((r) => r.id === batchId));
	let relics = $derived(
		catalog.relics
			.filter(
				(r) =>
					r.varietyId === varietyId &&
					(!range ||
						((range.startIndex === null || (r.indexNumber ?? 0) >= range.startIndex) &&
							(range.endIndex === null || (r.indexNumber ?? 0) <= range.endIndex))),
			)
			.toSorted((a, b) => (a.indexNumber ?? 0) - (b.indexNumber ?? 0)),
	);
	function isWritten(relic: PageData["catalog"]["relics"][number]) {
		return catalog.ranges.some(
			(r) => r.varietyId === relic.varietyId && r.writtenIndices.includes(relic.indexNumber ?? 0),
		);
	}
	let done = $derived(relics.filter(isWritten).length);
	let writer = $derived(relics.find((r) => r.id === selected));
	let url = $derived(writer ? `${page.url.origin}/relics/${writer.id}` : "");
	let index = $derived(relics.findIndex((r) => r.id === selected));
	$effect(() => {
		if (!catalog.varieties.some((v) => v.id === varietyId)) {
			varietyId = catalog.varieties.at(0)?.id ?? 0;
		}

		if (!relics.some((r) => r.id === selected)) {
			selected = relics.find((r) => !isWritten(r))?.id ?? relics.at(0)?.id ?? "";
		}
	});
	$effect(() => {
		const current = url;
		let active = true;

		qr = "";
		qrError = "";
		copyMessage = "";

		if (current) {
			void QRCode.toDataURL(current, { width: 240, margin: 4, errorCorrectionLevel: "M" })
				.then((value) => {
					if (active) {
						qr = value;
					}
				})
				.catch(() => {
					if (active) {
						qrError = "QR code could not load. Use Copy URL instead.";
					}
				});
		}

		return () => {
			active = false;
		};
	});
	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
			copyMessage = "URL copied.";
		} catch {
			copyMessage = "Select the URL above, then choose Copy on your phone.";
		}
	}
	async function markWritten() {
		if (!writer || nfcActive || busy) {
			return;
		}

		const current = writer;
		const allocation = catalog.ranges.find(
			(r) =>
				r.varietyId === current.varietyId &&
				(r.startIndex === null || r.startIndex <= (current.indexNumber ?? 0)) &&
				(r.endIndex === null || r.endIndex >= (current.indexNumber ?? 0)),
		);

		if (!allocation) {
			return;
		}

		await save({ kind: "written", rangeId: allocation.id, index: current.indexNumber ?? 0 });
	}
	function prepareWrite() {
		const current = writer;
		const allocation =
			current &&
			catalog.ranges.find(
				(r) =>
					r.varietyId === current.varietyId &&
					(r.startIndex === null || r.startIndex <= (current.indexNumber ?? 0)) &&
					(r.endIndex === null || r.endIndex >= (current.indexNumber ?? 0)),
			);
		const following = [...relics.slice(index + 1), ...relics.slice(0, index)].find(
			(relic) => !isWritten(relic),
		);

		return async () => {
			if (!current || !allocation) {
				return false;
			}

			const saved = await save({
				kind: "written",
				rangeId: allocation.id,
				index: current.indexNumber ?? 0,
			});

			if (saved && selected === current.id && following) {
				selected = following.id;
			}

			return saved;
		};
	}
	function choose(id: string) {
		if (!nfcActive && !busy) {
			selected = id;
		}
	}
</script>

<div class="writer-heading">
	<h2>Write your tags</h2>
	<p class="inline-help">
		One link per physical tag. Your checklist is saved here, even when you close this page.
	</p>
</div>
<p class="writer-progress" role="status">
	{done} of {relics.length} written{#if done === relics.length}
		· All tags in this list are done.{/if}
</p>
<div class="filters">
	<label class="field"
		><span>Variety</span><select
			class="select"
			disabled={busy || nfcActive}
			bind:value={varietyId}
			onchange={() => {
				batchId = 0;
				selected = "";
			}}
			>{#each catalog.varieties as variety (variety.id)}<option value={variety.id}
					>{variety.typeName} / {variety.name}</option
				>{/each}</select
		></label
	>
	<label class="field"
		><span>Tag batch</span><select
			class="select"
			disabled={busy || nfcActive}
			bind:value={batchId}
			onchange={() => (selected = "")}
			><option value={0}>All tags in this variety</option>{#each batches as batch (batch.id)}<option
					value={batch.id}
					>Numbers {batch.startIndex ?? "open"} to {batch.endIndex ?? "open"}</option
				>{/each}</select
		></label
	>
</div>
{#if writer}
	<div class="writer-layout">
		<section class="write-current">
			<div class="current-heading">
				<h3>{writer.name}</h3>
				<span class="writing-status">{isWritten(writer) ? "Written" : "To write"}</span>
			</div>
			<BrowserTagWriter
				{url}
				written={relics.filter(isWritten).map((relic) => ({
					url: `${page.url.origin}/relics/${relic.id}`,
					number: relic.indexNumber ?? 0,
				}))}
				number={writer.indexNumber ?? 0}
				disabled={busy}
				prepare={prepareWrite}
				onactive={(active: boolean) => {
					nfcActive = active;
				}}
			/>
			<label class="field"
				><span>Tag URL</span><input
					class="input mono"
					readonly
					value={url}
					onclick={(e) => {
						e.currentTarget.select();
					}}
				/></label
			>
			<div class="actions">
				<button class="btn btn-ghost" onclick={copy}><Copy size={16} />Copy URL</button><a
					class="btn btn-ghost"
					href={url}
					target="_blank"
					rel="noreferrer">Open tag page</a
				>
			</div>
			{#if copyMessage}<p class="message" role="status">{copyMessage}</p>{/if}
			<div class="completion rule">
				<button
					class="btn btn-neutral"
					disabled={busy || nfcActive || isWritten(writer)}
					onclick={markWritten}
					><Check size={16} />{isWritten(writer)
						? "Marked written"
						: busy
							? "Saving…"
							: "Mark written"}</button
				>
				<p class="muted small">
					Using another writer? Mark this only after writing the exact URL and testing the physical
					tag.
				</p>
			</div>
			<div class="writer-navigation">
				<button
					class="btn btn-ghost"
					disabled={index <= 0 || busy || nfcActive}
					onclick={() => {
						choose(relics[index - 1]?.id ?? selected);
					}}>Previous</button
				><span class="mono">{index + 1} / {relics.length}</span><button
					class="btn btn-neutral"
					disabled={index >= relics.length - 1 || busy || nfcActive}
					onclick={() => {
						choose(relics[index + 1]?.id ?? selected);
					}}>Next tag</button
				>
			</div>
			<details>
				<summary>QR code and tag safety</summary>{#if qr}<img
						class="qr"
						src={qr}
						alt="QR code for the selected tag URL"
					/><a class="btn btn-ghost" href={qr} download={`relic-${writer.id}.png`}
						>Download QR code</a
					>{:else if qrError}<p role="alert">{qrError}</p>{:else}<p role="status">
						Preparing QR code…
					</p>{/if}
				<p class="inline-help">
					The QR code opens the same page. You can print it as a label. Keep existing tags as they
					are. Test a tag before locking it; locking may be permanent.
				</p>
			</details>
		</section>
		<section class="checklist">
			<h3>Writing checklist</h3>

			<button
				class="btn btn-ghost"
				disabled={done === relics.length || busy || nfcActive}
				onclick={() => {
					choose(relics.find((r) => !isWritten(r))?.id ?? selected);
				}}>Go to next unwritten tag</button
			>
			<ul>
				{#each relics as relic (relic.id)}<li>
						<button
							class:current={selected === relic.id}
							aria-current={selected === relic.id ? "true" : undefined}
							disabled={busy || nfcActive}
							onclick={() => {
								choose(relic.id);
							}}
							><span class="mono">#{relic.indexNumber}</span><span
								>{isWritten(relic) ? "Written" : "To write"}</span
							>{#if isWritten(relic)}<Check size={16} aria-label="Written" />{/if}</button
						>
					</li>{/each}
			</ul>
		</section>
	</div>
{:else}
	<p class="message">No tags here yet. Make a batch first, then come back to write them.</p>
	<a class="btn btn-primary" href="/admin/allocate">Make tags</a>
{/if}

<style>
	h2 {
		font-size: 1.75rem;
	}
	.filters {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 24px;
		margin-block-end: 24px;
	}
	.writer-layout {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: 48px;
		align-items: start;
	}
	.write-current {
		background: var(--color-base-200);
		padding: 32px;
	}
	.write-current .input {
		background: var(--color-base-100);
	}
	.current-heading {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
	}
	.writing-status {
		color: var(--color-primary);
	}
	.completion {
		margin-block-start: 24px;
		padding-block-start: 24px;
		display: grid;
		gap: 16px;
	}
	.writer-navigation {
		display: flex;
		gap: 8px;
		justify-content: space-between;
		align-items: center;
		margin-block-start: 24px;
	}
	.btn:disabled {
		opacity: 1;
		color: var(--muted);
		background: var(--color-base-300);
		cursor: default;
	}

	.writer-navigation .btn {
		padding-inline: 16px;
	}
	details {
		margin-block-start: 24px;
	}
	.qr {
		width: 240px;
		height: 240px;
		max-width: 100%;
		object-fit: contain;
	}
	.writer-progress {
		margin-block: 16px;
		color: var(--muted);
	}
	.checklist ul {
		padding: 0;
		margin: 16px 0 0;
		list-style: none;
		max-height: 560px;
		overflow-y: auto;
	}
	.checklist li button {
		display: flex;
		align-items: center;
		width: 100%;
		min-height: 56px;
		gap: 16px;
		padding: 16px;
		background: transparent;
		color: var(--color-base-content);
		border-block-end: 1px solid var(--rule);
		transition: background-color 160ms ease-out;
		text-align: start;
	}
	.checklist li button:hover,
	.checklist li button.current {
		background: var(--color-base-200);
	}
	.checklist li button.current {
		color: var(--color-primary);
	}
	.checklist li button span:nth-child(2) {
		margin-inline-start: auto;
	}
	@media (max-width: 800px) {
		.writer-layout {
			grid-template-columns: minmax(0, 1fr);
			gap: 32px;
		}
		.write-current {
			padding: 24px;
		}
	}
	@media (max-width: 540px) {
		.filters {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
		.write-current {
			padding: 16px;
		}
		.writer-navigation .btn {
			padding-inline: 8px;
		}
	}
</style>
