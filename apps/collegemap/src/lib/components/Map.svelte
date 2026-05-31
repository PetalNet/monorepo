<script lang="ts">
	import { onMount } from 'svelte';
	import type { Map as LeafletMap, Marker, TileLayer } from 'leaflet';
	import { getLogoUrl } from '$lib/collegeLogos';

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

	interface CollegeGroup {
		college: {
			id: string;
			name: string;
			latitude: number;
			longitude: number;
		};
		users: { firstName: string; lastName: string }[];
	}

	interface SelectedCollege {
		name: string;
		latitude: number;
		longitude: number;
	}

	let {
		users = [],
		viewMode = 'markers',
		selectedCollege = null,
		onMapReady = (_m: LeafletMap) => {}
	}: {
		users: UserWithCollege[];
		viewMode?: 'markers' | 'heat';
		selectedCollege?: SelectedCollege | null;
		onMapReady?: (map: LeafletMap) => void;
	} = $props();

	let mapContainer: HTMLDivElement;
	let map: LeafletMap;
	let markersByCollege = new Map<string, Marker>();
	let tileLayer: TileLayer;
	let L: typeof import('leaflet');
	let clusterGroup: import('leaflet').MarkerClusterGroup | null = null;
	let heatLayer: import('leaflet').HeatLayer | null = null;
	let collegeGroups: CollegeGroup[] = [];
	const collegeInfoCache = new Map<string, { description: string | null; thumbnailUrl: string | null }>();

	function groupUsersByCollege(users: UserWithCollege[]): CollegeGroup[] {
		const groups = new Map<string, CollegeGroup>();

		for (const user of users) {
			const existing = groups.get(user.college.id);
			if (existing) {
				existing.users.push({ firstName: user.firstName, lastName: user.lastName });
			} else {
				groups.set(user.college.id, {
					college: user.college,
					users: [{ firstName: user.firstName, lastName: user.lastName }]
				});
			}
		}

		return Array.from(groups.values());
	}

	function getMarkerSize(count: number): number {
		if (count >= 10) return 46;
		if (count >= 3) return 38;
		return 30;
	}

	function setTiles() {
		if (!map || !L) return;
		if (tileLayer) tileLayer.remove();

		tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
			maxZoom: 19
		}).addTo(map);
	}

	onMount(() => {
		let isDestroyed = false;

		const init = async () => {
			const LModule = await import('leaflet');
			if (isDestroyed) return;
			L = (LModule.default ?? LModule) as typeof import('leaflet');

			// Load markercluster plugin (extends L)
			await import('leaflet.markercluster');
			// Load heat plugin (extends L)
			await import('leaflet.heat');

			if (isDestroyed) return;

			map = L.map(mapContainer, {
				zoomControl: true
			}).setView([39.8283, -98.5795], 4);

			setTiles();
			updateMarkers();
			applyViewMode();
			onMapReady(map);
		};

		void init();

		return () => {
			isDestroyed = true;
			map?.remove();
		};
	});

	function getClusterTotalCount(cluster: import('leaflet').MarkerCluster): number {
		let total = 0;
		const childMarkers = cluster.getAllChildMarkers();
		for (const m of childMarkers) {
			total += (m.options as any).collegeCount ?? 1;
		}
		return total;
	}

	function updateMarkers() {
		if (!L || !map) return;

		// Clean up old cluster group
		if (clusterGroup) {
			clusterGroup.clearLayers();
			map.removeLayer(clusterGroup);
		}

		markersByCollege.clear();

		// Create cluster group with custom icon
		clusterGroup = L.markerClusterGroup({
			iconCreateFunction: (cluster) => {
				const totalCount = getClusterTotalCount(cluster);
				const size = totalCount >= 50 ? 56 : totalCount >= 20 ? 48 : 40;
				return L.divIcon({
					className: 'college-cluster',
					html: `<div class="cluster-dot" style="width:${size}px;height:${size}px">
						<div class="cluster-inner">${totalCount}</div>
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

			const markerHtml = logoUrl
				? `<div class="marker-dot" style="width:${size}px;height:${size}px">
					<div class="marker-inner marker-logo">
						<img src="${logoUrl}" alt="" width="${Math.round(size * 0.55)}" height="${Math.round(size * 0.55)}" onerror="this.style.display='none';this.parentElement.textContent='${userCount}'" />
					</div>
				</div>`
				: `<div class="marker-dot" style="width:${size}px;height:${size}px">
					<div class="marker-inner">${userCount}</div>
				</div>`;

			const icon = L.divIcon({
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
					<div class="popup-count">${userCount} ${userCount === 1 ? 'student' : 'students'}</div>
					<div class="popup-meta" id="popup-meta-${group.college.id}"></div>
					<div class="popup-students">${names}</div>
				</div>
			`;

			const marker = L.marker([group.college.latitude, group.college.longitude], {
				icon,
				collegeCount: userCount
			} as any).bindPopup(popupContent, { maxWidth: 250 });

			marker.on('click', () => {
				map.flyTo([group.college.latitude, group.college.longitude], 10, {
					duration: 1.2
				});
			});

			marker.on('popupopen', async () => {
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
					const info = await resp.json();
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
			});

			markersByCollege.set(group.college.name, marker);
			clusterGroup!.addLayer(marker);
		}

		// Build heat data
		const heatData: [number, number, number][] = collegeGroups.map((g) => [
			g.college.latitude,
			g.college.longitude,
			g.users.length
		]);

		if (heatLayer) {
			map.removeLayer(heatLayer);
		}

		heatLayer = L.heatLayer(heatData, {
			radius: 35,
			blur: 25,
			maxZoom: 10,
			gradient: { 0.2: '#bfdbfe', 0.4: '#818cf8', 0.6: '#6366f1', 0.8: '#4f46e5', 1.0: '#312e81' }
		});

		// Apply current view mode
		applyViewMode();
	}

	function applyViewMode() {
		if (!map || !clusterGroup || !heatLayer) return;

		if (viewMode === 'heat') {
			if (map.hasLayer(clusterGroup)) map.removeLayer(clusterGroup);
			if (!map.hasLayer(heatLayer)) heatLayer.addTo(map);
		} else {
			if (map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
			if (!map.hasLayer(clusterGroup)) clusterGroup.addTo(map);
		}
	}

	// React to users prop changes
	$effect(() => {
		if (map && users) {
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
		if (!selectedCollege || !map || !clusterGroup) return;

		const marker = markersByCollege.get(selectedCollege.name);
		if (marker) {
			clusterGroup.zoomToShowLayer(marker, () => {
				marker.openPopup();
			});
		} else {
			// College exists in data but has no marker (no users) - just fly to coords
			map.flyTo([selectedCollege.latitude, selectedCollege.longitude], 10, {
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
