import { spawn } from "node:child_process";
import { once } from "node:events";

import { Schema } from "effect";

export async function startCache(jwksUrl: string, storage: string) {
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
		import { createApp } from ${JSON.stringify(import.meta.resolve("turborepo-remote-cache"))};
		const app = createApp({ logger: false });
		const url = await app.listen({ port: 0, host: '127.0.0.1' });
		process.send(url);
		process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
	`,
		],
		{
			cwd: import.meta.dirname,
			stdio: ["ignore", "ignore", "inherit", "ipc"],
			env: {
				...process.env,
				AUTH_MODE: "jwt",
				JWKS_URL: jwksUrl,
				JWT_ISSUER: "https://turbo-cache.petalcat.dev",
				JWT_AUDIENCE: "turbo-cache.petalcat.dev",
				JWT_SCOPE_CLAIM: "scope",
				JWT_READ_SCOPES: "read",
				JWT_WRITE_SCOPES: "write",
				JWT_TEAM_CLAIM: "teams",
				STORAGE_PROVIDER: "local",
				STORAGE_PATH: storage,
				STORAGE_PATH_USE_TMP_FOLDER: "false",
			},
		},
	);

	try {
		const messages: unknown[] = await once(child, "message", {
			signal: AbortSignal.timeout(10_000),
		});
		const url = Schema.decodeUnknownSync(Schema.String)(messages[0]);

		return {
			url,
			close: async () => {
				const exited = once(child, "exit");

				child.kill("SIGTERM");
				await exited;
			},
		};
	} catch (error) {
		child.kill("SIGTERM");

		throw error;
	}
}
