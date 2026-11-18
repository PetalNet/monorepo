import { Resolver } from "node:dns/promises";

import { PROVIDERS, type Role } from "./providers";

/** The public DNS records the check reads. */
interface Records {
	ns: string[];
	mx: string[];
	txt: string[];
	/** What `www.<domain>` is an alias for. */
	cname: string[];
}

/** The four questions the check asks a resolver. `node:dns/promises` answers them in production. */
export interface Dns {
	resolveNs: (name: string) => Promise<string[]>;
	resolveMx: (name: string) => Promise<{ exchange: string }[]>;
	resolveTxt: (name: string) => Promise<string[][]>;
	resolveCname: (name: string) => Promise<string[]>;
}

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

/** The system resolver, asked once with a short wait so a slow answer cannot hold the page. */
export const systemDns: Dns = new Resolver({ timeout: 3000, tries: 1 });

/**
 * Reads the records. Only DNS is asked: the domain itself is never connected to, so a typed name
 * cannot make this server reach a host. "missing" means the resolver says the name itself does not
 * exist; a name with none of these records is an empty answer, not a missing domain.
 */
export async function records(domain: string, dns: Dns): Promise<Records | "missing" | "failed"> {
	const read = async <T>(ask: () => Promise<T[]>): Promise<T[] | "absent" | "failed"> => {
		try {
			return await ask();
		} catch (error) {
			const code = (error as { code?: unknown } | null)?.code;

			if (code === "ENOTFOUND") {
				return "absent";
			}

			return code === "ENODATA" ? [] : "failed";
		}
	};

	const [ns, mx, txt, cname] = await Promise.all([
		read(() => dns.resolveNs(domain)),
		read(() => dns.resolveMx(domain)),
		read(() => dns.resolveTxt(domain)),
		read(() => dns.resolveCname(`www.${domain}`)),
	]);

	if (ns === "failed" || mx === "failed" || txt === "failed") {
		return "failed";
	}

	// Only the name itself counts: a domain with no "www" is still a domain, and when the name does
	// not exist there is nothing to learn from asking about "www" under it.
	if (ns === "absent" && mx === "absent" && txt === "absent") {
		return "missing";
	}

	if (cname === "failed") {
		return "failed";
	}

	const list = <T>(answer: T[] | "absent"): T[] => (answer === "absent" ? [] : answer);

	return {
		ns: list(ns),
		mx: list(mx).map((record) => record.exchange),
		txt: list(txt).map((chunks) => chunks.join("")),
		cname: list(cname),
	};
}

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
export function dependencies(found: Records): Dependency[] {
	const spf = found.txt
		.filter((record) => record.toLowerCase().startsWith("v=spf1"))
		.flatMap((record) => record.split(/\s+/))
		.flatMap((part) => /^[+?~-]?include:(.+)$/i.exec(part)?.[1] ?? []);

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

		add("DNS", "NS", found.ns, provider.ns);
		add("Mail", "MX", found.mx, provider.mx);
		add("Sends mail", "SPF include", spf, provider.spf);
		add("Website", "www CNAME", found.cname, provider.cname);

		const proof = (provider.txt ?? []).find((label) =>
			found.txt.some((record) => record.startsWith(label)),
		);

		if (proof !== undefined) {
			signs.push({
				role: "Account",
				evidence: `TXT ${(proof.split("=")[0] ?? proof).replace(/_$/, "")}`,
			});
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
