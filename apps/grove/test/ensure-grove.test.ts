import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const source = resolve(import.meta.dirname, "../../../.agents/ensure-grove");
const serviceSource = resolve(import.meta.dirname, "../../../tools/start-grove-orb");
const temporaryDirectories: string[] = [];

const run = (
	command: string,
	arguments_: readonly string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv },
) =>
	new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
		const child = spawn(command, arguments_, options);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			done({ code, stdout, stderr });
		});
	});

const fixture = async (preflightStatus = "ready") => {
	const root = await mkdtemp(join(tmpdir(), "ensure-grove-"));
	temporaryDirectories.push(root);
	await mkdir(join(root, ".agents"), { recursive: true });
	await mkdir(join(root, ".amp/portals"), { recursive: true });
	await mkdir(join(root, "apps/grove"), { recursive: true });
	await mkdir(join(root, "bin"), { recursive: true });
	await mkdir(join(root, "tools"), { recursive: true });
	await writeFile(join(root, ".agents/ensure-grove"), await readFile(source));
	await writeFile(join(root, "tools/start-grove-orb"), await readFile(serviceSource));
	await chmod(join(root, ".agents/ensure-grove"), 0o755);
	await chmod(join(root, "tools/start-grove-orb"), 0o755);
	await writeFile(
		join(root, ".amp/portals/grove.json"),
		JSON.stringify({ links: [{ url: "https://grove.portal.test" }] }),
	);
	await writeFile(
		join(root, ".amp/portals/grove-oidc.json"),
		JSON.stringify({ links: [{ url: "https://oidc.portal.test" }] }),
	);
	await writeFile(
		join(root, "bin/amp"),
		`#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$AMP_CALLS"\nprintf '%s\\n' '{"status":"healthy"}'\n`,
	);
	await writeFile(
		join(root, "bin/curl"),
		`#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$CURL_CALLS"\nprintf '%s\\n' '${JSON.stringify({ status: preflightStatus, checks: [] })}'\n`,
	);
	await chmod(join(root, "bin/amp"), 0o755);
	await chmod(join(root, "bin/curl"), 0o755);
	const env = {
		...process.env,
		PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
		AMP_CALLS: join(root, "amp.calls"),
		CURL_CALLS: join(root, "curl.calls"),
	};
	return { root, env };
};

const postgresInspection = (image = "postgres:17-alpine") =>
	JSON.stringify([
		{
			Config: {
				Image: image,
				Env: ["POSTGRES_USER=grove", "POSTGRES_PASSWORD=grove", "POSTGRES_DB=grove"],
			},
			HostConfig: {
				PortBindings: {
					"5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54320" }],
				},
			},
		},
	]);

const serviceFixture = async (
	options: {
		image?: string;
		oidcReady?: boolean;
		postgresReady?: boolean;
		validOidcManifest?: boolean;
	} = {},
) => {
	const result = await fixture();
	if (options.validOidcManifest === false)
		await writeFile(join(result.root, ".amp/portals/grove-oidc.json"), "{}");
	await writeFile(
		join(result.root, "bin/docker"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "$1" in
  inspect) printf '%s\\n' "$DOCKER_INSPECTION" ;;
  start) printf '%s\\n' grove-postgres ;;
  exec)
    if [[ "$3" == pg_isready ]]; then
      [[ "$POSTGRES_READY" == 1 ]]
    elif [[ "$3" == psql ]]; then
      printf '%s\\n' grove:grove
    fi
    ;;
  run) printf '%s\\n' new-container ;;
