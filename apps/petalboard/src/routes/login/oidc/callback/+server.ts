import { createSession } from "$lib/server/auth";
import {
	decodeTransaction,
	exchangeOidcCode,
	findOrCreateOidcUser,
	getOidcConfig,
	sameOidcValue,
} from "$lib/server/oidc";
import { prisma } from "$lib/server/prisma";
import { error, redirect } from "@sveltejs/kit";

export const GET = async ({ url, cookies }) => {
	const transaction = decodeTransaction(cookies.get("oidc_tx"));

	cookies.delete("oidc_tx", { path: "/login/oidc" });

	if (
		url.searchParams.has("error") ||
		!transaction ||
		!sameOidcValue(url.searchParams.get("state") || "", transaction.state)
	) {
		throw error(400, "Invalid OIDC login response.");
	}

	const code = url.searchParams.get("code");

	if (!code) {
		throw error(400, "Invalid OIDC login response.");
	}

	if (!getOidcConfig()) {
		throw error(503, "Host login is unavailable: OIDC is not configured.");
	}

	try {
		const claims = await exchangeOidcCode(code, transaction);
		const email = claims?.email;

		if (!claims || !email) {
			throw error(403, "Not authorised for PetalBoard hosting.");
		}

		const user = await findOrCreateOidcUser(prisma, {
			sub: claims.sub,
			email,
			name: claims.name,
			preferred_username: claims.preferred_username,
		});

		if (!user) {
			throw error(403, "Not authorised for PetalBoard hosting.");
		}

		await createSession(user.id, cookies);

		throw redirect(303, "/dashboard");
	} catch (cause) {
		if (cause && typeof cause === "object" && "status" in cause) {
			throw cause;
		}

		throw error(503, "Host login is unavailable. Please try again later.");
	}
};
