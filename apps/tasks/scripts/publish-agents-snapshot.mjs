#!/usr/bin/env -S node --experimental-strip-types
import { readFile } from "node:fs/promises";
import { snapshot } from "./agents-snapshot.mjs";

const tokenFile = process.env.TASKS_AGENTS_INGEST_TOKEN_FILE;

if (!tokenFile) throw new Error("TASKS_AGENTS_INGEST_TOKEN_FILE is required");

const token = (await readFile(tokenFile, "utf8")).trim();

if (!token) throw new Error("Agents ingest token is empty");

const response = await fetch("https://tasks.petalcat.dev/api/agent/agents/snapshot", {
	method: "POST",
	headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
	body: JSON.stringify(await snapshot()),
	signal: AbortSignal.timeout(20_000),
	redirect: "error",
});

if (!response.ok) throw new Error(`Agents snapshot upload failed (${response.status})`);
