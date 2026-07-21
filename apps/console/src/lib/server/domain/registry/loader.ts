import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { Exit, Schema } from "effect";

import { asynchronously } from "#domain/iteration";

import { rejectUnknownKeys } from "../schema-conventions.ts";

const fileSchema = Schema.Struct({
	path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	mode: Schema.Literals([0o644, 0o755]),
	content_b64: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_800_000)),
}).annotate(rejectUnknownKeys);

const bundleSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	entrypoint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	files: Schema.Array(fileSchema).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
}).annotate(rejectUnknownKeys);

export type CapabilityBundle = typeof bundleSchema.Type;

export interface CapabilityIntegrity {
	readonly algorithm: "sha256";
	readonly digest: string;
}

function safeRelativePath(path: string): string {
	if (path.split(/[\\/]/).some((segment) => segment === ".."))
		throw new Error("capability bundle files must use a safe relative path");
	const clean = normalize(path);
	if (
		isAbsolute(path) ||
		clean === "." ||
		clean === ".." ||
		clean.startsWith(`..${sep}`) ||
		clean.includes(`..${sep}`)
	)
		throw new Error("capability bundle files must use a safe relative path");
	return clean;
}

function decodeBase64(value: string): Buffer {
	const bytes = Buffer.from(value, "base64");
	if (bytes.length === 0 || bytes.toString("base64") !== value)
		throw new Error("capability bundle contains invalid base64");
	return bytes;
}

/** Validate integrity and the complete bounded file manifest before any bytes reach disk. */
export function parseCapabilityBundle(
	bytes: Buffer,
	integrity: CapabilityIntegrity,
): CapabilityBundle {
	if (!/^[a-f0-9]{64}$/.test(integrity.digest))
		throw new Error("capability artifact integrity is invalid");
	const actual = createHash("sha256").update(bytes).digest();
	const expected = Buffer.from(integrity.digest, "hex");
	if (!timingSafeEqual(actual, expected)) throw new Error("capability artifact integrity mismatch");
	if (bytes.length > 2 * 1024 * 1024) throw new Error("capability artifact exceeds 2 MiB");
	let decoded: unknown;
	try {
		decoded = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("capability artifact is not a JSON bundle");
	}
	const parsed = Schema.decodeUnknownExit(bundleSchema)(decoded);
	if (Exit.isFailure(parsed)) throw new Error("capability artifact manifest is invalid");
	const seen = new Set<string>();
	let totalBytes = 0;
	for (const file of parsed.value.files) {
		const path = safeRelativePath(file.path);
		if (seen.has(path)) throw new Error("capability bundle contains duplicate paths");
		seen.add(path);
		totalBytes += decodeBase64(file.content_b64).length;
	}
	const entrypoint = safeRelativePath(parsed.value.entrypoint);
	if (!seen.has(entrypoint)) throw new Error("capability bundle entrypoint is missing");
	if (totalBytes > 2 * 1024 * 1024) throw new Error("capability bundle exceeds 2 MiB");
	return parsed.value;
}

function capabilityDirectoryName(capability: string): string {
	const name = capability.replace(/^(skill|tool)[.:/-]/, "").replace(/[^a-zA-Z0-9._-]/g, "-");
	if (!name || name === "." || name === "..") throw new Error("capability name is not installable");
	return name;
}

export interface InstallCapabilityOptions {
	readonly root: string;
	readonly capability: string;
	readonly kind: "skill" | "tool";
	readonly version: string;
}

export interface CapabilityInstallReceipt {
	readonly capability: string;
	readonly kind: "skill" | "tool";
	readonly version: string;
	readonly install_dir: string;
	readonly entrypoint: string;
	readonly files: number;
}

/** Install into a sibling staging directory, then atomically publish the verified bundle. */
export async function installCapabilityBundle(
	bundle: CapabilityBundle,
	options: InstallCapabilityOptions,
): Promise<CapabilityInstallReceipt> {
	const root = resolve(options.root);
	const installDir = join(
		root,
		options.kind === "skill" ? "skills" : "tools",
		capabilityDirectoryName(options.capability),
	);
	if (relative(root, installDir).startsWith(".."))
		throw new Error("install destination escaped root");
	const bundleDigest = createHash("sha256")
		.update(JSON.stringify(bundle))
		.digest("hex")
		.slice(0, 16);
	const versionsRoot = join(root, ".registry", "capabilities", options.kind, basename(installDir));
	const versionDir = join(
		versionsRoot,
		`${options.version.replace(/[^a-zA-Z0-9._-]/g, "-")}-${bundleDigest}`,
	);
	const staging = `${versionDir}.${String(process.pid)}.${String(Date.now())}.tmp`;
	const pointer = `${installDir}.${String(process.pid)}.${String(Date.now())}.link`;
	await mkdir(staging, { recursive: true, mode: 0o700 });
	try {
		for await (const file of asynchronously(bundle.files)) {
			const destination = join(staging, safeRelativePath(file.path));
			await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
			await writeFile(destination, decodeBase64(file.content_b64), { mode: file.mode, flag: "wx" });
			await chmod(destination, file.mode);
		}
		await mkdir(dirname(installDir), { recursive: true, mode: 0o755 });
		await rename(staging, versionDir).catch(async (error: unknown) => {
			const existing = await lstat(versionDir).catch(() => null);
			if (!existing?.isDirectory()) throw error;
			await rm(staging, { recursive: true, force: true });
		});
		await symlink(versionDir, pointer, "dir");
		const current = await lstat(installDir).catch(() => null);
		if (current && !current.isSymbolicLink())
			throw new Error("install destination is not managed by the registry loader");
		await rename(pointer, installDir);
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => undefined);
		await rm(pointer, { force: true }).catch(() => undefined);
		throw error;
	}
	if ((await readlink(installDir)) !== versionDir)
		throw new Error("capability pointer verification failed");
	return {
		capability: options.capability,
		kind: options.kind,
		version: options.version,
		install_dir: installDir,
		entrypoint: join(installDir, safeRelativePath(bundle.entrypoint)),
		files: bundle.files.length,
	};
}
