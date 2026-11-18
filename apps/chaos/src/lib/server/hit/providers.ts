/** How a domain leans on a provider, as far as public DNS shows. */
export type Role = "DNS" | "Mail" | "Sends mail" | "Website" | "Account";

export interface Provider {
	id: string;
	name: string;
	/** The row of the status board that covers this provider, when there is one. */
	board?: string;
	/** The provider's name in CISA's `vendorProject` field, for the exploited list. */
	vendors?: readonly string[];
	/** Name-server hosts: a suffix, or a pattern where the provider numbers its hosts. */
	ns?: readonly (string | RegExp)[];
	/** Mail-exchanger host suffixes. A suffix matches whole labels at the end of a host, nothing else. */
	mx?: readonly string[];
	/** `include:` targets in the SPF record. */
	spf?: readonly string[];
	/** What `www` points at. */
	cname?: readonly string[];
	/** The start of a TXT record that proves an account with the provider claimed the domain. */
	txt?: readonly string[];
}

/**
 * Fixed rules, read by code. A provider is listed only where a public DNS record names it; nothing
 * is inferred from page content, and the domain itself is never fetched.
 */
export const PROVIDERS: readonly Provider[] = [
	{
		id: "cloudflare",
		name: "Cloudflare",
		board: "cloudflare",
		vendors: ["Cloudflare"],
		ns: [".ns.cloudflare.com"],
		mx: [".mx.cloudflare.net"],
		spf: ["_spf.mx.cloudflare.net"],
		cname: [".cdn.cloudflare.net", ".pages.dev"],
	},
	{
		id: "aws",
		name: "AWS",
		board: "aws",
		vendors: ["Amazon"],
		ns: [/\.awsdns-\d+\.(?:com|net|org|co\.uk)$/],
		spf: ["amazonses.com"],
		cname: [".cloudfront.net", ".amazonaws.com", ".elasticbeanstalk.com"],
	},
	{
		id: "google",
		name: "Google",
		board: "gcp",
		vendors: ["Google"],
		ns: [".googledomains.com"],
		mx: [".google.com", ".googlemail.com"],
		spf: ["_spf.google.com", "_netblocks.google.com"],
		cname: ["ghs.googlehosted.com", ".googleusercontent.com"],
		txt: ["google-site-verification="],
	},
	{
		id: "microsoft",
		name: "Microsoft",
		board: "azure",
		vendors: ["Microsoft"],
		ns: [/\.azure-dns\.(?:com|net|org|info)$/],
		mx: [".mail.protection.outlook.com"],
		spf: ["spf.protection.outlook.com"],
		cname: [".azurewebsites.net", ".azureedge.net", ".trafficmanager.net", ".azurefd.net"],
		txt: ["MS="],
	},
	{
		id: "github",
		name: "GitHub",
		board: "github",
		vendors: ["GitHub"],
		cname: [".github.io"],
	},
	{
		id: "vercel",
		name: "Vercel",
		board: "vercel",
		vendors: ["Vercel"],
		ns: [".vercel-dns.com"],
		cname: [".vercel-dns.com", ".vercel.app"],
	},
	{
		id: "digitalocean",
		name: "DigitalOcean",
		board: "digitalocean",
		ns: [".digitalocean.com"],
	},
	{
		id: "atlassian",
		name: "Atlassian",
		board: "atlassian",
		vendors: ["Atlassian"],
		txt: ["atlassian-domain-verification=", "atlassian-sending-domain-verification="],
	},
	{ id: "slack", name: "Slack", board: "slack", txt: ["slack-domain-verification="] },
	{
		id: "zoom",
		name: "Zoom",
		board: "zoom",
		vendors: ["Zoom"],
		txt: ["ZOOM_verify_", "zoom-domain-verification="],
	},
	{ id: "openai", name: "OpenAI", board: "openai", txt: ["openai-domain-verification="] },
	{
		id: "anthropic",
		name: "Anthropic",
		board: "anthropic",
		txt: ["anthropic-domain-verification"],
	},
	{
		id: "twilio",
		name: "Twilio SendGrid",
		board: "twilio",
		vendors: ["Twilio"],
		spf: ["sendgrid.net"],
	},
	{ id: "apple", name: "Apple", vendors: ["Apple"], txt: ["apple-domain-verification="] },
	{ id: "cisco", name: "Cisco", vendors: ["Cisco"], txt: ["cisco-ci-domain-verification="] },
	{ id: "citrix", name: "Citrix", vendors: ["Citrix"], txt: ["citrix-verification-code="] },
	{ id: "adobe", name: "Adobe", vendors: ["Adobe"], txt: ["adobe-idp-site-verification="] },
	{ id: "salesforce", name: "Salesforce", vendors: ["Salesforce"], spf: ["_spf.salesforce.com"] },
	{ id: "zendesk", name: "Zendesk", spf: ["mail.zendesk.com"] },
	{ id: "proofpoint", name: "Proofpoint", vendors: ["Proofpoint"], mx: [".pphosted.com"] },
	{ id: "mimecast", name: "Mimecast", vendors: ["Mimecast"], mx: [".mimecast.com"] },
	{
		id: "barracuda",
		name: "Barracuda",
		vendors: ["Barracuda Networks"],
		mx: [".barracudanetworks.com"],
	},
	{ id: "akamai", name: "Akamai", vendors: ["Akamai"], cname: [".edgekey.net", ".akamaiedge.net"] },
	{ id: "fastly", name: "Fastly", cname: [".fastly.net"] },
	{ id: "jamf", name: "Jamf", vendors: ["Jamf"], txt: ["jamf-site-verification="] },
	{ id: "stripe", name: "Stripe", txt: ["stripe-verification="] },
];
