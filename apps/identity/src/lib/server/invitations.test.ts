import { describe, expect, it } from "vitest";

import { mintInvitations, parseRoster, type InviteRequest } from "./invitations";

const req = (username: string, displayName = "", email?: string): InviteRequest => ({
	username,
	displayName,
	email,
});

/** A writer that records what it was asked to do and can be told to fail for one username. */
function fakeWriter(failFor: string[] = []) {
	const calls: { name: string; fixedData: Record<string, unknown>; singleUse: boolean }[] = [];
	let counter = 0;
	return {
		calls,
		writer: {
			createInvitation: (options: {
				name: string;
				expires: string;
				flow: string;
				fixedData: Record<string, unknown>;
				singleUse: boolean;
			}) => {
				if (failFor.some((u) => options.name.includes(u))) {
					return Promise.reject(new Error("authentik said no"));
				}
				calls.push({
					name: options.name,
					fixedData: options.fixedData,
					singleUse: options.singleUse,
				});
				counter += 1;
				return Promise.resolve(`token-${String(counter)}`);
			},
		} as never,
	};
}

const options = (over: Partial<Parameters<typeof mintInvitations>[1]> = {}) => ({
	writer: fakeWriter().writer,
	flowPk: "flow-pk",
	flowSlug: "petalnet-migration",
	publicBaseUrl: "https://auth.petalcat.dev",
	expiresAt: new Date("2026-08-20T00:00:00.000Z"),
	stamp: "0813",
	existingUsernames: new Set<string>(),
	singleUse: false,
	...over,
});

