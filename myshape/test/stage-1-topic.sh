#!/usr/bin/env bash
# Behavior of myshape.sh without the board service: list, the token guard,
# the old forms, usage, and that every write goes to the board service.
set -u

# shellcheck source=myshape/test/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot myshape-stage-1-topic)

test_list() {
  local home out
  home=$(tb_make_home list)
  tb_board_has_run "$home"
  out=$(tb_run "$home" "$TOPIC" list)
  assert_contains "$out" "還沒有議題" "empty list did not say so"
  tb_write_topics "$home"
  out=$(tb_run "$home" "$TOPIC" list)
  assert_contains "$out" "billing" "list missed a confirmed topic"
  assert_contains "$out" "idea" "list missed a topic that is in no queue"
  assert_not_contains "$out" "gone" "list showed an archived topic without --all"
  out=$(tb_run "$home" "$TOPIC" list --all)
  assert_contains "$out" "gone" "list --all missed the archived topic"
  out=$(tb_run "$home" "$TOPIC" list --all --json)
  assert_equals 'billing:confirmed:high:1' \
    "$(printf '%s' "$out" | jq -r '.[] | select(.id == "billing") | "\(.id):\(.status):\(.queue):\(.position)"')" \
    "list --json has the wrong shape for a queued topic"
  assert_equals 'archived' "$(printf '%s' "$out" | jq -r '.[] | select(.id == "gone") | .status')" \
    "list --json did not mark the archived topic"
  assert_equals 'confirmed:null' "$(printf '%s' "$out" | jq -r '.[] | select(.id == "idea") | "\(.status):\(.queue)"')" \
    "a leftover proposal is listed as a topic in no queue until the board confirms it"
  assert_not_contains "$out" "proposed" "list must not report a proposed state"
  pass "list prints topics, --all adds archived ones, --json is structured"
}

