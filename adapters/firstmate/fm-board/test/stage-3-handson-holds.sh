#!/usr/bin/env bash
# Hands-on holds and the items an older board adopted from them. The code at
# OLD_BASE still adopted the main home's 動手： holds onto the board and closed
# an adopted item's hold when the item closed; this code does neither. Here a
# main home's board runs OLD_BASE's code from a scratch root (its bin/ and its
# board build, exported with git archive) and adopts two such holds, one of
# which the captain closes; then the same home runs this checkout's code. The
# board must read, show and close the old items as before, a hold still open
# shows as a decision, closing its item leaves that hold open and visible, a
# hands-on hold opened now is an ordinary decision, and going back to OLD_BASE
# adopts the open hold again. fm-inbox.sh, fm-send.sh, fm-captain-hold.sh and
# fm-on.sh are stand-ins in both roots (fm-board/test/helpers.sh). Every home is
# a scratch home with its own port.
# shellcheck disable=SC2016 # jq filters are literal text.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=fm-board/test/helpers.sh
. "$ROOT/fm-board/test/helpers.sh"
# shellcheck source=myshape/test/signal-lib.sh
. "$ROOT/myshape/test/signal-lib.sh"

OLD_BASE=cbe6e42a
LIVE_BOARD_PORT=47819

for tool in jq node curl git tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "skip: $tool not found"; exit 0; }
done
git -C "$ROOT" cat-file -e "$OLD_BASE^{commit}" 2>/dev/null || { echo "not ok - base $OLD_BASE is not in this checkout" >&2; exit 1; }
TMP_ROOT=$(fm_test_tmproot fm-board-s3h)
case "$TMP_ROOT" in /?*) ;; *) echo "not ok - no scratch root" >&2; exit 1 ;; esac
trap 'tb_stop_boards; sig_leftovers; fm_test_cleanup' EXIT
sig_init

unset FM_DATA_OVERRIDE FM_STATE_OVERRIDE FM_CONFIG_OVERRIDE FM_PROJECTS_OVERRIDE FM_TASK_ID FM_TASK_INBOX
export MYSHAPE_TEST=1 MYSHAPE_READ_MS=600000 MYSHAPE_RETRY_MS=200,200,200
export FM_SNAPSHOT_NOW=2026-07-25T00:00:00Z
export TB_LOG="$TMP_ROOT/calls.log" TB_PLAY="$TMP_ROOT/play" TB_REMOTES="$TMP_ROOT/remotes"
mkdir -p "$TB_PLAY" "$TB_REMOTES"
: > "$TB_LOG"

NEW=$TMP_ROOT/new-root
tb_make_fake_root "$NEW"

# old_root <dir>: a fake root like NEW whose every script and whose board build
# are OLD_BASE's own files, also the ones this checkout no longer has; the
# stand-ins and the fm-board.sh wrapper stay.
old_root() {
  local dir=$1 source=$TMP_ROOT/old-source path name
  tb_make_fake_root "$dir" >/dev/null
  mkdir -p "$source"
  git -C "$ROOT" archive "$OLD_BASE" bin myshape/dist myshape/public myshape/package.json | tar -x -C "$source"
  for path in "$dir"/bin/*; do
    [ -L "$path" ] || continue
    name=${path##*/}
    [ "$name" != fm-board-real.sh ] || name=fm-board.sh
    [ -f "$source/bin/$name" ] || continue
    rm "$path"
    cp -p "$source/bin/$name" "$path"
  done
  for path in "$source"/bin/*; do
    name=${path##*/}
    [ -e "$dir/bin/$name" ] || cp -p "$path" "$dir/bin/$name"
  done
  rm "$dir/myshape/dist"
  cp -R "$source/myshape/dist" "$source/myshape/public" "$source/myshape/package.json" "$dir/myshape/"
  tb_commit_root "$dir" "the scripts and board of $OLD_BASE" >/dev/null
}
OLD=$TMP_ROOT/old-root
old_root "$OLD"

MAIN=$(tb_make_service_home main)
case "$(cat "$MAIN/config/myshape-port")" in "$LIVE_BOARD_PORT" | '') fail "the scratch home must have its own port" ;; esac
tb_bind_home "$MAIN"
tb_write_topics "$MAIN"

