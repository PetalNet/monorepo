// console-api-mint-token — the out-of-band first-token path (contract §1.2, PHASE1-DESIGN §7).
// Mints a bearer, stores only its sha256 in api_tokens, prints the plaintext ONCE. In prod the
// plaintext also lands in the vault (CP4 re-issue); that write is a deploy step, not this CLI.
//
// Usage: console-api-mint-token <subject> <kind> [--tiers a,b] [--lanes a,b] [--owner user]

import { randomBytes } from "node:crypto";

import { sha256 } from "../src/lib/server/domain/auth/principal.ts";
import { openDb } from "../src/lib/server/domain/db/pool.ts";
import { loadEnv } from "../src/lib/server/domain/env.ts";

function argValue(flag: string): string | null {
	const i = process.argv.indexOf(flag);
	return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
	const subject = process.argv[2];
	const kind = process.argv[3];
	if (!subject || !kind || !["human", "agent", "system"].includes(kind)) {
		process.stderr.write(
			"usage: console-api-mint-token <subject> <human|agent|system> [--tiers a,b] [--lanes a,b] [--owner user]\n",
		);
		process.exit(2);
	}
	if (kind === "agent" && !/^agent:[a-z0-9._-]+$/.test(subject)) {
		process.stderr.write("agent subjects must use agent:<handle>\n");
		process.exit(2);
	}
	const tiers = (argValue("--tiers") ?? "").split(",").filter(Boolean);
	const lanes = (argValue("--lanes") ?? "").split(",").filter(Boolean);
	const owner = argValue("--owner");
	const token = `cbt_${randomBytes(24).toString("base64url")}`;
	const db = openDb(loadEnv());
	try {
		await db.admin.begin(async (tx) => {
			await tx`insert into api_tokens (token_sha256, subject, kind, tiers, lanes)
				values (${sha256(token)}, ${subject}, ${kind}, ${tx.json(tiers)}, ${tx.json(lanes)})`;
			if (kind !== "agent") return;
			for await (const grantSubject of [subject, owner].filter((value): value is string =>
				Boolean(value),
			)) {
				const existing = await tx`select 1 from grants
					where subject = ${grantSubject} and relation = 'owner' and object = ${subject}
					  and valid_at <= now() and (invalid_at is null or invalid_at > now())`;
				if (existing.length === 0)
					await tx`insert into grants (subject, relation, object, granted_by)
						values (${grantSubject}, 'owner', ${subject}, 'token-mint')`;
			}
		});
		process.stdout.write(`${token}\n`);
	} finally {
		await db.close();
	}
}

await main();
