<script lang="ts">
	let { size = 28 }: { size?: number } = $props();
</script>

<span aria-hidden="true" style:width={`${String(size)}px`} style:height={`${String(size)}px`}
></span>

<style>
	span {
		display: inline-block;
		flex-shrink: 0;
		background: currentColor;
		mask: url("/mushroom.svg") center / contain no-repeat;
	}
</style>
