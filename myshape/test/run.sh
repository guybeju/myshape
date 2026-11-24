#!/usr/bin/env bash
# Runs the myshape test scripts for the given stages (all stages when none
# are named). Each script is myshape/test/stage-<n>-*.sh and exits non-zero
# on its first failed assertion. The scripts run under the bash that runs this
# file, so `/bin/bash run.sh` checks them against that bash. Stages 3 to 5,
# which run the board with Firstmate's own adapter, and stage 6, the rules and
# the setup guide, moved to fm-board/test/run.sh; stage 7 runs the board
# alone, from a copy holding only its own files. The two static checks
# (signals, state writers) run first, whatever stages are named.
#
# Usage: myshape/test/run.sh [stage-number...]
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -eq 0 ]; then
  set -- 1 2 7
fi

"${BASH:-bash}" "$TEST_DIR/check-signals.sh"
"${BASH:-bash}" "$TEST_DIR/check-state-writers.sh"
ran=0
for stage in "$@"; do
  case "$stage" in
    [127]) ;;
    [3-6])
      echo "run.sh: stage $stage moved to fm-board/test/run.sh" >&2
      exit 2
      ;;
    *)
      echo "run.sh: unknown stage '$stage' (expected 1, 2 or 7)" >&2
      exit 2
      ;;
  esac
  for script in "$TEST_DIR"/stage-"$stage"-*.sh; do
    [ -f "$script" ] || continue
    echo "# $(basename "$script")"
    "${BASH:-bash}" "$script"
    ran=$((ran + 1))
  done
done
[ "$ran" -gt 0 ] || {
  echo "run.sh: no test scripts found for stages: $*" >&2
  exit 1
}
echo "# myshape tests passed ($ran scripts)"
