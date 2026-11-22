import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { operation, operationError, mapOperationErrors } from "@petalnet/effect-api";
import { createServer, SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Effect, Context, Schema } from "effect";

import { Collection, RelicCard, Claim, Legacy, Receipt, Id, Email, AdminCommand } from "../schema";
import { Rejected, Conflict, Unauthorized, Missing, StorageFailure, newToken } from "./database";
import { RelicsStore, services, attempt, device, setDevice, requireAdmin } from "./services";

const errors = {
	Rejected: operationError(Rejected, { status: 400, message: (e) => e.message }),
	Conflict: operationError(Conflict, { status: 409, message: (e) => e.message }),
	Unauthorized: operationError(Unauthorized, { status: 401, message: (e) => e.message }),
	Missing: operationError(Missing, { status: 404, message: (e) => e.message }),
	StorageFailure: operationError(StorageFailure, {
		status: 503,
		message: "The collection service is unavailable. Please try again.",
	}),
};
const ok = (message: string) => ({ message });

async function sendLink(email: string, token: string) {
	if (!process.env.RESEND_API_KEY || !process.env.ORIGIN) {
		throw new Rejected({
			message: "Email restoration is unavailable. Your collection is still on this device.",
		});
	}

	const link = `${process.env.ORIGIN.replace(/\/+$/, "")}/restore?token=${token}`;
	const result = await fetch("https://api.resend.com/emails", {
		method: "POST",
		signal: AbortSignal.timeout(15000),
		headers: {
			Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: process.env.EMAIL_FROM ?? "Petal Relics <relics@petalcat.dev>",
			to: email,
			subject: "Your private Petal Relics collection",
			text: `Open your collection on this device:\n\n${link}\n\nThis link works once and expires in 15 minutes. Opening it switches this device to that collection. If you did not request it, ignore this email.`,
		}),
	});

	if (!result.ok) {
		throw new Rejected({ message: "The email could not be sent. Please try again later." });
	}
}

