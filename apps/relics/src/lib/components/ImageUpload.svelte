<script lang="ts">
	import { Schema } from "effect";

	import { command } from "../client";
	let { url = $bindable("") } = $props();
	let busy = $state(false),
		error = $state("");
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

			url = result.url;
		} catch (e) {
			error = e instanceof Error ? e.message : "Upload failed.";
		} finally {
			busy = false;
		}
	}
</script>

<label class="field"
	><span>Image URL</span><input
		class="input"
		bind:value={url}
		placeholder="/uploads/… or https://…"
	/></label
><label class="field"
	><span>{busy ? "Uploading…" : "Or upload artwork (PNG, JPEG, WebP; up to 8 MB)"}</span><input
		type="file"
		accept="image/png,image/jpeg,image/webp"
		onchange={upload}
		disabled={busy}
	/></label
>{#if url}<img class="upload-preview" src={url} alt="Artwork preview" />{/if}{#if error}<p
		class="message error"
		role="alert"
	>
		{error}
	</p>{/if}

<style>
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
