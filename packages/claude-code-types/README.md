# @petalnet/claude-code-types

Claude Code's mod API declarations (`claude-code`, `claude-code-tools`, `claude-code-mcp`), for the mods in this repository to type-check against. Claude Code writes them beside every mod it loads; they are not published anywhere, so they are generated and committed here, marked `linguist-generated`.

A mod's `tsconfig.json` extends `@petalnet/claude-code-types/tsconfig.mod.json` and includes its `hooks/` directory.

## Regenerate

After a Claude Code update, from this directory:

```sh
pnpm generate
```

`scripts/generate.sh` loads an empty mod in an interactive Claude Code session on a tmux server of its own, which makes the engine write the declarations, copies them into `types/`, and exits the session. It connects no MCP server and refuses the result if any server's tool inputs were written, so no account's tools end up here. The first line of `types/claude-code/index.d.ts` names the Claude Code version that wrote them.
