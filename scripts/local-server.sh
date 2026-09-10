#!/usr/bin/env bash
# macOS session service: independent of the terminal/agent that starts it.
set -euo pipefail
cd "$(dirname "$0")/.."
project_path="$(pwd -P)"
service_label="local.lanka-studio.web"
service_url="http://127.0.0.1:4317/"
service_logs="$project_path/work/local-server"
service_plist="$HOME/Library/LaunchAgents/$service_label.plist"
service_domain="gui/$(id -u)"
restart_service=false
case "${1:-start}" in
  stop)
    node scripts/install-local-service.mjs --remove
    launchctl bootout "$service_domain/$service_label" 2>/dev/null || launchctl remove "$service_label" 2>/dev/null || true
    echo "Lanka stopped. Documents remain in work/local-library."
    exit 0
    ;;
  status)
    launchctl list "$service_label"
    curl --fail --silent --show-error --output /dev/null --write-out 'HTTP %{http_code}\n' "$service_url"
    exit 0
    ;;
  restart)
    restart_service=true
    ;;
  start) ;;
  *) echo "Usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac
if [[ "$restart_service" == false ]] && launchctl list "$service_label" >/dev/null 2>&1; then
  curl --fail --silent --show-error --output /dev/null "$service_url"
  echo "Lanka is already running: $service_url"
  exit 0
fi
if [[ ! -d node_modules ]]; then npm ci; fi
if [[ -f work/agent-chat/config.json ]]; then node scripts/setup-local-chat.mjs; fi
npm run build:mcp
mkdir -p "$service_logs" "$project_path/work/local-library"
node scripts/install-local-service.mjs
if [[ "$restart_service" == true ]]; then
  launchctl remove "$service_label" 2>/dev/null || true
  for ((attempt=0; attempt<50; attempt++)); do
    if ! launchctl list "$service_label" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  if launchctl list "$service_label" >/dev/null 2>&1; then
    echo "The previous Lanka process has not stopped yet. Retry restart." >&2
    exit 1
  fi
fi
launchctl bootstrap "$service_domain" "$service_plist"
curl --fail --retry 10 --retry-connrefused --retry-delay 1 --silent --show-error \
  --output /dev/null "$service_url"
echo "Lanka is running: $service_url"
echo "Logs: $service_logs"
