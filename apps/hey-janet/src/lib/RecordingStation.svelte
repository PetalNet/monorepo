<script lang="ts">
	import type { Prompt } from "./prompts";
	let {
		prompt,
		stage,
		level,
		elapsed,
	}: {
		prompt: Prompt;
		stage: "ready" | "recording" | "review";
		level: number;
		elapsed: number;
	} = $props();
</script>

<section class="station" aria-label="Current phrase">
	<span class="font-semibold text-primary"
		>{prompt.kind === "pos"
			? "Wake phrase"
			: prompt.kind === "neg"
				? "Near miss · should not wake Janet"
				: prompt.kind === "enroll"
					? "Voice profile · read aloud"
					: "Voice profile · free speech"}</span
	>
	<h1 class="phrase">{prompt.kind === "free" ? prompt.say : `“${prompt.say}”`}</h1>
	<p class="direction">{prompt.how}</p>
	{#if prompt.kind === "free"}<p role="timer" aria-label="Recording time">
			0:{String(Math.floor(elapsed)).padStart(2, "0")} / 0:30
		</p>{/if}
	<div
		class="meter"
		role="meter"
		aria-label="Microphone level"
		aria-valuemin="0"
		aria-valuemax="100"
		aria-valuenow={Math.round(level * 100)}
	>
		<div class="meter-fill" style:transform={`scaleX(${String(Math.min(1, level * 1.8))})`}></div>
	</div>
	<small
		>{stage === "recording"
			? prompt.kind === "free"
				? "Listening. Keep talking; pauses are fine."
				: "Listening. Say the phrase once."
			: stage === "review"
				? "Listen back before you continue."
				: "Tap Record, then speak when you see “Listening”."}</small
	>
</section>
