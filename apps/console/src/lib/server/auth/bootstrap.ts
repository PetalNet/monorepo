import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { auth } from "./index";

const identifier = "console:first-admin";
const expiresAt = new Date("9999-12-31T23:59:59.999Z");

const prominent = (code: string) => {
	const border = "=".repeat(72);
	console.warn(`\n${border}\nFIRST-RUN ADMIN CLAIM CODE\n${code}\nRedeem this after SSO sign-in at /login\n${border}\n`);
};

export const initializeAdminBootstrap = async (authentication: typeof auth) => {
	const context = await authentication.$context;
	try {
		await context.adapter.transaction(async (adapter) => {
			const admins = await adapter.count({ model: "user", where: [{ field: "tier", value: "owner" }] });
			if (admins > 0) return;
			const pending = await adapter.findOne({ model: "verification", where: [{ field: "id", value: identifier }] });
			if (pending) return;
			const code = randomBytes(24).toString("base64url");
			const digest = createHash("sha256").update(code).digest("base64url");
			await adapter.create({ model: "verification", data: { id: identifier, identifier, value: digest, expiresAt, createdAt: new Date(), updatedAt: new Date() } });
			prominent(code);
		});
	} catch (error) {
		if (!await context.adapter.findOne({ model: "verification", where: [{ field: "id", value: identifier }] })) throw error;
	}
};

export const redeemAdminBootstrap = async (authentication: typeof auth, userId: string, submittedCode: string) => {
	const context = await authentication.$context;
	return context.adapter.transaction(async (adapter) => {
		if (await adapter.count({ model: "user", where: [{ field: "tier", value: "owner" }] })) return false;
		const pending = await adapter.findOne<{ id: string; value: string }>({ model: "verification", where: [{ field: "identifier", value: identifier }] });
		if (!pending) return false;
		const expected = Buffer.from(pending.value);
		const received = Buffer.from(createHash("sha256").update(submittedCode).digest("base64url"));
		if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
		const consumed = await adapter.update({ model: "verification", where: [{ field: "id", value: pending.id }, { field: "value", value: pending.value }], update: { value: randomBytes(24).toString("base64url"), updatedAt: new Date() } });
		if (!consumed) return false;
		const user = await adapter.update({ model: "user", where: [{ field: "id", value: userId }], update: { tier: "owner", updatedAt: new Date() } });
		if (!user) return false;
		await adapter.delete({ model: "verification", where: [{ field: "id", value: pending.id }] });
		return true;
	});
};
