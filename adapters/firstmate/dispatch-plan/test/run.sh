#!/usr/bin/env bash
# Runs every dispatch-plan test script (dispatch-plan/test/stage-*.sh) under
# the bash that runs this file. Each script exits non-zero on its first failed
# assertion.
#
# Usage: dispatch-plan/test/run.sh
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$#" -eq 0 ] || {
  echo "run.sh: takes no arguments" >&2
  exit 2
}

ran=0
for script in "$TEST_DIR"/stage-*.sh; do
  [ -f "$script" ] || continue
  echo "# $(basename "$script")"
  "${BASH:-bash}" "$script"
  ran=$((ran + 1))
done
[ "$ran" -gt 0 ] || {
  echo "run.sh: no test scripts found in $TEST_DIR" >&2
  exit 1
}
echo "# dispatch-plan tests passed ($ran scripts)"
