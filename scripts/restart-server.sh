#!/bin/bash
# Restart the H3Mise server cleanly (kills both tsx wrapper and node child).
set -u
cd "$(dirname "$0")/.."
for p in $(ps -eo pid,cmd | grep -E "tsx/dist/cli.mjs src/index.ts|tsx/dist/preflight.cjs .*src/index.ts" | grep -v grep | awk '{print $1}'); do
  kill -9 "$p" 2>/dev/null
done
sleep 1
MODE="${H3MISE_PROVIDER:-runninghub}"
(setsid nohup env H3MISE_PROVIDER="$MODE" H3MISE_HOME="$(pwd)/.h3mise-home" PORT=4789 \
  pnpm --filter @h3mise/server start > .h3mise-server.log 2>&1 &)
sleep 6
curl -s -m 3 http://127.0.0.1:4789/api/health | grep -o '"ok":true' && echo "server up (provider=$MODE)"
