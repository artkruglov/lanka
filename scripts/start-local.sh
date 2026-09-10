#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project_path="$(pwd -P)"
if [[ ! -d node_modules ]]; then npm ci; fi
if [[ -f work/agent-chat/config.json ]]; then node scripts/setup-local-chat.mjs; fi
npm run build:mcp
mkdir -p "$project_path/work/local-library"
exec node .project-runtime/web.mjs --workspace "$project_path/work/local-library" --port "${PORT:-4317}"
