/** Turn each source's reply into label-friendly rows. Replies are parsed, not trusted. */
import type { SourceRows } from "$lib/api";
import type { Vars } from "$lib/doc";

import {
	array,
	nullable,
	number,
	object,
	optional,
	parse,
	record,
	string,
	type Parser,
} from "../parse.ts";

export type Table = Omit<SourceRows, "fetchedAt">;

const loose = <T>(parser: Parser<T>): Parser<T | null | undefined> => optional(nullable(parser));
const anyValue: Parser<unknown> = (input) => ({ ok: true, value: input });

const proxmoxList = object({
	data: array(
		object({
			vmid: number(),
			name: loose(string()),
			status: loose(string()),
			tags: loose(string()),
		}),
	),
});

export function proxmox(qemu: unknown, lxc: unknown): Table | null {
	const vms = parse(proxmoxList, qemu);
	const containers = parse(proxmoxList, lxc);

	if (!vms.ok || !containers.ok) {
		return null;
	}

	const rows = [
		...vms.value.data.map((guest) => ({ guest, type: "VM" })),
		...containers.value.data.map((guest) => ({ guest, type: "LXC" })),
	]
		.toSorted((a, b) => a.guest.vmid - b.guest.vmid)
		.map(
			({ guest, type }): Vars => ({
				vmid: String(guest.vmid),
				name: guest.name ?? "",
				type,
				status: guest.status ?? "",
				tags: (guest.tags ?? "")
					.split(/[;,\s]+/)
					.filter(Boolean)
					.join(", "),
			}),
		);

	return {
		columns: [
			{ key: "vmid", label: "ID" },
			{ key: "name", label: "Name" },
			{ key: "type", label: "Type" },
			{ key: "status", label: "Status" },
			{ key: "tags", label: "Tags" },
		],
		rows,
	};
}

const truenasDisks = array(
	object({
		name: string(),
		serial: loose(string()),
		model: loose(string()),
		size: loose(number()),
		type: loose(string()),
		pool: loose(string()),
	}),
);

/** Drive makers count in powers of ten, so a 4 TB disk should say 4 TB. */
export function humanSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let value = bytes;
	let unit = 0;

	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}

	const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;

	return `${String(rounded)} ${units[unit]}`;
}

export function truenas(body: unknown): Table | null {
	const disks = parse(truenasDisks, body);

	if (!disks.ok) {
		return null;
	}

	return {
		columns: [
			{ key: "name", label: "Disk" },
			{ key: "serial", label: "Serial" },
			{ key: "model", label: "Model" },
			{ key: "size", label: "Size" },
			{ key: "type", label: "Type" },
			{ key: "pool", label: "Pool" },
		],
		rows: disks.value
			.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
			.map((disk) => ({
				name: disk.name,
				serial: disk.serial ?? "",
				model: disk.model ?? "",
				size: disk.size == null ? "" : humanSize(disk.size),
				type: disk.type ?? "",
				pool: disk.pool ?? "",
			})),
	};
}

const hassStates = array(
	object({
		entity_id: string({ min: 1 }),
		state: string(),
		attributes: optional(record(anyValue)),
	}),
);

export function hass(body: unknown): Table | null {
	const states = parse(hassStates, body);

	if (!states.ok) {
		return null;
	}

	const text = (value: unknown): string => (typeof value === "string" ? value : "");
	const rows = states.value
		.toSorted((a, b) => a.entity_id.localeCompare(b.entity_id))
		.map((entity): Vars => {
			const attributes = entity.attributes ?? {};
			const area = text(attributes.area) || text(attributes.area_name) || text(attributes.area_id);

			return {
				entity_id: entity.entity_id,
				name: text(attributes.friendly_name) || entity.entity_id,
				domain: entity.entity_id.split(".")[0],
				state: entity.state,
				...(area ? { area } : {}),
			};
		});
	const hasArea = rows.some((row) => "area" in row);

	return {
		columns: [
			{ key: "entity_id", label: "Entity" },
			{ key: "name", label: "Name" },
			{ key: "domain", label: "Domain" },
			{ key: "state", label: "State" },
			...(hasArea ? [{ key: "area", label: "Area" }] : []),
		],
		rows,
	};
}
