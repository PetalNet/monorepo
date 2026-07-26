<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type { Map as LeafletMap, Marker, MarkerOptions, TileLayer } from 'leaflet';
	import { getLogoUrl } from '$lib/collegeLogos';
	import { groupUsersByCollege, type CollegeGroup, type UserWithCollege } from '$lib/collegeGroups';

	interface SelectedCollege {
		name: string;
		latitude: number;
		longitude: number;
	}

	/** What `/api/college-info` answers with — also the shape held in the popup cache. */
	interface CollegeInfo {
		description: string | null;
		thumbnailUrl: string | null;
	}

	/** Markers carry the college's headcount so a cluster can total its children (see below). */
	interface CollegeMarkerOptions extends MarkerOptions {
		collegeCount?: number;
	}

	let {
		users,
		viewMode = 'markers',
		selectedCollege = null,
		onMapReady
	}: {
		users: UserWithCollege[];
		viewMode?: 'markers' | 'heat';
		selectedCollege?: SelectedCollege | null;
		onMapReady?: (map: LeafletMap) => void;
	} = $props();

	let mapContainer = $state<HTMLDivElement>();
	// Everything below is populated by the async Leaflet import in onMount, so it is genuinely
	// absent until then -- the guards throughout this file depend on saying so.
	let map: LeafletMap | undefined;
	let tileLayer: TileLayer | undefined;
	let L: typeof import('leaflet') | undefined;
	let markersByCollege = new SvelteMap<string, Marker>();
	let clusterGroup: import('leaflet').MarkerClusterGroup | null = null;
	let heatLayer: import('leaflet').HeatLayer | null = null;
	let collegeGroups: CollegeGroup[] = [];
	const collegeInfoCache = new SvelteMap<string, CollegeInfo>();

	function getMarkerSize(count: number): number {
		if (count >= 10) return 46;
		if (count >= 3) return 38;
		return 30;
	}

	function setTiles() {
		const leaflet = L;
		const leafletMap = map;
		if (!leafletMap || !leaflet) return;
		if (tileLayer) tileLayer.remove();

		tileLayer = leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
			maxZoom: 19
		}).addTo(leafletMap);
	}

	onMount(() => {
		// A plain `let destroyed = false` would be narrowed to `false` for the whole closure; the
		// signal is read through a getter, so the post-import check is a real read.
		const teardown = new AbortController();

		const init = async () => {
			const LModule = await import('leaflet');
			// Both plugins extend L, so they load after it and before anything touches the map.
			await import('leaflet.markercluster');
			await import('leaflet.heat');

			if (teardown.signal.aborted) return;
			L = LModule.default;

			if (!mapContainer) return;

			map = L.map(mapContainer, {
				zoomControl: true
			}).setView([39.8283, -98.5795], 4);

			setTiles();
			updateMarkers();
			applyViewMode();
			onMapReady?.(map);
		};

		void init();

		return () => {
			teardown.abort();
			map?.remove();
		};
	});

	function getClusterTotalCount(cluster: import('leaflet').MarkerCluster): number {
		let total = 0;
		const childMarkers = cluster.getAllChildMarkers();
		for (const m of childMarkers) {
			total += (m.options as CollegeMarkerOptions).collegeCount ?? 1;
		}
		return total;
	}

	function updateMarkers() {
		// Narrowed once so the closures below (cluster icons, marker handlers) keep the non-null
		// view of the async-loaded Leaflet module and map.
		const leaflet = L;
		const leafletMap = map;
		if (!leaflet || !leafletMap) return;

		// Clean up old cluster group
		if (clusterGroup) {
			clusterGroup.clearLayers();
			leafletMap.removeLayer(clusterGroup);
		}

		markersByCollege.clear();

		// Create cluster group with custom icon
		clusterGroup = leaflet.markerClusterGroup({
			iconCreateFunction: (cluster) => {
				const totalCount = getClusterTotalCount(cluster);
				const size = totalCount >= 50 ? 56 : totalCount >= 20 ? 48 : 40;
				return leaflet.divIcon({
					className: 'college-cluster',
					html: `<div class="cluster-dot" style="width:${size.toString()}px;height:${size.toString()}px">
						<div class="cluster-inner">${totalCount.toString()}</div>
					</div>`,
					iconSize: [size, size],
					iconAnchor: [size / 2, size / 2]
				});
			},
			showCoverageOnHover: false,
			maxClusterRadius: 60
		});

		collegeGroups = groupUsersByCollege(users);

		for (const group of collegeGroups) {
			const userCount = group.users.length;
			const size = getMarkerSize(userCount);
			const logoUrl = getLogoUrl(group.college.name, size);
			const names = group.users
				.map((u) => `<span class="popup-student">${u.firstName} ${u.lastName}</span>`)
				.join('');

			const logoSize = Math.round(size * 0.55).toString();
			const markerHtml = logoUrl
				? `<div class="marker-dot" style="width:${size.toString()}px;height:${size.toString()}px">
					<div class="marker-inner marker-logo">
						<img src="${logoUrl}" alt="" width="${logoSize}" height="${logoSize}" onerror="this.style.display='none';this.parentElement.textContent='${userCount.toString()}'" />
					</div>
				</div>`
				: `<div class="marker-dot" style="width:${size.toString()}px;height:${size.toString()}px">
					<div class="marker-inner">${userCount.toString()}</div>
				</div>`;

			const icon = leaflet.divIcon({
				className: 'college-marker',
				html: markerHtml,
				iconSize: [size, size],
				iconAnchor: [size / 2, size / 2]
			});

			const popupLogoUrl = getLogoUrl(group.college.name, 32);
			const popupLogoHtml = popupLogoUrl
				? `<img class="popup-logo" src="${popupLogoUrl}" alt="" width="20" height="20" onerror="this.style.display='none'" />`
				: '';

			const popupContent = `
				<div class="popup-content">
					<div class="popup-header">
						${popupLogoHtml}
						<div class="popup-college-name">${group.college.name}</div>
					</div>
					<div class="popup-count">${userCount.toString()} ${userCount === 1 ? 'student' : 'students'}</div>
					<div class="popup-meta" id="popup-meta-${group.college.id}"></div>
					<div class="popup-students">${names}</div>
				</div>
			`;

			const markerOptions: CollegeMarkerOptions = { icon, collegeCount: userCount };
			const marker = leaflet
				.marker([group.college.latitude, group.college.longitude], markerOptions)
				.bindPopup(popupContent, { maxWidth: 250 });

			marker.on('click', () => {
				leafletMap.flyTo([group.college.latitude, group.college.longitude], 10, {
					duration: 1.2
				});
			});

			const loadPopupMeta = async () => {
				const metaEl = document.getElementById(`popup-meta-${group.college.id}`);
				if (!metaEl || metaEl.dataset.loaded) return;

				// Check client-side cache first
				const cached = collegeInfoCache.get(group.college.name);
				if (cached) {
					if (cached.description) {
						metaEl.innerHTML = `<div class="popup-description">${cached.description.slice(0, 150)}...</div>`;
					}
					metaEl.dataset.loaded = 'true';
					marker.getPopup()?.update();
					return;
				}

				metaEl.innerHTML = '<div class="popup-meta-loading">Loading info...</div>';
				try {
					const resp = await fetch(`/api/college-info?name=${encodeURIComponent(group.college.name)}`);
					const info = (await resp.json()) as CollegeInfo;
					collegeInfoCache.set(group.college.name, info);
					if (info.description) {
						metaEl.innerHTML = `<div class="popup-description">${info.description.slice(0, 150)}...</div>`;
					} else {
						metaEl.innerHTML = '';
					}
				} catch {
					metaEl.innerHTML = '';
				}
				metaEl.dataset.loaded = 'true';
				marker.getPopup()?.update();
			};

			// Leaflet's handler signature is void-returning, so the fetch is fired and not awaited.
			marker.on('popupopen', () => {
				void loadPopupMeta();
			});

			markersByCollege.set(group.college.name, marker);
			clusterGroup.addLayer(marker);
		}

		// Build heat data
		const heatData: [number, number, number][] = collegeGroups.map((g) => [
			g.college.latitude,
			g.college.longitude,
			g.users.length
		]);

		if (heatLayer) {
			leafletMap.removeLayer(heatLayer);
		}

		heatLayer = leaflet.heatLayer(heatData, {
			radius: 35,
			blur: 25,
			maxZoom: 10,
			gradient: { 0.2: '#bfdbfe', 0.4: '#818cf8', 0.6: '#6366f1', 0.8: '#4f46e5', 1.0: '#312e81' }
		});

		// Apply current view mode
		applyViewMode();
	}

	function applyViewMode() {
		const leafletMap = map;
		if (!leafletMap || !clusterGroup || !heatLayer) return;

		if (viewMode === 'heat') {
			if (leafletMap.hasLayer(clusterGroup)) leafletMap.removeLayer(clusterGroup);
			if (!leafletMap.hasLayer(heatLayer)) heatLayer.addTo(leafletMap);
		} else {
			if (leafletMap.hasLayer(heatLayer)) leafletMap.removeLayer(heatLayer);
			if (!leafletMap.hasLayer(clusterGroup)) clusterGroup.addTo(leafletMap);
		}
	}

	// React to users prop changes. `map` is a plain binding, so `users` has to be read
	// unconditionally or the effect would stop tracking it before the map finishes loading.
	$effect(() => {
		void users;
		if (map) {
			updateMarkers();
		}
	});

	// React to viewMode changes
	$effect(() => {
		void viewMode;
		applyViewMode();
	});

	// React to selectedCollege - fly to it
	$effect(() => {
		const leafletMap = map;
		if (!selectedCollege || !leafletMap || !clusterGroup) return;

		const marker = markersByCollege.get(selectedCollege.name);
		if (marker) {
			clusterGroup.zoomToShowLayer(marker, () => {
				marker.openPopup();
			});
		} else {
			// College exists in data but has no marker (no users) - just fly to coords
			leafletMap.flyTo([selectedCollege.latitude, selectedCollege.longitude], 10, {
				duration: 1.2
			});
		}
	});
