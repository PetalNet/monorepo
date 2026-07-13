import { randomUUID } from "node:crypto";

import { describe, it, expect } from "vitest";

import { matchPattern } from "../src/bus/broker.ts";
import { parseEmission, type Emission } from "../src/emission.ts";
import { authorizeEmission, type ProducerRegistration } from "../src/ingest/authz.ts";
import { scrubEmission } from "../src/ingest/scrubber.ts";

function emission(over: Partial<Emission> = {}): Emission {
	return {
		schema_version: 1,
		id: randomUUID(),
		type: "host.cpu.pct",
		ts: new Date().toISOString(),
		source: { service: "bridge", host: ".15", agent: null },
		subject: ".15",
		severity: "info",
		scope: "fleet",
		...over,
	};
}

describe("emission parsing", () => {
	it("accepts a valid emission", () => {
		const r = parseEmission(emission(), 200);
		expect(r.ok).toBe(true);
	});
	it("rejects an unscoped emission", () => {
		const bad = emission();
		const { scope: _drop, ...rest } = bad;
		void _drop;
		expect(parseEmission(rest, 200).ok).toBe(false);
	});
	it("rejects a bad type name", () => {
		expect(parseEmission(emission({ type: "NotADotted" }), 200).ok).toBe(false);
	});
	it("rejects an oversized payload", () => {
		expect(parseEmission(emission(), 20000).code).toBe("payload_too_large");
	});
});

describe("secret scrubber", () => {
	it("rejects a claim_token in dimensions", () => {
		const e = emission({ dimensions: { claim_token: "abc" } });
		expect(scrubEmission(e).ok).toBe(false);
	});
	it("rejects a token-shaped value", () => {
		const e = emission({ dimensions: { note: "ghp_0123456789012345678901" } });
		expect(scrubEmission(e).ok).toBe(false);
	});
	it("passes a clean emission", () => {
		expect(scrubEmission(emission({ dimensions: { link_id: "b" } })).ok).toBe(true);
	});
});

describe("emit authorization", () => {
	const reg: ProducerRegistration = {
		subject: "bridge:hosts",
		allowedServices: ["bridge"],
		allowedTypePrefixes: ["host", "container"],
		allowedScopes: ["fleet"],
		maxSeverity: "warn",
	};
	it("allows a permitted emission", () => {
		expect(authorizeEmission(reg, emission()).ok).toBe(true);
	});
	it("denies a foreign source", () => {
		expect(
			authorizeEmission(reg, emission({ source: { service: "manager", host: null, agent: null } }))
				.code,
		).toBe("source_mismatch");
	});
	it("denies a reserved namespace", () => {
		expect(authorizeEmission(reg, emission({ type: "audit.op" })).code).toBe("namespace_reserved");
	});
	it("denies a foreign scope", () => {
		expect(authorizeEmission(reg, emission({ scope: "user:parker" })).code).toBe("scope_denied");
	});
	it("denies over-cap severity", () => {
		expect(authorizeEmission(reg, emission({ severity: "p0" })).code).toBe("severity_denied");
	});
});

describe("pattern matching", () => {
	it("exact", () => expect(matchPattern("host.cpu.pct", "host.cpu.pct")).toBe(true));
	it("prefix glob", () => expect(matchPattern("doorman.*", "doorman.link.flap")).toBe(true));
	it("prefix glob miss", () => expect(matchPattern("doorman.*", "host.cpu.pct")).toBe(false));
	it("star", () => expect(matchPattern("*", "anything.here")).toBe(true));
	it("suffix glob", () => expect(matchPattern("*.flap", "doorman.flap")).toBe(true));
});
