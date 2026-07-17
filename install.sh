#!/usr/bin/env bash
# Installs the `doug` command by symlinking bin/doug into ~/.local/bin.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Vendor pi (+ apply branding patches via postinstall) if not already done
if [[ ! -d "$REPO_DIR/node_modules/@earendil-works/pi-coding-agent" ]]; then
  (cd "$REPO_DIR" && npm ci)
fi

mkdir -p "$HOME/.local/bin"
ln -sfn "$REPO_DIR/bin/doug" "$HOME/.local/bin/doug"

echo "doug installed: $HOME/.local/bin/doug -> $REPO_DIR/bin/doug"
command -v doug >/dev/null || echo "note: ~/.local/bin is not on your PATH"
