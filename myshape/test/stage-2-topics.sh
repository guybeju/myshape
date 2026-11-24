#!/usr/bin/env bash
# Every topic operation myshape.sh sends to the board: what it does once, that
# repeating it unchanged is harmless, and what it refuses. Firstmate's tags
# against the topics these change, and the topic of a task tagged through
# Firstmate, are in fm-board/test/stage-2-topics-tag.sh.
set -u

# shellcheck source=myshape/test/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "skip: node not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot tb-s2t)
trap 'tb_stop_boards; fm_test_cleanup' EXIT

HOME_DIR=$(tb_make_service_home topics)
tb_run "$HOME_DIR" "$TOPIC" open >/dev/null || fail "the board did not start"

t() {
  tb_run "$HOME_DIR" "$TOPIC" "$@"
}

code() {
  tb_code "$HOME_DIR" "$TOPIC" "$@"
}

# queue <name>: the ids in one queue, space separated.
queue() {
  jq -r --arg q "$1" '.queues[$q] | join(" ")' "$HOME_DIR/data/topics.json"
}

field() {  # <jq filter over topics.json>
  jq -r "$1" "$HOME_DIR/data/topics.json"
}

test_create() {
  local out
  out=$(t create "Billing rework" --goal "move charges to the new service")
  assert_equals "ok billing-rework 已建立，排在「一般」最後" "$out" "create must print the new id and where it landed"
  assert_equals "confirmed" "$(field '.topics["billing-rework"].status')" "a new topic must be confirmed at once"
  assert_equals "|billing-rework|" "$(queue high)|$(queue normal)|$(queue later)" \
    "a new topic without --queue must land in the normal queue"
  out=$(t create "Billing rework" --goal "move charges to the new service")
  assert_equals "ok billing-rework 本來就有這個議題，在「一般」" "$out" "repeating a create must return the same id"
  out=$(t create "Billing rework" --goal "move charges to the new service" --queue high)
  assert_contains "$out" "本來就有這個議題" "a repeat naming another queue must still be a repeat"
  assert_equals "|billing-rework|" "$(queue high)|$(queue normal)|$(queue later)" \
    "a repeated create must not add or move the topic"
  assert_equals 1 "$(field '.topics | length')" "repeating a create must not make a second topic"
  out=$(t create "Billing rework" --goal "a different goal" --queue later)
  assert_equals "ok billing-rework-2 已建立，排在「待辦」最後" "$out" "--queue must name the queue it lands in"
  out=$(t create "帳務重構" --goal "純中文名稱" --queue high)
  assert_contains "$out" "ok t1 " "a name with no usable slug must get t<n>"
  assert_equals 2 "$(field '.next_seq')" "next_seq must advance past the id it handed out"
  out=$(t create "Custom" --goal "own id" --id my.id-1)
  assert_contains "$out" "ok my.id-1 " "--id must be used as given"
  assert_equals "t1|billing-rework my.id-1|billing-rework-2" "$(queue high)|$(queue normal)|$(queue later)" \
    "each new topic must land after the topics already in its queue"
  assert_equals 4 "$(grep -c '"kind":"topic.created"' "$HOME_DIR/data/myshape/events.jsonl")" \
    "each new topic must write one system record, and a repeat none"
  assert_equals "null" "$(field '[.topics[] | .suggested_queue, .proposed_by] | map(select(. != null)) | first')" \
    "a topic must not carry fields of the removed proposal state"
  expect_code 1 "$(code create "Dup" --goal "g" --id t1)" "--id of an existing topic"
  expect_code 1 "$(code create "Bad" --goal "g" --id "-lead")" "--id starting with a dash"
  expect_code 1 "$(code create "   " --goal "g")" "an empty name"
  expect_code 1 "$(code create "Name" --goal "$(printf 'two\nlines')")" "a two-line goal"
  expect_code 1 "$(code create "$(printf 'x%.0s' $(seq 1 81))" --goal "g")" "a name over 80 characters"
  expect_code 2 "$(code create "No goal")" "create without --goal"
  expect_code 2 "$(code create)" "create without a name"
  expect_code 2 "$(code create "Name" --goal "g" --queue urgent)" "create with an unknown queue"
  expect_code 2 "$(code create "Name" --goal "g" --bogus x)" "create with an unknown flag"
  out=$(t propose "Old" --goal "old rules" 2>&1) && fail "propose must be gone"
  assert_contains "$out" "create" "propose must point at create"
  expect_code 2 "$(code confirm t1)" "confirm, which has nothing left to confirm"
  assert_equals 4 "$(field '.topics | length')" "the removed subcommands must write nothing"
  pass "create lands a confirmed topic last in its queue, is repeatable, and validates its input"
}

