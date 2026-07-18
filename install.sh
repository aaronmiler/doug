#!/usr/bin/env bash
# Installs the `doug` command by symlinking bin/doug into ~/.local/bin.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Vendor pi (+ apply branding patches via postinstall) if not already done,
# or if the lockfile moved since the last npm ci (i.e. after `doug update`).
STAMP="$REPO_DIR/node_modules/.package-lock.json"
if [[ ! -f "$STAMP" || "$REPO_DIR/package-lock.json" -nt "$STAMP" ]]; then
  (cd "$REPO_DIR" && npm ci)
fi

mkdir -p "$HOME/.local/bin"
ln -sfn "$REPO_DIR/bin/doug" "$HOME/.local/bin/doug"

VERSION="$(git -C "$REPO_DIR" describe --always --dirty 2>/dev/null || echo unknown)"
echo "doug $VERSION installed: $HOME/.local/bin/doug -> $REPO_DIR/bin/doug"
command -v doug >/dev/null || echo "note: ~/.local/bin is not on your PATH"
