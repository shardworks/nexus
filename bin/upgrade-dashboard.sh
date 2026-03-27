#!/usr/bin/env bash
# bin/upgrade-dashboard.sh — Wait for the guild-monitor publish pipeline, bump
# the @shardworks/guild-monitor dependency in packages/cli, commit+push, then
# invoke upgrade-guild.sh to wait for nexus's own publish pipeline.
#
# Steps:
#   1. Delegate to guild-monitor/bin/wait-for-publish.sh — polls for the
#      publish.yml run on guild-monitor HEAD, streams it to completion, and
#      returns the published version string.
#   2. Update @shardworks/guild-monitor in packages/cli/package.json to the
#      exact published version.
#   3. Regenerate the pnpm lock file (pnpm install at repo root).
#   4. Commit and push the version bump.
#   5. Invoke upgrade-guild.sh, which waits for nexus's own publish pipeline
#      and then upgrades the live guild workspace.
#
# Usage:
#   ./bin/upgrade-dashboard.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GUILD_MONITOR_DIR="/workspace/guild-monitor"
CLI_PKG_JSON="$PROJECT_ROOT/packages/cli/package.json"
PACKAGE="@shardworks/guild-monitor"

# ── 1. Wait for guild-monitor publish pipeline ────────────────

echo "→ Waiting for guild-monitor publish pipeline…"
VERSION="$("$GUILD_MONITOR_DIR/bin/wait-for-publish.sh")"

echo "✓ $PACKAGE published: $VERSION"

# ── 2. Update dependency in packages/cli/package.json ─────────

echo "→ Updating $PACKAGE → $VERSION in packages/cli/package.json…"
node -e "
  const fs = require('fs');
  const path = require('path');
  const pkgPath = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['$PACKAGE'] = '$VERSION';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
" "$CLI_PKG_JSON"

# ── 3. Regenerate the pnpm lock file ──────────────────────────

echo "→ Running pnpm install to update lock file…"
(cd "$PROJECT_ROOT" && pnpm install)

# ── 4. Commit and push ────────────────────────────────────────

echo "→ Committing version bump…"
git -C "$PROJECT_ROOT" add packages/cli/package.json pnpm-lock.yaml
if git -C "$PROJECT_ROOT" diff --cached --quiet; then
  echo "  (nothing to commit — $PACKAGE was already at $VERSION)"
else
  git -C "$PROJECT_ROOT" commit -m "chore: bump $PACKAGE to $VERSION"
fi

# Always push — there may be unpushed commits even if nothing new to commit
UNPUSHED=$(git -C "$PROJECT_ROOT" log origin/HEAD..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
if [[ "$UNPUSHED" -gt 0 ]]; then
  echo "→ Pushing $UNPUSHED unpushed commit(s)…"
  git -C "$PROJECT_ROOT" push
else
  echo "  (nothing to push — already up to date with origin)"
fi

# ── 5. Wait for nexus publish and upgrade the guild ───────────

echo "→ Invoking upgrade-guild.sh…"
"$SCRIPT_DIR/upgrade-guild.sh"

echo "✓ Done."