const operations = [
	operation({
		name: "collection",
		description: "Read the collection belonging to this device. No public collector listing.",
		method: "GET",
		path: "/collection",
		input: Schema.Struct({}),
		output: Collection,
		errors,
		handler: () =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(() => store.collection(device(event)));
			}),
	}),
	operation({
		name: "relic",
		description:
			"Read a relic's public name, first name and story. Owner identifiers remain private.",
		method: "GET",
		path: "/relics/:id",
		input: Schema.Struct({ id: Id }),
		output: RelicCard,
		errors,
		handler: ({ id }) =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(() => store.card(id, device(event)));
			}),
	}),
	operation({
		name: "claim",
		description: "Claim an available relic into a device-bound collection.",
		method: "POST",
		path: "/claim",
		input: Claim,
		output: Receipt,
		errors,
		handler: (input) =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(() => {
					store.limit(`claim:${event.getClientAddress()}`, 60);
					const result = store.claim(input, device(event));

					if (result.deviceToken) {
						setDevice(event, result.deviceToken);
					}

					return ok("And so, our little story begins.");
				});
			}),
	}),
	operation({
		name: "name",
		description: "Name or rename a relic belonging to this phone, keeping its birthday.",
		method: "POST",
		path: "/name",
		input: Claim,
		output: Receipt,
		errors,
		handler: (input) =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(() => {
					store.limit(`name:${event.getClientAddress()}`, 60);
					store.nameRelic(input, device(event));

					return ok("A lovely name for a little friend.");
				});
			}),
	}),
	operation({
		name: "release",
		description: "Release a relic belonging to the current device.",
		method: "POST",
		path: "/release",
		input: Schema.Struct({ relicId: Id }),
		output: Receipt,
		errors,
		handler: ({ relicId }) =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(() => {
					store.release(relicId, device(event));

					return ok("Released. The next person can claim it.");
				});
			}),
	}),
	operation({
		name: "migrate",
		description: "Move a legacy name and PIN collection to this device once.",
		method: "POST",
		path: "/migrate",
		input: Legacy,
		output: Receipt,
		errors,
		handler: (input) =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(async () => {
					store.limit(`migration-ip:${event.getClientAddress()}`, 30);
					store.limit(`migration-name:${input.name.toLowerCase()}`);
					const result = await store.migrate(input, device(event));

					if (result.deviceToken) {
						setDevice(event, result.deviceToken);
					}

					return ok(
						"Your existing relics are now on this device. You will not need your PIN again.",
					);
				});
			}),
	}),
	operation({
		name: "email",
		description: "Verify an optional recovery email for the current collection.",
		method: "POST",
		path: "/email",
		input: Schema.Struct({ email: Email }),
		output: Receipt,
		errors,
		handler: (input) =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(async () => {
					const owner = store.requireCollector(device(event));

					store.limit(`email:${owner.id}`);
					const email = input.email.toLowerCase();

					store.limit(`email-ip:${event.getClientAddress()}`, 20);
					store.limit(`email-address:${email}`);

					const token = store.createMagic(owner.id, email);

					await sendLink(email, token);

					return ok("Check your email. Open the link to verify your recovery address.");
				});
			}),
	}),
	operation({
		name: "restore.request",
		description:
			"Send a one-use link to a previously verified email without revealing whether it exists.",
		method: "POST",
		path: "/restore/request",
		input: Schema.Struct({ email: Email }),
		output: Receipt,
		errors,
		handler: (input) =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(async () => {
					store.limit(`restore-ip:${event.getClientAddress()}`, 20);
					const email = input.email.toLowerCase();

					store.limit(`restore-email:${email}`);

					if (!process.env.RESEND_API_KEY) {
						throw new Rejected({
							message: "Email restoration is unavailable. Please ask an admin.",
						});
					}

					const owner = store.recoveryCollector(email);

					if (owner) {
						await sendLink(email, store.createMagic(owner.id, email));
					}

					return ok(
						"If this address is verified, a collection link is on its way. It expires in 15 minutes.",
					);
				});
			}),
	}),
	operation({
		name: "restore.consume",
		description:
			"Exchange a one-use emailed token for a device session. Requires an explicit button press.",
		method: "POST",
		path: "/restore/consume",
		input: Schema.Struct({ token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)) }),
		output: Receipt,
		errors,
		handler: (input) =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(() => {
					store.limit(`restore-consume:${event.getClientAddress()}`, 60);
					setDevice(event, store.consumeMagic(input.token));

					return ok("Collection restored on this device.");
				});
			}),
	}),
	operation({
		name: "admin.command",
		description:
			"Manage types, varieties, ranges, sets, specimen metadata, NFC progress and reassignment. Admin only.",
		method: "POST",
		path: "/admin/command",
		input: AdminCommand,
		output: Receipt,
		errors,
		handler: (command) =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(() => {
					const admin = requireAdmin(store, event);

					store.administer(command, admin.subject);

					return ok("Saved.");
				});
			}),
	}),
	operation({
		name: "admin.upload",
		description: "Upload PNG, JPEG or WebP artwork, up to 8 MB. Admin only.",
		method: "POST",
		path: "/admin/upload",
		input: Schema.Struct({
			data: Schema.String.check(
				Schema.isMaxLength(11200000),
				Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
			),
		}),
		output: Schema.Struct({ url: Schema.String }),
		errors,
		handler: ({ data }) =>
			Effect.gen(function* () {
				const store = yield* RelicsStore;
				const event = yield* SvelteKitRequestEvent;

				return yield* attempt(async () => {
					requireAdmin(store, event);
					const bytes = Buffer.from(data, "base64");

					if (bytes.length > 8 * 1024 * 1024) {
						throw new Rejected({ message: "Choose an image smaller than 8 MB." });
					}

					const ext = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
						? "png"
						: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
							? "jpg"
							: bytes.toString("ascii", 0, 4) === "RIFF" &&
								  bytes.toString("ascii", 8, 12) === "WEBP"
								? "webp"
								: null;

					if (!ext) {
						throw new Rejected({ message: "Choose a PNG, JPEG or WebP image." });
					}

					const name = `${newToken()}.${ext}`;
					const dir = path.join(process.env.RELICS_UPLOADS ?? "data/uploads", "art");

					await mkdir(dir, { recursive: true });
					await writeFile(path.join(dir, name), bytes, { flag: "wx" });

					return { url: `/uploads/art/${name}` };
				});
			}),
	}),
];

export const relicsApi = createServer({
	title: "Petal Relics API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations,
	services,
	auth: { browser: Effect.succeed(Context.empty()), errors: {}, mcp: false },
	mapFailure: mapOperationErrors(errors),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => void relicsApi.dispose());
}
