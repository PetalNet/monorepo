import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";

// Stands in for the vault-cite CLI: `add <ref>` saves anything under example.org and logs the call.
const [log = "", verb = "", ref = ""] = process.argv.slice(2);

NodeRuntime.runMain(
	Effect.gen(function* () {
		yield* (yield* FileSystem.FileSystem).writeFileString(log, `${verb} ${ref}\n`, { flag: "a" });
		yield* Console.log("capturing");

		yield* Console.log(
			JSON.stringify(
				ref.startsWith("https://example.org/")
					? {
							source: {
								id: "src-feedfacefeedfacefeed",
								title: "A  fetched\npage",
								url: ref,
								fetched_at: "2026-11-16T08:00:00Z",
							},
						}
					: { citation: { status: "blocked", reason: "robots.txt disallows it" } },
			),
		);
	}).pipe(Effect.provide(NodeServices.layer)),
);
