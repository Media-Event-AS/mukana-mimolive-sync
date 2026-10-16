#!/bin/bash
# Mukana → mimoLive Sync: installer for macOS.
#
# Works on a fresh Mac with no Homebrew, Node.js or Git. It:
#   1. installs Node.js LTS from nodejs.org if Node 18.17+ is missing (asks for your Mac password),
#   2. makes sure `node` and `npm` are on the PATH in new Terminal windows,
#   3. downloads or updates the app in ~/mukana-mimolive-sync (your settings in data/ are kept),
#   4. verifies everything and optionally starts the service.
#
# Run it in Terminal:
#   curl -fsSL https://raw.githubusercontent.com/Media-Event-AS/mukana-mimolive-sync/main/install-mac.sh | bash
# or, from an existing copy of the repo:
#   bash install-mac.sh
#
# Safe to run again: it updates the app and skips steps that are already done.
# Env: MUKANA_DIR overrides the install folder.

set -euo pipefail

REPO="Media-Event-AS/mukana-mimolive-sync"
NODE_LINE="latest-v24.x"   # Node.js LTS line downloaded when Node is missing
MIN_MAJOR=18
MIN_MINOR=17

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n  \033[31m✘ %s\033[0m\n\n' "$*" >&2; exit 1; }

# Prompts read from the keyboard even when the script is piped from curl.
# Without a keyboard (no Terminal) it answers "n".
ask() {
  local answer=""
  { read -r -p "  $1 " answer < /dev/tty; } 2>/dev/null || answer="n"
  printf '%s' "$answer"
}

[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. On Linux/Windows install Node.js 18.17+ and see README.md."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- 1. Node.js
bold "1/4  Node.js"

node_ok() {  # $1 = path to node binary
  local v major minor
  v="$("$1" -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  [ "$major" -gt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ]; }
}

# Look on the PATH first, then where Homebrew and the nodejs.org installer put it.
NODE=""
for candidate in "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /opt/homebrew/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && node_ok "$candidate"; then NODE="$candidate"; break; fi
done

if [ -n "$NODE" ]; then
  ok "Node.js $("$NODE" -v) found at $NODE"
else
  if command -v node >/dev/null 2>&1; then
    info "Node.js $(node -v) is too old (need $MIN_MAJOR.$MIN_MINOR or newer)."
  else
    info "Node.js is not installed."
  fi
  info "Downloading the official Node.js LTS installer from nodejs.org…"
  curl -fsSL "https://nodejs.org/dist/$NODE_LINE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" \
    || fail "Could not reach nodejs.org. Check the internet connection and try again."
  PKG="$(awk '$2 ~ /^node-v[0-9.]+\.pkg$/ {print $2; exit}' "$TMP/SHASUMS256.txt")"
  SUM="$(awk '$2 ~ /^node-v[0-9.]+\.pkg$/ {print $1; exit}' "$TMP/SHASUMS256.txt")"
  [ -n "$PKG" ] || fail "Could not find the Node.js installer on nodejs.org."
  curl -fL --progress-bar "https://nodejs.org/dist/$NODE_LINE/$PKG" -o "$TMP/$PKG" || fail "Download of $PKG failed."
  echo "$SUM  $TMP/$PKG" | shasum -a 256 -c - >/dev/null 2>&1 || fail "Checksum mismatch for $PKG. Not installing."
  ok "Downloaded and verified $PKG"
  info "Installing Node.js. macOS will ask for YOUR Mac login password (nothing is shown while you type)."
  sudo installer -pkg "$TMP/$PKG" -target / || fail "Node.js installation failed or was cancelled."
  NODE=/usr/local/bin/node
  node_ok "$NODE" || fail "Node.js was installed but $NODE does not run."
  ok "Installed Node.js $("$NODE" -v) in /usr/local/bin"
fi

# ---------------------------------------------------------------- 2. PATH
bold "2/4  PATH (so 'node' and 'npm' work in Terminal)"

NODE_DIR="$(cd "$(dirname "$NODE")" && pwd)"
case "$(basename "${SHELL:-/bin/zsh}")" in
  bash) PROFILE="$HOME/.bash_profile" ;;
  *)    PROFILE="$HOME/.zprofile" ;;
esac

# Does a brand-new Terminal window find a good node and npm?
login_ok() {
  local n
  n="$("${SHELL:-/bin/zsh}" -l -c 'command -v node' 2>/dev/null)" || return 1
  [ -n "$n" ] && node_ok "$n" && "${SHELL:-/bin/zsh}" -l -c 'command -v npm' >/dev/null 2>&1
}

if login_ok; then
  ok "New Terminal windows find node and npm in $NODE_DIR"
else
  if [ "$NODE_DIR" = "/opt/homebrew/bin" ]; then
    LINE='eval "$(/opt/homebrew/bin/brew shellenv)"'
  else
    LINE="export PATH=\"$NODE_DIR:\$PATH\""
  fi
  if ! grep -qsF "$LINE" "$PROFILE"; then
    printf '\n# Added by mukana-mimolive-sync installer\n%s\n' "$LINE" >> "$PROFILE"
    ok "Added $NODE_DIR to PATH in $PROFILE"
  fi
  login_ok \
    || fail "node/npm are still not found by a new Terminal. Check $PROFILE, or send this output to ronny@mediaevent.no."
  ok "Verified: new Terminal windows find node and npm"
fi
export PATH="$NODE_DIR:$PATH"

# ---------------------------------------------------------------- 3. App
bold "3/4  App"

is_app_dir() { [ -f "$1/package.json" ] && grep -q '"name": "mukana-mimolive-sync"' "$1/package.json"; }

# Running from inside a copy of the repo? Then install there.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -z "${MUKANA_DIR:-}" ] && [ -n "$SELF_DIR" ] && is_app_dir "$SELF_DIR"; then
  APP_DIR="$SELF_DIR"
else
  APP_DIR="${MUKANA_DIR:-$HOME/mukana-mimolive-sync}"
fi

if [ -d "$APP_DIR/.git" ] && git -C "$APP_DIR" rev-parse >/dev/null 2>&1; then
  info "Updating Git checkout in $APP_DIR…"
  git -C "$APP_DIR" pull --ff-only || fail "git pull failed in $APP_DIR (local changes?). Fix that and run again."
  ok "Up to date: $APP_DIR"
elif [ -n "$SELF_DIR" ] && [ "$APP_DIR" = "$SELF_DIR" ]; then
  ok "Using this copy: $APP_DIR"
else
  if [ -e "$APP_DIR" ] && ! is_app_dir "$APP_DIR"; then
    fail "$APP_DIR exists and is not this app. Move it away, or set MUKANA_DIR to another folder."
  fi
  info "Downloading the latest version from github.com/$REPO…"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" -o "$TMP/app.tar.gz" \
    || fail "Could not download the app from GitHub."
  mkdir "$TMP/app"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP/app" --strip-components 1
  is_app_dir "$TMP/app" || fail "The download does not look like the app."
  # Keep settings (refresh token, mapping) from an earlier install.
  if [ -d "$APP_DIR/data" ]; then mv "$APP_DIR/data" "$TMP/app/data"; fi
  rm -rf "$APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  mv "$TMP/app" "$APP_DIR"
  ok "Installed in $APP_DIR"
fi
chmod +x "$APP_DIR/start-mac.command" 2>/dev/null || true

# ---------------------------------------------------------------- 4. Verify
bold "4/4  Verify"

ok "node $(node -v), npm $(npm -v)"
(cd "$APP_DIR" && node --check src/server.js) || fail "The app files look broken. Run the installer again."
ok "App files OK ($(node -p "require('$APP_DIR/package.json').version"))"

PORT="$(cd "$APP_DIR" && node -p "try{require('./data/config.json').server.port||8790}catch{8790}" 2>/dev/null || echo 8790)"

bold "Done!"
cat <<EOF
  To start the service, either
    • double-click  start-mac.command  in $APP_DIR  (Finder), or
    • in a NEW Terminal window:  cd "$APP_DIR" && npm start

  Then open  http://localhost:$PORT  in a browser. Stop with Ctrl+C.
  In the web UI, section 5 · Service, "Start at login" runs it in the background.

  To update later, run this installer again.

EOF

case "$(ask "Start the service now? [Y/n]")" in
  [nN]*) ;;
  *) cd "$APP_DIR" && exec ./start-mac.command ;;
esac
