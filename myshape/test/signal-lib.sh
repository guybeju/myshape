#!/usr/bin/env bash
# The one guarded way a board test sends a signal (signal policy P-010), shared
# by every suite whose tests stop a process themselves. Every send goes through
# myshape/test/signal-guard.sh, which owns the checks; myshape/test/lib.sh
# loads this file, and a suite on Firstmate's side (tests/lib.sh) sources it
# after its library. myshape/test/check-signals.sh pins the guard's one send
# line as the only one in the board's test tree.
# shellcheck disable=SC2034 # SIGNAL_CHECK is read by the sourcing scripts.

[ -z "${TB_SIGNAL_LIB_SOURCED:-}" ] || return 0
TB_SIGNAL_LIB_SOURCED=1

# FM_TEST_SIGNAL_DRY_RUN=1: the guard sends nothing and instead writes one line
# per call to FM_TEST_SIGNAL_LOG (an absolute path), so the targets can be read
# before a real run; the assertions that need a killed run are skipped, and
# every shim and migration ends by itself.
# FM_TEST_SIGNAL_DRY_RUN=unfixed: the same, accepted as tests/lib.sh accepts
# it, for a run that rebuilds a case from before a fix. Nothing is signalled
# in either mode. With FM_TEST_SIGNAL_LOG set outside log-only mode
# the guard records each call and sends.
case "${FM_TEST_SIGNAL_DRY_RUN:-}" in
  '' | 1 | unfixed) ;;
  *) echo "not ok - FM_TEST_SIGNAL_DRY_RUN must be 1, unfixed, or unset" >&2; exit 1 ;;
esac
signal_dry_run() {
  [ -n "${FM_TEST_SIGNAL_DRY_RUN:-}" ]
}
if signal_dry_run; then
  case "${FM_TEST_SIGNAL_LOG:-}" in
    /*) ;;
    *) echo "not ok - FM_TEST_SIGNAL_DRY_RUN needs FM_TEST_SIGNAL_LOG, an absolute path for its log" >&2; exit 1 ;;
  esac
  printf '# signal dry run (%s): nothing is signalled; each target is logged to %s\n' \
    "$FM_TEST_SIGNAL_DRY_RUN" "$FM_TEST_SIGNAL_LOG"
fi

# The guard, and the test script it protects: this file is sourced by the test
# script itself, so $$ is the script and $PPID its parent. The start time lets
# the guard tell this script from a later process that reuses its pid.
SIGNAL_CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/signal-guard.sh"
TB_TEST_SUITE_PID=$$
TB_TEST_SUITE_PARENT=$PPID
TB_TEST_SUITE_START=$("$SIGNAL_CHECK" --start-of "$$")
export TB_TEST_SUITE_PID TB_TEST_SUITE_PARENT TB_TEST_SUITE_START
[ -n "$TB_TEST_SUITE_START" ] || { echo "not ok - the start time of the test script $$ could not be read" >&2; exit 1; }

# sig_init: check that TMP_ROOT is set before the first send, which keeps its
# verdict there. Call it once TMP_ROOT is set.
sig_init() {
  case "${TMP_ROOT:-}" in
    /?*) ;;
    *) fail "sig_init: TMP_ROOT must be an absolute scratch directory" ;;
  esac
}

# sig_send <source> <signal> <form...>: run the guard's send form as a plain
# command of this shell, never in $(...), so the guard's parent is this shell.
# Leaves the guard's verdict line in SIG_VERDICT and returns its exit code.
sig_send() {
  local rc=0 file
  case "${TMP_ROOT:-}" in
    /?*) ;;
    *) fail "signal guard: TMP_ROOT must be an absolute scratch directory" ;;
  esac
  file=$TMP_ROOT/.signal-verdict
  "$SIGNAL_CHECK" --send "$@" > "$file" || rc=$?
  SIG_VERDICT=
  IFS= read -r SIG_VERDICT < "$file" || true
  return "$rc"
}

# kill_own_child <pid>: KILL a child this shell started itself with &, through
# the guard. Anything the guard refuses fails the test unsent. In a dry run
# nothing is sent and the guard logs the call. The pid is a child this shell
# has not waited for, so it cannot have been reused.
kill_own_child() {
  local rc=0
  sig_send kill_own_child KILL "$@" || rc=$?
  ! signal_dry_run || return 0
  case "$rc" in
    0 | 3) ;;
    *) fail "signal guard: $SIG_VERDICT" ;;
  esac
}

# dry_log <line>: one line in the dry run's log.
dry_log() {
  ! signal_dry_run || printf '%s\n' "$1" >> "$FM_TEST_SIGNAL_LOG"
}

# sig_leftovers: in a signal dry run, give processes the run left under
# TMP_ROOT ten seconds to end by themselves, then log every one still there:
# these are what the cleanup on exit would signal. Under the board's library
# (TB_TEST_ROOTS set) each is logged with the guard's --identity verdict, the
# form that cleanup uses; under Firstmate's tests/lib.sh, whose own cleanup
# and guard decide and log them, each gets one plain line. Outside a dry run
# it does nothing.
sig_leftovers() {
  local pids pid i=0
  signal_dry_run || return 0
  while [ "$i" -lt 100 ]; do
    pids=$(ps -ww -eo pid=,args= | SIG_ROOT="$TMP_ROOT/" awk 'index($0, ENVIRON["SIG_ROOT"]) { print $1 }')
    [ -n "$pids" ] || break
    sleep 0.1
    i=$((i + 1))
  done
  if [ -z "$pids" ]; then
    dry_log "leftovers: none; the cleanup on exit has nothing to signal"
    return 0
  fi
  for pid in $pids; do
    if [ -n "${TB_TEST_ROOTS:-}" ]; then
      "$SIGNAL_CHECK" "$$" "$FM_TEST_SIGNAL_LOG" "leftover the cleanup on exit would signal" --identity "$pid" >/dev/null
    else
      dry_log "leftover pid $pid ($(ps -ww -o args= -p "$pid" 2>/dev/null || true)): tests/lib.sh's cleanup decides it, through tests/signal-guard.sh"
    fi
  done
}

# sig_product_target <home> <subcommand>: in a signal dry run, before a board
# command that may stop the running board (open, stop, restart, and any
# command that replaces a board on other code), log the board its pid file
# names, which is the only process the board's own stop could signal.
sig_product_target() {
  local pid
  signal_dry_run || return 0
  pid=$(cat "$1/state/myshape/pid" 2>/dev/null || true)
  [ -n "$pid" ] || return 0
  "$SIGNAL_CHECK" "$$" "$FM_TEST_SIGNAL_LOG" "the board's own stop, before: myshape.sh $2" "$pid" >/dev/null
}
