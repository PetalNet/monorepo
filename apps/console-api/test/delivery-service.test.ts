import { describe, expect, it, vi } from "vitest";

import type { Db } from "../src/db/pool.ts";
import type { Emission } from "../src/emission.ts";
import { DeliveryService } from "../src/notifications/delivery.ts";
import type { MatrixTransport } from "../src/notifications/matrix.ts";

function signal(overrides: Partial<Emission> = {}): Emission {
	return {
		schema_version: 1,
		id: crypto.randomUUID(),
		type: "host.disk.warn",
		ts: new Date().toISOString(),
		source: { service: "box-agent", host: ".12", agent: null },
		subject: "Disk high on .12",
		subject_kind: "host",
		severity: "warn",
		scope: "fleet",
		...overrides,
	};
}

function service(options?: {
	cocoon?: boolean;
	developmentSource?: string | (() => string | undefined);
	loud?: boolean;
	tier?: string;
	scopes?: string[];
	scopesForOwner?: () => Promise<string[]>;
	pattern?: string;
	filter?: Record<string, unknown>;
	configured?: boolean;
}) {
	const send = vi.fn<MatrixTransport["send"]>().mockResolvedValue({
		eventId: "$receipt",
		roomId: "!room:example.test",
	});
	const matrix: MatrixTransport = {
		assertOwnedTarget: vi.fn().mockResolvedValue(undefined),
		send,
	};
	const sql = (async (strings: TemplateStringsArray) => {
		const statement = strings.join(" ");
		if (statement.includes("from signal_source_modes")) {
			const developmentSource =
				typeof options?.developmentSource === "function"
					? options.developmentSource()
					: options?.developmentSource;
			return developmentSource ? [{ source_service: developmentSource, mode: "development" }] : [];
		}
		if (statement.includes("from current_state where kind = 'subscription'"))
			return [
				{
					owner: "parker",
					state: {
						owner: "parker",
						pattern: options?.pattern ?? "host.**",
						filter: options?.filter,
						tier: options?.tier ?? "feed",
						loud: options?.loud ?? true,
					},
				},
			];
		if (statement.includes("from delivery_config"))
			if (options?.configured === false) return [];
			else
				return [
					{
						owner: "parker",
						scope: "user:parker",
						target: "@parker:example.test",
						cocoon_until: options?.cocoon ? new Date(Date.now() + 60 * 60_000).toISOString() : null,
					},
				];
		if (statement.includes("select exists")) return [{ active: false }];
		return [];
	}) as unknown as Db["writer"];
	const db = { admin: sql, app: sql, ro: sql, writer: sql, close: vi.fn() } as unknown as Db;
	const emitted: Emission[] = [];
	const delivery = new DeliveryService({
		db,
		matrix,
		emit: async (emission) => {
			emitted.push(emission);
			return { ok: true, seq: emitted.length };
		},
		scopesForOwner:
			options?.scopesForOwner ?? (async () => options?.scopes ?? ["fleet", "user:parker"]),
	});
	return { delivery, send, emitted };
}

describe("DeliveryService subscription dispatch", () => {
	it("mutes off-console alerts from a source in development mode", async () => {
		const { delivery, send, emitted } = service({
			developmentSource: "box-agent",
			loud: true,
		});
		await delivery.onEmission(signal({ severity: "p0" }));
		expect(send).not.toHaveBeenCalled();
		expect(emitted).toEqual([]);
	});

	it("rechecks development mode at the final transport boundary", async () => {
		let developing = false;
		let scopeChecks = 0;
		let resumeFinalCheck!: () => void;
		let reachedFinalCheck!: () => void;
		const paused = new Promise<void>((resolve) => (reachedFinalCheck = resolve));
		const resume = new Promise<void>((resolve) => (resumeFinalCheck = resolve));
		const { delivery, send } = service({
			developmentSource: () => (developing ? "box-agent" : undefined),
			scopesForOwner: async () => {
				scopeChecks += 1;
				if (scopeChecks === 2) {
					reachedFinalCheck();
					await resume;
				}
				return ["fleet", "user:parker"];
			},
		});

		const dispatch = delivery.onEmission(signal({ severity: "p0" }));
		await paused;
		developing = true;
		resumeFinalCheck();
		await dispatch;

		expect(send).not.toHaveBeenCalled();
	});

	it("suppresses ordinary loud delivery during Cocoon mode", async () => {
		const { delivery, send, emitted } = service({ cocoon: true, loud: true });
		await delivery.onEmission(signal());
		expect(send).not.toHaveBeenCalled();
		expect(emitted).toEqual([]);
	});

	it("always lets P0 through Cocoon and persists a real receipt", async () => {
		const { delivery, send, emitted } = service({ cocoon: true, loud: true });
		await delivery.onEmission(signal({ severity: "p0" }));
		expect(send).toHaveBeenCalledOnce();
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "delivery.receipt",
				scope: "user:parker",
				dimensions: expect.objectContaining({ status: "delivered", channel: "matrix" }),
			}),
		);
	});

	it("does not deliver an ineligible interrupt or a signal outside the owner's current scopes", async () => {
		const ineligible = service({ tier: "interrupt", loud: false });
		await ineligible.delivery.onEmission(signal());
		expect(ineligible.send).not.toHaveBeenCalled();

		const fenced = service({ loud: true, scopes: ["user:parker"] });
		await fenced.delivery.onEmission(signal({ severity: "p0" }));
		expect(fenced.send).not.toHaveBeenCalled();
	});

	it("uses the broker glob grammar and honors subscription filters", async () => {
		const matching = service({ pattern: "host.*", filter: { severity_gte: "warn" } });
		await matching.delivery.onEmission(signal({ type: "host.disk.warn" }));
		expect(matching.send).toHaveBeenCalledOnce();

		const filtered = service({ filter: { source_service: "manager" } });
		await filtered.delivery.onEmission(signal());
		expect(filtered.send).not.toHaveBeenCalled();
	});

	it("persists a failed backup receipt when an eligible line has no target", async () => {
		const { delivery, send, emitted } = service({ configured: false });
		await delivery.onEmission(signal());
		expect(send).not.toHaveBeenCalled();
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "delivery.receipt",
				dimensions: expect.objectContaining({
					status: "failed",
					error_code: "target_missing",
				}),
			}),
		);
	});

	it("returns the persisted receipt sequence and consolidates stale Matrix sync", async () => {
		const { delivery, emitted } = service();
		await expect(delivery.test("parker")).resolves.toMatchObject({ receipt_ref: "1" });
		await delivery.reconcileMatrixSync(Math.floor(Date.now() / 1_000) - 121);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "attention.created",
				subject: "delivery-line:parker",
			}),
		);
	});
});