# on <root> <command> <arguments...>: one of <root>'s commands for the main home.
# The board's command gets the home under both names: the old root's reads
# FM_HOME, this checkout's MYSHAPE_HOME.
on() {
  local root=$1 command=$2
  shift 2
  case "$command:${1:-}" in myshape.sh:open | myshape.sh:stop | myshape.sh:restart) sig_product_target "$MAIN" "$1" ;; esac
  case "$command" in
    myshape.sh)
      FM_HOME="$MAIN" FM_ROOT_OVERRIDE="$root" MYSHAPE_HOME="$MAIN" MYSHAPE_ROOT_OVERRIDE="$root" \
        "$root/bin/$command" "$@"
      ;;
    *) FM_HOME="$MAIN" FM_ROOT_OVERRIDE="$root" "$root/bin/$command" "$@" ;;
  esac
}

view() {  # [jq filter]: the board's state after a read of every home
  tb_op "$MAIN" dump '{"refresh":true}' | jq -c "${1:-.}"
}

item() {  # <id>: the board's stored item, or null
  jq -c --arg id "$1" '.items[$id]' "$MAIN/data/myshape/todos.json"
}

wait_for() {  # <description> <command...>: retry for up to 15 seconds
  local what=$1 tries=0
  shift
  until "$@"; do
    tries=$((tries + 1))
    [ "$tries" -lt 100 ] || fail "timed out waiting for $what"
    sleep 0.15
  done
}

logged() {  # <text>: the stand-ins logged <text>
  grep -qF "$1" "$TB_LOG"
}

# press <route> <task>: the captain's two-step press on the page.
press() {
  local base auth code
  base="http://127.0.0.1:$(cat "$MAIN/config/myshape-port")"
  auth="Authorization: Bearer $(cat "$MAIN/state/myshape/token")"
  code=$(curl -s -H "$auth" -H "Origin: $base" -H 'Content-Type: application/json' \
    -d "{\"task\":\"$2\"}" "$base/api/$1" | jq -r '.confirm')
  curl -s -o /dev/null -w '%{http_code}' -H "$auth" -H "Origin: $base" -H 'Content-Type: application/json' \
    -d "{\"task\":\"$2\",\"confirm\":\"$code\"}" "$base/api/$1"
}

hold_line() {  # <id> <title> <reason>: one open captain hold of the backlog, its reason encoded
  printf -- '- [ ] %s - %s (repo: sample) (kind: captain) (hold: fm-hold-v1:%s) (hold-kind: captain)\n' \
    "$1" "$2" "$(printf '%s' "$3" | base64 | tr -d '\n')"
  printf '  Captain hold set: 2026-07-24T09:30:00Z\n'
}

LABELLED=$(printf '動手：開 NAS 的兩步驟驗證\n說明：只在你人在電腦前時做。\n指令：sudo nas-2fa --on\n續：  --now')

# backlog [closed] [today]: the main home's backlog: an ordinary decision,
# h-open's hands-on hold, h-closed's (or, with "closed", the Done row the
# hold tool leaves when the board closed its item), and with "today" a
# hands-on hold opened now.
backlog() {
  local closed='' today='' word
  for word in "$@"; do
    case "$word" in closed) closed=1 ;; today) today=1 ;; esac
  done
  {
    printf '## In flight\n\n## Queued\n'
    printf -- '- [ ] call-main - A call (repo: sample) (kind: captain) (hold: 要合併嗎？ 選項：合併 | 先不要) (hold-kind: captain)\n'
    hold_line h-open "Turn on 2FA" "$LABELLED"
    [ -n "$closed" ] || hold_line h-closed "Restart x" "動手：重啟 x"
    [ -z "$today" ] || hold_line h-today "Restart the router" "動手：重開路由器"
    printf -- '- [ ] work-1 - Ordinary work (repo: sample) (kind: ship)\n'
    printf '\n## Done\n'
    if [ -n "$closed" ]; then
      printf -- '- [x] h-closed - Restart x (repo: sample) (kind: captain) (done 2026-07-24) (hold: 動手：重啟 x) (hold-kind: captain)\n'
      printf '  Resolution recorded by fm-captain-hold.\n  Decision digest: d-h-closed\n  Resolution mode: answered\n\n'
      printf '  Captain decision:\n  Captain answered this call through myshape.\n  Task: h-closed\n  Answer: 不做了\n'
      printf '  Answer as shown to the captain: 不做了\n'
    fi
  } > "$MAIN/data/backlog.md"
}

backlog
mkdir -p "$MAIN/data/h-open"
printf 'billing 2026-07-24T00:00:00Z\n' > "$MAIN/data/h-open/topic"
jq '.todos = {"h-open": {state: "rejected", at: "2026-07-24T10:00:00Z", reason: "還沒開"}}' \
  "$MAIN/data/topics.json" > "$MAIN/data/topics.json.new"
mv "$MAIN/data/topics.json.new" "$MAIN/data/topics.json"

