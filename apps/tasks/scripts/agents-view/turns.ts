// Adapted from Claude Code agents-view hooks, 291069fa-3ac4-4e01-939f-5d8782460da4.
import type { Agent, Turn } from "./model.ts";
import {
	body,
	byteSize,
	content,
	json,
	number,
	prLinks,
	record,
	short,
	string,
	time,
} from "./safe.ts";

export class Turns {
	readonly rows: Turn[] = [];
	readonly byId = new Map<string, Turn>();
	readonly usage = new Map<string, number>();
	private readonly fragments = new Map<string, string>();
	malformed = 0;
	private sequence = 0;
	private codexTurn = 0;
	private codexThread = 0;
	readonly run: Agent;
	readonly keepRows: boolean;
	constructor(run: Agent, keepRows = true) {
		this.run = run;
		this.keepRows = keepRows;
	}

	private put(turn: Turn): void {
		this.run.links = [
			...new Set([...this.run.links, ...prLinks(turn.text), ...prLinks(turn.result)]),
		];

		if (!this.keepRows) {
			return;
		}

		const previous = this.byId.get(turn.id);
		const safe = {
			...turn,
			id: short(turn.id, 1024),
			name: short(turn.name, 1024),
			text: body(turn.text),
			result: body(turn.result),
		};

		if (previous) {
			Object.assign(previous, safe);
		} else {
			this.rows.push(safe);
			this.byId.set(turn.id, safe);
		}
	}

	private tokens(key: string, value: unknown, cumulative = false): void {
		const u = record(value);

		if (Object.keys(u).length === 0) {
			return;
		}

		const total =
			number(u.total_tokens) ??
			(number(u.input_tokens) ?? 0) +
				(number(u.output_tokens) ?? 0) +
				(number(u.cache_creation_input_tokens) ?? 0) +
				(number(u.cache_read_input_tokens) ?? 0);

		if (cumulative) {
			this.usage.clear();
		}

		this.usage.set(key, total);
		this.run.tokens = [...this.usage.values()].reduce((a, b) => a + b, 0);
	}

	ingest(line: string): void {
		const e = json(line);

		if (!e) {
			if (line.trim()) {
				this.malformed++;
			}

			return;
		}

		this.sequence++;
		const at = time(e.timestamp) || time(e.at);

		if (at) {
			if (!this.run.startedAt || at < this.run.startedAt) {
				this.run.startedAt = at;
			}

			this.run.updatedAt = Math.max(this.run.updatedAt, at);
		}

		if (string(e.cwd)) {
			this.run.cwd = string(e.cwd);
		}

		if (string(e.gitBranch)) {
			this.run.branch = short(string(e.gitBranch), 1024);
		}

		if (string(e.effort) || string(e.perTurnEffort)) {
			this.run.effort = short(string(e.perTurnEffort) || string(e.effort), 1024);
		}

		const type = string(e.type);

		if (type === "thread.started") {
			this.codexThread++;
		} else if (type.startsWith("item.")) {
			this.codex(e, at);
		} else if (type === "turn.started") {
			this.codexTurn++;
			this.activity();
		} else if (type === "turn.completed") {
			this.tokens(`codex:${this.codexTurn}`, e.usage);
			this.finish(false, at);
		} else if (type === "turn.failed" || type === "error") {
			const error = content(e.error) || string(e.message);

			this.put({
				id: `error:${this.sequence}`,
				kind: "event",
				name: "Error",
				text: error,
				result: "",
				resultBytes: null,
				status: "failed",
				at,
			});

			this.finish(true, at);
		} else if (e.event === "step_update" || e.event === "init" || e.event === "result") {
			this.agy(e, at);
		} else if (type === "assistant" || type === "user") {
			this.claude(e, at);
		} else if (type === "api-request") {
			const params = record(e.params);

			if (string(params.model)) {
				this.run.model = short(string(params.model), 1024);
			}

			const effort = string(record(params.output_config).effort);

			if (effort) {
				this.run.effort = short(effort, 1024);
			}

			this.activity();
		} else if (type === "system" && (e.subtype === "turn_duration" || e.subtype === "stop")) {
			this.finish(false, at);
		} else if (type === "result") {
			this.finish(e.is_error === true, at);
		}

		this.run.indexed = true;
	}

	private activity(): void {
		if (this.run.source !== "router") {
			this.run.status = "running";
			this.run.statusNote = "Transcript activity";
			this.run.endedAt = null;
		}
	}
	private finish(failed: boolean, at: number): void {
		// Router outcomes own run status; a failed attempt stream must not end its fallback.
		if (this.run.source !== "router") {
			this.run.status = failed ? "failed" : "done";
			this.run.statusNote = failed ? "Transcript reports failure" : "Final turn recorded";
			this.run.endedAt = at || this.run.updatedAt || null;
		}
	}

