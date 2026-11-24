#!/usr/bin/env bash
# The board's line in the session-start digest: a full locked session start in
# a main home whose board has run reports the service as running, starts it
# when it is down, or says in one line why it could not; every other session
# start prints no line and starts nothing.
#
# Each case runs the real bin/fm-session-start.sh against a scratch home with
# its own board port, under a stand-in harness process named claude so the
# session lock behaves the same whatever runs the tests. The deferred network
# stage and the Herdr cleanup are replaced by no-ops in the scratch code root.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=fm-board/test/helpers.sh
. "$ROOT/fm-board/test/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "skip: node not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot tb-s2s)
HOLDERS=()
stop_holders() {
  local pid
  for pid in "${HOLDERS[@]+"${HOLDERS[@]}"}"; do
    fm_test_signal_children TERM "$pid" || true
    kill "$pid" 2>/dev/null || true
  done
}
trap 'stop_holders; tb_stop_boards; fm_test_cleanup' EXIT

# make_start_root <dir>: a scratch code root for session start.
make_start_root() {
  local name
  tb_make_fake_root "$1"
  for name in fm-startup-network.sh fm-herdr-session-cleanup.sh; do
    rm "$1/bin/$name"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$1/bin/$name"
    chmod +x "$1/bin/$name"
  done
}
FAKE_ROOT=$TMP_ROOT/root
make_start_root "$FAKE_ROOT"
HARNESS_DIR=$TMP_ROOT/harness
mkdir -p "$HARNESS_DIR"
# /bin/bash, not env, and no exec: the process must keep the name claude for
# the session lock to recognize it as a harness.
printf '#!/bin/bash\n"$@"\n' > "$HARNESS_DIR/claude"
chmod +x "$HARNESS_DIR/claude"
"$HARNESS_DIR/claude" sleep 5 &
probe=$!
sleep 0.2
probe_name=$(ps -o comm= -p "$probe" 2>/dev/null || true)
fm_test_signal_children TERM "$probe" || true
kill "$probe" 2>/dev/null || true
if [ "${probe_name##*/}" != claude ]; then
  echo "skip: this platform names a script's process '${probe_name##*/}', so the stand-in harness is not seen as claude"
  exit 0
fi

# session_start <home> [args...]: the digest of one session start in <home>,
# with $START_ROOT (default $FAKE_ROOT) as the code root.
session_start() {
  local home=$1 root=${START_ROOT:-$FAKE_ROOT}
  shift
  env -u CLAUDECODE -u PI_CODING_AGENT -u FM_PI_HARNESS -u GROK_AGENT \
    FM_HOME="$home" FM_ROOT_OVERRIDE="$root" \
    "$HARNESS_DIR/claude" "$root/bin/fm-session-start.sh" "$@" 2>&1
}

# board_lines <digest>: the digest's board lines.
board_lines() {
  printf '%s\n' "$1" | grep '^看板服務：' || true
}

# used_home <name>: a main home whose board has run once and is stopped now.
used_home() {
  local home
  home=$(tb_make_service_home "$1")
  tb_run "$home" "$TOPIC" open >/dev/null || fail "the board did not start in $home"
  tb_run "$home" "$TOPIC" stop >/dev/null || fail "the board did not stop in $home"
  printf '%s\n' "$home"
}

assert_no_token() {  # <digest> <home>
  assert_not_contains "$1" "#t=" "the digest must not carry the board URL"
  assert_not_contains "$1" "$(cat "$2/state/myshape/token")" "the digest must not carry the token"
}

test_reports_a_running_board_without_touching_it() {
  local home out pid
  home=$(tb_make_service_home running)
  tb_bind_home "$home"
  tb_run "$home" "$TOPIC" open >/dev/null || fail "the board did not start"
  pid=$(tb_board_pid "$home")
  out=$(session_start "$home")
  assert_contains "$out" "NEXT STEP" "the digest must complete"
  assert_equals "看板服務：在跑" "$(board_lines "$out")" "a running board must get exactly the running line"
  assert_equals "$pid" "$(tb_board_pid "$home")" "a running board must not be replaced"
  assert_equals 1 "$(tb_board_count "$home")" "session start must not start a second board"
  assert_no_token "$out" "$home"
  tb_run "$home" "$TOPIC" stop >/dev/null
  pass "a running board is reported in one line and left alone"
}

