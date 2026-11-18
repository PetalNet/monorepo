# boot-ping

A Claude Code mod. After a fresh start or a resume, it starts one turn that states the restart happened, so a resumed session does not sit idle until someone messages it. It fires once per process; compactions do not re-fire it. The turn starts 20 seconds after `session.start`.

Load it with `claude --plugin-dir apps/boot-ping`. It type-checks against [`@petalnet/claude-code-types`](../../packages/claude-code-types): `pnpm --filter @petalnet/boot-ping typecheck`.
