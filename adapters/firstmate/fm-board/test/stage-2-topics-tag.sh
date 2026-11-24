#!/usr/bin/env bash
# Firstmate's tags against topics the board itself changed: the steps that
# myshape/test/stage-2-topics.sh had before the board's suites stopped needing
# bin/fm-board.sh. A tag given an id the board merged is written under the
# topic it was merged into, and a proposal the board confirmed when it started
# holds the task Firstmate had tagged to it and takes new tags.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=fm-board/test/helpers.sh
. "$ROOT/fm-board/test/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "skip: node not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot tb-s2tg)
trap 'tb_stop_boards; fm_test_cleanup' EXIT

test_tag_follows_a_merged_id() {
  local home
  home=$(tb_make_service_home merged)
  tb_run "$home" "$TOPIC" open >/dev/null || fail "the board did not start"
  tb_run "$home" "$TOPIC" create "Billing rework" --goal "move charges to the new service" >/dev/null ||
    fail "create failed"
  tb_run "$home" "$TOPIC" create "Side idea" --goal "fold into billing" --id side >/dev/null || fail "create failed"
  tb_run "$home" "$TOPIC" merge side billing-rework >/dev/null || fail "merge failed"
  tb_run "$home" "$BOARD" tag task-1 side >/dev/null
  assert_equals billing-rework "$(cut -d' ' -f1 "$home/data/task-1/topic")" "tag must follow the merged id"
  tb_run "$home" "$TOPIC" stop >/dev/null
  pass "a tag given a merged id is written under the topic it was merged into"
}

# A board that ran older code can hold topics still waiting for the captain;
# the new board confirms them the moment it starts (stage-2-topics.sh).
test_a_confirmed_proposal_takes_tags() {
  local home out
  home=$(tb_make_service_home leftover)
  tb_board_has_run "$home"
  tb_bind_home "$home"
  cat > "$home/data/topics.json" <<'JSON'
{
  "v": 1, "next_seq": 1,
  "queues": { "high": [], "normal": ["work"], "later": [] },
  "topics": {
    "work": { "name": "Work", "goal": "g", "status": "confirmed", "created_at": "2026-11-01T00:00:00Z" },
    "first": { "name": "First", "goal": "g", "status": "proposed", "created_at": "2026-11-18T01:00:00Z",
               "proposed_by": "firstmate" },
    "urgent": { "name": "Urgent", "goal": "g", "status": "proposed", "created_at": "2026-11-18T03:00:00Z",
                "proposed_by": "firstmate", "suggested_queue": "high" }
  },
  "merged": {}
}
JSON
  mkdir -p "$home/data/task-9"
  printf 'first 2026-11-18T01:30:00Z\n' > "$home/data/task-9/topic"
  out=$(tb_run "$home" "$TOPIC" which task-9) || fail "which failed on a board with leftover proposals: $out"
  assert_equals "First：" "$out" "a task tagged to a leftover proposal must now be under that topic"
  tb_run "$home" "$BOARD" tag task-10 urgent >/dev/null || fail "a confirmed proposal must take tags"
  tb_run "$home" "$TOPIC" stop >/dev/null
  pass "a proposal the board confirmed at start holds the task tagged to it and takes tags"
}

fm_test_run test_tag_follows_a_merged_id test_a_confirmed_proposal_takes_tags