test_starts_a_stopped_board() {
  local home out
  home=$(used_home stopped)
  tb_bind_home "$home"
  out=$(session_start "$home")
  assert_equals "看板服務：原本沒在跑，已啟動" "$(board_lines "$out")" "a stopped board must get exactly the started line"
  assert_equals 1 "$(tb_board_count "$home")" "session start must leave exactly one board"
  assert_contains "$(tb_run "$home" "$TOPIC" status)" "看板服務：在跑" "the board must answer after session start"
  assert_no_token "$out" "$home"
  tb_run "$home" "$TOPIC" stop >/dev/null
  pass "a stopped board is started and reported in one line"
}

test_restarts_a_board_that_does_not_answer() {
  local home out pid
  home=$(tb_make_service_home hung)
  tb_bind_home "$home"
  tb_run "$home" "$TOPIC" open >/dev/null || fail "the board did not start"
  pid=$(tb_board_pid "$home")
  fm_test_signal STOP --identity "$pid"
  fm_test_signal_skipped "a board that does not answer is replaced" && return 0
  out=$(session_start "$home")
  assert_equals "看板服務：原本沒有回應，已重新啟動" "$(board_lines "$out")" \
    "a board that does not answer must get exactly the restarted line"
  kill -0 "$pid" 2>/dev/null && fail "the board that did not answer must be gone"
  assert_equals 1 "$(tb_board_count "$home")" "exactly one board must remain"
  assert_no_token "$out" "$home"
  tb_run "$home" "$TOPIC" stop >/dev/null
  pass "a board that does not answer is replaced and reported in one line"
}

test_reports_why_a_board_could_not_start() {
  local home out port listener
  home=$(used_home occupied)
  tb_bind_home "$home"
  port=$(cat "$home/config/myshape-port")
  node -e 'require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$port" &
  listener=$!
  HOLDERS+=("$listener")
  for _ in $(seq 50); do
    [ -z "$(tb_listeners "$port")" ] || break
    sleep 0.1
  done
  [ -n "$(tb_listeners "$port")" ] || fail "the stand-in listener did not take port $port"
  out=$(session_start "$home")
  kill "$listener" 2>/dev/null || true
  assert_equals "看板服務：無法啟動：埠 $port 被別的程式佔用。在 config/myshape-port 寫另一個埠號。" \
    "$(board_lines "$out")" "an occupied port must give one line with the reason"
  assert_equals 0 "$(tb_board_count "$home")" "a failed start must leave no board"

  printf 'abc\n' > "$home/config/myshape-port"
  out=$(session_start "$home")
  assert_equals 1 "$(board_lines "$out" | wc -l | tr -d ' ')" "an invalid port file must give exactly one line"
  assert_contains "$(board_lines "$out")" \
    "看板服務：無法啟動：config/myshape-port 不是 1024 到 65535 的埠號。" \
    "an invalid port file must be named in the line"
  assert_not_contains "$out" "這次的要求沒有寫入" "the line must not claim a request was refused"
  assert_equals 0 "$(tb_board_count "$home")" "an invalid port file must leave no board"
  pass "a board that cannot start is reported in one line with the reason"
}

# The client's own timeout reason spans several lines (the service log's tail),
# and open prints the URL with the token even when it then fails; a stand-in
# myshape.sh gives both without waiting out the real 10 seconds.
test_reduces_a_multi_line_reason_to_one_line() {
  local home out root=$TMP_ROOT/root-multiline
  make_start_root "$root"
  rm "$root/bin/myshape.sh"
  cat > "$root/bin/myshape.sh" <<'SH'
#!/usr/bin/env bash
case "$1" in
  status) printf '看板服務：沒在跑\n' ;;
  open)
    printf 'http://127.0.0.1:1/#t=stand-in-secret\n'
    printf '看板服務無法啟動：10 秒內沒有就緒。看 /x/service.log 找原因，最後幾行：\nlog line one\nlog line two\n修好後再試。這次的要求沒有寫入。\n' >&2
    exit 69
    ;;
