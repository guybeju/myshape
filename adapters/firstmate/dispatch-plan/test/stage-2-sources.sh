#!/usr/bin/env bash
# Where fm-dispatch-plan.sh order takes the board's queues from in a secondmate
# home: the main home's published files when the main home is on this machine,
# otherwise the copy the main home pushed. Scratch homes only.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot dispatch-plan-stage-2-sources)
# shellcheck source=dispatch-plan/test/helpers.sh
. "$ROOT/dispatch-plan/test/helpers.sh"

# A secondmate's queued items, in backlog order:
#   n1 (t2/normal)  u1 (untagged)  h1 (billing/high)
#   r1 (untagged, routed with "topic: billing")  m1 (old-billing, merged into billing)
#   l1 (parked/later)  a1 (gone/archived)  p1 (t2/normal, held by the board)
write_mate_backlog() {
  local home=$1 pair
  cat > "$home/data/backlog.md" <<'EOF'
## In flight

## Queued
- [ ] n1 - Normal one (repo: sample) (kind: ship)
- [ ] u1 - Untagged (repo: sample) (kind: ship)
- [ ] h1 - High one (repo: sample) (kind: ship)
- [ ] r1 - Routed (repo: sample) (kind: ship)
  topic: billing
- [ ] m1 - Merged alias (repo: sample) (kind: ship)
- [ ] l1 - Later (repo: sample) (kind: ship)
- [ ] a1 - Archived (repo: sample) (kind: ship)
- [ ] p1 - Held by the board (repo: sample) (kind: ship) (hold: 看板佇列：議題 t2 在待辦)

## Done
EOF
  for pair in n1:t2 h1:billing m1:old-billing l1:parked a1:gone p1:t2; do
    mkdir -p "$home/data/${pair%%:*}"
    printf '%s 2026-07-01T00:00:00Z\n' "${pair##*:}" > "$home/data/${pair%%:*}/topic"
  done
}

# assert_ranked <output> <what>: the sections the board's queues produce for
# write_mate_backlog.
assert_ranked() {
  assert_equals "h1 r1 m1 n1 p1 u1 " "$(section "$1" "可派：")" "$2: high, normal, then untagged"
  assert_equals "l1 a1 " "$(section "$1" "該 hold：")" "$2: parked and archived topics must be listed to hold"
  assert_equals "p1 " "$(section "$1" "該解除：")" "$2: the board's hold on a queued topic must be listed to release"
  assert_contains "$1" 'bin/fm-tasks-axi.sh hold a1 --reason "看板佇列：議題 gone 在封存"' "$2: an archived topic must say so"
}

# assert_fell_open <output> <what>: backlog order, no holds, the board's own
# hold still visible.
assert_fell_open() {
  assert_equals "n1 u1 h1 r1 m1 l1 a1 " "$(section "$1" "可派：")" "$2: every unheld item in backlog order"
  assert_equals "" "$(section "$1" "該 hold：")" "$2: nothing may be listed to hold"
  assert_equals "" "$(section "$1" "該解除：")" "$2: nothing may be listed to release"
  assert_equals "p1 " "$(section "$1" "停著：")" "$2: the board's earlier hold must stay visible"
}

first_line() {
  printf '%s\n' "$1" | head -n 1
}

test_local_mate_reads_the_main_homes_queues() {
  local main mate out
  main=$(tb_make_home local-main)
  tb_write_topics "$main"
  mate=$(dp_make_local_mate local-mate sm1 "$main")
  write_mate_backlog "$mate"
  out=$(tb_run "$mate" "$PLAN" order) || fail "order failed in a local secondmate home"
  assert_equals "照主 home 的議題順序（直接讀 $main/data/topics.json）。" "$(first_line "$out")" \
    "the first line must name the main home's file"
  assert_ranked "$out" "local mate"
  jq '.queues.high = ["t2", "billing"] | .queues.normal = []' "$main/data/topics.json" > "$main/data/topics.json.new"
  mv "$main/data/topics.json.new" "$main/data/topics.json"
  out=$(tb_run "$mate" "$PLAN" order)
  assert_equals "n1 p1 h1 r1 m1 u1 " "$(section "$out" "可派：")" \
    "a topic moved after routing must reach the local mate at its next order"
  pass "a local secondmate ranks by the main home's own topic file, live"
}

