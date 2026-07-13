import type { EdgeRegistryItem, EdgeSessionItem } from "$lib/api/types";
const now = Date.now(),
	iso = (ago: number) => new Date(now - ago).toISOString();
export interface EdgeHealthFixture {
	state: "open" | "degraded" | "dark";
	listener: string;
	caddyOk: boolean;
	updatedAt: string;
}
export interface WireEventFixture {
	type: "resume" | "flap";
	handle: string;
	detail: string;
	at: string;
}
export const mockEdgeHealth: EdgeHealthFixture = {
	state: "open",
	listener: "wss/443",
	caddyOk: true,
	updatedAt: iso(5e3),
};
export const mockWireEvents: WireEventFixture[] = [
	{ type: "resume", handle: "derek", detail: "gap 3.1s", at: iso(3 * 36e5) },
	{ type: "flap", handle: "scout", detail: "link 1 · 0.4s", at: iso(9 * 36e5) },
	{ type: "resume", handle: "carson-2", detail: "gap 1.8s", at: iso(21 * 36e5) },
];
export const mockSessions: EdgeSessionItem[] = [
	{
		session_id: "sess-janet",
		handle: "janet",
		host: ".202",
		state: "open",
		established_at: iso(6 * 864e5),
		resumes_count: 2,
		last_seen_at: iso(4e3),
		handshakes_clean_count: 12005,
		links: [
			{
				link_id: "j1",
				role: "primary",
				state: "active",
				rtt_ms: 11,
				established_at: iso(6 * 864e5),
				last_flap_at: iso(3 * 864e5),
				flap_count_24h: 0,
			},
			{
				link_id: "j2",
				role: "standby",
				state: "warm",
				rtt_ms: 12,
				established_at: iso(6 * 864e5),
				flap_count_24h: 0,
			},
		],
	},
	{
		session_id: "sess-carson",
		handle: "carson-2",
		host: ".14",
		state: "open",
		established_at: iso(2 * 864e5),
		resumes_count: 5,
		last_seen_at: iso(5e3),
		handshakes_clean_count: 10400,
		links: [
			{
				link_id: "c1",
				role: "primary",
				state: "active",
				rtt_ms: 12,
				established_at: iso(2 * 864e5),
				last_flap_at: iso(9 * 36e5),
				flap_count_24h: 1,
			},
			{
				link_id: "c2",
				role: "standby",
				state: "warm",
				rtt_ms: 15,
				established_at: iso(2 * 864e5),
				flap_count_24h: 0,
			},
		],
	},
	{
		session_id: "sess-point",
		handle: "point-fable",
		host: ".14",
		state: "open",
		established_at: iso(2 * 864e5),
		resumes_count: 1,
		last_seen_at: iso(6e3),
		handshakes_clean_count: 9800,
		links: [
			{
				link_id: "p1",
				role: "primary",
				state: "active",
				rtt_ms: 13,
				established_at: iso(2 * 864e5),
				flap_count_24h: 0,
			},
			{
				link_id: "p2",
				role: "standby",
				state: "warm",
				rtt_ms: 12,
				established_at: iso(2 * 864e5),
				flap_count_24h: 0,
			},
		],
	},
	{
		session_id: "sess-scout",
		handle: "scout",
		host: ".15",
		state: "open",
		established_at: iso(14 * 36e5),
		resumes_count: 0,
		last_seen_at: iso(7e3),
		handshakes_clean_count: 0,
		links: [
			{
				link_id: "s1",
				role: "primary",
				state: "active",
				rtt_ms: 18,
				established_at: iso(14 * 36e5),
				flap_count_24h: 0,
			},
			{
				link_id: "s2",
				role: "standby",
				state: "warm",
				rtt_ms: 17,
				established_at: iso(14 * 36e5),
				flap_count_24h: 0,
			},
		],
	},
	{
		session_id: "sess-derek",
		handle: "derek",
		host: "VPS",
		state: "open",
		established_at: iso(8 * 36e5),
		resumes_count: 3,
		last_seen_at: iso(12e3),
		handshakes_clean_count: 9000,
		links: [
			{
				link_id: "d1",
				role: "primary",
				state: "active",
				rtt_ms: 41,
				established_at: iso(8 * 36e5),
				last_flap_at: iso(3 * 36e5),
				flap_count_24h: 2,
			},
			{
				link_id: "d2",
				role: "standby",
				state: "warm",
				rtt_ms: 44,
				established_at: iso(8 * 36e5),
				last_flap_at: iso(3 * 36e5),
				flap_count_24h: 2,
			},
		],
	},
];
export const mockRegistry: EdgeRegistryItem[] = mockSessions.map((s) => ({
	pubkey_fp: `fp-${s.handle}`,
	handle: s.handle,
	host: s.host,
	state: "enrolled" as const,
	enrolled_at: s.established_at,
	enrolled_by: "parker",
	last_seen_at: s.last_seen_at,
}));
export const mockPendingKey: EdgeRegistryItem = {
	pubkey_fp: "9f4a22c17d0e5b8366d108af3c52e9b017c44da2b06e91f5d3a820c75e6bfa39",
	state: "pending",
	requested_handle: "mc34",
	source_ip: "10.0.0.34",
	first_seen_at: iso(24e4),
};