	private codex(e: Record<string, unknown>, at: number): void {
		const item = record(e.item);
		const type = string(item.type);
		const id = `codex:${this.codexThread}:${string(item.id) || this.sequence}`;
		const status =
			e.type === "item.completed"
				? item.status === "failed" || (number(item.exit_code) !== null && item.exit_code !== 0)
					? "failed"
					: "done"
				: "running";

		if (type === "agent_message") {
			this.put({
				id,
				kind: "assistant",
				name: "Assistant",
				text: string(item.text),
				result: "",
				resultBytes: null,
				status,
				at,
			});
		} else if (
			[
				"command_execution",
				"mcp_tool_call",
				"web_search",
				"file_change",
				"collab_tool_call",
				"tool_call",
			].includes(type)
		) {
			const name =
				type === "command_execution" ? "Command" : string(item.tool) || string(item.name) || type;
			const args =
				string(item.command) ||
				string(item.query) ||
				content(item.arguments ?? item.changes ?? item.input);
			const result =
				string(item.aggregated_output) || content(item.result ?? item.error ?? item.output);
			const exit = number(item.exit_code);

			this.put({
				id,
				kind: "tool",
				name,
				text: args,
				result: result + (exit === null ? "" : `\nExit ${exit}`),
				resultBytes: byteSize(result),
				status,
				at,
			});
		} else if (type !== "reasoning") {
			this.put({
				id,
				kind: "event",
				name: type || "Event",
				text: content(item.text ?? item.items ?? item),
				result: "",
				resultBytes: null,
				status,
				at,
			});
		}
	}

	private claude(e: Record<string, unknown>, at: number): void {
		const message = record(e.message);

		if (string(message.model)) {
			this.run.model = short(string(message.model), 1024);
		}

		const messageId = string(message.id) || string(e.uuid) || `message:${this.sequence}`;

		this.tokens(messageId, message.usage);
		this.activity();

		const blocks = Array.isArray(message.content)
			? message.content
			: [{ type: "text", text: string(message.content) }];

		blocks.forEach((raw, index) => {
			const block = record(raw);
			const id = `claude:${string(e.uuid) || messageId}:${index}`;

			if (block.type === "text") {
				const text = string(block.text);

				if (e.type === "user" && !this.run.brief) {
					this.run.brief = body(text, 4000);
				}

				if (text) {
					this.put({
						id,
						kind: e.type === "user" ? "user" : "assistant",
						name: e.type === "user" ? "User" : "Assistant",
						text,
						result: "",
						resultBytes: null,
						status: "done",
						at,
					});
				}
			} else if (block.type === "tool_use") {
				this.put({
					id: `tool:${string(block.id) || id}`,
					kind: "tool",
					name: string(block.name),
					text: content(block.input),
					result: "",
					resultBytes: null,
					status: "running",
					at,
				});
			} else if (block.type === "tool_result") {
				const key = `tool:${string(block.tool_use_id)}`;
				const call = this.byId.get(key);
				const result = content(block.content);

				this.put({
					id: key,
					kind: "tool",
					name: call?.name ?? "Tool result",
					text: call?.text ?? "",
					result,
					resultBytes: byteSize(result),
					status: block.is_error === true ? "failed" : "done",
					at: call?.at ?? at,
				});
			}
		});

		if (message.stop_reason === "max_tokens" || e.isApiErrorMessage === true) {
			this.finish(true, at);
		} else if (message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence") {
			this.finish(false, at);
		}
	}

	private agy(e: Record<string, unknown>, at: number): void {
		if (e.event === "init") {
			const init = record(e.init);

			if (string(init.cwd)) {
				this.run.cwd = string(init.cwd);
			}

			if (string(init.model)) {
				this.run.model = short(string(init.model), 1024);
			}

			return;
		}

		if (e.event === "result") {
			const result = record(e.result);

			this.tokens("agy:total", result.usage, true);
			this.finish(result.status === "ERROR", at);

			if (result.status === "ERROR") {
				this.put({
					id: `agy:error:${this.sequence}`,
					kind: "event",
					name: "Error",
					text: content(result.error),
					result: "",
					resultBytes: null,
					status: "failed",
					at,
				});
			}

			return;
		}

		const step = record(e.step_update);
		const id = `agy:${string(step.conversation_id)}:${number(step.step_index) ?? this.sequence}`;
		const done = step.state === "DONE";
		const tool = record(step.tool_info);
		const status = tool.error ? "failed" : done ? "done" : "running";

		this.activity();

		if (step.step_type === "agent_response" || step.step_type === "user_input") {
			const combined = (this.fragments.get(id) ?? "") + string(step.text_delta);

			this.fragments.set(id, combined);
			const text = done ? combined : combined.replace(/\S+$/, "");

			this.put({
				id,
				kind: step.step_type === "agent_response" ? "assistant" : "user",
				name: step.step_type === "agent_response" ? "Assistant" : "User",
				text,
				result: "",
				resultBytes: null,
				status,
				at,
			});

			if (done) {
				this.fragments.delete(id);
			}
		} else if (step.step_type === "tool") {
			const result = content(tool.output ?? tool.error);
			const previous = this.byId.get(id);

			this.put({
				id,
				kind: "tool",
				name: string(step.tool_name) || string(tool.name) || previous?.name || "Tool",
				text: content(tool.parameters ?? step.subagent_info) || previous?.text || "",
				result,
				resultBytes: byteSize(result),
				status,
				at,
			});
		} else if (step.step_type !== "checkpoint") {
			this.put({
				id,
				kind: "event",
				name: string(step.step_type) || "Step",
				text: content(step.subagent_info),
				result: "",
				resultBytes: null,
				status,
				at,
			});
		}

		this.tokens(id, step.usage);
	}
}
