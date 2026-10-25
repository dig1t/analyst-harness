#!/usr/bin/env bash
# Install analyst-harness from this checkout and make it start with every Claude Code session.
#
#   bash scripts/install.sh              install, add the Claude Code hook, start the harness
#   bash scripts/install.sh --no-hook    install without the Claude Code hook
#   bash scripts/install.sh --uninstall  stop it, remove the hook and the harness command
#
# Your data (data/) and settings (.env, config/) are never deleted. See GETTING_STARTED.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HARNESS_BIN_DIR:-$HOME/.local/bin}"
HOOK=1
UNINSTALL=0

usage() { sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
say() { printf '\n==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --no-hook) HOOK=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; fail "unknown option $arg" ;;
  esac
done

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required (https://nodejs.org)"
command -v npm >/dev/null 2>&1 || fail "npm is required (it comes with Node.js)"

if [ "$UNINSTALL" = 1 ]; then
  [ -f "$ROOT/dist/cli.js" ] && "$ROOT/bin/harness" daemon stop || true
  node "$ROOT/scripts/claude-hook.js" uninstall
  if [ -f "$BIN_DIR/harness" ] && grep -q "$ROOT/bin/harness" "$BIN_DIR/harness"; then
    rm -f "$BIN_DIR/harness"
    echo "Removed $BIN_DIR/harness."
  fi
  say "Uninstalled. Your data ($ROOT/data), .env and config are still there; delete the folder to remove everything."
  exit 0
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || fail "Node.js 22 or newer is required (found $(node --version))"

say "Installing dependencies"
(cd "$ROOT" && npm ci --no-audit --no-fund)

say "Building"
(cd "$ROOT" && npm run build)

if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  say "Created $ROOT/.env: put your ANTHROPIC_API_KEY in it (and Discord settings if you want the bot)"
fi

say "Adding the harness command to $BIN_DIR"
mkdir -p "$BIN_DIR"
printf '#!/bin/sh\nexec "%s/bin/harness" "$@"\n' "$ROOT" > "$BIN_DIR/harness"
chmod +x "$BIN_DIR/harness"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to your PATH to use \`harness\` everywhere, for example in ~/.bashrc or ~/.zshrc:"
     echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

if [ "$HOOK" = 1 ]; then
  say "Registering the Claude Code session hook"
  node "$ROOT/scripts/claude-hook.js" install
fi

say "Starting the harness"
"$ROOT/bin/harness" daemon start || echo "It did not start; see \`harness daemon logs\`."

say "Checking the configuration"
"$ROOT/bin/harness" doctor || true

say "Done"
cat <<EOF
analyst-harness is installed at $ROOT and running in the background.
$( [ "$HOOK" = 1 ] && echo "Every new Claude Code session starts it (if it is not already running) and learns how to use it." )
Next: put your ANTHROPIC_API_KEY in $ROOT/.env, then try
  harness run "Summarize the latest Hacker News stories"
  harness explore hn-top-stories        (after \`harness scrape hn-top-stories\`)
Read GETTING_STARTED.md for everything else.
EOF
