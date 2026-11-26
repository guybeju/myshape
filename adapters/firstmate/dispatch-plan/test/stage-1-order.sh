#!/usr/bin/env bash
# Behavior of fm-dispatch-plan.sh order against the real fm-fleet-snapshot.sh and a
# fixture backlog.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot dispatch-plan-stage-1-order)
# shellcheck source=dispatch-plan/test/helpers.sh
. "$ROOT/dispatch-plan/test/helpers.sh"

# Queued items, in backlog order:
#   n1 (t2/normal)  h1 (billing/high)  h2 (billing/high)  u1 (untagged)
#   p1 (idea, a leftover proposal in no queue yet, so ranked as untagged)
#   l1 (parked/later, not held)
#   l2 (parked/later, held by the board)  r1 (billing/high, held by the board)
#   a1 (gone/archived, not held)       o1 (billing/high, held by something else)
#   b1 (billing/high, blocked by n1)   c1 (billing/high, a captain hold)
#   d1 (untagged, a captain decision that was answered and released)
write_backlog() {
  local home=$1
  cat > "$home/data/backlog.md" <<'EOF'
## In flight
- [ ] running - Already running (repo: sample) (kind: ship) (since 2026-07-07)

## Queued
- [ ] n1 - Normal one (repo: sample) (kind: ship)
- [ ] h1 - High one (repo: sample) (kind: ship)
- [ ] h2 - High two (repo: sample) (kind: ship)
- [ ] u1 - Untagged (repo: sample) (kind: ship)
- [ ] p1 - Proposed topic item (repo: sample) (kind: ship)
- [ ] l1 - Later not held (repo: sample) (kind: ship)
- [ ] l2 - Later held (repo: sample) (kind: ship) (hold: 看板佇列：議題 parked 在待辦)
- [ ] r1 - Release me (repo: sample) (kind: ship) (hold: 看板佇列：議題 billing 在待辦)
- [ ] a1 - Archived not held (repo: sample) (kind: ship)
- [ ] o1 - Other hold (repo: sample) (kind: ship) (hold: waiting for a vendor)
- [ ] b1 - Blocked blocked-by: n1 (repo: sample) (kind: ship)
- [ ] c1 - Captain call (repo: sample) (kind: captain) (hold: choose a route) (hold-kind: captain)
  Captain hold set: 2026-07-20T00:00:00Z
- [ ] d1 - Decided call (repo: sample) (kind: captain)

## Done
EOF
}

write_tags() {
  local home=$1 pair
  for pair in n1:t2 h1:billing h2:old-billing l1:parked l2:parked r1:billing a1:gone \
    o1:billing b1:billing c1:billing running:parked; do
    mkdir -p "$home/data/${pair%%:*}"
    printf '%s 2026-07-01T00:00:00Z\n' "${pair##*:}" > "$home/data/${pair%%:*}/topic"
  done
  # A task tagged with a leftover proposal, not yet in any queue, ranks as untagged.
  mkdir -p "$home/data/p1"
  printf 'idea 2026-07-01T00:00:00Z\n' > "$home/data/p1/topic"
}

