import { randomUUID } from "node:crypto";

import { error } from "@sveltejs/kit";
import { z } from "zod";

import { consentVersion } from "#lib/consent.ts";
import { jsonBody, identity, limit, sign, verify } from "#lib/server/security.ts";
import { participant } from "#lib/server/store.ts";

import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async (event) => {
	limit(`start:${event.getClientAddress()}`, 30);
	const parsed = z
		.object({
			name: z.string().trim().min(1).max(60),
			consent: z.boolean(),
			speakerConsent: z.boolean(),
		})
		.safeParse(await jsonBody(event, 1024));
	if (!parsed.success) error(400, "Enter a first name and choose your consent options.");
	if (!parsed.data.consent && !parsed.data.speakerConsent)
		error(400, "Consent is required to record.");
	const auth = await identity(event);
	let id: string = randomUUID();
	try {
		const old = await verify(event.cookies.get("booth-participant") ?? "");
		if (
			typeof old.id === "string" &&
			old.name === parsed.data.name &&
			old.authSub === (auth?.sub ?? null)
		)
			id = old.id;
	} catch {
		/* A new participant gets a fresh ID. */
	}
	const p = participant(parsed.data.name, auth?.sub ?? null, id, {
		version: consentVersion,
		at: new Date().toISOString(),
		wakeWord: parsed.data.consent,
		speakerRecognition: parsed.data.speakerConsent,
	});
	event.cookies.set("booth-participant", await sign({ ...p }), {
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: event.url.protocol === "https:",
		maxAge: 30 * 86400,
	});
	return Response.json({ id: p.id, name: p.name });
};

export const DELETE: RequestHandler = (event) => {
	const options = { path: "/", secure: event.url.protocol === "https:" };
	event.cookies.delete("booth-participant", options);
	event.cookies.delete("booth-auth", options);
	return new Response(null, { status: 204 });
};
