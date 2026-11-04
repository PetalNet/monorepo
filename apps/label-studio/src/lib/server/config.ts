import type { SourceId } from "$lib/api";

export interface SourceConfig {
	url: string;
	/** File holding the token or API key; read per request, never cached. */
	secretFile: string;
	/** Accept a self-signed certificate for this source only. */
	insecureTls: boolean;
	/** Proxmox node name. */
	node?: string;
}

export interface Config {
	printerUrl: string;
	dataDir: string;
	/** Null when the source's URL or secret file is not set. */
	sources: Record<SourceId, SourceConfig | null>;
}

type Env = Readonly<Record<string, string | undefined>>;

const SOURCE_ENV: Record<SourceId, { url: string; secret: string; node?: string }> = {
	proxmox: {
		url: "LABEL_STUDIO_PROXMOX_URL",
		secret: "LABEL_STUDIO_PROXMOX_TOKEN_FILE",
		node: "LABEL_STUDIO_PROXMOX_NODE",
	},
	truenas: { url: "LABEL_STUDIO_TRUENAS_URL", secret: "LABEL_STUDIO_TRUENAS_KEY_FILE" },
	hass: { url: "LABEL_STUDIO_HASS_URL", secret: "LABEL_STUDIO_HASS_TOKEN_FILE" },
};

export function parseConfig(env: Env): Config {
	const value = (key: string): string | undefined => {
		const raw = env[key]?.trim();

		return raw === "" ? undefined : raw;
	};

	const insecure = new Set(
		(value("LABEL_STUDIO_INSECURE_TLS") ?? "").split(",").map((id) => id.trim()),
	);

	const source = (id: SourceId): SourceConfig | null => {
		const keys = SOURCE_ENV[id];
		const url = value(keys.url);
		const secretFile = value(keys.secret);
		const node = keys.node === undefined ? undefined : value(keys.node);

		if (!url || !secretFile || (keys.node !== undefined && !node)) {
			return null;
		}

		return { url: url.replace(/\/+$/, ""), secretFile, insecureTls: insecure.has(id), node };
	};

	return {
		printerUrl: (value("LABEL_STUDIO_PRINTER_URL") ?? "http://127.0.0.1:8631").replace(/\/+$/, ""),
		dataDir: value("LABEL_STUDIO_DATA_DIR") ?? "./data",
		sources: { proxmox: source("proxmox"), truenas: source("truenas"), hass: source("hass") },
	};
}