test_move() {
  local out
  out=$(t move my.id-1 high)
  assert_contains "$out" "ok my.id-1 已移到「高」" "move must report the new queue"
  assert_equals "t1 my.id-1" "$(queue high)" "a move without a position must append"
  t move billing-rework high --first >/dev/null
  assert_equals "billing-rework t1 my.id-1" "$(queue high)" "--first must put the topic at the front"
  t move my.id-1 high --before t1 >/dev/null
  assert_equals "billing-rework my.id-1 t1" "$(queue high)" "--before must insert ahead of the anchor"
  out=$(t move my.id-1 high)
  assert_contains "$out" "本來就在" "moving to the same queue without a position must not move it"
  assert_equals "billing-rework my.id-1 t1" "$(queue high)" "a repeated move must not send the topic to the end"
  out=$(t move my.id-1 high --before t1)
  assert_contains "$out" "本來就在" "repeating a positioned move must be a no-op"
  t move billing-rework-2 normal >/dev/null
  assert_equals "" "$(queue later)" "moving out of a queue must remove the topic from it"
  expect_code 1 "$(code move my.id-1 high --before billing-rework-2)" "--before a topic in another queue"
  expect_code 1 "$(code move my.id-1 high --before my.id-1)" "--before itself"
  expect_code 1 "$(code move nope high)" "moving an unknown topic"
  expect_code 2 "$(code move my.id-1 urgent)" "moving to an unknown queue"
  expect_code 2 "$(code move my.id-1)" "move without a queue"
  expect_code 2 "$(code move my.id-1 high --first --before t1)" "move with both positions"
  pass "move changes queue and position, and repeats leave the order alone"
}

test_rename_goal_and_close_propose() {
  local out
  out=$(t rename t1 "帳務")
  assert_contains "$out" "ok t1 名稱已改" "rename must report the change"
  assert_equals "帳務" "$(field '.topics.t1.name')" "rename must store the new name"
  assert_contains "$(t rename t1 "帳務")" "沒有變" "renaming to the same name must be a no-op"
  t goal t1 "新的目標" >/dev/null
  assert_equals "新的目標" "$(field '.topics.t1.goal')" "goal must store the new goal"
  expect_code 1 "$(code rename t1 "")" "an empty name"
  expect_code 1 "$(code goal nope "x")" "the goal of an unknown topic"
  expect_code 2 "$(code rename t1)" "rename without a name"

  out=$(t close-propose t1 --reason "三個 PR 都已合併")
  assert_contains "$out" "ok t1 已提議關閉" "close-propose must report the proposal"
  assert_equals "三個 PR 都已合併" "$(field '.topics.t1.close_proposal.reason')" "close-propose must store the reason"
  assert_contains "$(t close-propose t1 --reason "三個 PR 都已合併")" "已經提議過" "the same reason must be a no-op"
  t close-propose t1 --reason "換一個理由" >/dev/null
  assert_equals "換一個理由" "$(field '.topics.t1.close_proposal.reason')" "another reason must replace the first"
  expect_code 2 "$(code close-propose t1)" "close-propose without --reason"
  pass "rename, goal, and close-propose store their text and repeats are no-ops"
}

