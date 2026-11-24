#!/usr/bin/env bash
# Static check of the board's whole test tree (signal policy P-010): every
# text file under myshape/test, the stand-ins the tests write included, since
# their text lives in these files. No file is exempt. Comment lines are not
# checked (shell "#" lines; in .mjs and .js files also "//", "/*" and "*").
#   - no line may combine a signal with a pid found by walking up the process
#     tree ($PPID, a ppid field or getppid, or /proc/<pid>/stat): a wrapper
#     that execs, or a parent that dies first, moves that pid one level up,
#     and on a desktop the parent of an orphan is the user's service manager,
#     so signalling it ends the login;
#   - no line may use the pattern-based or group signal commands (p-, -all,
#     s-, snice, -pg);
#   - the only shell signal command is the one send line of the guard,
#     myshape/test/signal-guard.sh; the only other shell form allowed is the
#     probe that sends nothing, the signal command with -0 and one quoted
#     variable;
#   - the only JavaScript signal calls, in any file, are the browser driver's
#     own child process (myshape/test/kit/browser.mjs, one pinned line) and
#     process probes with signal 0.
# It also sources the kit and runs its exit helper tb_stop_boards with no
# usable scratch root, and runs the library's fm_test_cleanup with a registry
# naming no usable root, and requires that none of them ran a command it
# could reach through PATH. Firstmate's directories (fm-board/test,
# dispatch-plan/test) are checked by Firstmate's tests/check-signals.sh.
#
# Usage: myshape/test/check-signals.sh
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$TEST_DIR/../.." && pwd)"
[ "$#" -eq 0 ] || { echo "usage: myshape/test/check-signals.sh (it takes no arguments)" >&2; exit 2; }
signal='kill'
nice='nice'
ancestor='PPID|ppid|getppid|/proc/[^ ]*/stat'
banned="p${signal}|${signal}all|s${signal}|s${nice}|${signal}pg"
guard_file="$TEST_DIR/signal-guard.sh"
guard_line="  ${signal} -s \"\$1\" \"\$2\" 2>/dev/null || sent_rc=3"
browser_file="$TEST_DIR/kit/browser.mjs"
browser_line="  firefox.${signal}(\"SIGKILL\");"
problems=""

# code_lines <extended regex>: "file:line:text" of every matching line that is
# not a comment.
code_lines() {
  grep -rnIE "$1" "$TEST_DIR" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' |
    grep -vE '^[^:]+\.(mjs|js):[0-9]+:[[:space:]]*(//|/\*|\*)' || true
}

# text_of <file:line:text>: the text part of a code_lines line.
text_of() {
  awk '{ split($0, part, ":"); print substr($0, length(part[1]) + length(part[2]) + 3) }'
}

hits=$(code_lines "${signal}.*(${ancestor})|(${ancestor}).*${signal}")
[ -z "$hits" ] || problems="${problems}a signal sent to a pid found through its ancestry:
$hits
"
hits=$(code_lines "(^|[^[:alnum:]_-])(${banned})([^[:alnum:]_-]|\$)")
[ -z "$hits" ] || problems="${problems}a pattern-based signal command:
$hits
"

# Shell: each line with a signal command, its probes taken out, must be the
# guard's send line or have nothing left.
shell_word="(^|[^[:alnum:]_-])${signal}([[:space:]]|\$)"
probe="(^|[^[:alnum:]_-])${signal} -0 \"\\\$[A-Za-z_][A-Za-z0-9_]*\"([^[:alnum:]_]|\$)"
guard_found=0
others=""
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  file=${hit%%:*}
  text=$(printf '%s\n' "$hit" | text_of)
  if [ "$file" = "$guard_file" ] && [ "$text" = "$guard_line" ]; then
    guard_found=$((guard_found + 1))
    continue
  fi
  case "$file" in *.mjs | *.js) continue ;; esac
  rest=$(printf '%s\n' "$text" | sed -E "s/${probe}/\\1\\2/g")
  if printf '%s\n' "$rest" | grep -qE "$shell_word"; then
    others="$others$hit
