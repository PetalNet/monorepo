// Color mapping from Tailwind
const colorMap: Record<
	string,
	{ 50: string; 100: string; 600: string; 700: string; 800: string; 900: string }
> = {
	red: {
		50: "#fef2f2",
		100: "#fee2e2",
		600: "#dc2626",
		700: "#b91c1c",
		800: "#991b1b",
		900: "#7f1d1d",
	},
	orange: {
		50: "#fff7ed",
		100: "#ffedd5",
		600: "#ea580c",
		700: "#c2410c",
		800: "#9a3412",
		900: "#7c2d12",
	},
	amber: {
		50: "#fffbeb",
		100: "#fef3c7",
		600: "#d97706",
		700: "#b45309",
		800: "#92400e",
		900: "#78350f",
	},
	yellow: {
		50: "#fefce8",
		100: "#fef9c3",
		600: "#ca8a04",
		700: "#a16207",
		800: "#854d0e",
		900: "#713f12",
	},
	lime: {
		50: "#f7fee7",
		100: "#ecfccb",
		600: "#65a30d",
		700: "#4d7c0f",
		800: "#3f6212",
		900: "#365314",
	},
	green: {
		50: "#f0fdf4",
		100: "#dcfce7",
		600: "#16a34a",
		700: "#15803d",
		800: "#166534",
		900: "#14532d",
	},
	emerald: {
		50: "#ecfdf5",
		100: "#d1fae5",
		600: "#059669",
		700: "#047857",
		800: "#065f46",
		900: "#064e3b",
	},
	teal: {
		50: "#f0fdfa",
		100: "#ccfbf1",
		600: "#0d9488",
		700: "#0f766e",
		800: "#115e59",
		900: "#134e4a",
	},
	cyan: {
		50: "#ecfeff",
		100: "#cffafe",
		600: "#0891b2",
		700: "#0e7490",
		800: "#155e75",
		900: "#164e63",
	},
	sky: {
		50: "#f0f9ff",
		100: "#e0f2fe",
		600: "#0284c7",
		700: "#0369a1",
		800: "#075985",
		900: "#0c4a6e",
	},
	blue: {
		50: "#eff6ff",
		100: "#dbeafe",
		600: "#2563eb",
		700: "#1d4ed8",
		800: "#1e40af",
		900: "#1e3a8a",
	},
	indigo: {
		50: "#eef2ff",
		100: "#e0e7ff",
		600: "#4f46e5",
		700: "#4338ca",
		800: "#3730a3",
		900: "#312e81",
	},
	violet: {
		50: "#f5f3ff",
		100: "#ede9fe",
		600: "#7c3aed",
		700: "#6d28d9",
		800: "#5b21b6",
		900: "#4c1d95",
	},
	purple: {
		50: "#faf5ff",
		100: "#f3e8ff",
		600: "#9333ea",
		700: "#7e22ce",
		800: "#6b21a8",
		900: "#581c87",
	},
	fuchsia: {
		50: "#fdf4ff",
		100: "#fae8ff",
		600: "#c026d3",
		700: "#a21caf",
		800: "#86198f",
		900: "#701a75",
	},
	pink: {
		50: "#fdf2f8",
		100: "#fce7f3",
		600: "#db2777",
		700: "#be185d",
		800: "#9f1239",
		900: "#831843",
	},
	rose: {
		50: "#fff1f2",
		100: "#ffe4e6",
		600: "#e11d48",
		700: "#be123c",
		800: "#9f1239",
		900: "#881337",
	},
};

// Legacy hex to color name mapping (for old events)
const hexToColorName: Record<string, string> = {
	"#EF4444": "red",
	"#F97316": "orange",
	"#F59E0B": "amber",
	"#EAB308": "yellow",
	"#84CC16": "lime",
	"#22C55E": "green",
	"#10B981": "emerald",
	"#14B8A6": "teal",
	"#06B6D4": "cyan",
	"#0EA5E9": "sky",
	"#3B82F6": "blue",
	"#6366F1": "indigo",
	"#8B5CF6": "violet",
	"#A855F7": "purple",
	"#D946EF": "fuchsia",
	"#EC4899": "pink",
	"#F43F5E": "rose",
};

const hexToRgb = (value: string | null | undefined) => {
	if (!value) {
		return { r: 255, g: 255, b: 255 };
	}

	const normalized = value.trim();
	const rgbMatch = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(normalized);

	if (rgbMatch) {
		return {
			r: Number(rgbMatch[1]),
			g: Number(rgbMatch[2]),
			b: Number(rgbMatch[3]),
		};
	}

	const trimmed = normalized.replace("#", "");

	if (!/^[0-9a-fA-F]{3,8}$/.test(trimmed)) {
		return { r: 255, g: 255, b: 255 };
	}

	const expanded =
		trimmed.length === 3 || trimmed.length === 4
			? trimmed
					.split("")
					.map((c) => c + c)
					.join("")
			: trimmed.length >= 6
				? trimmed.slice(0, 6)
				: trimmed.padEnd(6, trimmed[trimmed.length - 1] ?? "0");

	return {
		r: parseInt(expanded.slice(0, 2), 16),
		g: parseInt(expanded.slice(2, 4), 16),
		b: parseInt(expanded.slice(4, 6), 16),
	};
};

