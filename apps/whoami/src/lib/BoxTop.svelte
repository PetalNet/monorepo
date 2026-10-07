<script lang="ts">
	let { title }: { title: string } = $props();
</script>

<div class="btop">
	<span class="c" aria-hidden="true">┌──</span><span class="btt" role="heading" aria-level="2"
		>{title}</span
	><span class="bfill" aria-hidden="true"></span><span class="c" aria-hidden="true">┐</span>
</div>
