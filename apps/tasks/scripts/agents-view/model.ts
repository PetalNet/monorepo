// Adapted from Claude Code agents-view hooks, 291069fa-3ac4-4e01-939f-5d8782460da4.
export type Status = "running" | "done" | "failed" | "fell back" | "unknown";
export interface Attempt {
	number: number;
	model: string;
	effort: string;
	plan: string;
	pool: string;
	startedAt: number;
	endedAt: number | null;
	exitCode: number | null;
	failureClass: string;
	handoff: boolean;
}

export interface Agent {
	id: string;
	source: "router" | "claude" | "legacy";
	name: string;
	status: Status;
	statusNote: string;
	model: string;
	effort: string;
	plan: string;
	kind: string;
	tier: string;
	startedAt: number;
	endedAt: number | null;
	updatedAt: number;
	attempts: Attempt[];
	brief: string;
	briefPath: string;
	cwd: string;
	branch: string;
	outputPath: string;
	logPath: string;
	eventsPath: string;
	links: string[];
	tokens: number | null;
	indexed: boolean;
	imported: boolean;
}

export function agent(id: string, source: Agent["source"]): Agent {
	return {
		id,
		source,
		name: id.split("/").at(-1) ?? id,
		status: "unknown",
		statusNote: "Reading activity",
		model: "unknown",
		effort: "not recorded",
		plan: source === "claude" ? "Claude" : "not recorded",
		kind: source,
		tier: "",
		startedAt: 0,
		endedAt: null,
		updatedAt: 0,
		attempts: [],
		brief: "",
		briefPath: "",
		cwd: "",
		branch: "",
		outputPath: "",
		logPath: "",
		eventsPath: "",
		links: [],
		tokens: null,
		indexed: false,
		imported: false,
	};
}

export interface Turn {
	id: string;
	kind: "assistant" | "user" | "tool" | "event";
	name: string;
	text: string;
	result: string;
	resultBytes: number | null;
	status: "running" | "done" | "failed";
	at: number;
}

export function sortedAgents(agents: Iterable<Agent>): Agent[] {
	return [...agents].toSorted(
		(a, b) =>
			Number(b.status === "running") - Number(a.status === "running") ||
			b.startedAt - a.startedAt ||
			a.id.localeCompare(b.id),
	);
}
