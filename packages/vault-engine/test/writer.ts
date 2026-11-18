import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { Vault } from "../src/engine.ts";
import { TierFiles } from "../src/store.ts";

// Run as a child process by the lock test: adds `count` guesses to one topic, one write each.
const [root = "", agent = "", count = "0"] = process.argv.slice(2);

NodeRuntime.runMain(
	Effect.gen(function* () {
		const vault = yield* Vault.make({ root, agent, host: "test-host" }).pipe(
			Effect.provide(TierFiles.layer(root, "test-host")),
		);

		for (let n = 0; n < Number(count); n++) {
			yield* vault.transact("shared", "concurrent", (tx) =>
				tx.addClaim({
					text: `${agent} wrote claim ${String(n)}.`,
					topic: "t-note-granularity",
					heading: "Concurrent",
					links: [],
					sourceType: "GUESS",
				}),
			);
		}
	}).pipe(Effect.provide(NodeServices.layer)),
);
