export const testAdapter = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (["--version", "debug"].includes(args[0])) process.exit(1);
if (process.env.MARKER) fs.writeFileSync(process.env.MARKER, process.env.ROUTE_DEPTH);
const input = fs.readFileSync(0, "utf8");
const text = (process.env.MARKER ? "" : args.join("\n") + "\n") + input;
const emit = (row) => console.log(JSON.stringify(row));
if (path.basename(process.argv[1]) === "codex") {
  emit({ type: "thread.started", thread_id: "codex-id", model: "gpt-observed" });
  emit({ type: "item.completed", item: { type: "agent_message", text } });
  emit({ type: "turn.completed", usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 4 } });
} else {
  emit({ event: "result", result: { conversation_id: "agy-id", response: text, usage: { input_tokens: 40, cache_read_tokens: 10, thinking_tokens: 4, output_tokens: 20, total_tokens: 60 } } });
}
`;
