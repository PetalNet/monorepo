#!/bin/sh
set -e

node docker/migrate.ts
exec node build/index.js
