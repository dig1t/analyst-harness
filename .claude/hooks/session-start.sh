#!/bin/bash
# Claude Code SessionStart hook for this repository. Installs dependencies and builds when they
# are missing or stale (cloud sessions start from a fresh clone), keeps analyst-harness running
# in the background and tells the session how to use it. It runs synchronously, so the session
# starts once the harness is ready. See GETTING_STARTED.md.
set -euo pipefail
exec node "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}/scripts/claude-session-start.js"
