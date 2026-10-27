// Usage: node diag.ts <store-root> <ref>...  Runs resolveSource per ref on a scratch store
// and logs the URL whose robots/request threw.
/* oxlint-disable eslint/no-await-in-loop -- Refs are diagnosed one at a time against an isolated Network/robots state each. */
import { Network } from "../src/network.ts";
import { resolveSource } from "../src/resolver.ts";
import { Store } from "../src/store.ts";

const [root, ...refs] = process.argv.slice(2);
const store = new Store(root ?? "");
for (const ref of refs) {
	const net = new Network(store);
	const allowed = net.allowed.bind(net);
	const seen: string[] = [];
	net.allowed = async (u: string) => {
		try {
			return await allowed(u);
		} catch (e) {
			seen.push(`${new URL(u).origin} -> ${(e as Error).message}`);
			throw e;
		}
	};
	try {
		const c = await resolveSource(ref, net);
		console.log(JSON.stringify({ ref, ok: true, id: c.canonicalId, title: c.title }));
	} catch (e) {
		const err = e as Error;
		console.log(
			JSON.stringify({
				ref,
				ok: false,
				name: err.constructor.name,
				msg: err.message,
				code: (err as { code?: string }).code,
				robots: seen,
				stack: err.stack?.split("\n").slice(0, 4).join(" | "),
			}),
		);
	}
}
