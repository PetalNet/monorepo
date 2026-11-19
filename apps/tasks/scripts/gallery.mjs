#!/usr/bin/env node
// Janet's publishing tool, run in the deployed image (tasks-run scripts/gallery.mjs ...). It writes
// the gallery database directly, like every other host script, and prints JSON.
//
//   gallery.mjs publish            page JSON on stdin: slug, title, content, plus optional
//                                  description, kind, source, owner, visibility, collection (the
//                                  project), caps, audience, links (GitHub PR/issue/commit/repo refs:
//                                  "owner/repo#12", a URL, or { url, kind, label }). `<!--janet-shim-->` in content becomes
//                                  the inlined janet helper. Republishing a slug bumps its rev.
//   gallery.mjs find <ref>                  pages that link to a PR, issue, commit or repo
//   gallery.mjs feedback <slug> [status]    list the answers on a page
//   gallery.mjs resolve <id> <resolution>   close an answer, at the page's current rev
import { readFileSync } from "node:fs";

import { JANET_SHIM } from "../src/lib/janet-shim.js";
import {
	findArtifactsByLink,
	getFeedback,
	listFeedback,
	resolveFeedback,
	upsertArtifact,
} from "../src/lib/server/db.js";

const [command, ...args] = process.argv.slice(2);
const print = (value) => console.log(JSON.stringify(value, null, 2));

if (command === "publish") {
	const page = JSON.parse(readFileSync(0, "utf8"));
	const content = String(page.content).replace(
		"<!--janet-shim-->",
		() => `<script>${JANET_SHIM}</script>`,
	);
	const { slug, rev, collection, caps, audience, links } = upsertArtifact({ ...page, content });

	print({
		slug,
		rev,
		collection,
		caps: JSON.parse(caps),
		audience: JSON.parse(audience),
		links: JSON.parse(links),
	});
} else if (command === "find" && args[0]) {
	print(
		findArtifactsByLink(args[0], null).map(({ links, ...page }) => ({
			...page,
			links: JSON.parse(links),
		})),
	);
} else if (command === "feedback" && args[0]) {
	print(listFeedback(args[0], { status: args[1] }));
} else if (command === "resolve" && args[0] && args[1]) {
	const resolved =
		getFeedback(Number(args[0])) && resolveFeedback({ id: Number(args[0]), resolution: args[1] });

	print(resolved ?? { error: "no such feedback" });
} else {
	console.error(
		"usage: gallery.mjs publish < page.json | find <ref> | feedback <slug> [status] | resolve <id> <resolution>",
	);

	process.exit(2);
}
