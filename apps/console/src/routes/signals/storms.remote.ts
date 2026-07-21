import { getRequestEvent } from "$app/server";
const env = import.meta.env;
import type { OpResult, ReadEnvelope, SubscriptionItem } from "$lib/api/types";
import { mockSubscriptions } from "$lib/data/signals";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { error } from "@sveltejs/kit";
import { Effect, Schema } from "effect";
import { Command, Query } from "svelte-effect-runtime";

const undoArgs = Schema.Struct({
	pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
}).annotate(rejectUnknownKeys);

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
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as
			| { error?: { message?: string } }
			| OpResult
			| null;
		const message =
			body && "error" in body && body.error?.message
				? body.error.message
				: `Console API returned ${String(response.status)}`;
		error(response.status, message);
	}
	return (await response.json()) as T;
}

export type ActiveSignalStorm = SubscriptionItem & {
	storm: NonNullable<SubscriptionItem["storm"]>;
};

export const getSignalStorms = Query(
	Effect.promise(async (): Promise<ActiveSignalStorm[]> => {
		const subscriptions = isMock()
			? mockSubscriptions
			: (
					await apiJson<ReadEnvelope<SubscriptionItem>>("/subscriptions?limit=1000", {
						headers: forwardedHeaders(),
					})
				).items;
		return subscriptions.filter(
			(subscription): subscription is ActiveSignalStorm => subscription.storm?.active === true,
		);
	}),
);

export const undoSignalStorm = Command(undoArgs, ({ pattern }) =>
	Effect.promise(async () => {
		if (isMock()) return { pattern, tier: "feed" as const, restored: true };
		const result = await apiJson<OpResult>("/op", {
			method: "POST",
			headers: forwardedHeaders(true),
			body: JSON.stringify({
				schema_version: 1,
				id: crypto.randomUUID(),
				op: "signal.snooze",
				args: { type_pattern: pattern, restore: true },
				dry_run: false,
			}),
		});
		if (!result.ok) error(400, result.error.message);
		void Effect.runPromise(getSignalStorms().refresh());
		return { pattern, tier: "feed" as const, restored: true };
	}),
);
