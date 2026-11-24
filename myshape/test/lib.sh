#!/usr/bin/env bash
# myshape/test/lib.sh - the board's own test library, so that a copy of the
# board without Firstmate runs its own suites. Every suite in myshape/test
# sources it first:
#   # shellcheck source=myshape/test/lib.sh
#   . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
#
# Sourcing it gives the suite:
#   - a clean start: umask 022; none of the names the board's command takes its
#     home and code root from (MYSHAPE_HOME, MYSHAPE_ROOT_OVERRIDE,
#     MYSHAPE_STATE_OVERRIDE, MYSHAPE_DATA_OVERRIDE, MYSHAPE_CONFIG_OVERRIDE),
#     and none of the names it took them from before it had its own (FM_HOME,
#     FM_ROOT, FM_ROOT_OVERRIDE, FM_STATE_OVERRIDE, FM_DATA_OVERRIDE,
#     FM_CONFIG_OVERRIDE), so no board command reaches a real home; and git
#     with no global or system configuration;
#   - ROOT, the checkout this file is in;
#   - fail and pass, and fm_test_run <case>...: a plan line 1..N, each case
#     (which prints one "ok - " line through pass), then FM_TEST_COMPLETE;
#   - the assertions assert_equals, assert_not_equals, assert_contains,
#     assert_not_contains, expect_code, assert_grep, assert_absent and
#     assert_present, and fm_fakebin and fm_git_init_commit;
#   - fm_test_tmproot <prefix>: a fresh scratch root under the run's temp
#     directory, marked and registered as this run's;
#   - fm_test_cleanup, run on exit (a suite that sets its own EXIT trap calls
#     it last): every process whose command line still names one of this
#     run's roots is sent TERM, then KILL, through the guard's --identity
#     form, each followed by a wait of at most 2 s; a root is removed only
#     when nothing names it any more, otherwise it is kept and reported on
#     stderr. In a log-only run it waits up to 10 s and then only logs. It
#     never touches a root another run made;
#   - fm_test_signal <signal> <pid> and fm_test_signal <signal> --identity
#     <pid>, the suites' own sends, and fm_test_signal_skipped <case>, through
#     myshape/test/signal-lib.sh, which it loads.
# The names and the output match Firstmate's tests/lib.sh, so the board's test
# kit (myshape/test/kit/helpers.sh) works under either library.

[ -z "${TB_TEST_LIB_SOURCED:-}" ] || return 0
TB_TEST_LIB_SOURCED=1

umask 022
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
unset FM_HOME FM_ROOT FM_ROOT_OVERRIDE FM_STATE_OVERRIDE FM_DATA_OVERRIDE FM_CONFIG_OVERRIDE MYSHAPE_HOME
unset MYSHAPE_ROOT_OVERRIDE MYSHAPE_STATE_OVERRIDE MYSHAPE_DATA_OVERRIDE MYSHAPE_CONFIG_OVERRIDE

# shellcheck disable=SC2034 # ROOT is read by the sourcing suites.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

# fm_test_run <case>...: the plan line, every case, then FM_TEST_COMPLETE.
fm_test_run() {
  local name
  [ "$#" -gt 0 ] || fail "fm_test_run: no cases given"
  printf '1..%s\n' "$#"
  for name in "$@"; do
    [ "$(type -t "$name" 2>/dev/null)" = function ] || fail "fm_test_run: $name is not a function"
    "$name"
  done
  printf 'FM_TEST_COMPLETE\n'
}

assert_equals() {  # <expected> <actual> <message>
  [ "$1" = "$2" ] || fail "$3 (expected '$1', got '$2')"
}

assert_not_equals() {  # <unexpected> <actual> <message>
  [ "$1" != "$2" ] || fail "$3 (unexpectedly got '$1')"
}

assert_contains() {  # <text> <part> <message>
  case "$1" in
    *"$2"*) ;;
    *) fail "$3 (missing: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
  esac
}

assert_not_contains() {  # <text> <part> <message>
  case "$1" in
    *"$2"*) fail "$3 (unexpected: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
    *) ;;
  esac
}

expect_code() {  # <expected> <actual> <label>
  [ "$2" = "$1" ] || fail "$3: expected exit $1, got $2"
}

assert_grep() {  # <fixed text> <file> <message>
  grep -F -- "$1" "$2" >/dev/null || fail "$3"
}

assert_absent() {  # <path> <message>
  [ ! -e "$1" ] || fail "$2"
}

assert_present() {  # <path> <message>
  [ -e "$1" ] || fail "$2"
}

# fm_fakebin <dir>: make <dir>/fakebin and print it, for stand-ins put first on PATH.
fm_fakebin() {
  mkdir -p "$1/fakebin"
  printf '%s\n' "$1/fakebin"
}

# fm_git_init_commit <dir>: a git repository at <dir> on branch main with one
# commit of a README, under a fixed identity.
fm_git_init_commit() {
  mkdir -p "$1"
  git -C "$1" init -q -b main
  printf '# %s\n' "$(basename "$1")" > "$1/README.md"
  git -C "$1" add README.md
  git -C "$1" -c user.name='Firstmate Tests' -c user.email='tests@example.invalid' commit -qm initial
}

# shellcheck source=myshape/test/signal-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/signal-lib.sh"

# The run's temp directory, fixed here so that every root of the run lies
# below it: TMPDIR as a physical path, or /tmp when TMPDIR is unset, not a
# directory, holds a .git entry itself, or is longer than 40 characters. That last
# rule is kit/helpers.sh's (a board's socket path must stay short), applied
# here first so the base does not change after the kit is sourced.
tb_lib_tmpdir=${TMPDIR:-}
if [ "${#tb_lib_tmpdir}" -gt 40 ]; then
  export TMPDIR=/tmp
