#!/usr/bin/env bash
# bin/upgrade-guild.sh — Wait for the Publish workflow on HEAD, then upgrade nsg globally.
#
# Steps:
#   1. Find the GitHub Actions "Publish" workflow run for the current HEAD commit.
#      Polls for up to 30s if no run exists yet (the push may have just arrived).
#   2. Stream the run until it completes; fail if the workflow failed.
#   3. Clean npm cache, reinstall @shardworks/nexus-core globally.
#   4. Run `nsg upgrade` in /workspace/shardworks.
#
# Usage:
#   ./bin/publish-wait.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKFLOW_FILE="publish.yml"
UPGRADE_DIR="/workspace/shardworks"
PACKAGE="@shardworks/nexus-core"

# ── 1. Resolve HEAD SHA ────────────────────────────────────────

COMMIT_SHA="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
echo "→ HEAD: $COMMIT_SHA"
echo "→ Looking for a '$WORKFLOW_FILE' run on this commit…"

# ── 2. Poll for the workflow run (up to 30s) ──────────────────

DEADLINE=$(( SECONDS + 30 ))
RUN_ID=""

while [[ $SECONDS -lt $DEADLINE ]]; do
  RUN_ID=$(
    gh run list \
      --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
      --workflow "$WORKFLOW_FILE" \
      --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$COMMIT_SHA\") | .databaseId" \
      2>/dev/null | head -1 || true
  )

  if [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]]; then
    echo "→ Found run: $RUN_ID"
    break
  fi

  echo "  (no run yet — waiting…)"
  sleep 3
done

if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  echo "✗ No publish workflow run found for $COMMIT_SHA after 30s." >&2
  exit 1
fi

# ── 3. Wait for the run to complete ───────────────────────────

echo "→ Waiting for run $RUN_ID to finish…"
# --exit-status: exits non-zero if the run concluded with failure/cancelled
gh run watch "$RUN_ID" --exit-status

echo "✓ Publish workflow succeeded."

# ── 4. Reinstall @shardworks/nexus-core globally ──────────────

echo "→ Cleaning npm cache…"
# npm v5+ uses a content-addressed cache with no per-package clean;
# --force clears the whole cache (safe, just slow on next install of other things).
npm cache clean --force

echo "→ Uninstalling $PACKAGE globally…"
npm uninstall -g "$PACKAGE"

echo "→ Installing $PACKAGE globally…"
npm install -g "$PACKAGE"

nsg --version

# ── 5. Run nsg upgrade in the guild workspace ─────────────────

echo "→ Running 'nsg upgrade' in $UPGRADE_DIR…"
(cd "$UPGRADE_DIR" && nsg upgrade)

echo "✓ Done."