SHOWN='{todos, closed_todos, updates}'

test_the_old_code_adopts_and_closes() {
  on "$OLD" myshape.sh open >/dev/null || fail "the old board did not start"
  view >/dev/null
  view >/dev/null
  wait_for "both old holds on the board" test "$(jq -c '.items | keys' "$MAIN/data/myshape/todos.json")" = '["h-closed","h-open"]'
  assert_equals '{"topic":"billing","state":"rejected","ref":"hold","adopted":true}' \
    "$(item h-open | jq -c '{topic, state, ref, adopted}')" "the old code must adopt the tagged hold with its mark"
  assert_equals '{"topic":null,"ref":"hold","adopted":true}' "$(item h-closed | jq -c '{topic, ref, adopted}')" \
    "the old code must adopt the untagged hold under no topic"
  assert_equals 200 "$(press todos/drop h-closed)" "the captain's 不做了 on the old board failed"
  wait_for "the old deliverer to close h-closed's hold" logged "$(printf 'stdin=h-closed\t不做了\t不做了\tdone')"
  backlog closed
  view >/dev/null
  wait_for "the old board to settle h-closed" test "$(jq -c '.closed' "$MAIN/data/myshape/todos.json")" = '{}'
  assert_equals '["call-main"]' "$(view '[.holds[].task] | sort')" "the old code must hide the hands-on holds"
  view "$SHOWN" > "$TMP_ROOT/shown.before"
  cp "$MAIN/data/myshape/events.jsonl" "$TMP_ROOT/events.before"
  cp "$MAIN/data/myshape/todos.json" "$TMP_ROOT/todos.before"
  on "$OLD" myshape.sh stop >/dev/null
  pass "the code at $OLD_BASE adopts two hands-on holds, closes one item with its hold, and hides both holds"
}

test_the_new_code_reads_the_old_items_the_same() {
  on "$NEW" myshape.sh open >/dev/null || fail "the new board did not start"
  view >/dev/null
  assert_equals "$(cat "$TMP_ROOT/shown.before")" "$(view "$SHOWN")" \
    "the items, the closed item and every update must show exactly as before"
  assert_equals "" "$(cmp "$TMP_ROOT/events.before" "$MAIN/data/myshape/events.jsonl" 2>&1)" \
    "reading the old board's home must add no record, not even for the hold closed with its item"
  assert_equals "" "$(cmp "$TMP_ROOT/todos.before" "$MAIN/data/myshape/todos.json" 2>&1)" \
    "reading must not rewrite the stored items"
  assert_equals '["call-main","h-open"]' "$(view '[.holds[].task] | sort')" \
    "h-open's hold, still open, must now show as a decision beside its item"
  assert_equals '"動手：開 NAS 的兩步驟驗證\n說明：只在你人在電腦前時做。\n指令：sudo nas-2fa --on\n續：  --now"' \
    "$(view '.holds[] | select(.task == "h-open") | .question')" "the decision must show the hold's reason as it is"
  assert_equals '["call-main","h-open","work-1"]' \
    "$(on "$NEW" fm-topic-board-read.sh 0 - | jq -c '[.queued[].id] | sort')" "the reader must list the hands-on hold as queued work"
  pass "this code shows the items an older board adopted, and its records, exactly as before; the open hold shows as a decision"
}

test_closing_an_old_item_leaves_its_hold_open() {
  local holds
  holds=$(grep -c 'cmd=fm-captain-hold.sh' "$TB_LOG")
  assert_equals 200 "$(press todos/drop h-open)" "the captain's 不做了 on an old item failed"
  wait_for "the note" logged 'stdin=使用者在看板上：「Turn on 2FA」不做了（h-open）'
  sleep 1
  assert_equals "$holds" "$(grep -c 'cmd=fm-captain-hold.sh' "$TB_LOG")" "closing an old item must not touch its hold"
  assert_equals '[]' "$(view '[.todos[].task]')" "the item must leave the page"
  assert_equals '["call-main","h-open"]' "$(view '[.holds[].task] | sort')" "the hold left open must stay in front of the captain"
  assert_equals "todo.dropped/captain/dropped/billing/要你動手「Turn on 2FA」已關：你選了不做了（你在頁面上）" \
    "$(jq -r -s '[.[] | select(.item == "h-open")] | last | "\(.kind)/\(.by)/\(.outcome)/\(.topic)/\(.text)"' "$MAIN/data/myshape/events.jsonl")" \
    "the close must be recorded as it always was"
  assert_equals false "$(jq -c '[.. | objects | has("adopted") or has("closed")] | any' "$MAIN/data/myshape/todos.json")" \
    "the stored file must no longer carry the adoption's fields once the board writes it"
  pass "closing an old item is a note only: its hold stays open and shows as a decision"
}