# list reads schedules.json without the service: a schedule follows a merged
# topic id, an open occurrence comes first ordered by rt, then its time, and
# one past its closes_by has ended.
test_list_schedules() {
  local home out
  home=$(tb_make_home list-schedules)
  tb_board_has_run "$home"
  tb_write_topics "$home"
  mkdir -p "$home/data/myshape"
  cat > "$home/data/myshape/schedules.json" <<'JSON'
{ "v": 1, "settings": {},
  "series": {
    "bill": { "topic": "old-billing", "title": "帳務", "rule": "weekly mon 10:00", "tz": "Asia/Taipei",
              "duration_min": null, "lead_min": null, "rt": "soft-rt", "rt_locked": false,
              "state": "on", "locked": true, "by": "captain", "created_at": "2026-11-01T00:00:00Z" },
    "park": { "topic": "parked", "title": "停著", "rule": "daily 06:00", "tz": "UTC",
              "duration_min": 30, "lead_min": 5, "rt": "hard-rt", "rt_locked": false,
              "state": "on", "locked": false, "by": "aggregator", "seen": false, "created_at": "2026-11-01T00:00:00Z" },
    "late": { "topic": "t2", "title": "登入", "rule": "daily 07:00", "tz": "UTC",
              "duration_min": null, "lead_min": null, "rt": "none", "rt_locked": false,
              "state": "on", "locked": false, "by": "captain", "created_at": "2026-11-01T00:00:00Z" } },
  "occurrences": {
    "bill:20991130T0200Z": { "series": "bill", "at": "2099-11-30T02:00:00Z", "state": "taken",
      "opened_at": "2099-11-30T01:45:00Z", "taken_at": "2099-11-30T02:01:00Z", "note": "晚點開",
      "closes_by": "2099-11-30T05:00:00Z" },
    "park:20991201T0600Z": { "series": "park", "at": "2099-12-01T06:00:00Z", "state": "upcoming",
      "opened_at": "2099-12-01T05:55:00Z", "closes_by": "2099-12-01T06:30:00Z" },
    "late:20200101T0700Z": { "series": "late", "at": "2020-01-01T07:00:00Z", "state": "due",
      "opened_at": "2020-01-01T06:45:00Z", "closes_by": "2020-01-01T08:00:00Z" } },
  "recent": {}, "removed": {} }
JSON
  out=$(tb_run "$home" "$TOPIC" list)
  assert_equals "$(printf 'parked\tnow\tupcoming\tpark:20991201T0600Z\t之後再說（hard-rt）\nbilling\tnow\ttaken\tbill:20991130T0200Z\t帳務重構（soft-rt）')" \
    "$(printf '%s\n' "$out" | head -n 2)" "list must put open occurrences first, hard-rt before soft-rt"
  assert_not_contains "$out" "late:20200101T0700Z" "an occurrence past its closes_by has ended"
  assert_contains "$out" "$(printf 'billing\tconfirmed\thigh\t1\t帳務重構')" "the topic keeps its own row"
  out=$(tb_run "$home" "$TOPIC" list --json)
  assert_equals 4 "$(printf '%s' "$out" | jq 'length')" "list --json must keep one row per topic"
  assert_equals "bill|soft-rt|true|bill:20991130T0200Z|taken|晚點開" \
    "$(printf '%s' "$out" | jq -r '.[] | select(.id == "billing")
      | "\(.schedule.id)|\(.schedule.rt)|\(.schedule.locked)|\(.occurrence.key)|\(.occurrence.state)|\(.occurrence.note)"')" \
    "list --json must put the schedule and its open occurrence on the topic's row"
  assert_equals "late|null" "$(printf '%s' "$out" | jq -r '.[] | select(.id == "t2") | "\(.schedule.id)|\(.occurrence)"')" \
    "an occurrence past its closes_by must not be listed as open"
  assert_equals "null|null" "$(printf '%s' "$out" | jq -r '.[] | select(.id == "idea") | "\(.schedule)|\(.occurrence)"')" \
    "a topic without a schedule must have null schedule and occurrence"
  printf 'not json' > "$home/data/myshape/schedules.json"
  expect_code 1 "$(tb_code "$home" "$TOPIC" list)" "list with an unreadable schedules.json"
  pass "list shows the open occurrences first and puts schedules on their topics' rows"
}

test_list_without_jq() {
  local home fakebin tool
  home=$(tb_make_home list-nojq)
  tb_board_has_run "$home"
  tb_write_topics "$home"
  fakebin=$(fm_fakebin "$home")
  for tool in bash dirname cat; do
    ln -s "$(command -v "$tool")" "$fakebin/$tool"
  done
  expect_code 1 "$(PATH="$fakebin" tb_code "$home" "$TOPIC" list)" "list without jq"
  pass "list without jq is refused"
}

# A home whose board never ran has no token; only open may run there, so a
# secondmate home, where session start never opens a board, refuses the rest.
test_refused_where_no_board_has_run() {
  local home out rc sub
  for home in "$(tb_make_home guard-main)" "$(tb_make_secondmate_home guard-sm sm1)"; do
    tb_write_topics "$home"
    for sub in list status stop restart reset-token find which create todo; do
      rc=0
      out=$(tb_run "$home" "$TOPIC" "$sub" x 2>&1) || rc=$?
      assert_equals 1 "$rc" "$sub must be refused in a home with no board token"
      assert_equals "這裡沒有看板（找不到 state/myshape/token）；要在這裡開看板先跑 myshape.sh open。" "$out" \
        "$sub must say why and name open"
    done
    assert_absent "$home/state/myshape" "a refused command must create nothing"
  done
  pass "every subcommand but open is refused where no board has run, and writes nothing"
}

