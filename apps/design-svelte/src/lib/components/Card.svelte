<script lang="ts">
	/**
	 * A content card. variant "filled" for content, "outlined" for a tappable
	 * tile (gets tabindex + the hover state-layer from CSS).
	 */
	let {
		variant,
		variantLabel,
		title,
		body,
	}: {
		variant: "filled" | "outlined";
		variantLabel: string;
		title: string;
		body: string;
	} = $props();
</script>

{#if variant === "outlined"}
	<!-- The outlined card is a tappable tile; tabindex matches the source spec. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="card-outlined" tabindex="0">
		<div class="card-variant mono">{variantLabel}</div>
		<div class="card-title">{title}</div>
		<div class="card-body">{body}</div>
	</div>
{:else}
	<div class="card-filled">
		<div class="card-variant mono">{variantLabel}</div>
		<div class="card-title">{title}</div>
		<div class="card-body">{body}</div>
	</div>
{/if}
