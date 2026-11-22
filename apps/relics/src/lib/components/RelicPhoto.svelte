<script lang="ts">
	let { src: imageUrl, alt: description }: { src: string | null; alt: string } = $props();
	let failedSrc = $state<string | null>(null);
</script>

{#if imageUrl && imageUrl !== failedSrc}<img
		src={imageUrl}
		alt={description}
		onerror={() => (failedSrc = imageUrl)}
	/>{:else}<div class="placeholder">
		<img src="/storybook/snail-placeholder.svg" alt="An illustrated little friend" /><span
			>Photo coming soon</span
		>
	</div>{/if}

<style>
	img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: inherit;
	}
	.placeholder {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: center;
		border-radius: inherit;
	}
	.placeholder img {
		object-fit: contain;
		min-height: 0;
		flex: 1;
	}
	.placeholder span {
		font: 18px/1.3 var(--font-note);
		text-align: center;
		color: var(--muted);
	}
</style>
