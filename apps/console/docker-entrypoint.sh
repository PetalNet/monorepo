#!/bin/sh
set -e

# Apply pending schema migrations against the live DATABASE_URL (creates the three
# hardened roles + RLS on first boot), then hand off to the unified SvelteKit
# server (HTTP + /api/v1 + MCP + crossws bus on $PORT).
#
# `migrate` is the package.json script `effectdb migrate up`; the effect-db CLI is
# a production dependency, so its bin is present in the pruned runtime.
./node_modules/.bin/effectdb migrate up

exec node build
