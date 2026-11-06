# selfedit

`selfedit` is the single write path for an agent's memory repository. Each
write is one git commit that records where the change came from. Only an owner
can cause a rule.

## Usage

```sh
selfedit write <note.md> --event <event-id> --sender <mxid> [--repo <dir>] < content
```

The command reads the note content on stdin and writes it to `<repo>/<note.md>`.
It commits only that file, with these trailers:

```text
Selfedit-Event: <event-id>
Selfedit-Sender: <mxid>
Selfedit-Trust: owner | untrusted
```

A sender is an owner when its Matrix ID is a line in the owners file. The
owners file is `~/.config/selfedit/owners`, or the path in `SELFEDIT_OWNERS`. A
missing owners file means no sender is an owner.

An untrusted sender can write a note only when its frontmatter declares
`type: project`, `type: reference` or `type: user`. The command refuses any
other note from an untrusted sender, including a note without frontmatter, an
overwrite of a note that is already a rule, and any write to `MEMORY.md`.

The command refuses a note that has uncommitted changes, and one write at a
time holds `.git/selfedit.lock`. Git runs without repository hooks or `GIT_*`
environment variables, and the command checks that the new commit holds exactly
the requested file, content and trailers.

The default repository is the Claude Code memory directory for the current
user, `~/.claude/projects/<home path with dashes>/memory`.

## Exit codes

- `0` prints the new commit SHA, or `unchanged` when the content is the same.
- `1` refuses the write. The note and the repository do not change.
- `2` rejects the arguments, or reports a git failure.

## Requirements

Node.js 22.18 or later runs `src/selfedit.ts` directly.

## Tests

```sh
pnpm --filter @petalnet/selfedit test
```
