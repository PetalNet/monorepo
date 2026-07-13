import type { CardItem, DeliveryItem, SignalEmission, SubscriptionItem } from "$lib/api/types";

export interface DeliveryReceiptView {
	seq: string;
	ts: string;
	tier: string;
	signal: string;
	subject: string;
	status: string;
	error: string | null;
	retryable?: boolean;
}

const now = Date.now(),
	iso = (ago: number) => new Date(now - ago).toISOString();
export const mockSignals: SignalEmission[] = [
	{
		schema_version: 1,
		id: "9e3f7390-e290-4ab3-8a51-5600ed6fbe61",
		type: "host.disk.warn",
		ts: iso(6 * 6e4),
		source: { service: "shawn", host: ".12", agent: "shawn" },
		subject: "Disk 84% on .12, rising since Tuesday",
		severity: "warn",
		action: "/hosts?host=.12",
		scope: "fleet",
	},
	{
		schema_version: 1,
		id: "2dc10c03-9f16-4e52-b4db-e35de294c4c8",
		type: "host.swap.steady",
		ts: iso(22 * 6e4),
		source: { service: "shawn", host: ".12", agent: "shawn" },
		subject: "Swap steady at 41% on .12",
		severity: "info",
		action: "/hosts?host=.12",
		scope: "fleet",
	},
	{
		schema_version: 1,
		id: "a387e1e6-04e2-4481-a5c9-235083ce4607",
		type: "host.load.settled",
		ts: iso(36e5),
		source: { service: "box-agent", host: "mc34" },
		subject: "mc34 load settled after the backup window",
		severity: "debug",
		action: "/hosts?host=mc34",
		scope: "fleet",
	},
];
export const mockSubscriptions: SubscriptionItem[] = [
	{
		schema_version: 1,
		pattern: "citeseer.*",
		tier: "digest",
		window: "18:00",
		loud: false,
		owner: "parker",
		note: "automatic storm override",
		updated_by: "system:bus",
		updated_at: iso(2 * 6e4),
		storm: {
			active: true,
			event_count: 4_120,
			threshold: 60,
			window_started_at: iso(7 * 6e4),
			muted_at: iso(2 * 6e4),
			expires_at: iso(-58 * 6e4),
			previous_tier: "feed",
			muted_by: "system:bus",
		},
	},
	{
		schema_version: 1,
		pattern: "host.disk.*",
		tier: "feed",
		loud: false,
		owner: "parker",
		updated_by: "parker",
		updated_at: iso(12 * 864e5),
	},
	{
		schema_version: 1,
		pattern: "container.update.*",
		tier: "digest",
		window: "18:00",
		loud: false,
		owner: "parker",
		updated_by: "janet",
		updated_at: iso(2 * 864e5),
	},
	{
		schema_version: 1,
		pattern: "board.digest.*",
		tier: "digest",
		window: "18:00",
		loud: false,
		owner: "parker",
		note: "retired from chat",
		updated_by: "janet",
		updated_at: iso(2 * 864e5),
	},
	{
		schema_version: 1,
		pattern: "agent.crashed",
		tier: "interrupt",
		loud: true,
		owner: "parker",
		note: "reserved class: P0",
		updated_by: "parker",
		updated_at: iso(4 * 864e5),
	},
];
export const mockDelivery: DeliveryItem = {
	owner: "parker",
	channel: "matrix",
	target: "@parker:petalcat.dev",
	verified: true,
	cocoon_until: null,
	next_digest_at: new Date(now + 9 * 36e5).toISOString(),
	updated_at: iso(2 * 864e5),
	updated_by: "janet",
};
export const mockCards: CardItem[] = [
	{
		card_id: "c-dead-482",
		task_id: 482,
		sender: "michael",
		sender_class: "agent",
		recipient: "carson-2",
		priority: 1,
		interrupt_policy: "defer",
		body: "Reconcile the failed board delivery.",
		needs: [],
		state: "dead",
		fence: 5,
		reaps: 3,
		created_at_ms: now - 3 * 36e5,
		updated_at_ms: now - 2 * 36e5,
	},
	{
		card_id: "c-park-gpu",
		task_id: 511,
		sender: "dispatcher",
		sender_class: "system",
		recipient: null,
		priority: 2,
		interrupt_policy: "defer",
		body: "GPU capacity check.",
		needs: ["gpu"],
		state: "parked",
		fence: 1,
		reaps: 0,
		created_at_ms: now - 5 * 36e5,
		updated_at_ms: now - 3 * 36e5,
	},
];
export const mockReceipts: DeliveryReceiptView[] = [
	{
		seq: "r1",
		ts: iso(2 * 6e4),
		tier: "test",
		signal: "delivery.test",
		subject: "Test from the lab.",
		status: "delivered",
		error: null,
	},
	{
		seq: "r2",
		ts: iso(2 * 36e5),
		tier: "digest",
		signal: "digest.batch",
		subject: "14 signals batched",
		status: "delivered",
		error: null,
	},
	{
		seq: "r3",
		ts: iso(6 * 36e5),
		tier: "interrupt",
		signal: "agent.crashed",
		subject: "carson-2",
		status: "delivered",
		error: null,
	},
];
