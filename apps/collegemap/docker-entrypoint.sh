#!/bin/sh
set -e

npx drizzle-kit push --force
exec node build/index.js
