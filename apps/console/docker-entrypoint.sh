#!/bin/sh
set -e

./node_modules/.bin/effectdb migrate up

exec node build
