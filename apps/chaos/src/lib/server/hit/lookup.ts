import { Resolver } from "node:dns/promises";

import { PROVIDERS, type Role } from "./providers";

/** The public DNS records the check reads. */
export interface Records {
	ns: string[];
	mx: string[];
	txt: string[];
	/** What `www.<domain>` is an alias for. */
	cname: string[];
}

export type Dns = (domain: string) => Promise<Records | "missing" | "failed">;

/** Names that never belong to the public internet. They are refused without a lookup. */
const PRIVATE =
	/\.(?:local|localhost|internal|intranet|lan|home|corp|arpa|test|invalid|example|onion)$/;
const HOSTNAME =
	/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Reduces what a visitor typed to a public domain name, or nothing. A pasted address or URL is cut
 * down to its host. An IP address, a single label or a private suffix is refused.
 */
export function parseDomain(input: string): string | undefined {
	const typed = input.trim().toLowerCase();

	if (typed === "" || typed.length > 300) {
		return undefined;
	}

	const host = URL.parse(typed.includes("://") ? typed : `https://${typed.split("@").at(-1) ?? ""}`)
		?.hostname.replace(/^www\./, "")
		.replace(/\.$/, "");

	return host !== undefined && HOSTNAME.test(host) && !PRIVATE.test(host) ? host : undefined;
}

const ABSENT = new Set(["ENODATA", "ENOTFOUND"]);

/**
 * Reads the records through the system resolver. Only DNS is asked: the domain itself is never
 * connected to, so a typed name cannot make this server reach a host.
 */
export const systemDns: Dns = async (domain) => {
	const resolver = new Resolver({ timeout: 3000, tries: 1 });
	let failed = 0;
	let missing = 0;
	const read = async <T>(ask: () => Promise<T[]>): Promise<T[]> => {
		try {
			return await ask();
		} catch (error) {
			const code = (error as { code?: unknown }).code;

			if (code === "ENOTFOUND") {
				missing += 1;
			} else if (typeof code !== "string" || !ABSENT.has(code)) {
				failed += 1;
			}

			return [];
		}
	};

	const [ns, mx, txt, cname] = await Promise.all([
		read(() => resolver.resolveNs(domain)),
		read(() => resolver.resolveMx(domain)),
		read(() => resolver.resolveTxt(domain)),
		read(() => resolver.resolveCname(`www.${domain}`)),
	]);

	if (failed > 0) {
		return "failed";
	}

	// The name itself does not exist when even its name servers are unknown.
	if (missing > 0 && ns.length === 0 && mx.length === 0 && txt.length === 0) {
		return "missing";
	}

	return {
		ns,
		mx: mx.map((record) => record.exchange),
		txt: txt.map((chunks) => chunks.join("")),
		cname,
	};
};

export interface Sign {
	role: Role;
	/** The record that names the provider. A TXT proof is cut to its label, never its secret half. */
	evidence: string;
}

export interface Dependency {
	id: string;
	name: string;
	board: string | undefined;
	vendors: readonly string[];
	signs: Sign[];
}

/**
 * Whether a host is the provider's. A text rule is a suffix of whole labels, so a look-alike such
 * as "google.com.attacker.example" never matches ".google.com".
 */
function named(host: string, rules: readonly (string | RegExp)[] | undefined): boolean {
	const name = host.toLowerCase().replace(/\.$/, "");

	return (rules ?? []).some((rule) => {
		if (typeof rule !== "string") {
			return rule.test(name);
		}

		const suffix = rule.replace(/^\./, "");

		return name === suffix || name.endsWith(`.${suffix}`);
	});
}

/** Matches the records against the fixed provider rules. Code decides every match. */
export function dependencies(records: Records): Dependency[] {
	const spf = records.txt
		.filter((record) => record.toLowerCase().startsWith("v=spf1"))
		.flatMap((record) => record.split(/\s+/))
		.filter((part) => part.toLowerCase().startsWith("include:"))
		.map((part) => part.slice("include:".length));

	return PROVIDERS.flatMap((provider) => {
		const signs: Sign[] = [];
		const add = (
			role: Role,
			kind: string,
			hosts: readonly string[],
			rules?: readonly (string | RegExp)[],
		) => {
			const host = hosts.find((candidate) => named(candidate, rules));

			if (host !== undefined) {
				signs.push({ role, evidence: `${kind} ${host.toLowerCase()}` });
			}
		};

		add("DNS", "NS", records.ns, provider.ns);
		add("Mail", "MX", records.mx, provider.mx);
		add("Sends mail", "SPF include", spf, provider.spf);
		add("Website", "www CNAME", records.cname, provider.cname);

		const proof = (provider.txt ?? []).find((label) =>
			records.txt.some((record) => record.startsWith(label)),
		);

		if (proof !== undefined) {
			signs.push({ role: "Account", evidence: `TXT ${proof.replace(/[=_]$/, "")}` });
		}

		return signs.length > 0
			? [
					{
						id: provider.id,
						name: provider.name,
						board: provider.board,
						vendors: provider.vendors ?? [],
						signs,
					},
				]
			: [];
	});
}
