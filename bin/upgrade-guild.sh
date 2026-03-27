#!/usr/bin/env bash
# bin/upgrade-guild.sh — Wait for the Publish workflow on HEAD, then upgrade
# the global nsg CLI and run `nsg upgrade` in the guild workspace.
#
# Steps:
#   1. Delegate to bin/wait-for-publish.sh to find and stream the publish.yml
#      run for the current HEAD commit, and capture the published version.
#   2. Reinstall @shardworks/nexus globally at that exact version.
#   3. Run `nsg upgrade` in /workspace/shardworks.
#
# Usage:
#   ./bin/upgrade-guild.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

UPGRADE_DIR="/workspace/shardworks"
PACKAGE="@shardworks/nexus"

# ── 1. Wait for publish pipeline, capture version ─────────────

echo "→ Waiting for publish pipeline…"
VERSION="$("$SCRIPT_DIR/wait-for-publish.sh")"

echo "✓ $PACKAGE published: $VERSION"

# ── 2. Reinstall @shardworks/nexus globally ───────────────────

echo "→ Uninstalling $PACKAGE globally…"
npm uninstall -g "$PACKAGE"

# npm's cache is content-addressed (v5+) and has no per-package clean command.
# --prefer-online forces a fresh registry lookup on the next install, ensuring
# we pull the newly published version rather than any cached resolution.
echo "→ Installing $PACKAGE@$VERSION globally (--prefer-online)…"
INSTALL_ATTEMPTS=5
INSTALL_DELAY=10
for attempt in $(seq 1 $INSTALL_ATTEMPTS); do
  if npm install -g "$PACKAGE@$VERSION" --prefer-online; then
    break
  fi
  if [[ $attempt -lt $INSTALL_ATTEMPTS ]]; then
    echo "  (attempt $attempt failed — retrying in ${INSTALL_DELAY}s…)"
    sleep $INSTALL_DELAY
  else
    echo "✗ Failed to install $PACKAGE@$VERSION after $INSTALL_ATTEMPTS attempts." >&2
    exit 1
  fi
done

nsg --version

# ── 3. Run nsg upgrade in the guild workspace ─────────────────

echo "→ Running 'nsg upgrade' in $UPGRADE_DIR…"
(cd "$UPGRADE_DIR" && nsg upgrade)

echo "✓ Done."
