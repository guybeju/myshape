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

# Hashtags on topics: put on and taken off, one hashtag whatever its case or
# width, on a new topic with create, listed from the file with the service
# down, and found by find.
test_hashtags() {
  local out tags=$HOME_DIR/data/myshape/hashtags.json
  out=$(t hashtag billing-rework +AI_INFRA)
  assert_equals "ok billing-rework 已貼上 #AI_INFRA（新開的 hashtag：#AI_INFRA）" "$out" \
    "hashtag + must put the hashtag on and say it opened it"
  assert_contains "$(t hashtag billing-rework +ai_infra)" "本來就有 #AI_INFRA" "another case must be the same hashtag"
  assert_contains "$(t hashtag billing-rework +ＡＩ_INFRA)" "本來就有 #AI_INFRA" "a full-width spelling must be the same hashtag"
  expect_code 2 "$(code hashtag billing-rework -AI_INFRA)" "a name after a minus, which is not the remove form"
  expect_code 2 "$(code hashtag billing-rework)" "hashtag without a change"
  expect_code 1 "$(code hashtag billing-rework +a-b)" "a name with a dash"
  expect_code 1 "$(code hashtag nope +X)" "a hashtag on an unknown topic"
  out=$(t create "GPU" --goal "g" --id gpu --hashtag AI_INFRA --hashtag 基礎)
  assert_equals "ok gpu 已建立，排在「一般」最後；已貼上 #AI_INFRA、#基礎（新開的 hashtag：#基礎）" "$out" \
    "create --hashtag must put every hashtag on the new topic"
  assert_equals "AI_INFRA 基礎" "$(jq -r '.topics.gpu | join(" ")' "$tags")" "hashtags.json must hold the new topic's hashtags"
  assert_equals 2 "$(grep -c '"kind":"hashtag.added"' "$HOME_DIR/data/myshape/events.jsonl")" \
    "each change must write one record"
  t stop >/dev/null
  assert_equals "billing-rework gpu" "$(t list --hashtag ai_infra --json | jq -r 'map(.id) | sort | join(" ")')" \
    "list --hashtag must list the topics with the hashtag"
  assert_equals "$(printf 'gpu\tconfirmed\tnormal')" "$(t list --hashtag 基礎 | cut -f1-3)" \
    "list --hashtag must print the topics' usual lines"
  assert_contains "$(t list --hashtag NOPE)" "沒有議題貼著 #NOPE" "list --hashtag must say when no topic has it"
  expect_code 2 "$(code list --hashtag)" "list --hashtag without a name"
  assert_absent "$HOME_DIR/state/myshape/board.sock" "list --hashtag must not start the service"
  out=$(t find ai_infra)
  assert_contains "$out" "hashtag #AI_INFRA：2 個議題" "find must answer a hashtag with its topics"
  assert_contains "$out" "gpu　GPU（一般）" "find must name each topic with the hashtag"
  assert_equals "ok gpu 已撕掉 #AI_INFRA" "$(t hashtag gpu --remove ai_infra)" "--remove must take the hashtag off"
  assert_contains "$(t hashtag gpu --remove AI_INFRA)" "本來就沒有 #AI_INFRA" "removing twice must change nothing"
  pass "hashtags go on and off topics by command, and list and find read them"
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

sched() {  # <jq filter over schedules.json>
  jq -r "$1" "$HOME_DIR/data/myshape/schedules.json"
}

# Every schedule command, the queue rules of a scheduled topic, and list's
# open occurrences. Nothing opens an occurrence yet, so the open one is written
# into schedules.json while the board is stopped, as the clock will.
test_schedules() {
  local out key
  t create "Weekly sync" --goal "g" --id wsync --queue later >/dev/null
  t create "Mail" --goal "g" --id mailcheck --queue later >/dev/null
  t create "Loose" --goal "g" --id loose >/dev/null
  out=$(t schedule add wsync --weekly mon --at 10:00 --tz Asia/Taipei)
  assert_contains "$out" "ok wsync 已排程：每週一 10:00（Asia/Taipei）" "schedule add must say what it scheduled"
  assert_contains "$out" "最快的一場是" "schedule add must name the earliest occurrence"
  assert_equals "weekly mon 10:00|aggregator|false|false|on" \
    "$(sched '.series.wsync | "\(.rule)|\(.by)|\(.locked)|\(.seen)|\(.state)"')" \
    "an aggregator's schedule must be stored unlocked, unseen and on"
  assert_contains "$(t schedule add wsync --weekly mon --at 10:00 --tz Asia/Taipei)" "本來就有這筆排程" \
    "repeating schedule add must change nothing"
  expect_code 1 "$(code schedule add loose --daily --at 06:00)" "a schedule on a topic outside 待辦"
  assert_contains "$(t schedule add loose --daily --at 06:00 2>&1)" "先把議題移到待辦" \
    "the refusal must say to move the topic to 待辦 first"
  expect_code 2 "$(code schedule add mailcheck --daily)" "schedule add without --at"
  expect_code 2 "$(code schedule add mailcheck --weekly funday --at 06:00)" "an unknown weekday"
  expect_code 2 "$(code schedule add mailcheck --daily --at 06:00 --tz Mars/Base)" "an unknown zone"
  expect_code 2 "$(code schedule add mailcheck --daily --at 06:00 --lead 500)" "a lead out of range"
  expect_code 2 "$(code schedule settings)" "a page-only schedule press from the command line"

  expect_code 1 "$(code move wsync high)" "moving a scheduled topic out of 待辦"
  assert_contains "$(t move wsync high 2>&1)" "這個議題有排程，位置由時間決定" "move must say why"
  expect_code 0 "$(code move wsync later --first)" "a move within 待辦"

  assert_contains "$(t schedule edit wsync --at 11:00)" "ok wsync 排程已改：每週一 11:00" "schedule edit must retime"
  assert_contains "$(t schedule rt wsync hard-rt)" "ok wsync rt 改為 hard-rt" "schedule rt must set rt"
  expect_code 2 "$(code schedule rt wsync loud)" "an unknown rt"
  assert_contains "$(t schedule pause wsync)" "ok wsync 排程已暫停" "schedule pause must pause"
  assert_contains "$(t schedule resume wsync)" "ok wsync 排程已恢復" "schedule resume must resume"
  assert_contains "$(t schedule skip wsync)" "ok wsync 跳過" "schedule skip must skip the next occurrence"
  assert_contains "$(t schedule skip wsync)" "本來就已跳過" "repeating schedule skip must change nothing"
  assert_equals "wsync|weekly mon 11:00|hard-rt|null" \
    "$(t list --json | jq -r '.[] | select(.id == "wsync") | "\(.schedule.id)|\(.schedule.rule)|\(.schedule.rt)|\(.occurrence)"')" \
    "list --json must carry the schedule on its topic's row"
  assert_equals "null" "$(t list --json | jq -r '.[] | select(.id == "loose") | .schedule')" \
    "a topic without a schedule must have a null schedule"

  t stop >/dev/null
  key="wsync:20991130T0300Z"
  jq --arg key "$key" '.occurrences[$key] = {series: "wsync", at: "2099-11-30T03:00:00Z", state: "due",
      opened_at: "2099-11-30T02:45:00Z", closes_by: "2099-11-30T04:00:00Z"}
    | .occurrences["wsync:20200106T0300Z"] = {series: "wsync", at: "2020-01-06T03:00:00Z", state: "due",
      opened_at: "2020-01-06T02:45:00Z", closes_by: "2020-01-06T04:00:00Z"}' \
    "$HOME_DIR/data/myshape/schedules.json" > "$TMP_ROOT/schedules.json"
  cp "$TMP_ROOT/schedules.json" "$HOME_DIR/data/myshape/schedules.json"
  assert_equals "$(printf 'wsync\tnow\tdue\t%s\tWeekly sync（hard-rt）' "$key")" "$(t list | head -n 1)" \
    "list must put an open occurrence first, and not one past its closes_by"
  assert_equals "$key" "$(t list --json | jq -r '.[] | select(.id == "wsync") | .occurrence.key')" \
    "list --json must carry the open occurrence on its topic's row"
  assert_contains "$(t schedule take "$key" --note "有空位再開")" "ok $key 已接下" "schedule take must take an open occurrence"
  assert_equals "taken|有空位再開" \
    "$(jq -r --arg k "$key" '.occurrences[$k] | "\(.state)|\(.note)"' "$HOME_DIR/data/myshape/schedules.json")" \
    "take must store the state and note"
  expect_code 1 "$(code schedule take wsync:20991207T0300Z)" "taking an occurrence that is not open"
  expect_code 2 "$(code schedule close "$key" finished)" "closing with an unknown outcome"
  assert_contains "$(t schedule close "$key" "done" --note "紀錄已整理")" "ok $key 已結束" "schedule close must end it"
  assert_contains "$(t schedule close "$key" "done")" "本來就已結束" "repeating schedule close must change nothing"
  assert_equals "done" "$(jq -r '.recent.wsync[-1].outcome' "$HOME_DIR/data/myshape/schedules.json")" \
    "a closed occurrence must go to the last ten"

  assert_contains "$(t archive wsync)" "ok wsync 已封存" "archiving a scheduled topic"
  assert_equals "paused" "$(sched '.series.wsync.state')" "archiving must pause the schedule"
  assert_contains "$(t reopen wsync --queue high)" "（有排程，排程議題放在「待辦」）" "reopen must say where it landed"
  assert_contains " $(queue later) " " wsync " "a reopened scheduled topic must land in 待辦"

  t schedule add mailcheck --daily --at 06:00 >/dev/null
  expect_code 1 "$(code merge mailcheck wsync)" "merging two scheduled topics"
  assert_contains "$(t merge mailcheck wsync 2>&1)" "先刪掉其中一筆排程" "the merge refusal must say what to do"
  out=$(t merge mailcheck loose)
  assert_contains "$out" "排程跟著過來，議題放進「待辦」" "a single schedule must follow the merge"
  assert_contains " $(queue later) " " loose " "the topic merged into must go to 待辦"
  assert_equals "mailcheck" "$(t list --json | jq -r '.[] | select(.id == "loose") | .schedule.id')" \
    "the schedule must follow its topic into the one it was merged into"

  assert_contains "$(t schedule delete wsync)" "ok wsync 排程已刪除" "schedule delete must delete"
  assert_contains "$(t schedule delete wsync)" "本來就已刪除" "repeating schedule delete must change nothing"
  assert_equals "wsync" "$(sched '.removed | keys | join(",")')" "a deleted schedule must be kept for undoing"
  assert_contains "$(t move wsync high)" "ok wsync 已移到「高」" "a topic without its schedule moves again"
  # Nine schedule changes so far, under the aggregator's default cap of ten an hour.
  assert_equals "aggregator" "$(jq -r 'select(.kind == "schedule.created") | .by' \
    "$HOME_DIR/data/myshape/events.jsonl" | sort -u | tr -d '\n')" "every schedule change must write a record by its actor"
  pass "schedule commands keep a topic coming up on a timetable, held in 待辦"
}

