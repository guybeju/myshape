#!/usr/bin/env bash
# fm-board.sh split: the board's split of a topic plus moving the named tasks,
# in the main home and a local secondmate home, against the real board service.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=fm-board/test/helpers.sh
. "$ROOT/fm-board/test/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "skip: node not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot fm-board-s3)
[ -n "$TMP_ROOT" ] || { echo "not ok - no scratch root" >&2; exit 1; }
trap 'tb_stop_boards; fm_test_cleanup' EXIT

MAIN=$(tb_make_service_home main)
tb_bind_home "$MAIN"
LOCAL_SM=$(tb_make_secondmate_home sm sm1)
tb_write_registry "$MAIN" "$LOCAL_SM"

t() {
  tb_run "$MAIN" "$TOPIC" "$@"
}

b() {
  tb_run "$MAIN" "$BOARD" "$@"
}

last_topic() {  # <home> <task>: the topic the task is tagged with now
  tail -n 1 "$1/data/$2/topic" | cut -d' ' -f1
}

t open >/dev/null || fail "the board did not start"
t create "Login" --goal "new login page" --id login --queue high >/dev/null

test_split_moves_the_named_tasks_to_a_new_topic() {
  local out rc
  t create "Docs" --goal "all the docs" --id docs --queue high >/dev/null
  b tag sp-1 docs >/dev/null
  b tag sp-2 docs >/dev/null
  b --in-home sm1 tag sp-3 docs >/dev/null
  b tag ship-b login >/dev/null

  rc=0
  out=$(b split docs "Docs API" --goal "the API pages" --id docs-api sp-1 ship-b 2>&1) || rc=$?
  assert_equals 1 "$rc" "a task that is not in the source topic must stop the split"
  assert_contains "$out" "ship-b" "the refusal must name the task that is elsewhere"
  rc=0
  out=$(b split docs "Docs API" --goal "the API pages" --id docs-api far1/sp-9 2>&1) || rc=$?
  assert_equals 1 "$rc" "a remote secondmate's task must stop the split"
  assert_contains "$out" "遠端" "the refusal must say the task is in a remote home"
  rc=0
  out=$(b split docs "Docs API" --goal "the API pages" --id docs-api never-tagged 2>&1) || rc=$?
  assert_equals 1 "$rc" "an untagged task must stop the split"
  assert_equals "" "$(t list --all | grep '^docs-api' || true)" "a refused split must not create the topic"
  assert_equals docs "$(last_topic "$MAIN" sp-1)" "a refused split must not move any task"

  out=$(b split docs "Docs API" --goal "the API pages" --id docs-api sp-1) || fail "split failed: $out"
  assert_contains "$out" "ok docs-api 已從 docs 拆出，放進「高」" "split must report the new topic"
  assert_contains "$out" "ok sp-1 已標記為 docs-api" "split must report each task it moved"
  assert_equals "Docs API：" "$(t which sp-1)" "a moved task must belong to the new topic"
  assert_equals docs "$(last_topic "$MAIN" sp-2)" "a task that was not named must stay"
  assert_equals "login docs docs-api" "$(jq -r '.queues.high | join(" ")' "$MAIN/data/topics.json")" \
    "the new topic must sit right after its source"

  out=$(b split docs "Docs API" --goal "the API pages" sp-1 sp-2 sm1/sp-3) || fail "the second run failed: $out"
  assert_contains "$out" "ok docs-api 本來就已從 docs 拆出" "running the split again must reuse the topic"
  assert_equals "docs-api" "$(last_topic "$MAIN" sp-2)" "the second run must move the tasks the first did not"
  assert_equals "docs-api" "$(last_topic "$LOCAL_SM" sp-3)" "a local secondmate's task must be moved in its own home"
  assert_equals 2 "$(wc -l < "$MAIN/data/sp-1/topic" | tr -d ' ')" "a task already moved must not be tagged twice"
  assert_equals 1 "$(jq '[.history[] | select(.kind == "split")] | length' "$MAIN/data/topics.json")" \
    "the split must be recorded once"
  assert_contains "$(t find docs-api)" "從「Docs」（docs）拆出「Docs API」（docs-api）" "find must show where the topic came from"

  b tag sp-4 docs >/dev/null
  chmod 444 "$MAIN/data/sp-4/topic"
  rc=0
  out=$(b split docs "Docs API" --goal "the API pages" sp-4 2>&1) || rc=$?
  chmod 644 "$MAIN/data/sp-4/topic"
  assert_equals 1 "$rc" "a task that could not be tagged must fail the split"
  assert_not_contains "$out" "ok sp-4" "a task that could not be tagged must not be reported as moved"
  assert_contains "$out" "再跑一次" "the failure must say the command can be run again"
  assert_equals docs "$(last_topic "$MAIN" sp-4)" "a failed tag must leave the tag file as it was"
  b split docs "Docs API" --goal "the API pages" sp-4 >/dev/null || fail "the rerun after a failed tag failed"
  assert_equals docs-api "$(last_topic "$MAIN" sp-4)" "the rerun must move the task"
  rc=0
  b split docs >/dev/null 2>&1 || rc=$?
  assert_equals 2 "$rc" "split without a name is a usage error"
  pass "split creates the topic once, moves the named tasks, and can be run again to finish"
}

test_split_without_tasks_only_makes_the_topic() {
  local out
  out=$(b split login "Login help" --goal "the help pages" --id login-help) || fail "a split with no task failed: $out"
  assert_equals "ok login-help 已從 login 拆出，放進「高」" "$out" "a split with no task must only report the new topic"
  assert_equals "login login-help docs docs-api" "$(jq -r '.queues.high | join(" ")' "$MAIN/data/topics.json")" \
    "the new topic must sit right after its source"
  pass "a split that names no task makes the topic and moves nothing"
}

test_split_is_refused_in_a_secondmate_home() {
  local out rc
  rc=0
  out=$(tb_run "$LOCAL_SM" "$BOARD" split docs X --goal g sp-3 2>&1) || rc=$?
  assert_equals 1 "$rc" "split must be refused in a secondmate home"
  assert_contains "$out" "只在主 home" "the refusal must say topics live in the main home"
  assert_absent "$LOCAL_SM/state/myshape" "a refused split must not start a board in the secondmate home"
  pass "split runs only in the main home"
}

fm_test_run test_split_moves_the_named_tasks_to_a_new_topic test_split_without_tasks_only_makes_the_topic \
  test_split_is_refused_in_a_secondmate_home
