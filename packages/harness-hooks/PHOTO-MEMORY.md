# Photo memories

`node src/photo-memory.ts sweep` discovers image files referenced by incoming hub history and the legacy Matrix spool, describes them with a local Ollama vision model, scans the complete metadata note, and stages approved notes for vault collection. It never puts image bytes in the vault. `status` reports pending, staged and refused counts; staged means the note exists locally, not that vault sync has completed.

Configure the worker on the agent host:

- `PHOTO_VISION_URL`: an HTTP endpoint at a literal loopback or private IPv4 address. There is no external provider fallback. The installed model must advertise vision and must not be a cloud model.
- `PHOTO_VISION_MODEL`: the installed local model name.
- `FOLD_SECRET_SCANNER_ARGV`: the shared outbound scanner's JSON argv array. Candidate text goes to stdin; only exit 0 with empty stdout and stderr permits a note.
- `VAULT_SECRET_PROVIDER_ARGV` and optional `VAULT_SECRET_POLICY`: the scanner's private provider configuration.
- `PHOTO_MEMORY_DIR`: queue and notes directory, default `~/.local/share/photo-memory`.
- `PHOTO_MEDIA_ROOTS`: JSON array of source directories. Defaults to the hub media cache and legacy Matrix incoming-media directory.
- `PHOTO_HISTORY`, `PHOTO_LEGACY_SPOOL` and `PHOTO_LEGACY_INDEX`: optional overrides for the metadata sources.

Include the staged `notes/` directory in guarded `vault collect`, with a stable origin such as `photo-memory`, kind `memory`, and tier `agent`. Schedule a repeating sweep after the scanner is configured. Each run processes at most three pending images. Failures use bounded backoff; a scanner refusal stays refused. No automatic cloud fallback or model download occurs.

Notes preserve the file pointer, source event and room when retained, date provenance, description and tags. The existing Matrix search index also resolves legacy filenames to known event IDs; ambiguous filename matches are not used. Old files without a retained source event are explicitly marked unavailable and use the file modification date, not an invented message date. Media caches can expire; the event pointer is the durable way to recover an original. Descriptions are labelled as model-derived observations.

The worker uses Node and SQLite to match the existing host-side harness tools. Tests run a real local HTTP neighbor and scanner subprocess; the real-model proof belongs in the PR. This is a local ingestion command, not a new web service.