# audit_ids <write id>: how many first lines the audit log has for that write.
audit_ids() {
  jq -r --arg id "$1" 'select(.write_id == $id and .sending != null) | .write_id' \
    "$HOME_DIR/state/myshape/audit.jsonl" | wc -l | tr -d ' '
}

# The board's clock, which schedule tick runs once, against schedules.json
# written while the board is stopped (times are relative to now): csoon is up
# in about twelve minutes, so with its 15-minute lead its occurrence opens with
# a coming-up notice, a few minutes late, not late enough to say so;
# cmissed's window passed while the board was down, so it gets one missed
# notice; ccold's open occurrence is past its closes_by, so the board ends it.
# Every notice has its fixed id, and ticking again hands nothing over twice.
test_schedule_tick() {
  local times soon_hm soon gone_hm gone cold_hm cold an_hour_ago four_hours_ago two_hours_ago file
  local pre missed key out
  t create "Clock soon" --goal "g" --id csoon --queue later >/dev/null
  t create "Clock missed" --goal "g" --id cmissed --queue later >/dev/null
  t create "Clock cold" --goal "g" --id ccold --queue later >/dev/null
  t stop >/dev/null
  times=$(node -e '
    const m = 60000, now = Math.floor(Date.now() / m) * m;
    const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
    const hm = (t) => iso(t).slice(11, 16);
    const compact = (t) => iso(t).replace(/[-:]/g, "").slice(0, 13) + "Z";
    const soon = now + 12 * m, gone = now - 180 * m, cold = now - 120 * m;
    console.log([hm(soon), compact(soon), hm(gone), compact(gone), hm(cold), compact(cold),
      iso(now - 60 * m), iso(now - 240 * m), iso(cold)].join(" "));') || fail "node could not compute the times"
  read -r soon_hm soon gone_hm gone cold_hm cold an_hour_ago four_hours_ago two_hours_ago <<< "$times"
  file="$HOME_DIR/data/myshape/schedules.json"
  [ -f "$file" ] || printf '{"v":1}\n' > "$file"
  jq --arg soon "daily $soon_hm" --arg gone "daily $gone_hm" --arg cold "daily $cold_hm" \
    --arg hour "$an_hour_ago" --arg four "$four_hours_ago" --arg two "$two_hours_ago" \
    --arg ckey "ccold:$cold" '
    def daily($topic; $rule; $made): {topic: $topic, title: "old title", rule: $rule, tz: "UTC",
      duration_min: 30, lead_min: 15, rt: "hard-rt", rt_locked: false, state: "on", locked: true,
      by: "captain", created_at: $made};
    .series.csoon = daily("csoon"; $soon; $hour)
    | .series.cmissed = (daily("cmissed"; $gone; $four) + {checked_through: $four, rt: "none"})
    | .series.ccold = daily("ccold"; $cold; $four)
    | .occurrences[$ckey] = {series: "ccold", at: $two, state: "due", opened_at: $two,
        closes_by: $hour}' "$file" > "$TMP_ROOT/schedules.json" || fail "could not write the schedules"
  cp "$TMP_ROOT/schedules.json" "$file"

  out=$(t schedule tick) || fail "schedule tick failed: $out"
  assert_contains "$out" "ok schedule tick：" "schedule tick must say what the check did"
  pre="w-s-csoon-$soon-pre"
  missed="w-s-cmissed-$gone-missed"
  key="csoon:$soon"
  assert_equals "upcoming|$pre" "$(jq -r --arg k "$key" '.occurrences[$k] | "\(.state)|\(.notices.pre)"' "$file")" \
    "an occurrence inside its window must open with its coming-up notice's fixed id"
  assert_equals 1 "$(audit_ids "$pre")" "the coming-up notice must be handed over once, under its fixed id"
  assert_equals "schedule.upcoming|true|false" \
    "$(jq -r --arg id "$pre" 'select(.write_id == $id and .sending != null) | .sending.action
      | "\(.event)|\(.text | startswith("排程「Clock soon」"))|\(.text | contains("old title"))"' \
      "$HOME_DIR/state/myshape/audit.jsonl")" \
    "the coming-up notice must name the topic, not the schedule's title"
  assert_contains "$(jq -r --arg id "$pre" 'select(.write_id == $id and .sending != null) | .sending.action.text' \
    "$HOME_DIR/state/myshape/audit.jsonl")" "（議題 csoon，這一場 $key）（hard-rt）" \
    "the coming-up notice must carry the topic id, the occurrence key and the rt word"
  assert_equals "missed|$missed" "$(jq -r '.recent.cmissed[-1] | "\(.outcome)|\(.notice)"' "$file")" \
    "a window that passed while the board was down must be recorded missed with its notice's id"
  assert_equals 1 "$(audit_ids "$missed")" "the missed notice must be handed over once"
  assert_equals "untaken|board" "$(jq -r '.recent.ccold[-1] | "\(.outcome)|\(.by)"' "$file")" \
    "an occurrence past its closes_by must be ended by the board"
  assert_equals "null" "$(jq -r --arg k "ccold:$cold" '.occurrences[$k]' "$file")" \
    "an ended occurrence must leave the open ones"
  assert_equals "board" "$(jq -r 'select(.kind == "occurrence.opened" and .topic == "csoon") | .by' \
    "$HOME_DIR/data/myshape/events.jsonl" | sort -u | tr -d '\n')" "the clock's records must be by the board"

  out=$(t schedule tick) || fail "a second schedule tick failed: $out"
  out=$(t schedule tick) || fail "a third schedule tick failed: $out"
  assert_equals "1|1" "$(audit_ids "$pre")|$(audit_ids "$missed")" \
    "ticking again must hand no notice over twice"
  assert_equals 1 "$(jq -r 'select(.kind == "occurrence.opened" and .topic == "csoon") | .rid' \
    "$HOME_DIR/data/myshape/events.jsonl" | wc -l | tr -d ' ')" "ticking again must open nothing twice"
  pass "schedule tick opens, sends under fixed ids, ends and reports missed, once"
}

fm_test_run test_create test_move test_rename_goal_and_close_propose \
  test_archive_and_reopen test_merge test_hashtags test_reset_token test_confirms_leftover_proposals \
  test_secondmate_home_cannot_create test_schedules test_schedule_tick
t stop >/dev/null