# A split that names tasks is not this command's, and neither are the
# subcommands Firstmate's own commands took over. Here, where no board has run,
# a split with tasks meets the token guard (where one has, the board's own
# usage check refuses it: stage-7-standalone.sh); nothing is written either way.
test_old_forms_are_refused() {
  local home out rc form sub
  home=$(tb_make_home old-forms)
  tb_write_topics "$home"
  for form in "split billing Part --goal g task-1" "split billing Part --goal g --id p --reason r sm1/task-1"; do
    rc=0
    # shellcheck disable=SC2086 # each form is a list of words.
    out=$(tb_run "$home" "$TOPIC" $form 2>&1) || rc=$?
    assert_equals 1 "$rc" "the old form '$form' must be refused where no board has run"
    assert_equals "這裡沒有看板（找不到 state/myshape/token）；要在這裡開看板先跑 myshape.sh open。" "$out" \
      "the old form '$form' must meet the token guard"
  done
  for sub in tag setup install-rules order --in-home; do
    rc=0
    out=$(tb_run "$home" "$TOPIC" "$sub" x 2>&1) || rc=$?
    assert_equals 2 "$rc" "$sub must be a usage error"
    assert_equals "myshape.sh: 不認得的子命令：${sub}（myshape.sh --help 看用法）" "$out" "$sub must not be a subcommand"
  done
  assert_absent "$home/data/task-1" "an old form must write no tag"
  assert_absent "$home/config/fleet-ledger" "an old setup must not open the ledger"
  assert_absent "$home/data/captain.md" "an old install-rules must write no rules"
  assert_absent "$home/state/myshape" "an old form must not start a board"
  pass "split with tasks is refused, and Firstmate's subcommands are not this command's"
}

# bash 3.2 (the /bin/bash of macOS) reads the bytes of a non-ASCII character
# that directly follows "$name" as part of the name, and then fails on an
# unbound variable. Linux cannot show that failure, so the shape is checked.
# Firstmate's reader has the same check in fm-board/test/stage-1-read.sh.
test_variables_are_braced_before_wide_characters() {
  local script hits
  for script in myshape.sh myshape-lib.sh; do
    hits=$(LC_ALL=C grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~]' "$ROOT/bin/$script" || true)
    assert_equals "" "$hits" "$script: write \${name} when a non-ASCII character follows the variable"
  done
  pass "no variable is directly followed by a non-ASCII character"
}

