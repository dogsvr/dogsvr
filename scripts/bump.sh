#!/bin/bash
# Usage:
#   ./scripts/bump.sh <patch|minor|major>               # bump all packages
#   ./scripts/bump.sh <patch|minor|major> pkg1 pkg2 ... # bump subset by short name
#
# Short names: logger, cfg-luban, cfg-luban-cli, dogsvr, cl-tsrpc, cl-grpc
#
# Run from dogsvr/ or dogsvr/scripts/. Does NOT auto-commit or tag.

set -e

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <patch|minor|major> [pkg...]"
  echo "  packages: logger cfg-luban cfg-luban-cli dogsvr cl-tsrpc cl-grpc"
  echo "  omit [pkg...] to bump all packages"
  exit 0
fi

BUMP=$1
if [[ "$BUMP" != patch && "$BUMP" != minor && "$BUMP" != major ]]; then
  echo "Usage: $0 <patch|minor|major> [pkg...]"
  echo "  packages: logger cfg-luban cfg-luban-cli dogsvr cl-tsrpc cl-grpc"
  exit 1
fi
shift

# Resolve polyrepo root: script lives at <root>/dogsvr/scripts/bump.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Verify we landed on the polyrepo root (sanity check)
if [[ ! -d "$ROOT/dogsvr" ]]; then
  echo "Error: could not locate polyrepo root (expected $ROOT/dogsvr to exist)"
  exit 1
fi

declare -A PKG_DIR=(
  [logger]="logger"
  [cfg-luban]="cfg-luban/cfg-luban"
  [cfg-luban-cli]="cfg-luban/cfg-luban-cli"
  [dogsvr]="dogsvr"
  [cl-tsrpc]="cl-tsrpc"
  [cl-grpc]="cl-grpc"
)

# Ordered for full-bump (deps first)
ALL_PKGS=(logger cfg-luban cfg-luban-cli dogsvr cl-tsrpc cl-grpc)

if [[ $# -eq 0 ]]; then
  TARGETS=("${ALL_PKGS[@]}")
else
  TARGETS=("$@")
fi

for name in "${TARGETS[@]}"; do
  if [[ -z "${PKG_DIR[$name]}" ]]; then
    echo "Unknown package: $name"
    echo "  valid: ${!PKG_DIR[*]}"
    exit 1
  fi
  dir="$ROOT/${PKG_DIR[$name]}"
  old=$(node -p "require('$dir/package.json').version")
  npm version "$BUMP" --no-git-tag-version --prefix "$dir" > /dev/null
  new=$(node -p "require('$dir/package.json').version")
  echo "$name: $old → $new"
done
