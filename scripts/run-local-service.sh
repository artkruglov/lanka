#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
service_node="$1"
if [[ -f work/agent-chat/config.json ]]; then "$service_node" scripts/setup-local-chat.mjs; fi
exec "$service_node" .project-runtime/web.mjs --workspace "$PWD/work/local-library" --port 4317
