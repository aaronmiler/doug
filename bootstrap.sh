#!/bin/sh
# Bootstraps doug from nothing — safe to pipe from curl, safe to re-run:
#   curl -fsSL https://raw.githubusercontent.com/aaronmiler/doug/main/bootstrap.sh | sh
# Clones the repo (or fast-forwards an existing install), then runs install.sh.
set -eu

REPO_URL="https://github.com/aaronmiler/doug.git"
DEFAULT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/doug"

command -v git >/dev/null || { echo "doug: git is required" >&2; exit 1; }

# An existing install wins: follow the PATH symlink back to whatever repo it
# came from (e.g. a dev checkout), instead of cloning a second copy.
LAUNCHER="$HOME/.local/bin/doug"
if [ -L "$LAUNCHER" ]; then
  REPO_DIR="$(dirname "$(dirname "$(readlink -f "$LAUNCHER")")")"
else
  REPO_DIR="$DEFAULT_DIR"
fi

if [ -d "$REPO_DIR/.git" ]; then
  echo "doug: updating $REPO_DIR"
  git -C "$REPO_DIR" pull --ff-only
else
  echo "doug: cloning into $REPO_DIR"
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone "$REPO_URL" "$REPO_DIR"
fi

exec "$REPO_DIR/install.sh"