test_sections() {
  local home out
  home=$(tb_make_home order)
  tb_write_topics "$home"
  write_backlog "$home"
  write_tags "$home"
  out=$(tb_run "$home" "$PLAN" order)
  assert_equals "h1 h2 r1 n1 u1 p1 d1 " "$(section "$out" "可派：")" \
    "dispatch order must be high, normal, then untagged, in backlog order within a topic"
  assert_equals "l1 a1 " "$(section "$out" "該 hold：")" "items of parked or archived topics must be listed to hold"
  assert_equals "r1 " "$(section "$out" "該解除：")" "a board hold on a non-parked topic must be listed to release"
  assert_equals "l2 " "$(section "$out" "停著：")" "a board hold on a parked topic must be listed as parked"
  assert_contains "$out" 'bin/fm-tasks-axi.sh hold l1 --reason "看板佇列：議題 parked 在待辦"' \
    "the hold line must carry the command to run"
  assert_contains "$out" 'bin/fm-tasks-axi.sh hold a1 --reason "看板佇列：議題 gone 在封存"' \
    "an archived topic must say so in the hold reason"
  assert_contains "$out" "bin/fm-tasks-axi.sh unhold r1" "the release line must carry the command to run"
  printf '%s\n' "$out" | awk '/^可派：/ { on = 1; next } /^[^ ]/ { on = 0 } on' | grep '^  r1	' | grep -q '先照「該解除」解除' ||
    fail "a dispatchable item still under the board's hold must say so"
  printf '%s\n' "$out" | awk '/^可派：/ { on = 1; next } /^[^ ]/ { on = 0 } on' | grep '^  h1	' | grep -q '解除' &&
    fail "an item that is not held must not be marked as held"
  printf '%s\n' "$out" | grep '^  d1	' | grep -q '決定事項' ||
    fail "a released captain decision must be marked as a decision, not as work to dispatch"
  printf '%s\n' "$out" | grep '^  u1	' | grep -q '決定事項' &&
    fail "ordinary work must not be marked as a decision"
  assert_contains "$out" "$(printf 'h1\t帳務重構\t高')" "lines must show the topic name and queue"
  assert_not_contains "$out" "running" "in-flight items must never be listed"
  assert_not_contains "$(section "$out" "可派：")" "o1" "an item held by something else must not be dispatchable"
  assert_not_contains "$(section "$out" "可派：")" "b1" "a blocked item must not be dispatchable"
  assert_not_contains "$(section "$out" "可派：")" "c1" "a captain hold must not be dispatchable"
  assert_equals "o1 b1 c1 " "$(section "$out" "先不派：")" \
    "every queued item in none of the four sections must be listed under 先不派, in backlog order"
  assert_contains "$out" "$(printf 'o1\t帳務重構\t高\t← 被看板以外的 hold 擋著')" "an item held by something else must say so"
  assert_contains "$out" "$(printf 'b1\t帳務重構\t高\t← 等 n1 完成')" "a blocked item must name the unfinished item it waits on"
  assert_contains "$out" "$(printf 'c1\t帳務重構\t高\t← 等使用者決定（captain hold）')" "a captain hold must say it waits on the captain"
  assert_equals "可派： 該 hold： 該解除： 停著： 先不派： " "$(printf '%s\n' "$out" | grep -v '^  ' | tr '\n' ' ')" \
    "the four sections must keep their order, with 先不派 right after them"
  pass "order prints dispatchable, to-hold, to-release, parked, and not-dispatched sections"
}

# write_items <home> <json>: the board's data/myshape/todos.json with these items.
write_items() {
  mkdir -p "$1/data/myshape"
  jq -n --argjson items "$2" '{v: 1, items: $items, marks: {}}' > "$1/data/myshape/todos.json"
}

