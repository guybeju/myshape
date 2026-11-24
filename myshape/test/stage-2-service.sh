#!/usr/bin/env bash
# The board service's lifecycle as myshape.sh users see it: on-demand start,
# one instance per home, recovery from crashes and stale files, replacement on
# a code or port change, and the startup failures that exit 69.
set -u

# shellcheck source=myshape/test/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "skip: node not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot tb-s2)
trap 'tb_stop_boards; fm_test_cleanup' EXIT

test_starts_on_demand_and_stays_single() {
  local home out pid
  home=$(tb_make_service_home demand)
  # A home's first open starts its board; later commands start it when it is down.
  tb_run "$home" "$TOPIC" open >/dev/null || fail "open must start the board"
  tb_run "$home" "$TOPIC" stop >/dev/null || fail "stop must stop the board"
  out=$(tb_run "$home" "$TOPIC" status)
  assert_contains "$out" "沒在跑" "status must report a stopped board"
  assert_equals 0 "$(tb_board_count "$home")" "status must not start the board"
  tb_run "$home" "$TOPIC" stop >/dev/null || fail "stop on a stopped board must succeed"
  assert_equals 0 "$(tb_board_count "$home")" "stop must not start the board"

  tb_run "$home" "$TOPIC" create "First" --goal "one" >/dev/null &
  tb_run "$home" "$TOPIC" create "Second" --goal "two" >/dev/null &
  tb_run "$home" "$TOPIC" create "Third" --goal "three" >/dev/null &
  wait
  assert_equals 1 "$(tb_board_count "$home")" "concurrent commands must leave exactly one board"
  assert_equals 3 "$(tb_run "$home" "$TOPIC" list --json | jq 'length')" "every concurrent create must be stored"
  pid=$(tb_board_pid "$home")
  tb_run "$home" "$TOPIC" create "Fourth" --goal "four" >/dev/null
  assert_equals "$pid" "$(tb_board_pid "$home")" "a later command must reuse the running board"

  out=$(tb_run "$home" "$TOPIC" status)
  assert_contains "$out" "在跑" "status must report a running board"
  assert_contains "$out" "pid：$pid" "status must print the pid"
  assert_contains "$out" "events.jsonl：" "status must print the event file size"
  assert_equals "srw-------" "$(tb_mode "$home/state/myshape/board.sock")" "the socket must be 0600"
  assert_equals "-rw-------" "$(tb_mode "$home/state/myshape/token")" "the token must be 0600"
  assert_equals "drwx------" "$(tb_mode "$home/state/myshape")" "the runtime directory must be 0700"
  out=$(tb_run "$home" "$TOPIC" open)
  assert_equals "http://127.0.0.1:$(cat "$home/config/myshape-port")/#t=$(cat "$home/state/myshape/token")" "$out" \
    "open must print the board URL with the token in the fragment"

  tb_run "$home" "$TOPIC" stop >/dev/null
  assert_equals 0 "$(tb_board_count "$home")" "stop must end the board"
  assert_absent "$home/state/myshape/board.sock" "stop must remove the socket"
  pass "the board starts on demand, stays single, and stops on request"
}

test_recovers_from_a_crash() {
  local home pid i
  home=$(tb_make_service_home crash)
  tb_run "$home" "$TOPIC" open >/dev/null
  tb_run "$home" "$TOPIC" create "Keep me" --goal "survive" --id keep >/dev/null
  pid=$(tb_board_pid "$home")
  fm_test_signal KILL --identity "$pid"
  fm_test_signal_skipped "a crashed board is restarted" && return 0
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 100 ]; do
    sleep 0.1
    i=$((i + 1))
  done
  ! kill -0 "$pid" 2>/dev/null || fail "the killed board must be gone within 10 s"
  assert_present "$home/state/myshape/board.sock" "a killed board leaves its socket file behind"
  printf 'garbage' > "$home/data/topics.json.tmp-99999"
  printf '{"src":"board","half' >> "$home/data/myshape/events.jsonl"
  jq -e '.topics.keep.status == "confirmed"' "$home/data/topics.json" >/dev/null ||
    fail "topics.json must be complete JSON after a hard kill"

  tb_run "$home" "$TOPIC" rename keep "Still here" >/dev/null || fail "the next command must restart a crashed board"
  assert_not_equals "$pid" "$(tb_board_pid "$home")" "a new board must have replaced the killed one"
  assert_absent "$home/data/topics.json.tmp-99999" "a stale temp file must be removed at startup"
  assert_equals 2 "$(wc -l < "$home/data/myshape/events.jsonl" | tr -d ' ')" \
    "a half-written event line must be cut off at startup, leaving the create and the rename records"
  assert_equals 0 "$(grep -c 'half' "$home/data/myshape/events.jsonl")" "the half-written line must be gone"
  tail -c 1 "$home/data/myshape/events.jsonl" | od -An -c | grep -q '\\n' ||
    fail "events.jsonl must end with a newline after recovery"
  tb_run "$home" "$TOPIC" stop >/dev/null
  pass "a crashed board is restarted and its leftovers are cleaned up"
}

