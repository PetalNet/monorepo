import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);

// The exact image compose deploys, so the test exercises the shipped ducktors build.
export const cacheImage =
	"ducktors/turborepo-remote-cache:3.0.3@sha256:2ad6692bf9c5eed7a3c12f606820abd0af3b2b0f081c7d3bf40f2a015fe27a2f";

export async function dockerAvailable() {
	if (process.platform !== "linux") {
		return false;
	}

	try {
		await run("docker", ["version", "--format", "{{.Server.Version}}"]);

		return true;
	} catch {
		return false;
	}
}

export async function pullCache() {
	await run("docker", ["pull", "--quiet", cacheImage]);
}

async function freePort() {
	const server = createServer();

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();

	await new Promise<void>((resolve) => {
		server.close(() => {
			resolve();
		});
	});

	if (!address || typeof address === "string") {
		throw new Error("Missing free port");
	}

	return address.port;
}

// Host networking lets the container reach the test's loopback JWKS server.
export async function startCache(jwksUrl: string) {
	const port = await freePort();
	const env = {
		PORT: String(port),
		AUTH_MODE: "jwt",
		JWKS_URL: jwksUrl,
		JWT_ISSUER: "https://turbo-cache.petalcat.dev",
		JWT_AUDIENCE: "turbo-cache.petalcat.dev",
		JWT_SCOPE_CLAIM: "scope",
		JWT_READ_SCOPES: "read",
		JWT_WRITE_SCOPES: "write",
		JWT_TEAM_CLAIM: "teams",
		STORAGE_PROVIDER: "local",
		STORAGE_PATH: "/data",
		STORAGE_PATH_USE_TMP_FOLDER: "false",
	};
	const { stdout } = await run("docker", [
		"run",
		"--detach",
		"--rm",
		"--network",
		"host",
		"--tmpfs",
		"/data:uid=1001,gid=1001",
		...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
		cacheImage,
	]);
	const id = stdout.trim();
	const close = async () => {
		await run("docker", ["rm", "--force", id]).catch(() => undefined);
	};

	const url = `http://127.0.0.1:${String(port)}`;

	try {
		const deadline = Date.now() + 15_000;

		for (;;) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- readiness polling is sequential by design.
				await fetch(`${url}/v8/artifacts/status`);

				break;
			} catch (error) {
				if (Date.now() > deadline) {
					throw error;
				}

				// oxlint-disable-next-line no-await-in-loop -- readiness polling is sequential by design.
				await new Promise((resolve) => {
					setTimeout(resolve, 100);
				});
			}
		}

		return { url, close };
	} catch (error) {
		await close();

		throw error;
	}
}