test_lists_hands_on_items_waiting_for_a_check() {
  local home out item
  home=$(tb_make_home order-todo)
  tb_write_topics "$home"
  write_backlog "$home"
  write_tags "$home"
  out=$(tb_run "$home" "$PLAN" order)
  assert_not_contains "$out" "等你驗證" "the section must be absent while nothing waits for a check"
  item='{title: "T", action: "x", guidance: "", commands: [], reason: null, at: "t", by: "firstmate", ref: "", captain_closes: false, created_at: "t"}'
  write_items "$home" "$(jq -cn "{td1: ($item + {topic: \"billing\", state: \"claimed\"}),
    td2: ($item + {topic: \"billing\", state: \"rejected\", reason: \"r\"}),
    td3: ($item + {topic: null, state: \"claimed\"}), td4: ($item + {topic: \"billing\", state: \"open\"})}")"
  # A mark topics.json still publishes is not an item: only the board's file is read.
  jq '.todos = {gone: {state: "claimed", at: "t"}}' "$home/data/topics.json" > "$home/data/topics.json.new"
  mv "$home/data/topics.json.new" "$home/data/topics.json"
  out=$(tb_run "$home" "$PLAN" order)
  assert_equals "td1 td3 " "$(section "$out" "等你驗證：")" \
    "every item the captain says is done waits for a check, and nothing else"
  assert_contains "$out" "$(printf 'td1\t帳務重構\t高\t← 使用者說做完了；驗證後跑 bin/myshape.sh todo done td1，沒成功就跑 bin/myshape.sh todo failed td1 --reason <一行>')" \
    "the line must carry the topic, its queue and both commands"
  assert_contains "$out" "$(printf 'td3\t（未分類）\t-\t')" "an item with no topic must still be listed"
  assert_not_contains "$(section "$out" "可派：")" "td" "a hands-on item is never dispatchable"
  printf 'not json' > "$home/data/myshape/todos.json"
  out=$(tb_run "$home" "$PLAN" order) || fail "order failed on an unreadable item file"
  assert_not_contains "$out" "等你驗證" "an unreadable item file lists nothing to check"
  pass "order lists the board's hands-on items the captain says are done"
}

test_falls_open_without_a_usable_topic_file() {
  local home out
  home=$(tb_make_home order-nofile)
  write_backlog "$home"
  write_tags "$home"
  out=$(tb_run "$home" "$PLAN" order) || fail "order failed without a topic file"
  assert_contains "$out" "還沒有議題檔" "order did not explain the missing topic file"
  assert_equals "n1 h1 h2 u1 p1 l1 a1 d1 " "$(section "$out" "可派：")" \
    "without a topic file every unheld, unblocked item is dispatchable in backlog order"
  assert_equals "" "$(section "$out" "該 hold：")" "without a topic file nothing may be listed to hold"
  assert_equals "" "$(section "$out" "該解除：")" "without a topic file nothing may be listed to release"
  assert_equals "l2 r1 " "$(section "$out" "停著：")" "items the board held earlier must stay visible without a topic file"
  assert_equals "o1 b1 c1 " "$(section "$out" "先不派：")" "without a topic file held and blocked items must still be listed"
  printf 'not json' > "$home/data/topics.json"
  out=$(tb_run "$home" "$PLAN" order) || fail "order failed on an unreadable topic file"
  assert_contains "$out" "讀不懂" "order did not explain the unreadable topic file"
  assert_equals "" "$(section "$out" "該 hold：")" "an unreadable topic file must not produce holds"
  pass "order lets dispatch proceed when the topic file is missing or unreadable"
}

# An untagged queued item ranks under the topic its body's bare "topic: <id>"
# line names, the line first mate writes when it routes an item; a tag wins.
test_ranks_an_untagged_item_by_its_topic_line() {
  local home out
  home=$(tb_make_home order-hint)
  tb_write_topics "$home"
  {
    printf '## In flight\n\n## Queued\n'
    printf -- '- [ ] n1 - Normal (repo: sample) (kind: ship)\n'
    printf -- '- [ ] u1 - Untagged (repo: sample) (kind: ship)\n'
    printf -- '- [ ] t1 - Routed (repo: sample) (kind: ship)\n  Some note.\n  topic: billing\n'
    printf -- '- [ ] t2 - Routed, tagged too (repo: sample) (kind: ship)\n  topic: billing\n'
    printf -- '- [ ] t3 - Routed to an alias (repo: sample) (kind: ship)\n  topic: old-billing\n'
    printf -- '- [ ] t4 - Routed to a parked topic (repo: sample) (kind: ship)\n  topic: parked\n'
    printf -- '- [ ] t5 - Not a bare line (repo: sample) (kind: ship)\n  topic: billing, later\n'
    printf '\n## Done\n'
  } > "$home/data/backlog.md"
  mkdir -p "$home/data/n1" "$home/data/t2"
  printf 't2 2026-07-01T00:00:00Z\n' > "$home/data/n1/topic"
  printf 't2 2026-07-01T00:00:00Z\n' > "$home/data/t2/topic"
  out=$(tb_run "$home" "$PLAN" order)
  assert_equals "t1 t3 n1 t2 u1 t5 " "$(section "$out" "可派：")" \
    "a topic line must rank an untagged item, follow a merged alias, and lose to a tag"
  assert_equals "t4 " "$(section "$out" "該 hold：")" "a topic line naming a parked topic must ask for a hold"
  assert_contains "$out" "$(printf 't1\t帳務重構\t高')" "the line must show the topic named by the body"
  pass "order ranks an untagged item by its topic line, and a tag wins"
}

# every_listed <output>: each task id listed under any section, one per line, sorted and unique.
every_listed() {
  printf '%s\n' "$1" | awk '/^  / { sub(/^  /, ""); split($0, cols, "\t"); print cols[1] }' | sort -u
}

# A blocker that is done counts as resolved after Done retention has moved it
# into the archive the backlog root's .tasks.toml names; a live record of the
# same id wins over an archived one, and an id found in neither stays open.
# Every queued item lands in a section, and those in none of the four are
# listed under 先不派 with why.
test_resolves_archived_blockers_and_lists_every_item() {
  local home out
  home=$(tb_make_home order-archive)
  tb_free_port > "$home/config/myshape-port"
  mkdir -p "$TMP_ROOT/user-home"
  tb_write_topics "$home"
  printf 'backend = "markdown"\n\n[markdown]\npath = "data/backlog.md"\narchive = "data/old-done.md"\n' \
    > "$home/.tasks.toml"
  cat > "$home/data/backlog.md" <<'EOF'
## In flight

## Queued
- [ ] g1 - Waits on one archived item blocked-by: fin1 (repo: sample) (kind: ship)
- [ ] g2 - Waits on two archived items blocked-by: fin1 blocked-by: fin2 (repo: sample) (kind: ship)
- [ ] w1 - Waits on queued work blocked-by: open1 (repo: sample) (kind: ship)
- [ ] open1 - Still queued (repo: sample) (kind: ship)
- [ ] z1 - Waits on a typo blocked-by: fni1 (repo: sample) (kind: ship)
- [ ] r1 - Waits on a reused id blocked-by: reused (repo: sample) (kind: ship)
- [ ] reused - Reused id, open again (repo: sample) (kind: ship) (hold: waiting for a vendor)
- [ ] q1 - Waits on an item archived unfinished blocked-by: prq (repo: sample) (kind: ship)
- [ ] d1 - Waits on an item in the unconfigured archive blocked-by: dflt (repo: sample) (kind: ship)
- [ ] c1 - Held and blocked blocked-by: open1 (repo: sample) (kind: captain) (hold: choose a route) (hold-kind: captain)

## Done
EOF
  cat > "$home/data/old-done.md" <<'EOF'

## Archived 2026-11-01T00:00:00Z
- [x] fin1 - Finished long ago (repo: sample) (kind: ship) (done 2026-10-01)
  A body line.
- [x] reused - An earlier item with this id (repo: sample) (kind: ship) (done 2026-10-01)

## Archived 2026-11-02T00:00:00Z
- [x] fin2 - Finished later (repo: sample) (kind: ship) (done 2026-10-02)
- [ ] prq - Pruned while queued (repo: sample) (kind: ship)
EOF
  printf '\n## Archived 2026-11-01T00:00:00Z\n- [x] dflt - Only in the default archive (repo: sample) (kind: ship)\n' \
    > "$home/data/done-archive.md"
  out=$(HOME="$TMP_ROOT/user-home" FM_HOME="$home" FM_ROOT_OVERRIDE="$ROOT" "$PLAN" order 2> "$TMP_ROOT/order-archive.err") ||
    fail "order failed on a home with an archive"
  assert_equals "" "$(cat "$TMP_ROOT/order-archive.err")" "order must not write to stderr"
  assert_equals "g1 g2 open1 " "$(section "$out" "可派：")" \
    "an item whose blockers are all done and archived must be dispatchable"
  assert_equals "w1 z1 r1 reused q1 d1 c1 " "$(section "$out" "先不派：")" \
    "every other queued item must be listed under 先不派"
  assert_contains "$out" "$(printf 'w1\t（未分類）\t-\t← 等 open1 完成')" "an unfinished blocker must be named"
  assert_contains "$out" "$(printf 'z1\t（未分類）\t-\t← 找不到它等的 fni1（不在 backlog，也不在封存檔）')" \
    "a blocker in neither the backlog nor the archive must be named as not found"
  assert_contains "$out" "$(printf 'r1\t（未分類）\t-\t← 等 reused 完成')" \
    "a blocker open in the backlog must stay open although an older item of its id is archived"
  assert_contains "$out" "$(printf 'q1\t（未分類）\t-\t← 找不到它等的 prq')" \
    "an item archived unfinished must not count as done"
  assert_contains "$out" "$(printf 'd1\t（未分類）\t-\t← 找不到它等的 dflt')" \
    "only the archive the backlog root configures may be read"
  assert_contains "$out" "$(printf 'c1\t（未分類）\t-\t← 等使用者決定（captain hold）；等 open1 完成')" \
    "an item held and blocked must give both reasons"
  assert_equals "$(sed -n 's/^- \[ \] \([^ ]*\) - .*/\1/p' "$home/data/backlog.md" | sort -u)" "$(every_listed "$out")" \
    "every queued item must be listed in some section"

  chmod 000 "$home/data/old-done.md"
  out=$(HOME="$TMP_ROOT/user-home" FM_HOME="$home" FM_ROOT_OVERRIDE="$ROOT" "$PLAN" order 2> "$TMP_ROOT/order-archive.err") ||
    fail "order failed on an unreadable archive"
  chmod 600 "$home/data/old-done.md"
  assert_equals "" "$(cat "$TMP_ROOT/order-archive.err")" "an unreadable archive must not write to stderr"
  assert_equals "open1 " "$(section "$out" "可派：")" "an unreadable archive must resolve nothing extra"
  assert_contains "$out" "$(printf 'g1\t（未分類）\t-\t← 找不到它等的 fin1')" "an unreadable archive must leave its ids open"
  pass "order resolves archived blockers and lists every queued item with why"
}

test_falls_open_when_the_snapshot_fails() {
  local home root out
  home=$(tb_make_home order-nosnap)
  tb_write_topics "$home"
  root="$TMP_ROOT/order-root"
  order_root "$root" none
  printf '#!/usr/bin/env bash\nexit 1\n' > "$root/bin/fm-fleet-snapshot.sh"
  out=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$root" "$root/bin/fm-dispatch-plan.sh" order) ||
    fail "order must exit 0 when the snapshot fails"
  assert_equals "讀不到 backlog，照平常的方式派工。" "$out" "order did not fall open on a failed snapshot"
  pass "order tells firstmate to dispatch as usual when the backlog cannot be read"
}

# order_root <dir> <offers>: a code root of order's own files whose
# fm-fleet-snapshot.sh logs its arguments to <dir>/snapshot.log and passes the
# real snapshot's --json report through. With <offers> label its argument
# parser has a --board-input case label; with comment it names --board-input
# only in a comment; with none it names it nowhere. That is all order's check
# of the snapshot reads.
order_root() {
  local root=$1 note="Offers the full report only." parser=""
  mkdir -p "$root/bin"
  cp "$ROOT"/bin/fm-dispatch-plan.sh "$ROOT"/bin/myshape-lib.sh "$ROOT"/bin/fm-primary-scope-lib.sh \
    "$ROOT"/bin/fm-secondmate-registry-lib.sh "$ROOT"/bin/fm-queue-source-lib.sh "$ROOT"/bin/fm-board-lib.sh \
    "$root/bin/"
  [ "$2" != comment ] || note="Offers --board-input, the board's cheaper read."
  [ "$2" != label ] || parser=$'case "$1" in\n  --board-input) ;;\nesac\n'
  printf '#!/usr/bin/env bash\n# %s\n%sprintf "%%s\\n" "$*" >> %q\nexec env -u FM_ROOT_OVERRIDE %q --json\n' \
    "$note" "$parser" "$root/snapshot.log" "$ROOT/bin/fm-fleet-snapshot.sh" > "$root/bin/fm-fleet-snapshot.sh"
  chmod +x "$root/bin/fm-fleet-snapshot.sh"
}

# asks <log>: "<--board-input calls> <--json calls>" in an order_root snapshot log.
asks() {
  printf '%s %s\n' "$(grep -cx -e --board-input "$1")" "$(grep -cx -e --json "$1")"
}

test_asks_for_board_input_when_the_snapshot_offers_it() {
  local home root offers out
  home=$(tb_make_home order-mode)
  tb_write_topics "$home"
  write_backlog "$home"
  write_tags "$home"
  for offers in label comment none; do
    root="$TMP_ROOT/order-mode-$offers"
    order_root "$root" "$offers"
    out=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$root" "$root/bin/fm-dispatch-plan.sh" order) ||
      fail "order failed with a snapshot that offers board input: $offers"
    assert_equals "h1 h2 r1 n1 u1 p1 d1 " "$(section "$out" "可派：")" \
      "order must rank the same either way (offers board input: $offers)"
  done
  assert_equals "1 0" "$(asks "$TMP_ROOT/order-mode-label/snapshot.log")" \
    "order must ask a snapshot whose parser offers --board-input for it, and not for --json"
  assert_equals "0 1" "$(asks "$TMP_ROOT/order-mode-comment/snapshot.log")" \
    "order must ask a snapshot that names --board-input only in a comment for --json"
  assert_equals "0 1" "$(asks "$TMP_ROOT/order-mode-none/snapshot.log")" \
    "order must ask a snapshot without --board-input for --json"
  pass "order reads the backlog through --board-input when the snapshot's parser offers it, else --json"
}

fm_test_run test_sections test_lists_hands_on_items_waiting_for_a_check \
  test_falls_open_without_a_usable_topic_file test_ranks_an_untagged_item_by_its_topic_line \
  test_resolves_archived_blockers_and_lists_every_item \
  test_falls_open_when_the_snapshot_fails test_asks_for_board_input_when_the_snapshot_offers_it
