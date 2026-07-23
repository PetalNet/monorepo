import { Effect, Exit } from "effect";

import { formatUnknown } from "#format";

import type { PaletteSearchResponse } from "../../../data/palette.ts";
import type { Principal } from "../auth/principal.ts";
import { searchLibraryPaletteItems } from "../dashboard/store.ts";
import { searchEntity } from "../reads/entities.ts";
import { readAgents, readTasks } from "../reads/tracker-reads.ts";
import { searchSemanticCorpus } from "../semantic/search.ts";
import type { Services } from "../substrate.ts";
import { rankPaletteCandidates, type PaletteCandidate } from "./search.ts";

export function searchPalette(
	services: Services,
	principal: Principal,
	text: string,
	limit = 24,
): Effect.Effect<PaletteSearchResponse> {
	return Effect.gen(function* () {
		const [agents, tasks, library, hosts, statistics] = yield* Effect.all(
			[
				Effect.exit(
					services.tracker
						? Effect.map(
								readAgents(services.tracker, principal.scopes),
								(envelope) => envelope.items,
							)
						: Effect.succeed<readonly Record<string, unknown>[]>([]),
				),
				Effect.exit(
					services.tracker
						? Effect.map(
								readTasks(services.tracker, principal.scopes),
								(envelope) => envelope.items,
							)
						: Effect.succeed<readonly Record<string, unknown>[]>([]),
				),
				Effect.exit(searchLibraryPaletteItems(services.db.app, principal.scopes, text, limit)),
				Effect.exit(searchEntity(services.db.app, principal.scopes, "box_update", text, limit)),
				Effect.exit(
					Effect.promise(() =>
						searchSemanticCorpus(services.db.app, principal.scopes, text, limit, "statistic"),
					),
				),
			],
			{ concurrency: "unbounded" },
		);
		const candidates: PaletteCandidate[] = [];
		if (Exit.isSuccess(agents)) {
			for (const agent of agents.value) {
				const handle = formatUnknown(agent["handle"] ?? "");
				if (!handle) continue;
				const displayName = formatUnknown(agent["display_name"] ?? handle);
				const host = typeof agent["host"] === "string" ? agent["host"] : null;
				const role = typeof agent["role"] === "string" ? agent["role"] : "agent";
				candidates.push({
					id: `agent:${handle}`,
					kind: "agent",
					label: displayName,
					description: `@${handle} · ${role}${host ? ` · ${host}` : ""}`,
					href: `/agents?agent=${encodeURIComponent(handle)}`,
					keywords: [handle, role, host ?? "", formatUnknown(agent["capabilities"] ?? "")],
					meta: agent["active"] === 0 ? "inactive" : "resident",
				});
			}
		}
		if (Exit.isSuccess(tasks)) {
			for (const task of tasks.value) {
				const id = Number(task["id"]);
				const title = formatUnknown(task["title"] ?? "");
				if (!Number.isSafeInteger(id) || id < 1 || !title) continue;
				const status = formatUnknown(task["status"] ?? "unknown");
				const project = typeof task["project_name"] === "string" ? task["project_name"] : null;
				const owner = formatUnknown(
					task["claimed_by"] ?? task["assignee"] ?? task["owner"] ?? "unassigned",
				);
				candidates.push({
					id: `task:${String(id)}`,
					kind: "task",
					label: title,
					description: `/task/${String(id)} · ${status}${project ? ` · ${project}` : ""}`,
					href: `/work?task=${String(id)}`,
					keywords: [String(id), status, project ?? "", owner],
					meta: owner,
				});
			}
		}
		if (Exit.isSuccess(library)) {
			const items = Array.isArray(library.value["items"])
				? (library.value["items"] as Record<string, unknown>[])
				: [];
			for (const item of items) {
				const id = formatUnknown(item["id"] ?? "");
				const title = formatUnknown(item["title"] ?? "");
				if (!id || !title) continue;
				const kind = formatUnknown(item["kind"] ?? "item");
				const project = formatUnknown(item["project"] ?? "unfiled");
				candidates.push({
					id: `library:${id}`,
					kind: "library",
					label: title,
					description: `${kind} · ${project}`,
					href: `/library?item=${encodeURIComponent(id)}`,
					keywords: [id, kind, project, formatUnknown(item["status"] ?? "")],
					meta: formatUnknown(item["status"] ?? ""),
				});
			}
		}
		if (Exit.isSuccess(hosts)) {
			for (const host of hosts.value.items) {
				const hostname = formatUnknown(host["hostname"] ?? host["box_id"] ?? host["subject"] ?? "");
				if (!hostname) continue;
				const status = formatUnknown(host["status"] ?? "unknown").replaceAll("_", " ");
				candidates.push({
					id: `host:${hostname}`,
					kind: "host",
					label: hostname,
					description: `Host · ${status}`,
					href: `/hosts?host=${encodeURIComponent(hostname)}`,
					keywords: [
						formatUnknown(host["box_id"] ?? ""),
						status,
						formatUnknown(host["os_family"] ?? ""),
					],
					meta: formatUnknown(host["last_checked_at"] ?? host["observed_at"] ?? ""),
				});
			}
		}
		if (Exit.isSuccess(statistics)) {
			for (const statistic of statistics.value) {
				if (statistic.kind !== "statistic") continue;
				candidates.push({
					id: `statistic:${statistic.source_ref}`,
					kind: "statistic",
					label: statistic.source_ref,
					description: statistic.content.slice(0, 120),
					href: `/observability?stat=${encodeURIComponent(statistic.source_ref)}`,
					keywords: [statistic.kind, statistic.content],
					meta: statistic.kind,
				});
			}
		}
		const sourceRanked = ["agent", "task", "library", "host", "statistic"].flatMap((kind) =>
			rankPaletteCandidates(
				text,
				candidates.filter((candidate) => candidate.kind === kind),
				limit,
			),
		);
		return {
			schema_version: 1,
			freshness: { source: "palette", observed_at: new Date().toISOString(), window_s: 0 },
			query: text,
			items: rankPaletteCandidates(text, sourceRanked, limit),
			sources: {
				agents: Exit.isSuccess(agents) && services.tracker ? "live" : "unavailable",
				tasks: Exit.isSuccess(tasks) && services.tracker ? "live" : "unavailable",
				library: Exit.isSuccess(library) ? "live" : "unavailable",
				hosts: Exit.isSuccess(hosts) ? "live" : "unavailable",
				statistics: Exit.isSuccess(statistics) ? "live" : "unavailable",
			},
		};
	});
}
