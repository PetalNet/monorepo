/// <reference types="@types/google.maps" />

declare global {
	interface Window {
		google: typeof google;
		initGoogleMaps: () => void;
	}
}

let loadPromise: Promise<void> | null = null;

export function loadGoogleMaps(apiKey: string): Promise<void> {
	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = new Promise((resolve, reject) => {
		// Check if already loaded
		if (window.google?.maps) {
			resolve();
			return;
		}

		// Create callback
		window.initGoogleMaps = () => {
			resolve();
			Reflect.deleteProperty(window, "initGoogleMaps");
		};

		// Load script
		const script = document.createElement("script");
		script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,marker&loading=async&callback=initGoogleMaps`;
		script.async = true;
		script.defer = true;
		script.addEventListener("error", () => reject(new Error("Failed to load Google Maps script")));
		document.head.appendChild(script);
	});

	return loadPromise;
}