test_archive_and_reopen() {
  local out
  out=$(t archive t1)
  assert_equals "ok t1 已封存" "$out" "archive must report success"
  assert_equals "null" "$(field '.topics.t1')" "an archived topic must leave topics.json"
  assert_equals "billing-rework my.id-1" "$(queue high)" "an archived topic must leave its queue"
  assert_equals "帳務|null" "$(jq -r '.topics.t1 | "\(.name)|\(.close_proposal)"' "$HOME_DIR/data/topics-archive.json")" \
    "the archive must keep the topic and drop its close proposal"
  assert_contains "$(t archive t1)" "本來就已封存" "archiving twice must be a no-op"
  expect_code 1 "$(code move t1 high)" "moving an archived topic"
  expect_code 1 "$(code create "Reuse" --goal "g" --id t1)" "reusing an archived id"
  assert_not_contains "$(t list)" "t1" "list must hide an archived topic"
  assert_contains "$(t list --all)" "$(printf 't1\tarchived')" "list --all must show the archived topic"

  out=$(t reopen t1)
  assert_equals "ok t1 已重開，放進「一般」" "$out" "reopen must default to the normal queue"
  assert_equals "billing-rework-2 t1" "$(queue normal)" "reopen must append to the queue"
  assert_equals "{}" "$(jq -c '.topics' "$HOME_DIR/data/topics-archive.json")" "reopen must empty the archive entry"
  assert_contains "$(t reopen t1)" "本來就沒有封存" "reopening twice must be a no-op"
  expect_code 1 "$(code archive nope)" "archiving an unknown topic"
  expect_code 1 "$(code reopen nope)" "reopening an unknown topic"
  expect_code 2 "$(code archive)" "archive without an id"
  pass "archive and reopen move a topic between the two files and are repeatable"
}

test_merge() {
  local out
  t create "Side idea" --goal "fold into billing" --id side >/dev/null
  out=$(t merge side billing-rework)
  assert_equals "ok side 已併入 billing-rework" "$out" "merge must report the alias"
  assert_equals "billing-rework|null" "$(field '"\(.merged.side)|\(.topics.side)"')" \
    "merge must record the alias and drop the old topic"
  assert_contains "$(t merge side billing-rework)" "本來就已併入" "merging twice must be a no-op"
  t merge my.id-1 billing-rework >/dev/null
  assert_equals "billing-rework" "$(queue high)" "a merged topic must leave its queue"
  assert_contains "$(t rename side "Billing")" "ok billing-rework " "an old id must act on the topic it was merged into"
  expect_code 1 "$(code create "Reuse" --goal "g" --id side)" "reusing a merged id"
  expect_code 1 "$(code merge billing-rework billing-rework)" "merging a topic into itself"
  expect_code 1 "$(code merge nope t1)" "merging an unknown topic"
  expect_code 2 "$(code merge t1)" "merge with one id"
  pass "merge aliases the old id, and old ids keep working everywhere"
}

test_reset_token() {
  local before
  before=$(cat "$HOME_DIR/state/myshape/token")
  assert_contains "$(t reset-token)" "ok reset-token" "reset-token must report success"
  assert_not_equals "$before" "$(cat "$HOME_DIR/state/myshape/token")" "reset-token must replace the token"
  [ "$(wc -c < "$HOME_DIR/state/myshape/token" | tr -d ' ')" -eq 65 ] || fail "the token must be 64 hex characters"
  assert_equals "-rw-------" "$(tb_mode "$HOME_DIR/state/myshape/token")" "the new token must be 0600"
  pass "reset-token replaces the token file"
}