"
  fi
done <<EOF
$(code_lines "$shell_word")
EOF
[ -z "$others" ] || problems="${problems}a signal command outside the guard, other than a probe:
$others"
[ "$guard_found" -eq 1 ] || problems="${problems}the guard's one send line was found $guard_found times in $guard_file, not once
"

# JavaScript, in any file (a .mjs, or node code a shell file runs): every
# .kill( must be the pinned child-process line or a signal-0 probe.
js_call="\\.${signal}\\("
js_probe="process\\.${signal}\\([A-Za-z_][A-Za-z0-9_.]*, 0\\)"
browser_found=0
others=""
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  file=${hit%%:*}
  text=$(printf '%s\n' "$hit" | text_of)
  if [ "$file" = "$browser_file" ] && [ "$text" = "$browser_line" ]; then
    browser_found=$((browser_found + 1))
    continue
  fi
  rest=$(printf '%s\n' "$text" | sed -E "s/${js_probe}//g")
  if printf '%s\n' "$rest" | grep -qE "$js_call"; then
    others="$others$hit
"
  fi
done <<EOF
$(code_lines "$js_call")
EOF
[ -z "$others" ] || problems="${problems}a signal call in JavaScript other than the driver's own child or a signal-0 probe:
$others"
[ "$browser_found" -eq 1 ] || problems="${problems}the browser driver's child-process line was found $browser_found times in $browser_file, not once
"

# tb_stop_boards with no usable scratch root, and fm_test_cleanup with a
# registry that names no usable root, must run nothing: every command they
# could reach is a stub that records being run. The stub names are built from
# parts so this file's own text is not a finding.
stubs=$(mktemp -d "${TMPDIR:-/tmp}/check-signals.XXXXXX")
for name in pgrep "p${signal}" "${signal}all" node ps sed sleep tr awk find; do
  printf '#!/bin/sh\nprintf "%%s %%s\\n" %s "$*" >> %s/ran\n' "$name" "$stubs" > "$stubs/$name"
  chmod +x "$stubs/$name"
done
stop_without_root() {  # <scratch>: the kit's tb_stop_boards with that TMP_ROOT, stubs first on PATH.
  PATH="$stubs:$PATH"
  ROOT=$ROOT_DIR
  TMP_ROOT=$1
  # shellcheck source=myshape/test/kit/helpers.sh
  . "$TEST_DIR/kit/helpers.sh"
  tb_stop_boards
}
cleanup_without_root() {  # the library's fm_test_cleanup on a registry naming no usable root.
  TMPDIR=$stubs
  # shellcheck source=myshape/test/lib.sh
  . "$TEST_DIR/lib.sh"
  trap - EXIT
  TB_TEST_ROOTS=$stubs/registry
  PATH="$stubs:$PATH"
  fm_test_cleanup
}
for scratch in "" "relative/root" "/"; do
  (stop_without_root "$scratch") || problems="${problems}tb_stop_boards failed with TMP_ROOT '$scratch'
"
done
printf '%s\n' "" "relative/root" "/" "$stubs" > "$stubs/registry"
(cleanup_without_root) >/dev/null 2>&1 ||
  problems="${problems}fm_test_cleanup failed with a registry naming no usable root
"
if [ -s "$stubs/ran" ]; then
  problems="${problems}tb_stop_boards or fm_test_cleanup ran commands without a usable scratch root:
$(cat "$stubs/ran")
"
fi
[ -d "$stubs" ] || problems="${problems}fm_test_cleanup removed $stubs, which is not a scratch root of its run
"
rm -r "$stubs"

if [ -n "$problems" ]; then
  printf 'not ok - signal check:\n%s' "$problems" >&2
  exit 1
fi
printf 'ok - the board test tree sends signals only through its guard, never by ancestry\n'
