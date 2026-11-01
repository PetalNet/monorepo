import { beginOidcLogin, getOidcConfig } from "$lib/server/oidc";
import { error, redirect } from "@sveltejs/kit";

export const GET = async ({ cookies }) => {
	if (!getOidcConfig()) {
		throw error(503, "Host login is unavailable: OIDC is not configured.");
	}

	try {
		const { url, transaction } = await beginOidcLogin();

		cookies.set("oidc_tx", transaction, {
			path: "/login/oidc",
			httpOnly: true,
			sameSite: "lax",
			secure: process.env.NODE_ENV === "production",
			maxAge: 10 * 60,
		});

		throw redirect(302, url);
	} catch (cause) {
		if (cause && typeof cause === "object" && "status" in cause) {
			throw cause;
		}

		throw error(503, "Host login is unavailable. Please try again later.");
	}
};