# A board that ran older code can hold topics still waiting for the captain.
# The new board confirms each at the end of the queue it was proposed for
# (normal when it named none), oldest first, the moment it starts.
test_confirms_leftover_proposals() {
  local home out
  # A home whose older board left proposals behind.
  home=$(tb_make_service_home leftover)
  tb_board_has_run "$home"
  tb_bind_home "$home"
  cat > "$home/data/topics.json" <<'JSON'
{
  "v": 1, "next_seq": 1,
  "queues": { "high": ["hot-old"], "normal": ["work"], "later": ["park"] },
  "topics": {
    "hot-old": { "name": "Hot old", "goal": "g", "status": "confirmed", "created_at": "2026-11-01T00:00:00Z" },
    "work": { "name": "Work", "goal": "g", "status": "confirmed", "created_at": "2026-11-01T00:00:00Z" },
    "park": { "name": "Park", "goal": "g", "status": "confirmed", "created_at": "2026-11-01T00:00:00Z" },
    "second": { "name": "Second", "goal": "g", "status": "proposed", "created_at": "2026-11-18T02:00:00Z",
                "proposed_by": "firstmate" },
    "first": { "name": "First", "goal": "g", "status": "proposed", "created_at": "2026-11-18T01:00:00Z",
               "proposed_by": "firstmate" },
    "urgent": { "name": "Urgent", "goal": "g", "status": "proposed", "created_at": "2026-11-18T03:00:00Z",
                "proposed_by": "firstmate", "suggested_queue": "high" }
  },
  "merged": { "old-first": "first" }
}
JSON
  cat > "$home/data/topics-archive.json" <<'JSON'
{ "v": 1, "topics": { "turned-down": { "name": "No", "goal": "g", "status": "proposed", "archived_at": "2026-11-17T00:00:00Z" } } }
JSON
  tb_run "$home" "$TOPIC" open >/dev/null || fail "the board did not start on a file with leftover proposals"
  assert_equals "hot-old urgent|work first second|park" \
    "$(jq -r '[.queues.high, .queues.normal, .queues.later] | map(join(" ")) | join("|")' "$home/data/topics.json")" \
    "leftover proposals must land last in their queues, oldest first, leaving every other topic in place"
  assert_not_contains "$(cat "$home/data/topics.json" "$home/data/topics-archive.json")" "proposed" \
    "the files must no longer hold a proposal once the board has started"
  assert_equals "turned-down" "$(jq -r '.topics | keys | join(" ")' "$home/data/topics-archive.json")" \
    "an archived proposal must stay archived"
  assert_equals "first" "$(jq -r '.merged["old-first"]' "$home/data/topics.json")" "merged ids must be kept"
  assert_equals 4 "$(grep -c '"kind":"topic.confirmed"' "$home/data/myshape/events.jsonl")" \
    "each confirmed proposal must write one system record"
  grep -q '看板不再等確認.*Second.*（id：second）' "$home/state/myshape/audit.jsonl" ||
    fail "firstmate, which may still be waiting to hear, must be told what was confirmed"
  assert_contains "$(tb_run "$home" "$TOPIC" list)" "$(printf 'first\tconfirmed\tnormal\t2\tFirst')" \
    "list must show the confirmed proposal in its queue"
  tb_run "$home" "$TOPIC" restart >/dev/null
  tb_run "$home" "$TOPIC" find First >/dev/null
  assert_equals 4 "$(grep -c '"kind":"topic.confirmed"' "$home/data/myshape/events.jsonl")" \
    "a later start must confirm nothing more"
  tb_run "$home" "$TOPIC" stop >/dev/null
  pass "a board that starts with leftover proposals confirms them at the end of their queues"
}

# A secondmate home keeps no topic file and session start never opens a board
# there, so it has no token and a topic can only be made in the main home.
test_secondmate_home_cannot_create() {
  local home out rc=0
  home=$(tb_make_secondmate_home sm-create sm1)
  tb_free_port > "$home/config/myshape-port"
  out=$(tb_run "$home" "$TOPIC" create "Elsewhere" --goal "g" 2>&1) || rc=$?
  expect_code 1 "$rc" "create in a secondmate home"
  assert_contains "$out" "這裡沒有看板" "the refusal must say this home has no board"
  assert_absent "$home/data/topics.json" "a secondmate home must not get a topic file"
  assert_absent "$home/state/myshape" "a secondmate home must not start a board"
  pass "create runs only in the main home"
}

fm_test_run test_create test_move test_rename_goal_and_close_propose \
  test_archive_and_reopen test_merge test_reset_token test_confirms_leftover_proposals \
  test_secondmate_home_cannot_create
t stop >/dev/null
