<script lang="ts">
	import { readingArc, RING_LABEL_SIZE, ringLabelBaseline } from "$lib/dial";

	let {
		id,
		label,
		inner,
	}: {
		/** The limit's window id: it names the lane and picks the limit's enamel colour. */
		id: string;
		label: string;
		/** Inner edge of the ring the label names. */
		inner: number;
	} = $props();

	const baseline = $derived(ringLabelBaseline(inner));
</script>

<path id="lane-{id}" class="lane" d={readingArc(0, 150, baseline)} />
<text class="ring-label {id}" font-size={RING_LABEL_SIZE}>
	<textPath href="#lane-{id}" startOffset="50%">{label}</textPath>
</text>