# Guard 3.6: myshape.sh cannot change an item behind the board's back, as
# todo add and todo done once did through the backlog. Every subcommand its
# usage names, except list, is handed to the board's client (a node stand-in
# here that records its argv and starts nothing), nothing under data/ changes
# without the board, and every one that changes the board is an operation in
# the board's table (myshape/dist/ops.js OPERATIONS).
test_every_write_reaches_the_board() {
  local home fakebin log real_node sub op before ops subs case_args out
  real_node=$(command -v node) || { pass "skip: node not found"; return 0; }
  home=$(tb_make_home writes)
  tb_free_port > "$home/config/myshape-port"
  tb_board_has_run "$home"
  tb_write_topics "$home"
  fakebin=$(fm_fakebin "$home")
  log="$home/node-argv.log"
  cat > "$fakebin/node" <<SH
#!/usr/bin/env bash
if [ "\$1" = "-p" ]; then echo 22; exit 0; fi
printf '%s\\n' "\$*" >> "$log"
cat > /dev/null
SH
  chmod +x "$fakebin/node"
  before=$(cd "$home/data" && find . -type f -exec cksum {} + | sort)
  subs=$(tb_run "$home" "$TOPIC" --help |
    sed -nE 's/^[[:space:]]+myshape\.sh ((todo|schedule) [a-z-]+|[a-z][a-z-]*( \| [a-z][a-z-]*)*).*/\1/p' |
    tr '|' '\n' | sed 's/^ *//; s/ *$//' | sort -u)
  [ -n "$subs" ] || fail "--help names no subcommand"
  ops=$("$real_node" --input-type=module -e "import('$ROOT/myshape/dist/ops.js').then((m) => console.log(Object.keys(m.OPERATIONS).join('\\n')))") ||
    fail "could not read the operation table from myshape/dist/ops.js"
  while IFS= read -r sub; do
    case "$sub" in
      list | hashtags) continue ;;
      create) case_args='create N --goal g' ;;
      merge) case_args='merge billing login' ;;
      close-propose) case_args='close-propose billing --reason r' ;;
      move) case_args='move billing high' ;;
      rename) case_args='rename billing N' ;;
      split) case_args='split billing P --goal g' ;;
      goal) case_args='goal billing g' ;;
      archive) case_args='archive billing' ;;
      reopen) case_args='reopen gone' ;;
      summary | retract) case_args="$sub task-1 ready -" ;;
      which) case_args='which task-1' ;;
      find) case_args='find billing' ;;
      hashtag) case_args='hashtag billing +AI_INFRA' ;;
      open | status | stop | restart | reset-token) case_args=$sub ;;
      'todo add') case_args='todo add item-1 T --topic billing --do d' ;;
      'todo done') case_args='todo done item-1' ;;
      'todo failed') case_args='todo failed item-1 --reason r' ;;
      'todo obsolete') case_args='todo obsolete item-1 --reason r' ;;
      'schedule add') case_args='schedule add parked --daily --at 06:00' ;;
      'schedule edit') case_args='schedule edit parked --at 07:00' ;;
      'schedule pause' | 'schedule resume' | 'schedule skip' | 'schedule delete') case_args="$sub parked" ;;
      'schedule rt') case_args='schedule rt parked hard-rt' ;;
      'schedule take') case_args='schedule take parked:20991130T0200Z' ;;
      'schedule close') case_args='schedule close parked:20991130T0200Z done' ;;
      'schedule tick') case_args='schedule tick' ;;
      *) fail "myshape.sh $sub has no case here: add one, and an operation for it if it changes the board" ;;
    esac
    : > "$log"
    # shellcheck disable=SC2086 # each case is a list of words.
    out=$(printf 'text\n' | PATH="$fakebin:$PATH" tb_run "$home" "$TOPIC" $case_args 2>&1) ||
      fail "myshape.sh $sub failed before reaching the board: $out"
    op=${sub/todo /todo-}
    op=${op/schedule /schedule-}
    assert_contains "$(cat "$log")" "-- $op" "myshape.sh $sub must hand $op to the board's client"
    # The client turns hashtag +NAME into the hashtag-add operation.
    [ "$op" != hashtag ] || op=hashtag-add
    case "$sub" in
      # schedule tick runs the board's own clock check; it is no operation of the table.
      open | status | stop | restart | reset-token | summary | retract | which | find | 'schedule tick') ;;
      *) printf '%s\n' "$ops" | grep -qxF "$op" || fail "myshape.sh $sub changes the board but $op is not an operation in OPERATIONS" ;;
    esac
  done <<< "$subs"
  assert_equals "$before" "$(cd "$home/data" && find . -type f -exec cksum {} + | sort)" \
    "myshape.sh must not change data/ without the board"
  pass "every myshape.sh write is handed to the board, and every change is a board operation"
}

test_usage() {
  local home out
  home=$(tb_make_home usage)
  expect_code 2 "$(tb_code "$home" "$TOPIC" no-such-subcommand)" "unknown subcommand"
  expect_code 2 "$(tb_code "$home" "$TOPIC")" "no subcommand"
  out=$(tb_run "$home" "$TOPIC" --help) || fail "--help needs no board"
  assert_contains "$out" "myshape.sh list" "--help printed no usage"
  pass "unknown subcommands are usage errors and --help prints usage"
}

fm_test_run test_list test_list_schedules test_list_without_jq test_refused_where_no_board_has_run \
  test_old_forms_are_refused test_variables_are_braced_before_wide_characters test_usage \
  test_every_write_reaches_the_board
