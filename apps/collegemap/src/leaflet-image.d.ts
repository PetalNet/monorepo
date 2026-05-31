declare module 'leaflet-image' {
	import type { Map } from 'leaflet';
	function leafletImage(
		map: Map,
		callback: (err: Error | null, canvas: HTMLCanvasElement) => void
	): void;
	export default leafletImage;
}
