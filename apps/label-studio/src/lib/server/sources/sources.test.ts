import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SourceConfig } from "../config.ts";
import { listenLocal } from "../testing.ts";
import { readSource } from "./index.ts";
import { hass, humanSize, proxmox, truenas } from "./normalise.ts";

const SECRET = "fixture-token-value";

describe("normalisers", () => {
	it("merges Proxmox VMs and containers by id with readable tags", () => {
		const table = proxmox(
			{ data: [{ vmid: 105, name: "web", status: "running", tags: "prod;dmz", cpu: 0.1 }] },
			{ data: [{ vmid: 101, name: "dns", status: "stopped" }] },
		);

		expect(table?.rows).toEqual([
			{ vmid: "101", name: "dns", type: "LXC", status: "stopped", tags: "" },
			{ vmid: "105", name: "web", type: "VM", status: "running", tags: "prod, dmz" },
		]);

		expect(table?.columns.map((column) => column.key)).toEqual([
			"vmid",
			"name",
			"type",
			"status",
			"tags",
		]);
	});

	it("gives TrueNAS disks decimal sizes in natural order", () => {
		const table = truenas([
			{
				name: "sdb10",
				serial: "SN-B",
				model: "Disk B",
				size: 4_000_787_030_016,
				type: "HDD",
				pool: null,
			},
			{
				name: "sdb2",
				serial: "SN-A",
				model: "Disk A",
				size: 500_107_862_016,
				type: "SSD",
				pool: "tank",
			},
		]);

		expect(table?.rows).toEqual([
			{ name: "sdb2", serial: "SN-A", model: "Disk A", size: "500 GB", type: "SSD", pool: "tank" },
			{ name: "sdb10", serial: "SN-B", model: "Disk B", size: "4 TB", type: "HDD", pool: "" },
		]);

		expect(humanSize(1_920_383_410_176)).toBe("1.9 TB");
	});

	it("names Home Assistant entities and adds an area column only when one is known", () => {
		const plain = hass([
			{ entity_id: "switch.porch", state: "on", attributes: {} },
			{ entity_id: "light.desk", state: "off", attributes: { friendly_name: "Desk lamp" } },
		]);

		expect(plain?.rows).toEqual([
			{ entity_id: "light.desk", name: "Desk lamp", domain: "light", state: "off" },
			{ entity_id: "switch.porch", name: "switch.porch", domain: "switch", state: "on" },
		]);

		expect(plain?.columns.some((column) => column.key === "area")).toBe(false);

		const withArea = hass([{ entity_id: "light.a", state: "on", attributes: { area: "Office" } }]);

		expect(withArea?.rows[0].area).toBe("Office");
		expect(withArea?.columns.at(-1)?.key).toBe("area");
	});

	it("rejects replies in the wrong shape", () => {
		expect(truenas({ disks: [] })).toBeNull();
		expect(proxmox({ data: [{ name: "no id" }] }, { data: [] })).toBeNull();
	});
});

let server: Server | undefined;

afterEach(() => {
	server?.close();
	server = undefined;
});

async function fakeSource(
	reply: (url: string, headers: IncomingHttpHeaders) => { status: number; body: string } | "hang",
): Promise<string> {
	server = createServer((request, response) => {
		const answer = reply(request.url ?? "", request.headers);

		if (answer === "hang") {
			return;
		}

		response.writeHead(answer.status, { "content-type": "application/json" });
		response.end(answer.body);
	});

	return listenLocal(server);
}

function sourceConfig(url: string, extra: Partial<SourceConfig> = {}): SourceConfig {
	const dir = mkdtempSync(path.join(os.tmpdir(), "ls-source-"));
	const secretFile = path.join(dir, "secret");

	writeFileSync(secretFile, `${SECRET}\n`);

	return { url, secretFile, insecureTls: false, ...extra };
}

describe("readSource", () => {
	it("sends the trimmed token and returns normalised rows", async () => {
		const seen: { url: string; auth: string | undefined }[] = [];
		const url = await fakeSource((requestPath, headers) => {
			seen.push({ url: requestPath, auth: headers.authorization });

			return {
				status: 200,
				body: JSON.stringify({ data: [{ vmid: 100, name: "a", status: "running" }] }),
			};
		});

		const result = await readSource("proxmox", sourceConfig(url, { node: "node-1" }));

		expect(result.ok).toBe(true);

		expect(seen.map((item) => item.url).toSorted()).toEqual([
			"/api2/json/nodes/node-1/lxc",
			"/api2/json/nodes/node-1/qemu",
		]);

		expect(seen.every((item) => item.auth === `PVEAPIToken=${SECRET}`)).toBe(true);
	});

	it.each([
		[401, "TrueNAS refused the token"],
		[403, "TrueNAS refused the token"],
		[500, "TrueNAS answered HTTP 500"],
	])("maps HTTP %i to a message without the secret", async (status, message) => {
		const url = await fakeSource(() => ({ status, body: JSON.stringify({ error: SECRET }) }));

		expect(await readSource("truenas", sourceConfig(url))).toEqual({ ok: false, error: message });
	});

	it("reports a non-JSON reply and an unexpected shape", async () => {
		const html = await fakeSource(() => ({ status: 200, body: "<html>login</html>" }));

		expect(await readSource("hass", sourceConfig(html))).toEqual({
			ok: false,
			error: "Home Assistant sent a reply that is not JSON",
		});

		server?.close();

		const wrong = await fakeSource(() => ({
			status: 200,
			body: JSON.stringify({ message: "ok" }),
		}));

		expect(await readSource("hass", sourceConfig(wrong))).toEqual({
			ok: false,
			error: "Home Assistant sent a reply in an unexpected shape",
		});
	});

	it("reports an unreachable source on a closed port and on a timeout", async () => {
		const url = await fakeSource(() => "hang");

		expect(await readSource("hass", sourceConfig(url), undefined, 100)).toEqual({
			ok: false,
			error: "Home Assistant unreachable",
		});

		server?.close();

		expect(await readSource("hass", sourceConfig(url))).toEqual({
			ok: false,
			error: "Home Assistant unreachable",
		});
	});

	it("reports a missing credential file without its path", async () => {
		const result = await readSource("hass", {
			url: "http://127.0.0.1:9",
			secretFile: "/nonexistent/secret",
			insecureTls: false,
		});

		expect(result).toEqual({
			ok: false,
			error: "Home Assistant credential file could not be read",
		});
	});
});
