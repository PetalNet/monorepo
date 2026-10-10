# Prune release-age exceptions

This composite action removes exact-version entries from `minimumReleaseAgeExclude`
when their registry publish timestamps satisfy `minimumReleaseAge` in the workspace
file. An omitted age uses pnpm ≥11's default of 1440 minutes, independently of
Renovate's minimum release age. The action reads only the workspace file's policy;
it does not read global pnpm settings, environment overrides, or `.npmrc`.

Every exception must specify an exact version, such as `vite@8.3.3` or
`@sveltejs/kit@3.0.1`. Package-wide exceptions, name patterns, version ranges, tags,
and version lists fail the action with a request to use exact versions. The entire
list is validated before any registry requests or file edits.

Entries whose registry request fails or whose publish time is missing or invalid
are kept. Publish times must be canonical ISO UTC timestamps with milliseconds,
such as `2026-10-09T12:00:00.000Z`. Comments on retained entries survive the YAML
rewrite. An unchanged file is not rewritten; an emptied list is kept as `[]`.

## Usage

Check out the repository before invoking the action. The runner needs Bash, npm,
and Node ≥22 (available on GitHub's Ubuntu runners). The action installs its own
locked dependencies without installing the monorepo's dependencies or running
dependency lifecycle scripts.

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  with:
    persist-credentials: false
- uses: ./.github/actions/prune-release-age-excludes
  id: prune
```

The `workspace-file` input defaults to `pnpm-workspace.yaml`, relative to the
caller's working directory. The `registry` input defaults to
`https://registry.npmjs.org/`. All timestamps are fetched from that registry;
scoped registry mappings and registry authentication are not supported. Use this
action only with exceptions belonging to the supplied registry.

The action edits the local file only. A calling workflow can run it on a schedule
and commit or propose the result when `steps.prune.outputs.changed == 'true'`.
`steps.prune.outputs.removed` is a JSON array of removed entries in their original
order. The action requires no GitHub write permissions and does not create a PR.

## Tests

```sh
npm ci --prefix .github/actions/prune-release-age-excludes --ignore-scripts
npm test --prefix .github/actions/prune-release-age-excludes
```

The tests run the script against a local registry fixture with a fixed clock,
including both sides of the release-age boundary, scoped prereleases, retained
exceptions, missing metadata, invalid configuration, and GitHub outputs.
