/**
 * In-process secret scan. CRDT history cannot be scrubbed, so every write is scanned before it is
 * committed and a hit rejects the whole write. The rules follow the gitleaks default rule set
 * (provider token shapes, private keys, and its entropy-gated generic assignment rule).
 */

interface Rule {
	id: string;
	pattern: RegExp;
	/** Capture group holding the secret, checked against `entropy` when set. */
	group?: number;
	entropy?: number;
}

const rules: Rule[] = [
	{ id: "private-key", pattern: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g },
	{ id: "aws-access-token", pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g },
	{ id: "github-pat", pattern: /\bghp_[0-9a-zA-Z]{36}\b/g },
	{ id: "github-fine-grained-pat", pattern: /\bgithub_pat_\w{82}\b/g },
	{ id: "github-oauth", pattern: /\bgh[ousr]_[0-9a-zA-Z]{36}\b/g },
	{ id: "gitlab-pat", pattern: /\bglpat-[\w-]{20,}\b/g },
	{ id: "slack-token", pattern: /\bxox[abeoprs]-[0-9a-zA-Z-]{10,}\b/g },
	{
		id: "slack-webhook",
		pattern: /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/g,
	},
	{ id: "discord-webhook", pattern: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{30,}/g },
	{ id: "stripe-token", pattern: /\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\b/g },
	{ id: "anthropic-api-key", pattern: /\bsk-ant-(?:api|admin)\d{2}-[\w-]{80,}\b/g },
	{ id: "openai-api-key", pattern: /\bsk-(?:proj|svcacct|admin)-[\w-]{40,}\b/g },
	{ id: "google-api-key", pattern: /\bAIza[\w-]{35}\b/g },
	{ id: "npm-token", pattern: /\bnpm_[a-zA-Z0-9]{36}\b/g },
	{ id: "pypi-token", pattern: /\bpypi-AgEIcHlwaS5vcmc[\w-]{50,}\b/g },
	{ id: "sendgrid-token", pattern: /\bSG\.[\w=-]{22}\.[\w=-]{43}\b/g },
	{ id: "twilio-key", pattern: /\bSK[0-9a-fA-F]{32}\b/g },
	{ id: "telegram-bot-token", pattern: /\b\d{8,10}:AA[\w-]{33}\b/g },
	{
		id: "matrix-access-token",
		pattern: /\b(?:syt|mat|mct)_[\w=-]{10,}_[\w=-]{10,}(?:_[\w=-]{4,})?\b/g,
	},
	{ id: "tailscale-key", pattern: /\btskey-[a-z]+-[\w-]{20,}\b/g },
	{ id: "age-secret-key", pattern: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b/g },
	{
		id: "jwt",
		pattern: /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/_-]{17,}\.(?:[a-zA-Z0-9/_-]{10,}={0,2})?/g,
	},
	{
		id: "url-credentials",
		pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]{1,64}:([^\s:/@]{6,})@[\w.-]+/gi,
		group: 1,
		entropy: 2.5,
	},
	{
		id: "bearer-token",
		pattern: /\bBearer\s+([\w=+/.-]{24,})/gi,
		group: 1,
		entropy: 3.5,
	},
	{ id: "matrix-synapse-token", pattern: /\bsyt_[\w=-]+_[A-Za-z0-9]{20}_[A-Za-z0-9]{6}\b/g },
	{ id: "otp-seed", pattern: /\botpauth:\/\/\S+/gi },
	{ id: "huggingface-token", pattern: /\bhf_[a-zA-Z0-9]{30,}\b/g },
	{
		id: "authorization-header",
		pattern: /\bAuthorization["']?\s*[:=]\s*["']?(?:Token|Basic|Bearer)\s+([\w=+/.-]{16,})/gi,
		group: 1,
		entropy: 3,
	},
	{
		// The value may hold punctuation and needs no terminator: lab passwords look like `Xk9pQ2vL7mWz!`.
		id: "generic-api-key",
		pattern:
			/(?:access|auth|api|credential|creds|key|passw(?:or)?d|passphrase|pwd|secret|token)[\w.-]{0,20}["'`]?\s{0,3}(?:=|:|=>|:=)\s{0,3}["'`]?([^\s"'`,;]{10,})/gi,
		group: 1,
		entropy: 3.2,
	},
];

function shannon(value: string): number {
	const counts = new Map<string, number>();

	for (const char of value) {
		counts.set(char, (counts.get(char) ?? 0) + 1);
	}

	let bits = 0;

	for (const count of counts.values()) {
		const share = count / value.length;

		bits -= share * Math.log2(share);
	}

	return bits;
}

// The generic rule needs a digit, like gitleaks: prose such as `key: some-long-identifier` is not a secret.
const plausibleSecret = (value: string, entropy: number) =>
	/\d/.test(value) &&
	shannon(value) >= entropy &&
	// A file path or a URL after `token:` is where a secret lives, not the secret. URLs that carry
	// credentials or tokens have their own rules.
	!/^(?:[~.]{0,2}\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(value);

interface SecretFinding {
	rule: string;
	/** Offset only. The matched text is never returned, logged or stored. */
	index: number;
}

function scanSecrets(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];

	for (const rule of rules) {
		for (const match of text.matchAll(rule.pattern)) {
			const candidate = rule.group === undefined ? match[0] : match[rule.group];

			if (
				candidate !== undefined &&
				(rule.entropy === undefined || plausibleSecret(candidate, rule.entropy))
			) {
				findings.push({ rule: rule.id, index: match.index });
			}
		}
	}

	return findings;
}

/** The IDs of the rules a text matches; empty when it is clean. */
export const secretRules = (texts: Iterable<string>) => [
	...new Set([...texts].flatMap((text) => scanSecrets(text).map((finding) => finding.rule))),
];