test_a_handson_hold_opened_now_is_a_decision() {
  backlog closed today
  view >/dev/null
  assert_equals '["call-main","h-open","h-today"]' "$(view '[.holds[].task] | sort')" "a hands-on hold opened now must show as a decision"
  assert_equals '[]' "$(view '[.todos[].task]')" "a hands-on hold must not become an item"
  assert_equals "待決事項「Restart the router」已開：動手：重開路由器" \
    "$(jq -r -s '[.[] | select(.kind == "hold.opened" and .task == "h-today")] | last | .text' "$MAIN/data/myshape/events.jsonl")" \
    "its opening must be recorded like any other decision's"
  assert_equals '["call-main","h-open","h-today"]' "$(on "$NEW" fm-topic-board-read.sh 0 - | jq -c '[.holds[].id] | sort')" \
    "the reader must list every hands-on hold in holds[]"
  pass "a hands-on hold opened now is an ordinary decision on the board and in the reader"
}

test_a_secondmate_home_keeps_its_holds_as_decisions() {
  local mate
  mate=$(tb_make_secondmate_home sm sm1)
  printf '## In flight\n\n## Queued\n- [ ] mate-todo - X (repo: sample) (kind: captain) (hold: 動手：x) (hold-kind: captain)\n\n## Done\n' \
    > "$mate/data/backlog.md"
  assert_equals '["mate-todo"]' "$(FM_HOME="$mate" FM_ROOT_OVERRIDE="$NEW" "$NEW/bin/fm-topic-board-read.sh" 0 - | jq -c '[.holds[].id] | sort')" \
    "a secondmate's hold that starts with 動手： stays an ordinary decision"
  pass "a secondmate home keeps its 動手： holds as decisions"
}

# removed <expected stderr> <command...>: the command is an ordinary usage error.
removed() {
  local expected=$1 rc=0 err
  shift
  err=$("$@" 2>&1 >/dev/null </dev/null) || rc=$?
  assert_equals 2 "$rc" "$* must be a usage error"
  assert_contains "$err" "$expected" "$* must say what it does not know"
}

test_the_transition_commands_are_gone() {
  removed "fm-board.sh: 不認得的子命令：adopt（fm-board.sh --help 看用法）" on "$NEW" fm-board.sh adopt
  removed "fm-topic-board-read.sh: expected an offset and a prefix hash" on "$NEW" fm-topic-board-read.sh --legacy-todos 0 -
  removed "myshape.sh: todo 不認得 adopt-done；可用的是 add、done、failed、obsolete（myshape.sh --help 看用法）" \
    on "$NEW" myshape.sh todo adopt-done h-open
  removed "myshape.sh: todo add 不認得 --adopt。" on "$NEW" myshape.sh todo add h-x T --topic billing --do x --adopt
  removed "myshape.sh: todo add 不認得 --since。" \
    on "$NEW" myshape.sh todo add h-x T --topic billing --do x --since 2026-07-01T00:00:00Z
  assert_equals null "$(item h-x)" "a refused todo add must store nothing"
  pass "fm-board.sh adopt, the reader's --legacy-todos, todo adopt-done and --adopt are ordinary usage errors"
}

test_going_back_adopts_the_open_hold_again() {
  sig_product_target "$MAIN" "the old adoption's todo add (board on other code)"
  on "$OLD" fm-board.sh adopt >/dev/null || fail "the old adopt failed"
  assert_equals '{"topic":"billing","state":"open","adopted":true}' "$(item h-open | jq -c '{topic, state, adopted}')" \
    "going back must put the hold still open back on the board as an adopted item"
  assert_equals '["call-main"]' "$(view '[.holds[].task] | sort')" "the old code must hide the hands-on holds again"
  on "$OLD" myshape.sh stop >/dev/null
  pass "going back to $OLD_BASE adopts the hold still open again, so nothing is hidden twice"
}

test_nothing_is_left() {
  tb_stop_boards
  assert_equals 0 "$(tb_board_count "$MAIN")" "no board may be left running"
  pass "no board is left running"
}

fm_test_run test_the_old_code_adopts_and_closes test_the_new_code_reads_the_old_items_the_same \
  test_closing_an_old_item_leaves_its_hold_open test_a_handson_hold_opened_now_is_a_decision \
  test_a_secondmate_home_keeps_its_holds_as_decisions test_the_transition_commands_are_gone \
  test_going_back_adopts_the_open_hold_again test_nothing_is_left
