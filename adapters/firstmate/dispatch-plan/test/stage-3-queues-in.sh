#!/usr/bin/env bash
# fm-dispatch-plan.sh queues-in: a secondmate home on another machine keeps the
# queue copy the main home sends it. Scratch homes only.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot dispatch-plan-stage-3-queues-in)
# shellcheck source=dispatch-plan/test/helpers.sh
. "$ROOT/dispatch-plan/test/helpers.sh"

# receive <home> <copy-text>: run queues-in with <copy-text> on stdin; prints
# its stdout and stderr, then "rc=<code>".
receive() {
  local rc=0 out
  out=$(printf '%s' "$2" | tb_run "$1" "$PLAN" queues-in - 2>&1) || rc=$?
  printf '%s\nrc=%s\n' "$out" "$rc"
}

kept() {
  cat "$1/state/dispatch-plan/queues.json"
}

test_keeps_a_valid_copy() {
  local home copy out
  home=$(dp_make_remote_mate keep far1)
  copy=$(dp_copy_json "$(dp_minutes_ago 1)")
  out=$(receive "$home" "$copy")
  assert_equals "$(printf 'ok queues 副本已更新（%s）\nrc=0' "$(printf '%s' "$copy" | jq -r .at)")" "$out" \
    "queues-in must confirm the copy it kept"
  assert_equals "$copy" "$(kept "$home")" "the kept copy must be the copy received"
  assert_equals "drwx------" "$(tb_mode "$home/state/dispatch-plan")" "the copy's directory must be 0700"
  assert_equals "-rw-------" "$(tb_mode "$home/state/dispatch-plan/queues.json")" "the copy must be readable only by its owner"
  assert_equals "queues.json" "$(ls -A "$home/state/dispatch-plan")" "no temporary file may be left beside the copy"
  chmod 755 "$home/state/dispatch-plan"
  receive "$home" "$copy" >/dev/null
  assert_equals "drwx------" "$(tb_mode "$home/state/dispatch-plan")" "a widened directory must be made 0700 again"
  assert_contains "$(tb_run "$home" "$PLAN" order | head -n 1)" "照主 home 推來的佇列副本" "order must rank by the kept copy"
  pass "queues-in keeps a valid copy in a 0700 directory, through a temporary file"
}

test_ignores_an_older_copy() {
  local home newer older out
  home=$(dp_make_remote_mate older far1)
  newer=$(dp_copy_json "$(dp_minutes_ago 5)")
  older=$(dp_copy_json "$(dp_minutes_ago 20)" | jq -c '.queues.high = []')
  receive "$home" "$newer" >/dev/null
  out=$(receive "$home" "$older")
  assert_equals "$(printf 'ok queues 已有較新的副本（%s），這一份（%s）略過\nrc=0' \
    "$(printf '%s' "$newer" | jq -r .at)" "$(printf '%s' "$older" | jq -r .at)")" "$out" "an older copy must be ignored, and say so"
  assert_equals "$newer" "$(kept "$home")" "the newer copy must be kept"
  printf 'broken' > "$home/state/dispatch-plan/queues.json"
  out=$(receive "$home" "$older")
  assert_contains "$out" "ok queues 副本已更新" "a copy must replace an unreadable kept one"
  assert_equals "$older" "$(kept "$home")" "the received copy must replace the unreadable one"
  pass "queues-in ignores a copy older than the one it keeps"
}

test_refuses_a_malformed_copy() {
  local home good bad out
  home=$(dp_make_remote_mate malformed far1)
  good=$(dp_copy_json "$(dp_minutes_ago 1)")
  receive "$home" "$good" >/dev/null
  for bad in '' 'not json' '[]' "$(printf '%s' "$good" | jq -c '.schema = "fm-dispatch-queues.v2"')" \
    "$(printf '%s' "$good" | jq -c '.at = "yesterday"')" "$(printf '%s' "$good" | jq -c 'del(.archived)')" \
    "$(printf '%s' "$good" | jq -c '.topics.billing.name = 3')" "$(printf '%s' "$good" | jq -c '.merged.x = 1')" \
    "$(printf '%s\n%s' "$good" "$good")"; do
    out=$(receive "$home" "$bad")
    assert_equals "$(printf 'queues-in：收到的不是可用的佇列副本（fm-dispatch-queues.v1）；什麼都沒有寫。\nrc=1')" "$out" \
      "a malformed copy must be refused: $bad"
    assert_equals "$good" "$(kept "$home")" "a refused copy must leave the kept one alone: $bad"
  done
  out=$(receive "$home" "$(printf '%s' "$good" | jq -c --rawfile pad <(head -c 270000 /dev/zero | tr '\0' x) '.pad = $pad')")
  assert_equals "$(printf 'queues-in：收到的副本超過 262144 位元組；什麼都沒有寫。\nrc=1')" "$out" "an oversized copy must be refused"
  assert_equals "queues.json" "$(ls -A "$home/state/dispatch-plan")" "no temporary file may be left after a refusal"
  pass "queues-in refuses a malformed or oversized copy and keeps the old one"
}

test_runs_only_in_a_secondmate_home() {
  local home out
  home=$(tb_make_home main-refuses)
  out=$(receive "$home" "$(dp_copy_json "$(dp_minutes_ago 1)")")
  assert_equals "$(printf 'queues-in 只能在 secondmate home 跑：主 home 用自己的議題檔。什麼都沒有寫。\nrc=1')" "$out" \
    "the main home must refuse a copy"
  assert_absent "$home/state/dispatch-plan" "nothing may be written in the main home"
  home=$(dp_make_remote_mate usage far1)
  expect_code 2 "$(tb_code "$home" "$PLAN" queues-in)" "queues-in without -"
  expect_code 2 "$(tb_code "$home" "$PLAN" queues-in copy.json)" "queues-in with a file name"
  expect_code 2 "$(tb_code "$home" "$PLAN" queues-in - extra)" "queues-in with an extra argument"
  assert_absent "$home/state/dispatch-plan" "a usage error must write nothing"
  pass "queues-in runs only in a secondmate home and only reads stdin"
}

fm_test_run test_keeps_a_valid_copy test_ignores_an_older_copy test_refuses_a_malformed_copy \
  test_runs_only_in_a_secondmate_home