esac
SH
  chmod +x "$root/bin/myshape.sh"
  home=$(tb_make_service_home multiline)
  tb_bind_home "$home"
  mkdir -p "$home/state/myshape"
  printf 'stand-in-secret\n' > "$home/state/myshape/token"
  out=$(START_ROOT=$root session_start "$home")
  assert_equals "看板服務：無法啟動：10 秒內沒有就緒。看 /x/service.log 找原因" "$(board_lines "$out")" \
    "a multi-line reason must become its first line without the framing"
  assert_not_contains "$out" "log line one" "the log tail must not reach the digest"
  assert_no_token "$out" "$home"
  pass "a multi-line reason is reduced to one line and open's URL is discarded"
}

test_secondmate_home_gets_nothing() {
  local home out
  home=$(used_home secondmate)
  printf 'sm1\n' > "$home/.fm-secondmate-home"
  out=$(session_start "$home")
  assert_contains "$out" "NEXT STEP" "the digest must complete"
  assert_equals "" "$(board_lines "$out")" "a secondmate home must get no board line"
  assert_equals 0 "$(tb_board_count "$home")" "a secondmate home must not start a board"
  pass "a secondmate home gets no board line and no board"
}

test_main_home_without_the_board_gets_nothing() {
  local home out
  home=$(tb_make_service_home unused)
  tb_run "$home" "$BOARD" setup >/dev/null
  tb_run "$home" "$BOARD" install-rules >/dev/null 2>&1 || fail "install-rules failed"
  out=$(session_start "$home")
  assert_contains "$out" "NEXT STEP" "the digest must complete"
  assert_equals "" "$(board_lines "$out")" "a main home whose board never ran must get no board line"
  assert_equals 0 "$(tb_board_count "$home")" "a main home whose board never ran must not start one"
  pass "a main home whose board never ran gets no board line and no board"
}

test_read_only_session_gets_nothing() {
  local home out holder
  home=$(used_home readonly)
  printf '#!/bin/bash\nsleep 300\n' > "$TMP_ROOT/claude"
  chmod +x "$TMP_ROOT/claude"
  "$TMP_ROOT/claude" &
  holder=$!
  HOLDERS+=("$holder")
  printf '%s\n' "$holder" > "$home/state/.lock"
  out=$(session_start "$home")
  assert_contains "$out" "READ-ONLY SESSION" "the session must be refused the lock"
  assert_contains "$out" "NEXT STEP" "the digest must complete"
  assert_equals "" "$(board_lines "$out")" "a read-only session must print no board line"
  assert_equals 0 "$(tb_board_count "$home")" "a read-only session must not start a board"
  pass "a lock-refused session gets no board line and no board"
}

test_reemit_gets_nothing() {
  local home out
  home=$(used_home reemit)
  out=$(session_start "$home" --reemit)
  assert_contains "$out" "SESSION START (CONTEXT RE-EMIT)" "the run must be a context re-emit"
  assert_equals "" "$(board_lines "$out")" "a context re-emit must print no board line"
  assert_equals 0 "$(tb_board_count "$home")" "a context re-emit must not start a board"
  pass "a context re-emit gets no board line and no board"
}

fm_test_run test_reports_a_running_board_without_touching_it test_starts_a_stopped_board \
  test_restarts_a_board_that_does_not_answer test_reports_why_a_board_could_not_start test_reduces_a_multi_line_reason_to_one_line \
  test_secondmate_home_gets_nothing \
  test_main_home_without_the_board_gets_nothing test_read_only_session_gets_nothing \
  test_reemit_gets_nothing
