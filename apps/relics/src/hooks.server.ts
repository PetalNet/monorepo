import { readFile } from "node:fs/promises";
import pathModule from "node:path";

import { building } from "$app/env";
import { Effect } from "effect";

import { relicsApi } from "./lib/server/api";
import { Unauthorized } from "./lib/server/database";
import {
	beginOidcLogin,
	decodeTransaction,
	exchangeOidcCode,
	sameOidcValue,
} from "./lib/server/oidc";
import { RelicsStore, attempt } from "./lib/server/services";

export const init = async () => {
	await relicsApi.initialize();
	process.once("sveltekit:shutdown", () => void relicsApi.dispose());
};

export const handle = relicsApi.handle(({ event, resolve: render }) =>
	Effect.gen(function* () {
		if (building) {
			return yield* Effect.promise(() => Promise.resolve(render(event)));
		}

		const store = yield* RelicsStore;
		const path = event.url.pathname;

		if (event.request.method === "GET") {
			const aliases: Record<string, string> = {
				"/relics": "/collection",
				"/account": "/collection",
				"/login": "/legacy",
				"/register": "/",
				"/nfc-writer": "/admin/nfc-writer",
			};
			const destination = aliases[path];

			if (destination) {
				return new Response(null, { status: 302, headers: { Location: destination } });
			}
		}

		if (
			event.request.method !== "GET" &&
			event.request.method !== "HEAD" &&
			event.request.headers.get("origin") !== event.url.origin
		) {
			return new Response("Open this action from Petal Relics.", { status: 403 });
		}

		const response = yield* attempt(async () => {
			if (path === "/health") {
				const healthy = Boolean(store.sql.prepare("SELECT 1").get());

				return new Response(healthy ? "ok" : "unavailable", { status: healthy ? 200 : 503 });
			}

			if (path === "/login/oidc") {
				store.limit(`oidc:${event.getClientAddress()}`, 30);
				const login = await beginOidcLogin();

				const cookie = event.cookies.serialize("relics_oidc", login.transaction, {
					path: "/login/oidc",
					httpOnly: true,
					secure: event.url.protocol === "https:",
					sameSite: "lax",
					maxAge: 600,
				});

				return new Response(null, {
					status: 302,
					headers: { Location: login.url, "Set-Cookie": cookie },
				});
			}

			if (path === "/login/oidc/callback") {
				const transaction = decodeTransaction(event.cookies.get("relics_oidc"));

				event.cookies.delete("relics_oidc", { path: "/login/oidc" });
				const code = event.url.searchParams.get("code");

				if (
					!transaction ||
					!code ||
					!sameOidcValue(event.url.searchParams.get("state") ?? "", transaction.state)
				) {
					throw new Unauthorized({ message: "This admin sign-in expired. Try signing in again." });
				}

				const claims = await exchangeOidcCode(code, transaction);

				if (!claims) {
					throw new Unauthorized({
						message: "This Authentik account is not in the Relics admin group.",
					});
				}

				const cookie = event.cookies.serialize("relics_admin", store.createAdmin(claims.subject), {
					path: "/",
					httpOnly: true,
					secure: event.url.protocol === "https:",
					sameSite: "lax",
					maxAge: 28800,
				});

				const headers = new Headers({ Location: "/admin" });

				headers.append("Set-Cookie", cookie);

				headers.append(
					"Set-Cookie",
					event.cookies.serialize("relics_oidc", "", {
						path: "/login/oidc",
						maxAge: 0,
						httpOnly: true,
						secure: event.url.protocol === "https:",
						sameSite: "lax",
					}),
				);

				return new Response(null, { status: 303, headers });
			}

			if (path === "/logout" && event.request.method === "POST") {
				const token = event.cookies.get("relics_admin");

				if (token) {
					const { digest } = await import("./lib/server/database");

					store.sql.prepare("DELETE FROM AdminSession WHERE tokenHash=?").run(digest(token));
				}

				event.cookies.delete("relics_admin", { path: "/" });

				return new Response(null, {
					status: 303,
					headers: {
						Location: "/",
						"Set-Cookie": event.cookies.serialize("relics_admin", "", {
							path: "/",
							maxAge: 0,
							httpOnly: true,
							secure: event.url.protocol === "https:",
							sameSite: "lax",
						}),
					},
				});
			}

			if (path.startsWith("/uploads/")) {
				const relative = decodeURIComponent(path.slice(9));

				if (
					!/^[a-zA-Z0-9_./-]+$/.test(relative) ||
					relative.split("/").some((part) => part === ".." || part === "")
				) {
					return new Response("Not found", { status: 404 });
				}

				const root = pathModule.resolve(process.env.RELICS_UPLOADS ?? "data/uploads");
				const file = pathModule.resolve(root, relative);

				if (!file.startsWith(`${root}/`)) {
					return new Response("Not found", { status: 404 });
				}

				const mime: Record<string, string> = {
					".png": "image/png",
					".jpg": "image/jpeg",
					".jpeg": "image/jpeg",
					".webp": "image/webp",
					".gif": "image/gif",
				};
				const type = mime[pathModule.extname(file).toLowerCase()];

				if (!type) {
					return new Response("Not found", { status: 404 });
				}

				try {
					return new Response(await readFile(file), {
						headers: {
							"Content-Type": type,
							"Cache-Control": "public, max-age=86400",
							"X-Content-Type-Options": "nosniff",
						},
					});
				} catch {
					return new Response("Not found", { status: 404 });
				}
			}

			return await render(event);
		});

		response.headers.set("X-Content-Type-Options", "nosniff");
		response.headers.set("Referrer-Policy", "no-referrer");
		response.headers.set("X-Frame-Options", "DENY");

		if (!path.startsWith("/uploads/")) {
			response.headers.set("Cache-Control", "private, no-store");
		}

		return response;
	}),
);
