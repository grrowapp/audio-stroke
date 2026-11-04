#!/bin/bash
# Builds the Nitro server (if needed), starts it in the MOCK configuration (no .env, throw-away
# DATA_DIR) on a free port other than 8000, runs the headless integration test, cleans up.
# Needs: node/npm with the repo's node_modules installed, and `flutter` on PATH.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
[ -f "$REPO/.output/server/index.mjs" ] || (cd "$REPO" && npm run build)
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
[ "$PORT" != "8000" ] || { echo "got port 8000, retry"; exit 1; }
DATA="$(mktemp -d)"
PID=""
cleanup() { if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi; rm -rf "$DATA"; }
trap cleanup EXIT
# exec: $! is then node itself (not the subshell), so the cleanup kill really stops it.
# env -i: nothing from the caller's environment (API keys, .env) leaks into the mock server
(cd "$REPO" && exec env -i PATH="$PATH" HOME="$DATA" DATA_DIR="$DATA" PORT="$PORT" HOST=127.0.0.1 NITRO_PORT="$PORT" NITRO_HOST=127.0.0.1 node .output/server/index.mjs >"$DATA/server.log" 2>&1) &
PID=$!
for _ in $(seq 1 100); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null || { cat "$DATA/server.log"; exit 1; }
cd "$HERE"
AUDIO_STROKE_SERVER="http://127.0.0.1:$PORT" flutter test test/integration