test_local_mate_falls_open_without_the_main_homes_file() {
  local main mate out
  main=$(tb_make_home local-nofile-main)
  mate=$(dp_make_local_mate local-nofile-mate sm1 "$main")
  write_mate_backlog "$mate"
  dp_write_copy "$mate" "$(dp_minutes_ago 1)"
  out=$(tb_run "$mate" "$PLAN" order) || fail "order failed without the main home's file"
  assert_equals "還沒有議題檔；照 backlog 原本的順序列出。" "$(first_line "$out")" "the first line must say there is no topic file"
  assert_fell_open "$out" "local mate without a topic file"
  printf 'not json' > "$main/data/topics.json"
  out=$(tb_run "$mate" "$PLAN" order) || fail "order failed on the main home's unreadable file"
  assert_equals "讀不懂 $main/data/topics.json；照 backlog 原本的順序列出。" "$(first_line "$out")" \
    "the first line must name the unreadable file"
  assert_fell_open "$out" "local mate with an unreadable topic file"
  pass "a local secondmate falls open when the main home's file is missing or unreadable, and ignores a stray copy"
}

test_remote_mate_ranks_by_a_fresh_copy() {
  local mate out at
  mate=$(dp_make_remote_mate remote-fresh far1)
  write_mate_backlog "$mate"
  at=$(dp_minutes_ago 2)
  dp_write_copy "$mate" "$at"
  out=$(tb_run "$mate" "$PLAN" order) || fail "order failed with a copy"
  assert_equals "照主 home 推來的佇列副本（${at}，2 分鐘前）。" "$(first_line "$out")" \
    "the first line must give the copy's time and age"
  assert_ranked "$out" "remote mate"
  pass "a remote secondmate ranks by the copy and says how old it is"
}

test_remote_mate_warns_about_an_old_copy() {
  local mate out at
  mate=$(dp_make_remote_mate remote-old far1)
  write_mate_backlog "$mate"
  at=$(dp_minutes_ago 59)
  dp_write_copy "$mate" "$at"
  out=$(tb_run "$mate" "$PLAN" order)
  assert_equals "照主 home 推來的佇列副本（${at}，59 分鐘前）。" "$(first_line "$out")" "a 59-minute copy must not warn"
  at=$(dp_minutes_ago 60)
  dp_write_copy "$mate" "$at"
  assert_contains "$(first_line "$(tb_run "$mate" "$PLAN" order)")" "60 分鐘前）。副本超過一小時沒更新" \
    "a copy exactly 60 minutes old must carry the warning"
  at=$(dp_minutes_ago 90)
  dp_write_copy "$mate" "$at"
  out=$(tb_run "$mate" "$PLAN" order)
  assert_equals "照主 home 推來的佇列副本（${at}，90 分鐘前）。副本超過一小時沒更新：主 home 可能沒有 first mate 在跑，或連不到這台；仍照副本排。" \
    "$(first_line "$out")" "a copy an hour old or more must carry the warning"
  assert_ranked "$out" "old copy"
  at=$(jq -nr '(now + 600) | strftime("%Y-%m-%dT%H:%M:%SZ")')
  dp_write_copy "$mate" "$at"
  assert_equals "照主 home 推來的佇列副本（${at}，0 分鐘前）。" "$(first_line "$(tb_run "$mate" "$PLAN" order)")" \
    "a copy from a clock ahead of this one must read as 0 minutes old"
  pass "a copy an hour old or more is still used, with a warning"
}

