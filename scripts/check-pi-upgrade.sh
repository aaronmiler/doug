#!/usr/bin/env bash
# check-pi-upgrade.sh — dry-run a pi version bump without touching the real install.
#
# doug vendors pi and modifies it with a single patch-package patch
# (patches/@earendil-works+pi-coding-agent+<ver>.patch). That patch is applied
# on every `npm ci` via the postinstall hook. When pi moves, the patch is still
# applied against the *new* code — if pi refactored the region the patch touches,
# the hunk fails and `npm ci` (hence `doug update`) breaks.
#
# This script answers "is it safe to bump the pin?" by reproducing production
# behavior in a throwaway sandbox: it installs the target pi version in a temp
# dir and runs patch-package there, exactly as install.sh would. A pass here
# means the real bump applies cleanly. Nothing in this repo is modified.
#
# Usage:
#   scripts/check-pi-upgrade.sh            # target = pi.dev latest
#   scripts/check-pi-upgrade.sh 0.81.0     # target = an explicit version
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="$REPO_DIR/package.json"
PATCH_DIR="$REPO_DIR/patches"
PKG="@earendil-works/pi-coding-agent"

command -v npm >/dev/null || { echo "check-pi-upgrade: npm is required" >&2; exit 1; }

read_version() { # read the pinned pi version out of package.json (no jq dependency)
  node -e 'const p=require(process.argv[1]);process.stdout.write(p.dependencies["@earendil-works/pi-coding-agent"]||"")' "$PKG_JSON"
}
patch_dev_version() { # the patch-package version constraint we install in the sandbox
  node -e 'const p=require(process.argv[1]);process.stdout.write(p.devDependencies["patch-package"]||"^8.0.1")' "$PKG_JSON"
}
fetch_latest() { # same endpoint pi's own update check uses
  node -e '
    fetch("https://pi.dev/api/latest-version",{headers:{accept:"application/json"}})
      .then(r=>r.ok?r.json():Promise.reject(new Error("HTTP "+r.status)))
      .then(d=>{ if(!d||!d.version) throw new Error("no version in response"); process.stdout.write(String(d.version).trim()); })
      .catch(e=>{ console.error("check-pi-upgrade: could not reach pi.dev ("+e.message+")"); process.exit(1); })
  '
}

CURRENT="$(read_version)"
[[ -n "$CURRENT" ]] || { echo "check-pi-upgrade: could not read pinned pi version from package.json" >&2; exit 1; }

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Resolving pi.dev latest…"
  TARGET="$(fetch_latest)"
fi

# Fail early (and distinctly) on a version that was never published — otherwise
# npm's ETARGET would masquerade as a patch failure below.
if ! npm view "$PKG@$TARGET" version >/dev/null 2>&1; then
  echo "check-pi-upgrade: $PKG@$TARGET is not a published version." >&2
  echo "  Available recent versions:" >&2
  npm view "$PKG" versions --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);console.error("  "+v.slice(-8).join(", "))}catch{}})' >&2 || true
  exit 2
fi

echo "Pinned pi:  $CURRENT"
echo "Target pi:  $TARGET"
if [[ "$TARGET" == "$CURRENT" ]]; then
  echo "(same version — this is a sanity check that the current patch still applies)"
fi
echo

# Sandbox: minimal package that mirrors doug's postinstall patch flow.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/doug-pi-check.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

cp -R "$PATCH_DIR" "$TMP/patches"
PATCH_DEV="$(patch_dev_version)"
cat > "$TMP/package.json" <<EOF
{
  "name": "doug-pi-upgrade-check",
  "private": true,
  "scripts": { "postinstall": "patch-package" },
  "dependencies": { "$PKG": "$TARGET" },
  "devDependencies": { "patch-package": "$PATCH_DEV" }
}
EOF

echo "Installing $PKG@$TARGET in a sandbox and applying doug's patch…"
echo
LOG="$TMP/install.log"
if (cd "$TMP" && npm install --no-audit --no-fund) >"$LOG" 2>&1; then
  echo "✅ Patch applies to $TARGET."
  # Surface offset warnings — applied, but line numbers drifted (still safe).
  if grep -qiE 'with [0-9]+ offset|fuzz' "$LOG"; then
    echo "   (applied with line offsets — safe, but the region shifted:)"
    grep -iE 'offset|fuzz' "$LOG" | sed 's/^/   /'
  fi
  echo
  echo "Safe to bump: set \"$PKG\": \"$TARGET\" in package.json, then either keep"
  echo "the current patch file (works, warns on version mismatch) or refresh it:"
  echo "  npx patch-package $PKG   # regenerates, then rename patches/*+$TARGET.patch"
  RESULT=0
else
  echo "❌ Patch does NOT apply to $TARGET — pi changed the region doug patches."
  echo
  echo "----- patch-package output -----"
  # patch-package prints the failing patch file + hunk; show the relevant tail.
  grep -iE 'patch-package|Failed to apply|hunk|does not match|ENOENT|cannot apply|\.patch' "$LOG" | sed 's/^/  /' || tail -n 25 "$LOG" | sed 's/^/  /'
  echo "--------------------------------"
  echo
  echo "Recommendation: stay pinned at $CURRENT. To adopt $TARGET you'll need to"
  echo "refresh the patch against the new code:"
  echo "  1. npm install $PKG@$TARGET   (in a scratch checkout)"
  echo "  2. re-apply your edits to node_modules/$PKG/dist/…, then"
  echo "  3. npx patch-package $PKG  and rename the patch to +$TARGET.patch"
  RESULT=1
fi

exit $RESULT
