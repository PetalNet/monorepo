<script lang="ts">
	import { Schema } from "effect";
	import { onDestroy } from "svelte";

	import { command } from "../client";
	let { url = $bindable(""), busy = $bindable(false) } = $props();
	let error = $state("");
	let active = true;
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
	><span>{busy ? "Uploading photo…" : "Upload a photo (PNG, JPEG or WebP; up to 8 MB)"}</span><input
		type="file"
		accept="image/png,image/jpeg,image/webp"
		onchange={upload}
		disabled={busy}
	/></label
>
<p class="upload-help">
	Choose a photo from your phone or computer. Wait for the preview, then save the form.
</p>
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
{#if url}<img class="upload-preview" src={url} alt="Artwork preview" />{/if}{#if error}<p
		class="message error"
		role="alert"
	>
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
		object-fit: cover;
		margin-block: 16px;
	}
	input[type="file"] {
		max-width: 100%;
		font-size: 0.875rem;
	}
</style>
