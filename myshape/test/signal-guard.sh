#!/usr/bin/env bash
# myshape/test/signal-guard.sh - the board tests' guarded signal (signal policy
# P-010): the verdict on one signal call, and the one place in the board's test
# tree that sends one.
#
# Judge and send (the signalling shell is this program's own parent, never an
# argument):
#   signal-guard.sh --send <source> <signal> <form>
# Verdict only (never signals; for the log lines of a log-only run):
#   signal-guard.sh <shell-pid> <log-file-or-empty> <source> <form>
# Helpers for the board's test library (myshape/test/lib.sh):
#   signal-guard.sh --start-of <pid>   the start time the root markers record
#   signal-guard.sh --root-ok <root>   exit 0 when <root> counts as a scratch
#                                      root of this run (the test below)
# where <form> is one of
#   <pid>              a child of the signalling shell: its live parent is it
#   --identity <pid>   a process whose command line names a scratch root of
#                      this run
#
# --send must be run by the signalling shell as a plain command, not in $(...)
# or a subshell, so that its parent is that shell (myshape/test/signal-lib.sh's
# sig_send does that). It prints one verdict line. It exits 0 when the target
# was accepted and, outside log-only mode, signalled; 1 when it was refused
# (nothing is sent); 2 on a usage error; 3 when an accepted target was gone by
# the time of the send. The verdict-only form prints its verdict and exits 0,
# or 2 on a usage error.
#
# Log-only mode is FM_TEST_SIGNAL_DRY_RUN set (1 or unfixed) with
# FM_TEST_SIGNAL_LOG an absolute path: nothing is sent and each call appends
# its record to that log. With FM_TEST_SIGNAL_LOG set and no log-only mode the
# record is written too, and the signal is sent.
#
# Every form refuses: an argument that is not exactly one positive pid in
# digits with no leading 0; a signal other than TERM KILL STOP CONT; pid 1 or
# less; this program; the test script TB_TEST_SUITE_PID and its parent
# TB_TEST_SUITE_PARENT; the signalling shell, and each of its ancestors from
# the test script up (all of them when the test script is not among them); any
# process whose command line names systemd; a process that is not running; and
# everything when TB_TEST_SUITE_PID is empty, unset or not a pid.
#
# --identity accepts a process only when its command line contains a root of
# this run followed by "/", a space or its end. A root counts when it is listed
# in the registry file TB_TEST_ROOTS (written by myshape/test/lib.sh's
# fm_test_tmproot), is an absolute path strictly below TB_TEST_TMPDIR, is not
# "/", neither is nor contains $HOME or the checkout this program is in (the
# board's own command line names that checkout after --root), and holds the
# marker .myshape-test-root whose first line is TB_TEST_SUITE_PID and whose
# second line is that pid's start time, read again here from the live process.
# No other evidence counts: not the environment, not ancestry, not a group.
#
# A record is one line: the source, the raw arguments as received, the
# signalling shell, the target, its command line, the verdict with the
# evidence that held or why none did, and the target's ancestry up to pid 1.
set -u

GUARD_CHECKOUT=$(cd "$(dirname "$0")/../.." && pwd -P)