export const withAlpha = (color: string | null | undefined, alpha: number) => {
	const { r, g, b } = hexToRgb(color);

	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const mixColors = (colorA: string, colorB: string, weight = 0.5, alpha = 1) => {
	const clamp = (value: number, min = 0, max = 1) => Math.min(Math.max(value, min), max);
	const w = clamp(weight);
	const a = hexToRgb(colorA);
	const b = hexToRgb(colorB);
	const r = Math.round(a.r * w + b.r * (1 - w));
	const g = Math.round(a.g * w + b.g * (1 - w));
	const bl = Math.round(a.b * w + b.b * (1 - w));
	const aFixed = Number(alpha.toFixed(3));

	if (aFixed >= 1) {
		return `rgb(${r}, ${g}, ${bl})`;
	}

	return `rgba(${r}, ${g}, ${bl}, ${aFixed})`;
};

/** The event page's colours and the CSS variables its page, header and cards are themed with. */
export function eventTheme(event: {
	primaryColor: string | null;
	secondaryColor: string | null;
	backgroundImage: string | null;
}) {
	// Color utilities - handle both old hex values and new color names
	const getPrimaryColor = () => {
		if (!event.primaryColor) {
			return "violet";
		}

		// Check if it's a hex color (old format)
		if (event.primaryColor.startsWith("#")) {
			return hexToColorName[event.primaryColor] || "violet";
		}

		return event.primaryColor;
	};

	const getSecondaryColor = () => {
		if (!event.secondaryColor) {
			return "pink";
		}

		// Check if it's a hex color (old format)
		if (event.secondaryColor.startsWith("#")) {
			return hexToColorName[event.secondaryColor] || "pink";
		}

		return event.secondaryColor;
	};

	const primaryColor = getPrimaryColor();
	const secondaryColor = getSecondaryColor();
	const primaryColors = colorMap[primaryColor] || colorMap.violet;
	const secondaryColors = colorMap[secondaryColor] || colorMap.pink;

	const pageBackgroundLight = mixColors(
		"#fdfbff",
		mixColors(primaryColors[50], secondaryColors[50], 0.55, 1),
		0.82,
		1,
	);
	const pageBackgroundDark = "#0c0b11"; // Solid base for dark mode

	const backgroundImage = event.backgroundImage ? `url("${event.backgroundImage}")` : "none";
	const backgroundOverlayLight = event.backgroundImage
		? `linear-gradient(to bottom, ${withAlpha("#ffffff", 0.92)}, ${withAlpha("#ffffff", 0.96)})`
		: `radial-gradient(120% 120% at 20% -12%, ${withAlpha(primaryColors[100], 0.32)}, transparent 62%), radial-gradient(140% 140% at 92% 120%, ${withAlpha(secondaryColors[100], 0.18)}, transparent 70%)`;
	const backgroundOverlayDark = event.backgroundImage
		? `linear-gradient(to bottom, rgba(0,0,0,0.85), rgba(0,0,0,0.9))`
		: `linear-gradient(135deg, ${mixColors("#0c0b11", primaryColors[900], 0.85, 1)} 0%, ${mixColors("#0c0b11", secondaryColors[900], 0.88, 1)} 100%), radial-gradient(120% 120% at 18% -14%, ${withAlpha(primaryColors[600], 0.18)}, transparent 58%), radial-gradient(140% 150% at 92% 125%, ${withAlpha(secondaryColors[600], 0.15)}, transparent 68%)`;

	const themeVars = {
		"--event-primary-50": primaryColors[50],
		"--event-primary-100": primaryColors[100],
		"--event-primary-600": primaryColors[600],
		"--event-primary-700": primaryColors[700],
		"--event-primary-800": primaryColors[800],
		"--event-primary-900": primaryColors[900],
		"--event-primary-600-alpha": `${primaryColors[600]}30`,
		"--event-secondary-50": secondaryColors[50],
		"--event-secondary-100": secondaryColors[100],
		"--event-secondary-600": secondaryColors[600],
		"--event-secondary-700": secondaryColors[700],
		"--event-secondary-800": secondaryColors[800],
		"--event-secondary-900": secondaryColors[900],
		"--event-secondary-600-alpha": withAlpha(secondaryColors[600], 0.28),
		"--event-page-background": pageBackgroundLight,
		"--event-page-background-dark": pageBackgroundDark,
		"--event-background-image": backgroundImage,
		"--event-background-overlay": backgroundOverlayLight,
		"--event-background-overlay-dark": backgroundOverlayDark,
		"--event-background-attachment": event.backgroundImage ? "fixed" : "scroll",
		"--event-card-surface": "#ffffff",
		"--event-card-surface-dark": "rgba(28, 28, 35, 0.85)",
		"--event-section-surface": "#ffffff",
		"--event-section-surface-dark": "rgba(20, 20, 28, 0.8)",
		"--event-surface-border": withAlpha(primaryColors[600], 0.1),
		"--event-surface-border-dark": "rgba(255, 255, 255, 0.08)",
		"--event-surface-glow-dark": withAlpha(primaryColors[600], 0.15),
		"--event-panel-surface": "#ffffff",
		"--event-panel-surface-dark": "rgba(25, 25, 32, 0.85)",
		"--event-panel-shadow": withAlpha(primaryColors[600], 0.16),
		"--event-panel-shadow-dark": "0 8px 30px rgba(0, 0, 0, 0.6)",
		"--event-entry-surface-dark": "rgba(20, 20, 28, 0.9)",
		"--event-header-bg-light": mixColors(primaryColors[100], secondaryColors[100], 0.55, 0.9),
		"--event-header-bg-dark": `linear-gradient(135deg, rgba(${hexToRgb(primaryColors[700]).r}, ${hexToRgb(primaryColors[700]).g}, ${hexToRgb(primaryColors[700]).b}, 0.2), rgba(${hexToRgb(secondaryColors[700]).r}, ${hexToRgb(secondaryColors[700]).g}, ${hexToRgb(secondaryColors[700]).b}, 0.15))`,
		"--event-header-border-light": withAlpha(secondaryColors[600], 0.32),
		"--event-header-border-dark": "rgba(255, 255, 255, 0.1)",
		"--event-header-text-light": mixColors(primaryColors[900], secondaryColors[900], 0.6, 0.95),
		"--event-header-text-dark": "#ffffff",
		"--event-topbar-chip-bg": mixColors(primaryColors[50], secondaryColors[50], 0.4, 0.78),
		"--event-topbar-chip-bg-dark": `rgba(${hexToRgb(primaryColors[600]).r}, ${hexToRgb(primaryColors[600]).g}, ${hexToRgb(primaryColors[600]).b}, 0.25)`,
		"--event-topbar-chip-border": withAlpha(secondaryColors[600], 0.48),
		"--event-topbar-chip-text": mixColors(primaryColors[900], secondaryColors[900], 0.5, 0.95),
		"--event-topbar-chip-text-dark": "#ffffff",
		"--event-summary-attending-text": primaryColors[800],
		"--event-summary-attending-text-dark": "#ffffff",
		"--event-summary-maybe-text": secondaryColors[800],
		"--event-summary-maybe-text-dark": "#ffffff",
		"--event-summary-not-text": primaryColors[700],
		"--event-summary-not-text-dark": "#c9c9d4",
		"--event-entry-chip-bg-dark": `rgba(${hexToRgb(primaryColors[600]).r}, ${hexToRgb(primaryColors[600]).g}, ${hexToRgb(primaryColors[600]).b}, 0.3)`,
		"--event-entry-chip-text-dark": "#ffffff",
		"--event-badge-bg-dark": `rgba(${hexToRgb(secondaryColors[600]).r}, ${hexToRgb(secondaryColors[600]).g}, ${hexToRgb(secondaryColors[600]).b}, 0.3)`,
		"--event-badge-text-dark": "#ffffff",
		"--event-text-primary": "#1b1430",
		"--event-text-secondary": "#362a54",
		"--event-text-muted": "#5f5177",
		"--event-text-primary-dark": "#ffffff",
		"--event-text-secondary-dark": "#c9c9d4",
		"--event-text-muted-dark": "#8b8b99",
		"--event-divider-dark": withAlpha(secondaryColors[600], 0.22),
	} satisfies Record<string, string>;

	return { primaryColors, secondaryColors, themeVars };
}

// The layout reads these from the document root to theme its background and header.
export function applyEventTheme(
	themeVars: Record<string, string>,
	event: { emoji: string | null; title: string },
) {
	if (typeof document !== "undefined") {
		const root = document.documentElement;

		for (const [key, value] of Object.entries(themeVars)) {
			root.style.setProperty(key, value);
		}

		root.dataset.eventPage = "true";
		root.dataset.eventEmoji = event.emoji || "";
		root.dataset.eventTitle = event.title;
	}

	return () => {
		if (typeof document !== "undefined") {
			const root = document.documentElement;

			delete root.dataset.eventPage;
			delete root.dataset.eventEmoji;
			delete root.dataset.eventTitle;

			for (const key of Object.keys(themeVars)) {
				root.style.removeProperty(key);
			}
		}
	};
}
