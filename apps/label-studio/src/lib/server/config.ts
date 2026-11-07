import type { SourceId } from "$lib/api";

export interface SourceConfig {
	url: string;
	/** File holding the token or API key; read per request, never cached. */
	secretFile: string;
	/**
	 * PEM certificate this source's TLS chain must lead to, in place of the system roots, for a
	 * self-signed lab appliance. Read per request.
	 */
	caFile?: string;
	/**
	 * Name the certificate is checked against and sent as SNI, for an appliance reached by an IP its
	 * certificate does not list. The connection still goes to the URL's host.
	 */
	tlsName?: string;
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

const SOURCE_ENV: Record<
	SourceId,
	{ url: string; secret: string; ca: string; tlsName: string; node?: string }
> = {
	proxmox: {
		url: "LABEL_STUDIO_PROXMOX_URL",
		secret: "LABEL_STUDIO_PROXMOX_TOKEN_FILE",
		ca: "LABEL_STUDIO_PROXMOX_CA_FILE",
		tlsName: "LABEL_STUDIO_PROXMOX_TLS_NAME",
		node: "LABEL_STUDIO_PROXMOX_NODE",
	},
	truenas: {
		url: "LABEL_STUDIO_TRUENAS_URL",
		secret: "LABEL_STUDIO_TRUENAS_KEY_FILE",
		ca: "LABEL_STUDIO_TRUENAS_CA_FILE",
		tlsName: "LABEL_STUDIO_TRUENAS_TLS_NAME",
	},
	hass: {
		url: "LABEL_STUDIO_HASS_URL",
		secret: "LABEL_STUDIO_HASS_TOKEN_FILE",
		ca: "LABEL_STUDIO_HASS_CA_FILE",
		tlsName: "LABEL_STUDIO_HASS_TLS_NAME",
	},
};

/** The variables that pin a source's certificate and the name it is checked against. */
export const tlsEnv = (id: SourceId): { ca: string; tlsName: string } => SOURCE_ENV[id];

export function parseConfig(env: Env): Config {
	const value = (key: string): string | undefined => {
		const raw = env[key]?.trim();

		return raw === "" ? undefined : raw;
	};

	const source = (id: SourceId): SourceConfig | null => {
		const keys = SOURCE_ENV[id];
		const url = value(keys.url);
		const secretFile = value(keys.secret);
		const node = keys.node === undefined ? undefined : value(keys.node);

		if (!url || !secretFile || (keys.node !== undefined && !node)) {
			return null;
		}

		return {
			url: url.replace(/\/+$/, ""),
			secretFile,
			caFile: value(keys.ca),
			tlsName: value(keys.tlsName),
			node,
		};
	};

	return {
		printerUrl: (value("LABEL_STUDIO_PRINTER_URL") ?? "http://127.0.0.1:8631").replace(/\/+$/, ""),
		dataDir: value("LABEL_STUDIO_DATA_DIR") ?? "./data",
		sources: { proxmox: source("proxmox"), truenas: source("truenas"), hass: source("hass") },
	};
}
