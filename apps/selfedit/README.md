# selfedit

`selfedit` is the single write path for an agent's memory repository. Each
write is one git commit that records where the change came from. Only a sender
in the owners file can cause a rule.

The caller reports `--sender`, and this version does not check it against the
Matrix event. A forged sender is recorded in the commit, not prevented, so the
rule gate is only as strong as the caller that sets `--sender`.

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
exactly one `type` of `project`, `reference` or `user`, either as a top-level
key or under `metadata`. A comment or the text of another value does not count.
The command reads only `key: value` lines and one level of nested keys, each
value on one line. It refuses an untrusted note that uses any other syntax, such
as quoted keys, flow collections, block scalars, tags or continuation lines. It
also refuses a note without frontmatter, an overwrite of a note that is already
a rule, and any write to `MEMORY.md`.

The command refuses a note that has uncommitted changes, and one write at a
time holds `.git/selfedit.lock`. Git runs without repository hooks or `GIT_*`
environment variables. The command builds the commit from the exact bytes on
stdin, so `core.autocrlf`, `.gitattributes` and filters do not change them. It
checks that the commit holds only the requested file, content and trailers
before HEAD moves. If any later step fails, HEAD and the note return to their
state before the write.

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
