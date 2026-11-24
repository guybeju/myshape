#!/usr/bin/env bash
# Static check of guard 3.4: the board's state files have one writer
# (store.ts commitChange), records reach the journal only through its outbox
# flush, and no other module changes the board's state behind the read-only
# types. The rules are in state-writers.mjs, which reads the sources with the
# scanner of the TypeScript the board builds with. Prints "ok - ..." and exits
# 0, or each problem and exits 1. Without node or the board's node_modules it
# prints "skip:" and exits 0.
#
# Usage: myshape/test/check-state-writers.sh
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOARD_DIR="$(cd "$TEST_DIR/.." && pwd)"
TYPESCRIPT="$BOARD_DIR/node_modules/typescript"

if ! command -v node >/dev/null 2>&1 || [ ! -d "$TYPESCRIPT/dist/ast" ]; then
  echo "skip: node or myshape/node_modules/typescript not found (run pnpm install in myshape)"
  exit 0
fi
problems=$(node "$TEST_DIR/state-writers.mjs" "$TYPESCRIPT" "$BOARD_DIR/src")
if [ -n "$problems" ]; then
  printf 'not ok - the board state has a writer outside store.ts commitChange:\n%s\n' "$problems" >&2
  exit 1
fi
echo "ok - the board's state files have one writer"