describe("mintInvitations", () => {
	it("mints one per person and returns their claim links", async () => {
		const { writer, calls } = fakeWriter();
		const out = await mintInvitations(
			[req("cheyenne", "Cheyenne S"), req("josie", "Josie D")],
			options({ writer }),
		);
		expect(out.created.map((c) => c.username)).toEqual(["cheyenne", "josie"]);
		expect(out.failed).toEqual([]);
		expect(out.created[0].claimUrl).toBe(
			"https://auth.petalcat.dev/if/flow/petalnet-migration/?itoken=token-1",
		);
		expect(calls[0].fixedData).toEqual({ username: "cheyenne", name: "Cheyenne S" });
	});

	it("names the invitation with a slug Authentik accepts", async () => {
		const { writer, calls } = fakeWriter();
		await mintInvitations([req("Mary.Jane_Smith", "MJ")], options({ writer }));
		expect(calls[0].name).toBe("claim-mary-jane-smith-0813");
	});

	it("builds the claim link an invitee is actually sent", async () => {
		const out = await mintInvitations([req("tim")], options());
		expect(out.created[0].claimUrl).toBe(
			"https://auth.petalcat.dev/if/flow/petalnet-migration/?itoken=token-1",
		);
	});

	it("rejects a username that would be silently rewritten", async () => {
		// A username quietly becoming something else produces an account nobody can find and a
		// claim link that works for the wrong identity.
		const out = await mintInvitations([req("chey enne")], options());
		expect(out.created).toEqual([]);
		expect(out.failed[0].reason).toContain("not a usable username");
	});

	it("rejects an email that is not one", async () => {
		const out = await mintInvitations([req("nick", "Nick", "nick-at-example")], options());
		expect(out.failed[0].reason).toContain("not an email");
	});

	it("pins the username so the invitee cannot choose a different one", async () => {
		const { writer, calls } = fakeWriter();
		await mintInvitations([req("nick", "Nick S")], options({ writer }));
		expect(calls[0].fixedData.username).toBe("nick");
	});

	it("falls back to the username when no display name is given", async () => {
		const { writer, calls } = fakeWriter();
		await mintInvitations([req("moussa")], options({ writer }));
		expect(calls[0].fixedData.name).toBe("moussa");
	});

	it("refuses to invite someone who already has an account", async () => {
		const out = await mintInvitations(
			[req("parker"), req("aiden")],
			options({ existingUsernames: new Set(["parker"]) }),
		);
		expect(out.created.map((c) => c.username)).toEqual(["aiden"]);
		expect(out.failed).toEqual([
			{ username: "parker", reason: "an account with this username already exists" },
		]);
	});

	it("rejects both copies of a duplicate rather than silently inviting one", async () => {
		// Minting for the first and dropping the second would hand out a link the operator did
		// not realise was singular, which is worse than refusing the pair and saying so.
		const out = await mintInvitations([req("josie"), req("josie")], options());
		expect(out.created).toEqual([]);
		expect(out.failed).toHaveLength(2);
		expect(out.failed[0].reason).toContain("more than once");
	});

	it("keeps going when one person fails, and reports both halves", async () => {
		const { writer } = fakeWriter(["broken"]);
		const out = await mintInvitations(
			[req("aiden"), req("broken"), req("olivia")],
			options({ writer }),
		);
		expect(out.created.map((c) => c.username)).toEqual(["aiden", "olivia"]);
		expect(out.failed.map((f) => f.username)).toEqual(["broken"]);
	});

	it("does not create anything for an invalid row", async () => {
		const { writer, calls } = fakeWriter();
		const out = await mintInvitations([req("bad name")], options({ writer }));
		expect(calls).toEqual([]);
		expect(out.created).toEqual([]);
		expect(out.failed[0].reason).toContain("not a usable username");
	});

	it("passes the single-use choice through to Authentik rather than deciding for the caller", async () => {
		// single_use is consumed when the link is OPENED, not when signup completes, so a
		// prefetching messaging app burns it before the invitee taps anything. The caller has to
		// own that decision; a hardcoded true here quietly breaks texting links to people.
		const single = fakeWriter();
		await mintInvitations([req("tim")], options({ writer: single.writer, singleUse: true }));
		expect(single.calls[0].singleUse).toBe(true);

		const reusable = fakeWriter();
		await mintInvitations([req("tim")], options({ writer: reusable.writer, singleUse: false }));
		expect(reusable.calls[0].singleUse).toBe(false);
	});

	it("reports the single-use choice back so the UI can warn about it", async () => {
		const out = await mintInvitations([req("tim")], options({ singleUse: true }));
		expect(out.created[0].singleUse).toBe(true);
	});

	it("carries the expiry onto every invitation", async () => {
		const out = await mintInvitations([req("tim")], options());
		expect(out.created[0].expires).toBe("2026-08-20T00:00:00.000Z");
	});
});

describe("parseRoster", () => {
	it("reads a bare username", () => {
		expect(parseRoster("cheyenne").requests).toEqual([{ username: "cheyenne", displayName: "" }]);
	});

	it("reads username and display name", () => {
		expect(parseRoster("josie, Josie D").requests).toEqual([
			{ username: "josie", displayName: "Josie D" },
		]);
	});

	it("reads username, name and email", () => {
		expect(parseRoster("nick, Nick S, nick@example.com").requests).toEqual([
			{ username: "nick", displayName: "Nick S", email: "nick@example.com" },
		]);
	});

	it("skips blank lines and comments so a list can be annotated", () => {
		const out = parseRoster("# the twelve\n\ncheyenne\n\n# done\njosie");
		expect(out.requests.map((r) => r.username)).toEqual(["cheyenne", "josie"]);
		expect(out.malformed).toEqual([]);
	});

	it("reports a line it cannot read instead of dropping it", () => {
		// A silently skipped line means somebody never gets invited and nobody finds out until
		// they ask why.
		const out = parseRoster("cheyenne\n, no username here\njosie");
		expect(out.requests.map((r) => r.username)).toEqual(["cheyenne", "josie"]);
		expect(out.malformed).toEqual([", no username here"]);
	});

	it("returns nothing for empty input", () => {
		expect(parseRoster("   \n\n")).toEqual({ requests: [], malformed: [] });
	});
});