fi
unset tb_lib_tmpdir
TB_TEST_TMPDIR=$(CDPATH='' cd -- "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P) || TB_TEST_TMPDIR=/tmp
[ ! -e "$TB_TEST_TMPDIR/.git" ] || TB_TEST_TMPDIR=/tmp
case "$TB_TEST_TMPDIR" in
  /?*) ;;
  *) echo "not ok - the temp directory '$TB_TEST_TMPDIR' cannot hold scratch roots" >&2; exit 1 ;;
esac
TB_TEST_ROOTS=$(mktemp "$TB_TEST_TMPDIR/.myshape-test-roots.$$.XXXXXX") ||
  { echo "not ok - could not make the scratch-root registry in $TB_TEST_TMPDIR" >&2; exit 1; }
export TB_TEST_TMPDIR TB_TEST_ROOTS

# fm_test_tmproot <prefix>: print a fresh scratch root below the run's temp
# directory. Its marker names this test script and its start time, and the
# registry lists it, which is what the guard and the cleanup accept as this
# run's. The usual call is TMP_ROOT=$(fm_test_tmproot <prefix>), a subshell,
# so the registry is a file, not a shell variable.
fm_test_tmproot() {
  local prefix=${1:-myshape-test} root
  case "$prefix" in
    '' | */* | .*) return 1 ;;
  esac
  root=$(mktemp -d "$TB_TEST_TMPDIR/$prefix.XXXXXX") || return 1
  root=$(cd -P -- "$root" && pwd -P) || return 1
  printf '%s\n%s\n' "$TB_TEST_SUITE_PID" "$TB_TEST_SUITE_START" > "$root/.myshape-test-root" || return 1
  printf '%s\n' "$root" >> "$TB_TEST_ROOTS" || return 1
  "$SIGNAL_CHECK" --root-ok "$root" || return 1
  printf '%s\n' "$root"
}

# tb_lib_root_pids <root>: the pids whose command line names <root> followed by
# "/", a space or its end, this shell and its ancestors left out. Nothing is
# signalled here.
tb_lib_root_pids() {
  local chain=" " pid=$$
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    chain="$chain$pid "
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')
  done
  ps -ww -eo pid=,args= 2>/dev/null | TB_LIB_ROOT="$1" awk -v chain="$chain" '
    { line = $0 " "; root = ENVIRON["TB_LIB_ROOT"] }
    (index(line, root "/") || index(line, root " ")) && index(chain, " " $1 " ") == 0 { print $1 }'
}

# tb_lib_reap_root <root>: the cleanup's sends for one root of this run.
tb_lib_reap_root() {
  local pid pids sig i
  pids=$(tb_lib_root_pids "$1")
  [ -n "$pids" ] || return 0
  if signal_dry_run; then
    i=0
    while [ -n "$pids" ] && [ "$i" -lt 100 ]; do
      sleep 0.1
      i=$((i + 1))
      pids=$(tb_lib_root_pids "$1")
    done
    for pid in $pids; do
      "$SIGNAL_CHECK" --send fm_test_cleanup TERM --identity "$pid" >/dev/null 2>&1 || true
    done
    return 0
  fi
  for sig in TERM KILL; do
    for pid in $pids; do
      "$SIGNAL_CHECK" --send fm_test_cleanup "$sig" --identity "$pid" >/dev/null 2>&1 || true
    done
    i=0
    while [ "$i" -lt 20 ]; do
      sleep 0.1
      i=$((i + 1))
      pids=$(tb_lib_root_pids "$1")
      [ -n "$pids" ] || return 0
    done
  done
}

fm_test_cleanup() {
  local root pids pid
  [ -n "${TB_TEST_ROOTS:-}" ] && [ -f "$TB_TEST_ROOTS" ] || return 0
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    if ! "$SIGNAL_CHECK" --root-ok "$root"; then
      printf '# myshape-test: %s is not a scratch root of this run; left as it is\n' "$root" >&2
      continue
    fi
    tb_lib_reap_root "$root"
    pids=$(tb_lib_root_pids "$root")
    if [ -n "$pids" ]; then
      for pid in $pids; do
        printf '# myshape-test: scratch root %s kept; pid %s still names it: %s\n' \
          "$root" "$pid" "$(ps -ww -o args= -p "$pid" 2>/dev/null || true)" >&2
      done
      continue
    fi
    find "$root" -type d -exec chmod u+rwx {} + 2>/dev/null || true
    rm -rf "$root"
  done < "$TB_TEST_ROOTS"
  rm -f "$TB_TEST_ROOTS"
}

trap fm_test_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 131' QUIT

# fm_test_signal <signal> <pid> | <signal> --identity <pid>: send through the
# guard (signal-guard.sh, which owns the checks). Anything it refuses fails the
# case unsent; in a log-only run nothing is sent and the call returns 0.
fm_test_signal() {
  local source=main frame rc=0
  for frame in "${FUNCNAME[@]:1}"; do
    case "$frame" in fm_test_signal*) ;; *) source=$frame; break ;; esac
  done
  sig_send "$source" "$@" || rc=$?
  ! signal_dry_run || return 0
  [ "$rc" -eq 0 ] || fail "signal guard: $SIG_VERDICT"
}

# fm_test_signal_skipped <case>: right after a send a case depends on, in a
# log-only run only, report the case skipped (its signal was logged, not sent)
# and return 0 so the caller returns; otherwise return 1 and print nothing.
# Use: fm_test_signal_skipped "<case>" && return 0
fm_test_signal_skipped() {
  signal_dry_run || return 1
  pass "skip: log-only run, the signal was logged and not sent: $1"
}
