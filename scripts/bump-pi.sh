#!/usr/bin/env bash
# bump-pi.sh — bump the vendored pi to a new version, moving package.json and the
# branding patch filename together, then reinstall.
#
# doug pins pi in package.json and carries one patch-package patch named
# patches/@earendil-works+pi-coding-agent+<ver>.patch. patch-package requires the
# version in that filename (a version-less name is silently skipped), so a bump
# means editing package.json AND renaming the patch. This does both, then runs
# npm install — postinstall re-applies the renamed patch and the lockfile updates.
#
# By default it first runs check-pi-upgrade.sh <version> as a dry-run guard and
# aborts if the patch won't apply cleanly, so you never end up half-bumped.
#
# Usage:
#   scripts/bump-pi.sh 0.82.0             # dry-run check, then bump
#   scripts/bump-pi.sh --no-check 0.82.0  # skip the check (already ran it)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="$REPO_DIR/package.json"
PATCH_DIR="$REPO_DIR/patches"
PKG="@earendil-works/pi-coding-agent"
PATCH_PREFIX="@earendil-works+pi-coding-agent+"

RUN_CHECK=1
if [[ "${1:-}" == "--no-check" ]]; then
  RUN_CHECK=0
  shift
fi

TARGET="${1:-}"
[[ -n "$TARGET" ]] || { echo "usage: bump-pi.sh [--no-check] <version>" >&2; exit 1; }

command -v npm >/dev/null || { echo "bump-pi: npm is required" >&2; exit 1; }

read_version() { # read the pinned pi version out of package.json (no jq dependency)
  node -e 'const p=require(process.argv[1]);process.stdout.write(p.dependencies["@earendil-works/pi-coding-agent"]||"")' "$PKG_JSON"
}

CURRENT="$(read_version)"
[[ -n "$CURRENT" ]] || { echo "bump-pi: could not read pinned pi version from package.json" >&2; exit 1; }

if [[ "$TARGET" == "$CURRENT" ]]; then
  echo "bump-pi: package.json already pins $CURRENT — nothing to bump." >&2
  exit 1
fi

OLD_PATCH="$PATCH_DIR/${PATCH_PREFIX}${CURRENT}.patch"
NEW_PATCH="$PATCH_DIR/${PATCH_PREFIX}${TARGET}.patch"
[[ -f "$OLD_PATCH" ]] || { echo "bump-pi: expected patch not found: $OLD_PATCH" >&2; exit 1; }

# 1. Dry-run guard (reuses the sandbox check) unless skipped. check-pi-upgrade.sh
#    also rejects an unpublished version, so that failure surfaces here too.
if [[ "$RUN_CHECK" == 1 ]]; then
  echo "Verifying the patch applies to $TARGET before bumping…"
  echo
  if ! "$REPO_DIR/scripts/check-pi-upgrade.sh" "$TARGET"; then
    echo
    echo "bump-pi: aborted — nothing changed (see check-pi-upgrade output above)." >&2
    echo "  Refresh the patch against $TARGET first, or re-run with --no-check to force." >&2
    exit 1
  fi
  echo
fi

# 2. Rename the patch to match the new version (plain mv — you commit).
mv "$OLD_PATCH" "$NEW_PATCH"

# 3. Rewrite the package.json pin in place. Only the one value changes; 2-space
#    indent and key order are preserved.
node -e '
  const fs=require("fs"), f=process.argv[1], v=process.argv[2];
  const p=JSON.parse(fs.readFileSync(f,"utf8"));
  p.dependencies["@earendil-works/pi-coding-agent"]=v;
  fs.writeFileSync(f, JSON.stringify(p,null,2)+"\n");
' "$PKG_JSON" "$TARGET"

# 4. Reinstall: refreshes the lockfile and re-applies the renamed patch (postinstall).
echo "Bumping pi $CURRENT → $TARGET and reinstalling…"
echo
if ! (cd "$REPO_DIR" && npm install); then
  echo
  echo "bump-pi: npm install did not complete. The package.json pin, the patch" >&2
  echo "  rename, and the lockfile edits are correct and in place — just re-run" >&2
  echo "  'npm install' once the cause (e.g. registry/network) is resolved." >&2
  exit 1
fi

echo
echo "✅ pi bumped $CURRENT → $TARGET."
echo "   Updated: package.json, patches/${PATCH_PREFIX}${TARGET}.patch, package-lock.json."
echo "   Review the diff and commit when ready."
