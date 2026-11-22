<script lang="ts">
	import type { RelicCard } from "../schema";
	let { relic }: { relic: RelicCard } = $props();
</script>

<a class="specimen-card" href="/relics/{relic.id}"
	><div class="photo">
		{#if relic.imageUrl}<img
				src={relic.imageUrl}
				alt={`${relic.varietyName} ${relic.typeName}`}
				loading="lazy"
			/>{:else}<div class="muted" style="padding:32px">Artwork not yet added</div>{/if}
	</div>
	<div class="caption">
		<div class="small">
			<span>{relic.typeName}</span><span class="mono"
				>No. {String(relic.indexNumber ?? 0).padStart(3, "0")}</span
			>
		</div>
		<h3>{relic.varietyName}</h3>
	</div></a
>
