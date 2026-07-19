import { getRequestEvent, command, query } from "$app/server";
const env = import.meta.env;
import type { EdgeRegistryItem, OpResult, ReadEnvelope } from "$lib/api/types";
import { mockPendingKey, mockRegistry } from "$lib/data/network";
import { captureCaughtFailure } from "$lib/glitchtip";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { error } from "@sveltejs/kit";
import { Schema } from "effect";

const fingerprint = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256));
const handle = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(64),
	Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);
const reason = Schema.Trim.check(Schema.isMinLength(3), Schema.isMaxLength(500));
const approveInput = Schema.Struct({ pubkey_fp: fingerprint, handle }).annotate(rejectUnknownKeys);
const denyInput = Schema.Struct({ pubkey_fp: fingerprint, reason }).annotate(rejectUnknownKeys);
const revokeInput = Schema.Struct({
	pubkey_fp: fingerprint,
	handle,
	confirm_name: handle,
	reason,
}).annotate(rejectUnknownKeys);

export interface KeyCeremonySurface {
	readonly registry: EdgeRegistryItem[];
	readonly observed_at: string | null;
	readonly registry_available: boolean;
	readonly executor: {
		readonly configured: boolean;
		readonly live: boolean;
		readonly detail: string;
	};
	readonly is_mock: boolean;
}

interface ApiSurface {
	readonly registry: ReadEnvelope<EdgeRegistryItem>;
	readonly executor: KeyCeremonySurface["executor"];
}

const mockStates = new Map<string, EdgeRegistryItem["state"] | "denied">();

function isMock(): boolean {
	return env.PUBLIC_CONSOLE_DATA_MODE !== "live";
}

function apiBase(): string {
	return env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
}

function forwardedHeaders(contentType = false): Headers {
	const incoming = getRequestEvent().request.headers;
	const headers = new Headers({ accept: "application/json" });
	for (const name of ["authorization", "cookie", "x-dev-principal"]) {
		const value = incoming.get(name);
		if (value) headers.set(name, value);
	}
	if (contentType) headers.set("content-type", "application/json");
	return headers;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await getRequestEvent().fetch(`${apiBase()}${path}`, {
		...init,
		headers: init?.headers ?? forwardedHeaders(init?.body !== undefined),
	});
	const body = (await response.json().catch(() => null)) as
		| (T & { error?: { message?: string } | null })
		| OpResult
		| null;
	if (!response.ok) {
		const message = body?.error?.message ?? `Console API returned ${String(response.status)}`;
		error(response.status, message);
	}
	return body as T;
}

function mockSurface(): KeyCeremonySurface {
	const showPending = getRequestEvent().url.searchParams.get("scene") === "asked";
	const source = showPending ? [mockPendingKey, ...mockRegistry] : mockRegistry;
	return {
		registry: source.flatMap((item) => {
			const state = mockStates.get(item.pubkey_fp) ?? item.state;
			return state === "denied" ? [] : [{ ...item, state }];
		}),
		observed_at: new Date().toISOString(),
		registry_available: true,
		executor: { configured: true, live: true, detail: "Mock doorman is ready" },
		is_mock: true,
	};
}

export const getKeyCeremony = query(async (): Promise<KeyCeremonySurface> => {
	if (isMock()) return mockSurface();
	try {
		const surface = await apiJson<ApiSurface>("/network/key-ceremony");
		return {
			registry: surface.registry.items,
			observed_at: surface.registry.freshness.observed_at,
			registry_available: true,
			executor: surface.executor,
			is_mock: false,
		};
	} catch (cause) {
		captureCaughtFailure(cause, { surface: "network", endpoint: "/network/key-ceremony" });
		return {
			registry: [],
			observed_at: null,
			registry_available: false,
			executor: {
				configured: false,
				live: false,
				detail: "Key registry and doorman availability could not be verified",
			},
			is_mock: false,
		};
	}
});

async function runCeremonyOp(
	op: "edge.enroll.approve" | "edge.enroll.deny" | "edge.key.revoke",
	args: Record<string, string>,
	reasonText?: string,
) {
	const result = await apiJson<OpResult>("/op", {
		method: "POST",
		headers: forwardedHeaders(true),
		body: JSON.stringify({
			schema_version: 1,
			id: crypto.randomUUID(),
			op,
			args,
			...(reasonText ? { reason: reasonText } : {}),
			dry_run: false,
		}),
	});
	if (!result.ok) error(400, result.error.message);
	return result.result ?? {};
}

export const approveEnrollment = command(Schema.toStandardSchemaV1(approveInput), async (input) => {
	if (isMock()) {
		mockStates.set(input.pubkey_fp, "enrolled");
		return { state: "enrolled" as const, handle: input.handle };
	}
	return runCeremonyOp("edge.enroll.approve", input);
});

export const denyEnrollment = command(
	Schema.toStandardSchemaV1(denyInput),
	async ({ reason: reasonText, ...args }) => {
		if (isMock()) {
			mockStates.set(args.pubkey_fp, "denied");
			return { state: "denied" as const };
		}
		return runCeremonyOp("edge.enroll.deny", args, reasonText);
	},
);

export const revokeKey = command(
	Schema.toStandardSchemaV1(revokeInput),
	async ({ reason: reasonText, handle: _handle, ...args }) => {
		if (isMock()) {
			mockStates.set(args.pubkey_fp, "revoked");
			return { state: "revoked" as const };
		}
		return runCeremonyOp("edge.key.revoke", args, reasonText);
	},
);
