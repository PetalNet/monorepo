import { describe, expect, it, vi } from "vitest";

import { sendRsvpEmail } from "./email";
import { SEND_LIMIT } from "./rateLimit";
import { sendEditLink } from "./rsvpAccess";

vi.mock("./email", () => ({ sendRsvpEmail: vi.fn(async () => undefined) }));
vi.mock("./prisma", () => ({ prisma: { rsvpLink: { create: vi.fn(async () => undefined) } } }));

const event = { title: "Garden party", publicCode: "pc1" };

describe("sendEditLink", () => {
	it("stops sending app-wide after the hourly cap, even to fresh addresses from fresh IPs", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });

		try {
			for (let i = 0; i < SEND_LIMIT.limit + 5; i++) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- The limiter counts sends in order.
				await sendEditLink("requested", `rsvp${i}`, `guest${i}@example.test`, event, `ip${i}`);
			}

			expect(vi.mocked(sendRsvpEmail)).toHaveBeenCalledTimes(100);

			vi.setSystemTime(Date.now() + 60 * 60 * 1000);
			await sendEditLink("requested", "rsvp-late", "late@example.test", event, "ip-late");

			expect(vi.mocked(sendRsvpEmail)).toHaveBeenCalledTimes(101);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not spend the app-wide budget on addresses with no RSVP", async () => {
		vi.mocked(sendRsvpEmail).mockClear();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);

		try {
			for (let i = 0; i < SEND_LIMIT.limit; i++) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- The limiter counts sends in order.
				await sendEditLink("requested", null, `nobody${i}@example.test`, event, `nip${i}`);
			}

			await sendEditLink("requested", "rsvp-real", "real@example.test", event, "ip-real");

			expect(vi.mocked(sendRsvpEmail).mock.calls.map(([, to]) => to)).toEqual([
				"real@example.test",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still sends confirmations once link requests have used up the app-wide cap", async () => {
		vi.mocked(sendRsvpEmail).mockClear();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);

		try {
			for (let i = 0; i < SEND_LIMIT.limit + 1; i++) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- The limiter counts sends in order.
				await sendEditLink("requested", `flood${i}`, `flood${i}@example.test`, event, `fip${i}`);
			}

			expect(vi.mocked(sendRsvpEmail)).toHaveBeenCalledTimes(SEND_LIMIT.limit);

			await sendEditLink("confirmation", "rsvp-new", "new@example.test", event, "ip-new");

			expect(vi.mocked(sendRsvpEmail)).toHaveBeenLastCalledWith(
				"confirmation",
				"new@example.test",
				event,
				expect.any(String),
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