test_replaces_a_hung_board() {
  local home pid
  home=$(tb_make_service_home hung)
  tb_run "$home" "$TOPIC" open >/dev/null
  tb_run "$home" "$TOPIC" create "Hang" --goal "wait" --id hang >/dev/null
  pid=$(tb_board_pid "$home")
  fm_test_signal STOP --identity "$pid"
  fm_test_signal_skipped "a hung board is replaced" && return 0
  tb_run "$home" "$TOPIC" goal hang "moved on" >/dev/null || fail "a command must get past a hung board"
  assert_not_equals "$pid" "$(tb_board_pid "$home")" "the hung board must have been replaced"
  kill -0 "$pid" 2>/dev/null && fail "the hung board must be dead"
  assert_equals 1 "$(tb_board_count "$home")" "exactly one board must remain"
  tb_run "$home" "$TOPIC" stop >/dev/null
  pass "a board that stops answering is killed and replaced"
}

# A private code root in its own git repo, so the test controls its commit.
make_code_root() {
  local root=$TMP_ROOT/$1
  fm_git_init_commit "$root"
  mkdir -p "$root/bin" "$root/myshape"
  cp "$ROOT"/bin/myshape.sh "$ROOT"/bin/myshape-lib.sh "$root/bin/"
  ln -s "$ROOT/myshape/dist" "$root/myshape/dist"
  printf '%s\n' "$root"
}

test_replaces_the_board_when_code_or_port_changes() {
  local home root pid
  home=$(tb_make_service_home replace)
  root=$(make_code_root replace-root)
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" open >/dev/null
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" create "V1" --goal "old code" >/dev/null
  pid=$(tb_board_pid "$home")
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" status | grep -q "restart" &&
    fail "status must not ask for a restart while the board runs the checked-out code"
  git -C "$root" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m "new code"
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" status |
    grep -q "目前的程式是 $(git -C "$root" rev-parse HEAD)" ||
    fail "status must say the board runs older code than the checkout"
  assert_equals "$pid" "$(tb_board_pid "$home")" "status must not replace the board"
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" create "V2" --goal "new code" >/dev/null
  assert_not_equals "$pid" "$(tb_board_pid "$home")" "a new code commit must replace the running board"
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" status | grep -q "$(git -C "$root" rev-parse HEAD)" ||
    fail "the replacement must report the new commit"

  pid=$(tb_board_pid "$home")
  tb_free_port > "$home/config/myshape-port"
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" create "V3" --goal "new port" >/dev/null
  assert_not_equals "$pid" "$(tb_board_pid "$home")" "a new port must replace the running board"
  assert_equals "$(cat "$home/config/myshape-port")" "$(cat "$home/state/myshape/port")" \
    "the replacement must listen on the configured port"
  assert_equals 1 "$(tb_board_count "$home")" "exactly one board must remain"

  pid=$(tb_board_pid "$home")
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" status >/dev/null
  git -C "$root" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m "newer code"
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" status >/dev/null
  assert_equals "$pid" "$(tb_board_pid "$home")" "status must never replace the board"
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" restart >/dev/null
  assert_not_equals "$pid" "$(tb_board_pid "$home")" "restart must replace the board"
  MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" stop >/dev/null
  pass "a code or port change replaces the board on the next command; status never does"
}

