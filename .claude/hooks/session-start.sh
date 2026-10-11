#!/bin/bash
# Cloud sessions start on the image's Node 22; scriba runs on Node 24 (mise.toml, the
# Dockerfile and CI pin it). Install the same exact patch CI uses, put it first on PATH for
# the whole session, and install dependencies so tests and biome work from the first turn.
# npm ci, as CI does: it installs exactly the lockfile and never rewrites it.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Keep in step with the Dockerfile and .github/workflows/*.yml.
NODE_VERSION="24.18.1"

export NVM_DIR="${NVM_DIR:-/opt/nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION" >/dev/null
nvm alias default "$NODE_VERSION" >/dev/null
NODE_BIN="$NVM_DIR/versions/node/v$NODE_VERSION/bin"
export PATH="$NODE_BIN:$PATH"

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE_BIN:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
npm ci --no-audit --no-fund
# npm's allow-scripts gate skips better-sqlite3's native build, and without the addon the
# DB tests self-skip; build it explicitly (see "Local checks" in AGENTS.md).
npm rebuild better-sqlite3
