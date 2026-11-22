<script lang="ts">
	import { Schema } from "effect";
	import { onDestroy } from "svelte";

	import { command } from "../client";
	import RelicPhoto from "./RelicPhoto.svelte";
	let { url = $bindable(""), busy = $bindable(false) } = $props();
	let error = $state("");
	let fileInput = $state<HTMLInputElement>();
	let active = true;
	$effect(() => {
		if (!url && !busy && fileInput) {
			fileInput.value = "";
		}
	});
	onDestroy(() => {
		active = false;
		busy = false;
	});
	async function upload(event: Event) {
		const input = event.currentTarget;

		if (!(input instanceof HTMLInputElement)) {
			return;
		}

		const file = input.files?.[0];

		if (!file) {
			return;
		}

		if (file.size > 8 * 1024 * 1024) {
			error = "Choose an image smaller than 8 MB.";

			return;
		}

		busy = true;
		error = "";

		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			let binary = "";

			for (const byte of bytes) {
				binary += String.fromCharCode(byte);
			}

			const result = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
				await command("admin/upload", { data: btoa(binary) }),
			);

			if (active) {
				url = result.url;
			}
		} catch (e) {
			if (active) {
				error = e instanceof Error ? e.message : "Upload failed.";
			}
		} finally {
			if (active) {
				busy = false;
			}
		}
	}
</script>

<label class="field"
	><span>{busy ? "Uploading photo…" : "Photo"}</span><input
		type="file"
		bind:this={fileInput}
		accept="image/png,image/jpeg,image/webp"
		onchange={upload}
		disabled={busy}
	/></label
>
<p class="upload-help">PNG, JPEG or WebP, up to 8 MB. Check the preview before saving.</p>
<details>
	<summary>Use a photo URL instead</summary><label class="field"
		><span>Image URL</span><input
			class="input"
			bind:value={url}
			disabled={busy}
			placeholder="/uploads/… or https://…"
		/></label
	>
</details>
{#if url}<div class="upload-preview">
		<RelicPhoto src={url} alt="Photo preview" />
	</div>{/if}{#if error}<p class="message error" role="alert">
		{error}
	</p>{/if}

<style>
	.upload-help {
		color: var(--muted);
		font-size: 0.875rem;
	}
	.upload-preview {
		width: 120px;
		height: 120px;
		margin-block: 16px;
		border-radius: 6px;
		overflow: hidden;
		background: var(--color-base-200);
	}
	input[type="file"] {
		width: 100%;
		max-width: 100%;
		min-height: 48px;
		font-size: 0.875rem;
	}
	input[type="file"]::file-selector-button {
		min-height: 48px;
		padding: 8px 16px;
		margin-inline-end: 12px;
		border: 0;
		border-radius: 8px;
		background: var(--color-base-300);
		color: var(--color-base-content);
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}
</style>