test_startup_failures_exit_69() {
  local home root out rc holder port fakebin tool
  # Each home's board has run before, so the command tries to start it again.
  home=$(tb_make_service_home fail-port)
  tb_board_has_run "$home"
  port=$(cat "$home/config/myshape-port")
  node -e 'require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1"); setTimeout(() => process.exit(0), 60000);' "$port" &
  holder=$!
  sleep 0.5
  rc=0
  out=$(tb_run "$home" "$TOPIC" create "Blocked" --goal "port taken" 2>&1) || rc=$?
  fm_test_signal TERM "$holder"
  assert_equals 69 "$rc" "a port held by another program must exit 69"
  assert_equals "看板服務無法啟動：埠 $port 被別的程式佔用。在 config/myshape-port 寫另一個埠號。這次的要求沒有寫入。" "$out" \
    "the port failure must be the one documented line"
  assert_absent "$home/data/topics.json" "a failed start must not write the topic file"

  printf 'not-a-port\n' > "$home/config/myshape-port"
  expect_code 69 "$(tb_code "$home" "$TOPIC" create "Bad" --goal "port")" "an invalid configured port"

  home=$(tb_make_service_home fail-dist)
  tb_board_has_run "$home"
  root="$TMP_ROOT/no-dist-root"
  mkdir -p "$root/bin"
  cp "$ROOT"/bin/myshape.sh "$ROOT"/bin/myshape-lib.sh "$root/bin/"
  rc=0
  out=$(MYSHAPE_HOME="$home" MYSHAPE_ROOT_OVERRIDE="$root" "$root/bin/myshape.sh" create "X" --goal "y" 2>&1) || rc=$?
  assert_equals 69 "$rc" "a missing build must exit 69"
  assert_equals "看板服務無法啟動：編譯結果不見了（$root/myshape/dist）。確認 checkout 完整。這次的要求沒有寫入。" "$out" \
    "the missing-build failure must say so, sending nobody to another tool"

  home=$(tb_make_service_home fail-json)
  tb_board_has_run "$home"
  printf 'not json' > "$home/data/topics.json"
  rc=0
  out=$(tb_run "$home" "$TOPIC" create "X" --goal "y" 2>&1) || rc=$?
  assert_equals 69 "$rc" "an unreadable topic file must exit 69"
  assert_contains "$out" "topics.json 讀不懂" "the unreadable-file failure must name the file"
  assert_equals "not json" "$(cat "$home/data/topics.json")" "an unreadable topic file must be left untouched"
  assert_equals 0 "$(tb_board_count "$home")" "a failed start must leave no board behind"

  home=$(tb_make_service_home fail-node)
  tb_board_has_run "$home"
  fakebin=$(fm_fakebin "$home")
  for tool in bash dirname cat env git wc tr; do
    ln -s "$(command -v "$tool")" "$fakebin/$tool"
  done
  rc=0
  out=$(PATH="$fakebin" tb_run "$home" "$TOPIC" create "X" --goal "y" 2>&1) || rc=$?
  assert_equals 69 "$rc" "a missing node must exit 69"
  assert_contains "$out" "沒有 node" "the missing-node failure must say so"
  out=$(PATH="$fakebin" tb_run "$home" "$TOPIC" status) || fail "status without node must still succeed"
  assert_contains "$out" "沒有 node" "status without node must explain why it cannot ask the board"
  expect_code 69 "$(PATH="$fakebin" tb_code "$home" "$TOPIC" stop)" "stop without node"

  home=$(tb_make_secondmate_home fail-sm sm1)
  rc=0
  out=$(tb_run "$home" "$TOPIC" create "X" --goal "y" 2>&1) || rc=$?
  assert_equals 1 "$rc" "a socket subcommand in a secondmate home must exit 1"
  assert_contains "$out" "這裡沒有看板" "the secondmate refusal must explain itself"
  assert_absent "$home/state/myshape" "a secondmate home must never start a board"
  pass "each startup failure exits 69 with its one-line reason and writes nothing"
}

test_survives_ops_named_after_object_builtins() {
  local home pid op out
  home=$(tb_make_service_home builtins)
  tb_run "$home" "$TOPIC" open >/dev/null || fail "the board did not start"
  pid=$(tb_board_pid "$home")
  for op in constructor __proto__ toString valueOf hasOwnProperty; do
    out=$(tb_op "$home" "$op" 2>&1) && fail "op $op must be refused, got: $out"
    assert_contains "$out" "不認得的 op" "op $op must be answered as an unknown op"
  done
  assert_equals "$pid" "$(tb_board_pid "$home")" "the board must not be replaced"
  kill -0 "$pid" 2>/dev/null || fail "the board died on an op named after an Object builtin"
  pass "an op named after an Object builtin is an unknown op, not a crash"
}

fm_test_run test_starts_on_demand_and_stays_single test_recovers_from_a_crash test_replaces_a_hung_board \
  test_replaces_the_board_when_code_or_port_changes test_startup_failures_exit_69 \
  test_survives_ops_named_after_object_builtins
