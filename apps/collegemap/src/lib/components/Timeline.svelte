<script lang="ts">
	import { onMount } from 'svelte';

	interface UserWithCollege {
		id: string;
		firstName: string;
		lastName: string;
		createdAt: string;
		college: {
			id: string;
			name: string;
			latitude: number;
			longitude: number;
		};
	}

	let {
		users,
		onFilteredUsersChange
	}: {
		users: UserWithCollege[];
		onFilteredUsersChange: (filtered: UserWithCollege[]) => void;
	} = $props();

	let isPlaying = $state(false);
	let progress = $state(1);
	let animFrame = 0;

	let sortedUsers = $derived(
		[...users].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
	);

	let minTime = $derived(
		sortedUsers.length > 0 ? new Date(sortedUsers[0].createdAt).getTime() : 0
	);

	let maxTime = $derived(
		sortedUsers.length > 0 ? new Date(sortedUsers[sortedUsers.length - 1].createdAt).getTime() : 0
	);

	let currentTime = $derived(minTime + (maxTime - minTime) * progress);

	let filteredUsers = $derived(
		sortedUsers.filter((u) => new Date(u.createdAt).getTime() <= currentTime)
	);

	let currentDateLabel = $derived(
		new Date(currentTime).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		})
	);

	$effect(() => {
		onFilteredUsersChange(filteredUsers);
	});

	function play() {
		if (progress >= 1) progress = 0;
		isPlaying = true;
		const startTime = performance.now();
		const startProgress = progress;
		const duration = (1 - startProgress) * 5000; // 5 seconds total

		function step(now: number) {
			const elapsed = now - startTime;
			const newProgress = startProgress + (elapsed / duration) * (1 - startProgress);
			if (newProgress >= 1) {
				progress = 1;
				isPlaying = false;
				return;
			}
			progress = newProgress;
			animFrame = requestAnimationFrame(step);
		}
		animFrame = requestAnimationFrame(step);
	}

	function pause() {
		isPlaying = false;
		cancelAnimationFrame(animFrame);
	}

	function reset() {
		pause();
		progress = 0;
	}

	onMount(() => {
		return () => cancelAnimationFrame(animFrame);
	});
</script>

<div class="timeline-bar">
	<button class="tl-btn" aria-label="Reset" onclick={reset}>
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<polyline points="1 4 1 10 7 10"/>
			<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
		</svg>
	</button>

	<button class="tl-btn" aria-label={isPlaying ? 'Pause' : 'Play'} onclick={() => isPlaying ? pause() : play()}>
		{#if isPlaying}
			<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
				<rect x="6" y="4" width="4" height="16" rx="1"/>
				<rect x="14" y="4" width="4" height="16" rx="1"/>
			</svg>
		{:else}
			<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
				<polygon points="5 3 19 12 5 21 5 3"/>
			</svg>
		{/if}
	</button>

	<input
		type="range"
		min="0"
		max="1"
		step="0.001"
		bind:value={progress}
		class="tl-slider"
		style="--progress: {progress * 100}%"
		oninput={() => { if (isPlaying) pause(); }}
	/>

	<span class="tl-date">{currentDateLabel}</span>
	<span class="tl-count">{filteredUsers.length}/{users.length}</span>
</div>

<style>
	.timeline-bar {
		position: absolute;
		bottom: 56px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 1000;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		border-radius: 12px;
		background: var(--bg-card-alpha);
		backdrop-filter: blur(12px);
		border: 1px solid var(--border-card);
		animation: slide-up 0.3s ease;
		max-width: calc(100% - 24px);
		width: 480px;
	}

	.tl-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: none;
		background: var(--accent-bg);
		color: var(--text-secondary);
		cursor: pointer;
		transition: all 0.15s;
		flex-shrink: 0;
	}

	.tl-btn:hover {
		background: var(--accent-bg-hover);
		color: var(--accent);
	}

	.tl-slider {
		flex: 1;
		-webkit-appearance: none;
		appearance: none;
		height: 4px;
		border-radius: 2px;
		background: linear-gradient(
			to right,
			var(--accent) 0%,
			var(--accent) var(--progress),
			var(--accent-bg) var(--progress),
			var(--accent-bg) 100%
		);
		outline: none;
		cursor: pointer;
		min-width: 80px;
	}

	.tl-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--accent);
		border: 2px solid var(--bg-card, #fff);
		cursor: pointer;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
	}

	.tl-slider::-moz-range-thumb {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--accent);
		border: 2px solid var(--bg-card, #fff);
		cursor: pointer;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
	}

	.tl-date {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--text-secondary);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.tl-count {
		font-size: 0.7rem;
		font-weight: 700;
		color: var(--accent);
		white-space: nowrap;
		flex-shrink: 0;
	}

	@keyframes slide-up {
		from { opacity: 0; transform: translateX(-50%) translateY(8px); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}

	@media (max-width: 500px) {
		.timeline-bar {
			width: calc(100% - 24px);
		}
		.tl-date {
			display: none;
		}
	}
</style>