</script>

<div bind:this={mapContainer} class="h-full w-full"></div>

<style>
	:global(.college-marker) {
		background: transparent !important;
		border: none !important;
	}

	:global(.marker-dot) {
		border-radius: 50%;
		background: var(--marker-bg);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: transform 0.2s ease;
		box-shadow: 0 2px 8px rgba(99, 102, 241, 0.25);
	}

	:global(.marker-dot:hover) {
		transform: scale(1.15);
	}

	:global(.marker-inner) {
		width: calc(100% - 4px);
		height: calc(100% - 4px);
		border-radius: 50%;
		background: var(--marker-inner-bg);
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		font-size: 13px;
		color: var(--marker-text);
		font-family: 'Inter', sans-serif;
	}

	:global(.marker-logo) {
		padding: 0;
	}

	:global(.marker-logo img) {
		border-radius: 50%;
		object-fit: contain;
	}

	/* Cluster styles */
	:global(.college-cluster) {
		background: transparent !important;
		border: none !important;
	}

	:global(.cluster-dot) {
		border-radius: 50%;
		background: var(--marker-bg);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: transform 0.2s ease;
		box-shadow: 0 2px 12px rgba(99, 102, 241, 0.35);
		animation: cluster-pop 0.3s ease;
	}

	:global(.cluster-dot:hover) {
		transform: scale(1.12);
	}

	:global(.cluster-inner) {
		width: calc(100% - 6px);
		height: calc(100% - 6px);
		border-radius: 50%;
		background: var(--marker-inner-bg);
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 800;
		font-size: 14px;
		color: var(--marker-text);
		font-family: 'Inter', sans-serif;
	}

	@keyframes cluster-pop {
		from { transform: scale(0.5); opacity: 0; }
		to { transform: scale(1); opacity: 1; }
	}

	/* Hide default markercluster styles */
	:global(.marker-cluster-small),
	:global(.marker-cluster-medium),
	:global(.marker-cluster-large) {
		background: transparent !important;
	}

	:global(.marker-cluster-small div),
	:global(.marker-cluster-medium div),
	:global(.marker-cluster-large div) {
		background: transparent !important;
	}

	:global(.popup-content) {
		font-family: 'Inter', sans-serif;
	}

	:global(.popup-header) {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 2px;
	}

	:global(.popup-logo) {
		border-radius: 4px;
		flex-shrink: 0;
	}

	:global(.popup-college-name) {
		font-weight: 700;
		font-size: 14px;
		color: var(--popup-name-color);
		margin-bottom: 2px;
	}

	:global(.popup-count) {
		font-size: 11px;
		color: var(--popup-count-color);
		margin-bottom: 6px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 500;
	}

	:global(.popup-students) {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	:global(.popup-student) {
		font-size: 12px;
		color: var(--popup-student-color);
		padding: 1px 0;
	}
</style>
