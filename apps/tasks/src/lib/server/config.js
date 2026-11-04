import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

const person = z.object({
	name: z.string().min(1),
	color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
	kind: z.enum(["human", "agent"]),
	aliases: z.array(z.string().min(1)).default([]),
});

const schema = z.object({
	people: z.record(z.string().min(1), person).default({}),
	responsibles: z.array(z.string().min(1)).default([]),
	assignees: z.array(z.string().min(1)).default([]),
	fleet: z
		.object({
			agents: z
				.array(
					z.object({
						handle: z.string().min(1),
						host: z.string().min(1),
						term: z.string().url().optional(),
					}),
				)
				.default([]),
		})
		.default({ agents: [] }),
	accessMessage: z.string().min(1).optional(),
});

function readConfig() {
	const path = process.env.TASKS_CONFIG;

	if (!path || !existsSync(path)) return schema.parse({});

	let raw;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Invalid TASKS_CONFIG at ${path}: ${error.message}`);
	}

	const parsed = schema.safeParse(raw);
	if (!parsed.success)
		throw new Error(`Invalid TASKS_CONFIG at ${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

	return parsed.data;
}

export const tasksConfig = readConfig();
