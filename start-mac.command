#!/bin/bash
# Mukana → mimoLive Sync: double-click in Finder to start the service in a Terminal window.
# Close the window or press Ctrl+C to stop it.

cd "$(dirname "$0")" || exit 1
# Find Node even if the shell profile has not set up the PATH.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js was not found. Run the installer first:"
  echo "  curl -fsSL https://raw.githubusercontent.com/Media-Event-AS/mukana-mimolive-sync/main/install-mac.sh | bash"
  echo
  read -r -p "Press Return to close." _
  exit 1
fi

PORT="${PORT:-$(node -p "try{require('./data/config.json').server.port||8790}catch{8790}" 2>/dev/null || echo 8790)}"
echo "Starting Mukana → mimoLive Sync. Web UI: http://localhost:$PORT"
(sleep 2 && open "http://localhost:$PORT") &
exec node src/server.js