ps_field() {  # <field> <pid>: one field of <pid>, empty when it is gone.
  command -p ps -ww -o "$1=" -p "$2" 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

start_of() {  # <pid>: its start time, the identity a root marker records.
  LC_ALL=C command -p ps -o lstart= -p "$1" 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

is_pid() {  # <arg>: 0 when it is exactly one positive pid in digits.
  case "$1" in
    '' | 0* | *[!0-9]*) return 1 ;;
  esac
  return 0
}

root_ok() {  # <root>: 0 when <root> counts as a scratch root of this run.
  local root=$1 base=${TB_TEST_TMPDIR:-} home=${HOME:-} suite=${TB_TEST_SUITE_PID:-} owner started
  case "$root" in /?*) ;; *) return 1 ;; esac
  case "$root" in */ | *//* | */./* | */../* | */. | */..) return 1 ;; esac
  case "$base" in /?*) ;; *) return 1 ;; esac
  case "$root" in "$base"/?*) ;; *) return 1 ;; esac
  case "$home" in /?*) ;; *) return 1 ;; esac
  case "$home/" in "$root"/*) return 1 ;; esac
  case "$GUARD_CHECKOUT/" in "$root"/*) return 1 ;; esac
  is_pid "$suite" || return 1
  [ -f "$root/.myshape-test-root" ] && [ ! -L "$root/.myshape-test-root" ] || return 1
  owner=$(sed -n '1p' "$root/.myshape-test-root" 2>/dev/null)
  started=$(sed -n '2p' "$root/.myshape-test-root" 2>/dev/null)
  [ "$owner" = "$suite" ] && [ -n "$started" ] && [ "$started" = "$(start_of "$suite")" ]
}

path_evidence() {  # <pid>: prints the root of this run its command line names, or nothing.
  local args root
  [ -n "${TB_TEST_ROOTS:-}" ] && [ -f "$TB_TEST_ROOTS" ] || return 0
  args=" $(ps_field args "$1") "
  while IFS= read -r root; do
    root_ok "$root" || continue
    case "$args" in
      *"$root/"* | *"$root "*) printf '%s\n' "$root"; return 0 ;;
    esac
  done < "$TB_TEST_ROOTS"
}

protected_chain() {  # the signalling shell's ancestors from the test script up, or all of them.
  local chain=" " below=" " pid levels=0 seen=0
  pid=$(ps_field ppid "$self")
  while is_pid "$pid" && [ "$pid" -gt 1 ] && [ "$levels" -lt 64 ]; do
    [ "$pid" != "$suite_pid" ] || seen=1
    if [ "$seen" -eq 1 ]; then chain="$chain$pid "; else below="$below$pid "; fi
    pid=$(ps_field ppid "$pid")
    levels=$((levels + 1))
  done
  if [ "$seen" -eq 1 ]; then printf '%s\n' "$chain"; else printf '%s\n' "$below$chain"; fi
}

standing_refusal() {  # <pid>: why <pid> is refused whatever its form, or nothing.
  if ! is_pid "$suite_pid"; then
    echo "refused: TB_TEST_SUITE_PID is '$suite_pid', not a pid, so nothing is accepted"
  elif [ "$1" -le 1 ]; then
    echo "refused: pid $1 is 1 or less"
  elif [ "$1" = "$$" ]; then
    echo "refused: pid $1 is the guard itself"
  elif [ "$1" = "$suite_pid" ]; then
    echo "refused: pid $1 is the test script itself"
  elif [ "$1" = "${TB_TEST_SUITE_PARENT:-}" ]; then
    echo "refused: pid $1 is the test script's parent"
  elif [ "$1" = "$self" ]; then
    echo "refused: pid $1 is the signalling shell itself"
  elif [ -z "$command" ]; then
    echo "refused: pid $1 is not running"
  else
    case "$(protected_chain)" in
      *" $1 "*) echo "refused: pid $1 is an ancestor of the signalling shell $self at or above the test script"; return ;;
    esac
    case "$command" in
      *systemd*) echo "refused: pid $1 is the service manager '$command'" ;;
    esac
  fi
}

judge_child() {  # <pid>: the verdict on the own-child form.
  local refusal
  refusal=$(standing_refusal "$1")
  if [ -n "$refusal" ]; then
    echo "$refusal"
  elif [ "$(ps_field ppid "$1")" = "$self" ]; then
    echo "accepted $1 (evidence: its parent is the signalling shell $self)"
  else
    echo "refused: pid $1 is not a child of the signalling shell $self (its parent: $(ps_field ppid "$1"))"
  fi
}

judge_identity() {  # <pid>: the verdict on the --identity form.
  local refusal root
  refusal=$(standing_refusal "$1")
  if [ -n "$refusal" ]; then
    echo "$refusal"
    return
  fi
  root=$(path_evidence "$1")
  if [ -n "$root" ]; then
    echo "accepted $1 (evidence: path $root in its command line)"
  else
    echo "refused: pid $1 names no scratch root of this run in its command line"
  fi
}

log_line() {  # <verdict>: one record in the log, when there is one.
  local chain="" pid=$target levels=0
  [ -n "$log" ] || return 0
  while [ "$pid" != - ] && is_pid "$pid" && [ "$levels" -lt 64 ]; do
    chain="$chain < $pid $(ps_field args "$pid")"
    [ "$pid" -gt 1 ] || break
    pid=$(ps_field ppid "$pid")
    levels=$((levels + 1))
  done
  printf 'source=%s | raw: %s | shell=%s | target=%s command=%s | %s | ancestry: %s\n' \
    "$source" "$raw" "$self" "$target" "${command:--}" "$1" "${chain# < }" >> "$log"
}

send_signal() {  # <signal> <pid>: the one send of an accepted target.
  kill -s "$1" "$2" 2>/dev/null || sent_rc=3
}

usage() {
  echo "usage: signal-guard.sh --send <source> <signal> <pid> | --send <source> <signal> --identity <pid>" >&2
  echo "       signal-guard.sh <shell-pid> <log-file-or-empty> <source> <pid> | ... --identity <pid>" >&2
  echo "       signal-guard.sh --start-of <pid> | --root-ok <root>" >&2
  exit 2
}

case "${1-}" in
  --start-of)
    if [ "$#" -ne 2 ] || ! is_pid "$2"; then usage; fi
    start_of "$2"
    exit 0
    ;;
  --root-ok)
    [ "$#" -eq 2 ] || usage
    root_ok "$2"
    exit
    ;;
  --send)
    [ "$#" -ge 4 ] || usage
    mode=send
    self=$PPID
    source=$2
    signal=$3
    shift 3
    log=
    if [ -n "${FM_TEST_SIGNAL_DRY_RUN:-}" ]; then
      case "${FM_TEST_SIGNAL_LOG:-}" in
        /*) ;;
        *) echo "refused: log-only mode needs FM_TEST_SIGNAL_LOG, an absolute path" >&2; exit 2 ;;
      esac
    fi
    case "${FM_TEST_SIGNAL_LOG:-}" in /*) log=$FM_TEST_SIGNAL_LOG ;; esac
    ;;
  *)
    if [ "$#" -lt 4 ] || ! is_pid "$1"; then usage; fi
    mode=verdict
    self=$1
    log=$2
    source=$3
    signal=-
    shift 3
    case "$log" in '' | /*) ;; *) usage ;; esac
    ;;
esac

suite_pid=${TB_TEST_SUITE_PID:-}
raw="argc=$#"
for arg in "$@"; do raw="$raw [$arg]"; done
target=- command=-
if [ "$mode" = send ]; then
  case "$signal" in
    TERM | KILL | STOP | CONT) signal_ok=1 ;;
    *) signal_ok=0 ;;
  esac
else
  signal_ok=1
fi

if [ "$signal_ok" -eq 0 ]; then
  verdict="refused: '$signal' is not one of the signal names TERM KILL STOP CONT"
elif [ "${1-}" = --identity ]; then
  if [ "$#" -ne 2 ]; then
    verdict="refused: --identity takes exactly one pid, got $(($# - 1)) arguments"
  elif ! is_pid "$2"; then
    verdict="refused: '$2' is not a positive pid (a flag, a negative pid or a process group)"
  else
    target=$2
    command=$(ps_field args "$target")
    verdict=$(judge_identity "$target")
  fi
elif [ "$#" -ne 1 ]; then
  verdict="refused: takes exactly one pid, got $# arguments"
elif ! is_pid "$1"; then
  verdict="refused: '$1' is not a positive pid (a flag, a negative pid or a process group)"
else
  target=$1
  command=$(ps_field args "$target")
  verdict=$(judge_child "$target")
fi

log_line "$verdict"
printf '%s\n' "$verdict"
[ "$mode" = send ] || exit 0
case "$verdict" in
  "accepted "*) ;;
  *) exit 1 ;;
esac
sent_rc=0
[ -n "${FM_TEST_SIGNAL_DRY_RUN:-}" ] || send_signal "$signal" "$target"
exit "$sent_rc"