esac
`,
	);
	await writeFile(join(result.root, "bin/curl"), '#!/usr/bin/env bash\n[[ "$OIDC_READY" == 1 ]]\n');
	await writeFile(
		join(result.root, "bin/vp"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$VP_CALLS"
exit 0
`,
	);
	await chmod(join(result.root, "bin/docker"), 0o755);
	await chmod(join(result.root, "bin/curl"), 0o755);
	await chmod(join(result.root, "bin/vp"), 0o755);
	return {
		...result,
		env: {
			...result.env,
			DOCKER_CALLS: join(result.root, "docker.calls"),
			DOCKER_INSPECTION: postgresInspection(options.image),
			GROVE_DEPENDENCY_TIMEOUT_SECONDS: "1",
			OIDC_READY: options.oidcReady === false ? "0" : "1",
			PORT: "3000",
			POSTGRES_READY: options.postgresReady === false ? "0" : "1",
			PUBLIC_URL: "https://grove.portal.test",
			VP_CALLS: join(result.root, "vp.calls"),
		},
	};
};

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("ensure Grove orb services", () => {
	it("is valid shell and emits portal manifests plus machine preflight", async () => {
		const { root, env } = await fixture();
		const syntax = await run("bash", ["-n", join(root, ".agents/ensure-grove")], {
			cwd: root,
			env,
		});
		expect(syntax).toMatchObject({ code: 0, stderr: "" });

		const ensured = await run(join(root, ".agents/ensure-grove"), [], { cwd: "/", env });

		expect(ensured.code).toBe(0);
		expect(JSON.parse(ensured.stdout)).toEqual({
			status: "ready",
			grovePortal: "https://grove.portal.test",
			oidcPortal: "https://oidc.portal.test",
			portalManifests: {
				grove: ".amp/portals/grove.json",
				oidc: ".amp/portals/grove-oidc.json",
			},
			services: { status: "healthy" },
			preflight: { status: "ready", checks: [] },
		});
		expect(await readFile(join(root, "amp.calls"), "utf8")).toBe("orb services ensure --json\n");
		expect(await readFile(join(root, "curl.calls"), "utf8")).toContain(
			"https://grove.portal.test/__dev/preflight",
		);
	});

	it("prints diagnostic JSON and fails when required preflight checks are not ready", async () => {
		const { root, env } = await fixture("not-ready");

		const ensured = await run(join(root, ".agents/ensure-grove"), [], { cwd: root, env });

		expect(ensured.code).toBe(1);
		expect(JSON.parse(ensured.stdout)).toMatchObject({
			status: "not-ready",
			preflight: { status: "not-ready" },
		});
	});

	it("bounds a stuck supervisor ensure and prints machine-readable repair", async () => {
		const { root, env } = await fixture();
		await writeFile(join(root, "bin/amp"), "#!/usr/bin/env bash\nsleep 10\n");
		await chmod(join(root, "bin/amp"), 0o755);
		const started = Date.now();

		const ensured = await run(join(root, ".agents/ensure-grove"), [], {
			cwd: root,
			env: { ...env, GROVE_ENSURE_TIMEOUT_SECONDS: "1" },
		});

		expect(Date.now() - started).toBeLessThan(3_000);
		expect(ensured.code).toBe(124);
		expect(JSON.parse(ensured.stdout)).toMatchObject({
			status: "not-ready",
			error: {
				id: "service-ensure-timeout",
				repair: expect.stringContaining("amp orb service logs grove") as unknown,
			},
		});
	}, 5_000);
});

describe("Grove supervised service startup", () => {
	it("validates compatible PostgreSQL state and bounds dependency probes", async () => {
		const { root, env } = await serviceFixture();

		const started = await run(join(root, "tools/start-grove-orb"), [], { cwd: "/", env });

		expect(started).toMatchObject({ code: 0, stderr: "" });
		const dockerCalls = await readFile(join(root, "docker.calls"), "utf8");
		expect(dockerCalls).toContain("inspect grove-postgres");
		expect(dockerCalls).toContain("pg_isready --username grove --dbname grove");
		expect(dockerCalls).toContain(
			`psql --username grove --dbname grove --tuples-only --no-align --command select current_user || ':' || current_database()`,
		);
		expect(await readFile(join(root, "vp.calls"), "utf8")).toBe(
			"exec effectdb migrate up\nexec vite dev --host 0.0.0.0 --port 3000\n",
		);
	});

	it("refuses to delete an incompatible PostgreSQL container and gives an owner repair", async () => {
		const { root, env } = await serviceFixture({ image: "postgres:16-alpine" });

		const started = await run(join(root, "tools/start-grove-orb"), [], { cwd: root, env });

		expect(started.code).toBe(78);
		expect(started.stderr).toContain("image must be postgres:17-alpine");
		expect(started.stderr).toContain("it was not deleted because it may contain demo data");
		expect(started.stderr).toContain("docker stop grove-postgres && docker rm grove-postgres");
		expect(await readFile(join(root, "docker.calls"), "utf8")).toBe("inspect grove-postgres\n");
	});

	it("terminates with actionable diagnostics when PostgreSQL never becomes ready", async () => {
		const { root, env } = await serviceFixture({ postgresReady: false });
		const before = Date.now();

		const started = await run(join(root, "tools/start-grove-orb"), [], { cwd: root, env });

		expect(Date.now() - before).toBeLessThan(3_000);
		expect(started.code).toBe(1);
		expect(started.stderr).toContain("Timed out after 1s waiting for grove-postgres readiness");
		expect(started.stderr).toContain("amp orb service logs docker");
	}, 5_000);

	it.each([
		[
			"OIDC provider",
			{ oidcReady: false },
			"the local Grove development OIDC provider",
			".amp/in/grove-oidc.log",
		],
		[
			"OIDC manifest",
			{ validOidcManifest: false },
			"the OIDC portal manifest",
			"amp orb service status grove-oidc",
		],
	] as const)(
		"bounds a never-ready %s with its repair",
		async (_name, options, wait, repair) => {
			const { root, env } = await serviceFixture(options);
			const before = Date.now();

			const started = await run(join(root, "tools/start-grove-orb"), [], { cwd: root, env });

			expect(Date.now() - before).toBeLessThan(3_000);
			expect(started.code).toBe(1);
			expect(started.stderr).toContain(`Timed out after 1s waiting for ${wait}`);
			expect(started.stderr).toContain(repair);
		},
		5_000,
	);
});
