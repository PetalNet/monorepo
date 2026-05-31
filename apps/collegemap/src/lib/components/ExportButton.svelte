<script lang="ts">
	import type { Map as LeafletMap } from 'leaflet';

	let {
		mapInstance = null,
		mapName = 'College Map'
	}: {
		mapInstance?: LeafletMap | null;
		mapName?: string;
	} = $props();

	let exporting = $state(false);

	async function exportMap() {
		if (!mapInstance || exporting) return;
		exporting = true;

		try {
			const leafletImage = (await import('leaflet-image')).default;
			leafletImage(mapInstance, (err: Error | null, canvas: HTMLCanvasElement) => {
				if (err || !canvas) {
					exporting = false;
					return;
				}

				// Add watermark
				const ctx = canvas.getContext('2d');
				if (ctx) {
					ctx.font = '14px Inter, system-ui, sans-serif';
					ctx.fillStyle = 'rgba(0,0,0,0.4)';
					ctx.textAlign = 'right';
					ctx.fillText(mapName, canvas.width - 12, canvas.height - 12);
				}

				canvas.toBlob((blob) => {
					if (!blob) {
						exporting = false;
						return;
					}
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = `${mapName.replace(/\s+/g, '-').toLowerCase()}-map.png`;
					a.click();
					URL.revokeObjectURL(url);
					exporting = false;
				}, 'image/png');
			});
		} catch {
			exporting = false;
		}
	}
</script>

<button
	class="view-toggle-btn"
	class:active={exporting}
	aria-label="Export map as image"
	onclick={exportMap}
	disabled={!mapInstance || exporting}
>
	{#if exporting}
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
			<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
		</svg>
	{:else}
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
			<polyline points="7 10 12 15 17 10"/>
			<line x1="12" y1="15" x2="12" y2="3"/>
		</svg>
	{/if}
</button>

<style>
	.spin {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
