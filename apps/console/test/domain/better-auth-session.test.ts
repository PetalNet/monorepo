import { describe, expect, it } from "vitest";

import { devPrincipal } from "../../src/lib/server/domain/auth/principal.ts";
import { parseBetterAuthIdentity } from "../../src/lib/server/domain/auth/session-identity.ts";

describe("Better Auth session identity", () => {
	it("accepts only the normalized Authentik identity persisted by the OIDC mapper", () => {
		expect(
			parseBetterAuthIdentity({
				authentikUsername: "parker",
				authentikGroups: JSON.stringify(["owner", "term_admin"]),
				authentikSubject: "ak-user-123",
			}),
		).toEqual({ username: "parker", groups: ["owner", "term_admin"], subject: "ak-user-123" });
	});

	it.each([
		["missing username", { authentikGroups: '["owner"]', authentikSubject: "sub" }],
		[
			"unsafe username",
			{ authentikUsername: "../../owner", authentikGroups: '["owner"]', authentikSubject: "sub" },
		],
		["missing subject", { authentikUsername: "parker", authentikGroups: '["owner"]' }],
		[
			"empty groups",
			{ authentikUsername: "parker", authentikGroups: "[]", authentikSubject: "sub" },
		],
		[
			"duplicate groups",
			{
				authentikUsername: "parker",
				authentikGroups: '["owner","owner"]',
				authentikSubject: "sub",
			},
		],
		[
			"malformed groups",
			{ authentikUsername: "parker", authentikGroups: "owner", authentikSubject: "sub" },
		],
	])("fails closed for %s", (_label, user) => {
		expect(parseBetterAuthIdentity(user)).toBeNull();
	});

	it("does not turn a Better Auth-shaped value into the independent dev principal", () => {
		expect(
			devPrincipal(JSON.stringify({ authentikUsername: "parker", authentikGroups: '["owner"]' })),
		).toBeNull();
	});

	it("accepts Authentik group names that contain spaces", () => {
		expect(
			parseBetterAuthIdentity({
				authentikUsername: "janet",
				authentikGroups: JSON.stringify(["authentik Admins", "media"]),
				authentikSubject: "ak-user-janet",
			}),
		).toEqual({
			username: "janet",
			groups: ["authentik Admins", "media"],
			subject: "ak-user-janet",
		});
	});
});
