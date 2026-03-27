#!/usr/bin/env bash
# bin/wait-for-publish.sh — Wait for the Publish workflow on HEAD to complete,
# then echo the published version to stdout.
#
# All status messages go to stderr so callers can cleanly capture the version:
#
#   VERSION=$(./bin/wait-for-publish.sh)
#
# Steps:
#   1. Find the GitHub Actions "publish.yml" run for the current HEAD commit.
#      Polls for up to 30s if no run exists yet (the push may have just arrived).
#   2. Stream the run until it completes; fail if the workflow failed.
#   3. Fetch git tags from the remote and derive the published version from the
#      highest semver tag (vMAJOR.MINOR.PATCH) — matching the workflow's own
#      tagging strategy.
#   4. Echo the bare version string (e.g. "0.1.84") to stdout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKFLOW_FILE="publish.yml"

# ── 1. Resolve HEAD SHA ────────────────────────────────────────

COMMIT_SHA="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
echo "→ HEAD: $COMMIT_SHA" >&2
echo "→ Looking for a '$WORKFLOW_FILE' run on this commit…" >&2

# ── 2. Poll for the workflow run (up to 30s) ──────────────────

REPO="$(cd "$PROJECT_ROOT" && gh repo view --json nameWithOwner -q .nameWithOwner)"
DEADLINE=$(( SECONDS + 30 ))
RUN_ID=""

while [[ $SECONDS -lt $DEADLINE ]]; do
  RUN_ID=$(
    gh run list \
      --repo "$REPO" \
      --workflow "$WORKFLOW_FILE" \
      --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$COMMIT_SHA\") | .databaseId" \
      2>/dev/null | head -1 || true
  )

  if [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]]; then
    echo "→ Found run: $RUN_ID" >&2
    break
  fi

  echo "  (no run yet — waiting…)" >&2
  sleep 3
done

if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  echo "✗ No publish workflow run found for $COMMIT_SHA after 30s." >&2
  exit 1
fi

# ── 3. Wait for the run to complete ───────────────────────────

echo "→ Waiting for run $RUN_ID to finish…" >&2
# --exit-status: exits non-zero if the run concluded with failure/cancelled
gh run watch "$RUN_ID" --exit-status --repo "$REPO" >&2

echo "✓ Publish workflow succeeded." >&2

# ── 4. Determine the published version from the pushed git tag ─

echo "→ Fetching tags from remote…" >&2
git -C "$PROJECT_ROOT" fetch --tags --quiet

VERSION=$(
  git -C "$PROJECT_ROOT" tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-version:refname \
    | head -1 \
    | sed 's/^v//'
)

if [[ -z "$VERSION" ]]; then
  echo "✗ Could not determine published version from git tags." >&2
  exit 1
fi

echo "→ Published version: $VERSION" >&2

# Echo bare version to stdout for callers to capture
echo "$VERSION"