test_remote_mate_falls_open_without_a_usable_copy() {
  local mate out bad
  mate=$(dp_make_remote_mate remote-none far1)
  write_mate_backlog "$mate"
  out=$(tb_run "$mate" "$PLAN" order) || fail "order failed without a copy"
  assert_equals "這裡沒有主 home 推來的佇列副本；照 backlog 原本的順序列出。" "$(first_line "$out")" "the first line must say there is no copy"
  assert_fell_open "$out" "no copy"
  mkdir -p "$mate/state/dispatch-plan"
  for bad in 'not json' '{"schema":"other","at":"2026-11-18T00:00:00Z","queues":{},"topics":{}}' \
    "$(dp_copy_json 2026-13-45T99:00:00Z)" "$(dp_copy_json "$(dp_minutes_ago 1)" | jq -c '.queues.high = "billing"')"; do
    printf '%s' "$bad" > "$mate/state/dispatch-plan/queues.json"
    out=$(tb_run "$mate" "$PLAN" order) || fail "order failed on a malformed copy: $bad"
    assert_equals "讀不懂主 home 推來的佇列副本（$mate/state/dispatch-plan/queues.json）；照 backlog 原本的順序列出。" \
      "$(first_line "$out")" "a malformed copy must be named: $bad"
    assert_fell_open "$out" "malformed copy $bad"
  done
  out=$(tb_run "$(tb_make_secondmate_home unbound-mate sm9)" "$PLAN" order) || fail "order failed in a home with no parent record"
  assert_contains "$(first_line "$out")" "這裡沒有主 home 推來的佇列副本" "a home with no parent record must look for a copy"
  pass "a remote secondmate falls open only when it has no usable copy"
}

# The main home's hands-on items live on its board; a secondmate's own ids are
# its own, so an item there must never be read as one of the secondmate's.
test_never_lists_hands_on_items_in_a_secondmate_home() {
  local main mate out
  main=$(tb_make_home todo-main)
  tb_write_topics "$main"
  mkdir -p "$main/data/myshape"
  printf '%s' '{"v":1,"marks":{},"items":{"td1":{"title":"T","topic":"billing","action":"x","guidance":"","commands":[],"state":"claimed","reason":null,"at":"t","by":"firstmate","ref":"","captain_closes":false,"created_at":"t"}}}' \
    > "$main/data/myshape/todos.json"
  mate=$(dp_make_local_mate todo-mate sm1 "$main")
  mkdir -p "$mate/data/myshape"
  cp "$main/data/myshape/todos.json" "$mate/data/myshape/todos.json"
  printf '## In flight\n\n## Queued\n- [ ] td1 - Restart x (repo: sample) (kind: captain) (hold: 動手：重啟 x) (hold-kind: captain)\n\n## Done\n' \
    > "$mate/data/backlog.md"
  out=$(tb_run "$mate" "$PLAN" order)
  assert_contains "$(first_line "$out")" "照主 home 的議題順序" "the mate must read the main home's file"
  assert_not_contains "$out" "等你驗證" "a secondmate home must never list a hands-on item to check"
  cp "$mate/data/backlog.md" "$main/data/backlog.md"
  assert_contains "$(tb_run "$main" "$PLAN" order)" "等你驗證" "the same mark must still be listed in the main home"
  pass "order never lists 等你驗證 in a secondmate home"
}

# A secondmate on the far machine may have its own local secondmates; they
# read the copy kept in the top home on that machine.
test_local_child_of_a_remote_mate_reads_its_copy() {
  local top child out at
  top=$(dp_make_remote_mate child-top far1)
  at=$(dp_minutes_ago 3)
  dp_write_copy "$top" "$at"
  child=$(dp_make_local_mate child-mate kid1 "$top")
  write_mate_backlog "$child"
  out=$(tb_run "$child" "$PLAN" order)
  assert_equals "照主 home 推來的佇列副本（${at}，3 分鐘前）。" "$(first_line "$out")" \
    "a local child of a remote mate must read the copy in its top home"
  assert_ranked "$out" "child of a remote mate"
  pass "a local child of a remote secondmate reads the copy its top home keeps"
}

fm_test_run test_local_mate_reads_the_main_homes_queues test_local_mate_falls_open_without_the_main_homes_file \
  test_remote_mate_ranks_by_a_fresh_copy test_remote_mate_warns_about_an_old_copy \
  test_remote_mate_falls_open_without_a_usable_copy test_never_lists_hands_on_items_in_a_secondmate_home \
  test_local_child_of_a_remote_mate_reads_its_copy
