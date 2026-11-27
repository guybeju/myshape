#!/usr/bin/env bash
# What the board knows after reading its homes: agents and their lights,
# pending decisions, updates, per-home status, and the summary/which commands.
# The main home and a local secondmate home are read by the real scripts; a
# "remote" home is reached through a stand-in fm-on.sh.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=fm-board/test/helpers.sh
. "$ROOT/fm-board/test/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "skip: node not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot tb-s3)
trap 'tb_stop_boards; fm_test_cleanup' EXIT

export MYSHAPE_TEST=1 MYSHAPE_READ_MS=300
export MYSHAPE_IDLE_MS=8000 MYSHAPE_STALE_MS=4000
export FM_SNAPSHOT_NOW=2026-07-25T00:00:00Z

# A private code root: this checkout's scripts, its own git history (so every
# home reports the same commit), and a stand-in fm-on.sh.
CODE_ROOT="$TMP_ROOT/root"
fm_git_init_commit "$CODE_ROOT"
mkdir -p "$CODE_ROOT/bin" "$CODE_ROOT/myshape"
ln -s "$ROOT"/bin/* "$CODE_ROOT/bin/"
ln -s "$ROOT/myshape/dist" "$CODE_ROOT/myshape/dist"
rm "$CODE_ROOT/bin/fm-on.sh"
cat > "$CODE_ROOT/bin/fm-on.sh" <<'SH'
#!/usr/bin/env bash
# Stand-in for fm-on.sh: "remote" home <id> is the local directory
# $TB_REMOTES/<id>. Files in that directory steer what comes back.
set -u
id=$1
shift
remote="$TB_REMOTES/$id"
printf '%s\n' "$*" >> "$remote/fm-on.calls"
if [ -e "$remote/not-on-fork" ]; then
  echo "fm-remote-entrypoint: command is not tracked by the configured remote root" >&2
  exit 1
fi
[ ! -e "$remote/unreachable" ] || exit 255
out=$(FM_HOME="$remote" "$(dirname "$0")/$1" "${@:2}") || exit 1
if [ -e "$remote/schema" ]; then
  printf '%s' "$out" | jq --argjson schema "$(cat "$remote/schema")" '.schema = $schema'
elif [ -e "$remote/commit" ]; then
  printf '%s' "$out" | jq --arg commit "$(cat "$remote/commit")" '.code_commit = $commit'
else
  printf '%s\n' "$out"
fi
SH
chmod +x "$CODE_ROOT/bin/fm-on.sh"
export TB_REMOTES="$TMP_ROOT/remotes"
tb_fake_aggregator "$CODE_ROOT"

MAIN=$(tb_make_service_home main)
tb_bind_home "$MAIN"
LOCAL_SM=$(tb_make_secondmate_home sm sm1)
mkdir -p "$TB_REMOTES"
REMOTE_SM="$TB_REMOTES/far1"
mkdir -p "$REMOTE_SM/state" "$REMOTE_SM/data" "$REMOTE_SM/config"
printf 'far1\n' > "$REMOTE_SM/.fm-secondmate-home"
cat > "$MAIN/data/secondmates.md" <<EOF
- sm1 - Local helper (home: $LOCAL_SM; scope: sample work; projects: alpha; added 2026-11-01)
- far1 - Remote helper (host: farbox; root: /srv/fm; home: /srv/fm-home; scope: remote work; projects: beta; added 2026-11-01)
EOF

t() {
  MYSHAPE_HOME="$MAIN" MYSHAPE_ROOT_OVERRIDE="$CODE_ROOT" "$CODE_ROOT/bin/myshape.sh" "$@"
}

# b: firstmate's side of the board, for the tags a test needs.
b() {
  FM_HOME="$MAIN" FM_ROOT_OVERRIDE="$CODE_ROOT" "$CODE_ROOT/bin/fm-board.sh" "$@"
}

# view [jq filter]: read every home now, then print (part of) the board state.
view() {
  t open >/dev/null || fail "the board did not start"
  tb_op "$MAIN" dump '{"refresh":true}' | jq -r "${1:-.}"
}

# add_task <home> <id> <status line>: an in-flight worker with a status log.
add_task() {
  mkdir -p "$1/projects/$2"
  fm_write_meta "$1/state/$2.meta" "window=firstmate:fm-$2" "worktree=$1/projects/$2" \
    "project=sample" "harness=claude" "kind=ship" "mode=ship" "yolo=off"
  printf '%s\n' "$3" > "$1/state/$2.status"
}

ledger() {  # <home> <json line>...
  local home=$1
  shift
  printf '%s\n' "$@" >> "$home/state/fleet-ledger.jsonl"
}

tag_at() {  # <home> <task> <topic> <iso time>
  mkdir -p "$1/data/$2"
  printf '%s %s\n' "$3" "$4" >> "$1/data/$2/topic"
}

setup_fleet() {
  t open >/dev/null || fail "the board did not start"
  t create "Billing" --goal "rework billing" --id billing >/dev/null
  t create "Login" --goal "new login page" --id login --queue high >/dev/null
  t create "Later" --goal "someday" --id later --queue later >/dev/null
  cat > "$MAIN/data/backlog.md" <<'EOF'
## In flight
- [ ] ship-a - Ship A (repo: sample) (kind: ship) (hold: merge it?) (hold-kind: captain)
  Captain hold set: 2026-07-24T00:00:00Z
- [ ] ship-b - Ship B (repo: sample) (kind: ship)

## Queued
- [ ] call-login - Pick a provider (repo: sample) (kind: captain) (hold: 用哪一家？ 選項：A 家 | B 家) (hold-kind: captain)
  Captain hold set: 2026-07-20T00:00:00Z
- [ ] call-origin - Follow-up call (repo: sample) (kind: captain) (hold: keep going?) (hold-kind: captain)
  Captain hold set: 2026-07-22T00:00:00Z
  Captain hold origin: ship-b
- [ ] call-loose - Loose call (repo: sample) (kind: captain) (hold: unrelated question) (hold-kind: captain)
  Captain hold set: 2026-07-23T00:00:00Z
- [ ] call-dated - Dated call (repo: sample) (kind: captain) (hold: revisit) (hold-kind: captain) (hold-until: 2026-12-01)
  Captain hold set: 2026-07-20T00:00:00Z

## Done
EOF
  add_task "$MAIN" ship-a "working: on it"
  add_task "$MAIN" ship-b "needs-decision: which API shape"
  add_task "$MAIN" ship-idea "working: exploring"
  add_task "$MAIN" ship-loose "working: nobody tagged me"
  tag_at "$MAIN" ship-a billing 2026-07-01T00:00:00Z
  tag_at "$MAIN" ship-b later 2026-07-01T00:00:00Z
  tag_at "$MAIN" call-login login 2026-07-01T00:00:00Z
  tag_at "$MAIN" ship-idea idea 2026-07-01T00:00:00Z
  tag_at "$MAIN" gone-task billing 2026-07-01T00:00:00Z
  : > "$MAIN/config/fleet-ledger"
  # 1782864000 is 2026-07-01T00:00:00Z.
  ledger "$MAIN" \
    '{"v":1,"ts":1782864100,"event":"task.dispatched","task":"ship-a","kind":"ship","project":"sample","harness":"claude","model":null}' \
    '{"v":1,"ts":1782864200,"event":"task.status","task":"ship-a","state":"working","key":null,"text":" halfway"}' \
    '{"v":1,"ts":1782864300,"event":"task.pr_ready","task":"ship-a","pr":"https://example.invalid/pull/7"}' \
    '{"v":1,"ts":1782864400,"event":"task.dispatched","task":"gone-task","kind":"ship","project":"sample","harness":"claude","model":null}' \
    '{"v":1,"ts":1782864500,"event":"task.merged","task":"gone-task","via":"pr","pr":"https://example.invalid/pull/3"}' \
    '{"v":1,"ts":1782864600,"event":"task.cleaned_up","task":"gone-task"}'

  add_task "$LOCAL_SM" sm-work "blocked: waiting"
  tag_at "$LOCAL_SM" sm-work login 2026-07-01T00:00:00Z
  add_task "$REMOTE_SM" far-work "working: far away"
  tag_at "$REMOTE_SM" far-work billing 2026-07-01T00:00:00Z
}

test_agents_lights_and_placement() {
  local out
  out=$(view '.agents | map("\(.home)/\(.task)=\(.light):\(.topic // .unsorted_reason)") | sort | join(" ")')
  assert_contains "$out" "main/ship-a=decide:billing" "a task with a live captain hold must show the decide light"
  assert_contains "$out" "main/ship-b=unknown:later" "a tagged task must be placed in its topic"
  assert_contains "$out" "main/ship-idea=unknown:unknown-topic" "a task tagged with an unknown topic must be unsorted"
  assert_contains "$out" "main/ship-loose=unknown:no-tag" "an untagged task must be unsorted"
  assert_contains "$out" "main/gone-task=done:billing" "a cleaned-up task must be done, from its last ledger event"
  assert_contains "$out" "sm1/sm-work=unknown:login" "a local secondmate's worker must be listed with its home"
  assert_contains "$out" "far1/far-work=unknown:billing" "a remote secondmate's worker must be listed with its home"
  assert_equals 7 "$(view '.agents | length')" "only workers are agents, never a secondmate or a queued call"
  pass "agents carry a light, their home, and the topic their tag resolves to"
}

test_holds_are_placed_and_ordered() {
  local out
  out=$(view '.holds | map("\(.task):\(.topic // "-"):\(if .live then "live" else .deferred_reason end)") | join(" ")')
  assert_equals "call-login:login:live ship-a:billing:live call-origin:later:live call-loose:-:live call-dated:-:延到 2026-12-01" "$out" \
    "holds must be ordered live first, by the topic's queue, with unsorted last, then deferred"
  assert_equals 'A 家|B 家' "$(view '.holds[] | select(.task == "call-login") | .options | join("|")')" \
    "an option line at the end of the question must become buttons"
  assert_equals 0 "$(view '.holds[] | select(.task == "ship-a") | .options | length')" \
    "a question without an option line has no buttons"
  assert_equals "main/ship-b:later:which API shape" \
    "$(view '.questions | map("\(.home)/\(.task):\(.topic):\(.summary)") | join(" ")')" \
    "a worker needs-decision must be listed with its topic"
  pass "pending decisions follow their task's or origin's topic and the queue order"
}

# The adapter declares decisions_at_once 1: the first live decision in that
# order is in front, every other live one waits its turn, deferred ones are
# outside the cap, and a queued item whose decision waits says so.
test_one_decision_at_a_time() {
  assert_equals "call-login:false ship-a:true call-origin:true call-loose:true call-dated:false" \
    "$(view '.holds | map("\(.task):\(.waits_turn)") | join(" ")')" \
    "only the first live decision may be in front; the rest wait their turn, deferred ones never"
  assert_equals "call-login:等你決定 call-origin:決定排隊 call-loose:決定排隊 call-dated:等你決定" \
    "$(view '[.queued[] | select(.task | startswith("call-")) | "\(.task):\(.waiting)"] | join(" ")')" \
    "a queued item whose decision waits its turn must say 決定排隊"
  pass "the board shows one decision at a time, in its order, with the rest queued"
}

test_updates_and_topics() {
  local out
  out=$(view '.updates | map(select(.source == "ledger" and .topic == "billing")) | map("\(.task):\(.event)") | join(" ")')
  assert_equals "gone-task:task.cleaned_up gone-task:task.merged gone-task:task.dispatched ship-a:task.pr_ready ship-a:task.status ship-a:task.dispatched" "$out" \
    "ledger events must be listed newest first under their task's topic"
  assert_equals "https://example.invalid/pull/7|working：halfway" \
    "$(view '[.updates[] | select(.task == "ship-a" and .source == "ledger")] | "\(.[0].pr)|\(.[1].text)"')" \
    "updates must carry the PR link and the status text"
  assert_equals 3 "$(view '[.updates[] | select(.source == "board" and .event == "topic.created")] | length')" \
    "system records must appear among the updates"
  assert_equals "login|billing|later" "$(view '[.queues.high, .queues.normal, .queues.later] | map(join(",")) | join("|")')" \
    "the view must carry the queues"
  assert_equals "confirmed" "$(view '.topics.billing.status')" "the view must carry each topic's status"
  pass "updates gather ledger events and system records under each topic"
}

test_event_follows_the_tag_in_effect() {
  # ship-a moves from billing to login after its first three events.
  tag_at "$MAIN" ship-a login 2026-07-02T00:00:00Z
  ledger "$MAIN" '{"v":1,"ts":1782960000,"event":"task.status","task":"ship-a","state":"done","key":null,"text":" finished"}'
  assert_equals "login" "$(view '.agents[] | select(.task == "ship-a") | .topic')" "the agent must follow its newest tag"
  assert_equals "login:1 billing:3" \
    "$(view '[.updates[] | select(.task == "ship-a" and .source == "ledger")] | group_by(.topic) | map("\(.[0].topic):\(length)") | reverse | join(" ")')" \
    "events before a re-tag stay with the old topic; later events go to the new one"
  assert_equals "login:1 billing:1" \
    "$(view '[.updates[] | select(.task == "ship-a" and .source == "tag")] | group_by(.topic) | map("\(.[0].topic):\(length)") | reverse | join(" ")')" \
    "each tag made by command must show once, under the topic it filed the task in"
  pass "each ledger event belongs to the topic tagged when it happened"
}

test_ledger_is_stored_once_and_survives_rewrites() {
  local events="$MAIN/data/myshape/events.jsonl" before
  view >/dev/null
  before=$(grep -c '"src":"ledger"' "$events")
  assert_equals 7 "$before" "every ledger line must be stored exactly once"
  grep -q '"home":"main","raw":"{\\"v\\":1' "$events" || fail "stored ledger events must carry their home and raw line"
  # The home's ledger is rewritten: old lines again plus a new one.
  { head -n 3 "$MAIN/state/fleet-ledger.jsonl"; printf '%s\n' '{"v":1,"ts":1782970000,"event":"task.status","task":"ship-b","state":"working","key":null,"text":" new"}'; } > "$MAIN/state/ledger.new"
  mv "$MAIN/state/ledger.new" "$MAIN/state/fleet-ledger.jsonl"
  view >/dev/null
  assert_equals $((before + 1)) "$(grep -c '"src":"ledger"' "$events")" \
    "after a rewritten ledger only the unseen line may be added"
  # Crash between storing events and saving the cursor: the cursor goes back.
  t stop >/dev/null
  printf '{}\n' > "$MAIN/data/myshape/offsets.json"
  view >/dev/null
  assert_equals $((before + 1)) "$(grep -c '"src":"ledger"' "$events")" \
    "re-reading a piece after a lost cursor must not duplicate events"
  pass "ledger events are stored once across rewrites, restarts, and lost cursors"
}

test_home_status() {
  local out
  out=$(view '.homes | map("\(.id):\(.version):\(.ledger_enabled)") | join(" ")')
  assert_equals "main:same:true sm1:same:false far1:same:false" "$out" \
    "every home must report its version and whether its ledger is open"
  assert_contains "$(t status)" "home far1：相同" "status must list each home's version"

  printf 'deadbeef\n' > "$REMOTE_SM/commit"
  assert_equals "different" "$(view '.homes[] | select(.id == "far1") | .version')" "another commit must read as different"
  assert_equals 1 "$(view '[.agents[] | select(.home == "far1")] | length')" "a home on another commit is still used"
  rm "$REMOTE_SM/commit"
  printf '99\n' > "$REMOTE_SM/schema"
  assert_equals "incompatible" "$(view '.homes[] | select(.id == "far1") | .version')" "another schema must read as incompatible"
  assert_equals 0 "$(view '[.agents[] | select(.home == "far1")] | length')" "an incompatible home's output must not be used"
  rm "$REMOTE_SM/schema"
  : > "$REMOTE_SM/not-on-fork"
  assert_equals "unreported" "$(view '.homes[] | select(.id == "far1") | .version')" "a home without the script must read as unable to report"
  assert_contains "$(view '.homes[] | select(.id == "far1") | .error')" "還沒換到 fork" "its banner must be firstmate's not-on-the-fork line"
  assert_equals 0 "$(view '[.agents[] | select(.home == "far1")] | length')" "a home not on the fork shows no agents"
  assert_contains "$(t status)" "home far1：無法回報" "status must say which home cannot report"
  rm "$REMOTE_SM/not-on-fork"
  assert_equals "same" "$(view '.homes[] | select(.id == "far1") | .version')" "the home must recover once it answers again"

  : > "$REMOTE_SM/unreachable"
  view >/dev/null
  sleep 5
  out=$(tb_op "$MAIN" dump | jq -r '"\(.homes[] | select(.id == "far1") | .stale)|\(.agents[] | select(.home == "far1") | "\(.light):\(.stale)")|\(.homes[] | select(.id == "main") | .stale)"')
  assert_equals "true|unknown:true|false" "$out" \
    "a home not read for longer than the stale limit turns its agents unknown; other homes are unaffected"
  rm "$REMOTE_SM/unreachable"
  pass "each home shows its version, ledger flag, and staleness"
}

test_polling_follows_viewers() {
  local calls="$REMOTE_SM/fm-on.calls" before after views=0
  tb_op "$MAIN" dump >/dev/null
  sleep 1
  before=$(wc -l < "$calls")
  after=$before
  # A slow runner may need more than one second to start a scheduled read, so
  # keep viewing for up to 10 one-second rounds. Every round ends in a view
  # followed by one second, so the idle-limit checks below still start one
  # second after the last view.
  while [ "$after" -le "$before" ] && [ "$views" -lt 10 ]; do
    tb_op "$MAIN" dump >/dev/null
    sleep 1
    views=$((views + 1))
    after=$(wc -l < "$calls")
  done
  [ "$after" -gt "$before" ] || fail "homes must be read on a schedule while someone is viewing"
  assert_contains "$(t status)" "輪詢：進行中" "status must report polling while someone is viewing"
  sleep 9
  before=$(wc -l < "$calls")
  sleep 5
  assert_equals "$before" "$(wc -l < "$calls")" "polling must stop once nobody has viewed for the idle limit"
  assert_contains "$(t status)" "輪詢：沒在跑" "status must report that polling stopped"
  # Upstream's snapshot fetches a remote home summary on its own; everything
  # else that reached the remote must be the board's one read command, with
  # the closed decisions' cursor once the home has reported one.
  grep -v '^fm-remote-file.sh get state/home-summary.json ' "$calls" |
    grep -vEq '^fm-topic-board-read.sh (--closed-since [0-9]+ [0-9a-f-]+ )?[0-9]+ [0-9a-f-]+$' &&
    fail "the board ran something other than the read command remotely"
  grep -qE '^fm-topic-board-read.sh --closed-since [0-9]+ [0-9a-f-]+ ' "$calls" ||
    fail "a remote home that reported a closed decisions' cursor must be given it back"
  pass "the board polls only while someone is viewing, and only with the read command"
}

test_summary_and_which() {
  local out
  out=$(printf 'PR 已就緒，等你看。\n' | t summary ship-a ready -)
  assert_equals "Login：" "$out" "summary must print the topic name as the reminder prefix"
  printf 'PR 已就緒，等你看。\n' | t summary ship-a ready - >/dev/null
  assert_equals 1 "$(wc -l < "$MAIN/data/myshape/summaries.jsonl" | tr -d ' ')" "an identical summary must be stored once"
  printf '換了一個 PR。' | t summary ship-a ready - >/dev/null
  assert_equals 2 "$(wc -l < "$MAIN/data/myshape/summaries.jsonl" | tr -d ' ')" "a different text is a new summary"
  assert_equals "ready|login|https://example.invalid/pull/7" \
    "$(view '.summaries[0] | "\(.kind)|\(.topic)|\(.pr)"')" "a ready summary must pick up the task's PR link"
  out=$(printf 'scout 的結論。' | t summary --home far1 far-work report -)
  assert_equals "Billing：" "$out" "summary --home must resolve a secondmate's task"
  assert_equals "null" "$(view '.summaries[] | select(.task == "far-work") | .pr')" "a report summary carries no PR link"
  assert_equals "未分類：" "$(printf 'x' | t summary ship-loose failed -)" "an untagged task must be reported as unsorted"
  assert_equals "未分類：" "$(t which ship-idea)" "a task of an unknown topic is unsorted"
  assert_equals "Login：" "$(t which ship-a)" "which must print the same prefix without storing"
  assert_equals "Login：" "$(t which --home sm1 sm-work)" "which --home must resolve a local secondmate's task"
  : > "$REMOTE_SM/unreachable"
  assert_equals "議題不明（never-seen）：" "$(t which --home far1 never-seen)" \
    "a home that cannot be read must give 'unknown', not 'unsorted'"
  rm "$REMOTE_SM/unreachable"
  assert_equals "未分類：" "$(t which --home far1 never-seen)" "once the home is readable an untagged task is unsorted"

  expect_code 1 "$(printf 'x' | tb_code "$MAIN" "$CODE_ROOT/bin/myshape.sh" summary --home nobody ship-a ready -)" "summary with an unregistered home"
  expect_code 1 "$(printf '   ' | tb_code "$MAIN" "$CODE_ROOT/bin/myshape.sh" summary ship-a ready -)" "an empty summary"
  expect_code 1 "$(printf 'x%.0s' $(seq 1 601) | tb_code "$MAIN" "$CODE_ROOT/bin/myshape.sh" summary ship-a ready -)" "a summary over 600 characters"
  expect_code 2 "$(printf 'x' | tb_code "$MAIN" "$CODE_ROOT/bin/myshape.sh" summary ship-a shipped -)" "an unknown summary kind"
  expect_code 2 "$(tb_code "$MAIN" "$CODE_ROOT/bin/myshape.sh" summary ship-a ready)" "summary without the stdin marker"
  expect_code 2 "$(tb_code "$MAIN" "$CODE_ROOT/bin/myshape.sh" which)" "which without a task"
  pass "summary stores once and both commands print the reminder prefix"
}

test_summary_on_a_cold_board_reads_the_main_home_first() {
  t stop >/dev/null
  assert_equals "Billing：" "$(printf '剛啟動就寫摘要。' | t summary --home far1 far-work landed -)" \
    "a board that has never polled must still know the secondmates"
  pass "summary --home works on a board that was just started"
}

test_dump_is_test_only() {
  t stop >/dev/null
  MYSHAPE_TEST=0 t open >/dev/null
  tb_op "$MAIN" dump >/dev/null 2>&1 && fail "dump must not exist outside test mode"
  t stop >/dev/null
  pass "the dump op is registered only in test mode"
}

test_which_follows_a_retag_nobody_is_watching() {
  t restart >/dev/null || fail "the board did not restart"
  assert_equals "Login：" "$(t which ship-a)" "the task starts in its first topic"
  b tag ship-a billing >/dev/null || fail "retagging failed"
  assert_equals "Billing：" "$(t which ship-a)" "which must follow a retag even when no page keeps the board polling"
  assert_equals "Billing：" "$(printf 'retagged' | t summary ship-a report -)" "summary must follow the retag too"
  pass "which and summary read the task's topic afresh"
}

test_a_wrong_summary_can_be_retracted() {
  local out
  printf '已落地。' | t summary ship-a landed - >/dev/null
  assert_equals 1 "$(view '[.summaries[] | select(.task == "ship-a" and .kind == "landed")] | length')" \
    "the summary to retract must be on the board first"
  out=$(printf '合併其實失敗了。' | t retract ship-a landed -) || fail "retract failed"
  assert_contains "$out" "已落地。" "retract must say which summary it removed"
  assert_equals 0 "$(view '[.summaries[] | select(.task == "ship-a" and .kind == "landed")] | length')" \
    "a retracted summary must leave the board"
  grep -q '合併其實失敗了' "$MAIN/data/myshape/summaries.jsonl" || fail "the reason must be kept on file"
  expect_code 1 "$(printf 'again' | tb_code "$MAIN" "$CODE_ROOT/bin/myshape.sh" retract ship-a landed -)" "nothing left to retract"
  expect_code 1 "$(printf '  ' | tb_code "$MAIN" "$CODE_ROOT/bin/myshape.sh" retract ship-a ready -)" "a retraction without a reason"
  expect_code 2 "$(printf 'x' | tb_code "$MAIN" "$CODE_ROOT/bin/myshape.sh" retract ship-a shipped -)" "an unknown kind to retract"
  expect_code 2 "$(tb_code "$MAIN" "$CODE_ROOT/bin/myshape.sh" retract ship-a landed)" "retract without the stdin marker"
  printf '已落地。' | t summary ship-a landed - >/dev/null
  assert_equals 1 "$(view '[.summaries[] | select(.task == "ship-a" and .kind == "landed")] | length')" \
    "the same summary must be storable again once it is true"
  pass "a wrong summary can be retracted with a reason, and stated again later"
}

# Records that are not work items, next to finished work that has no topic:
# a retired mate's own events (its id is the task, its dispatch kind is
# secondmate), a live mate's needs-decision line, and a remote mate's reply
# channel (a status log no spawn or teardown ever touched).
add_records_that_are_not_work() {
  ledger "$MAIN" \
    '{"v":1,"ts":1782990000,"event":"task.dispatched","task":"old-mate","kind":"secondmate","project":"sample","harness":"claude","model":null}' \
    '{"v":1,"ts":1782990100,"event":"task.status","task":"old-mate","state":"done","key":null,"text":" child far-work PR ready"}' \
    '{"v":1,"ts":1782990200,"event":"task.cleaned_up","task":"old-mate"}' \
    '{"v":1,"ts":1782990300,"event":"task.dispatched","task":"done-loose","kind":"ship","project":"sample","harness":"claude","model":null}' \
    '{"v":1,"ts":1782990400,"event":"task.cleaned_up","task":"done-loose"}' \
    '{"v":1,"ts":1782990500,"event":"task.dispatched","task":"done-own-id","kind":"scout","project":"sample","harness":"claude","model":null}' \
    '{"v":1,"ts":1782990600,"event":"task.cleaned_up","task":"done-own-id"}'
  tag_at "$MAIN" old-mate billing 2026-07-01T00:00:00Z
  tag_at "$MAIN" done-own-id done-own-id 2026-07-01T00:00:00Z
  fm_write_meta "$MAIN/state/sm1.meta" "window=firstmate:fm-sm1" "kind=secondmate" "harness=claude" "home=$LOCAL_SM"
  printf '%s\n' "needs-decision: child sm-work asks which API" > "$MAIN/state/sm1.status"
  printf '%s\n' "done: idle, nothing in flight" "done: re-read the rules" > "$REMOTE_SM/state/parent-replies.status"
  ledger "$REMOTE_SM" \
    '{"v":1,"ts":1782990700,"event":"task.status","task":"parent-replies","state":"done","key":null,"text":" idle, nothing in flight"}' \
    '{"v":1,"ts":1782990800,"event":"task.status","task":"parent-replies","state":"done","key":null,"text":" re-read the rules"}' \
    '{"v":1,"ts":1782990900,"event":"task.dispatched","task":"far-done","kind":"ship","project":"beta","harness":"claude","model":null}' \
    '{"v":1,"ts":1782991000,"event":"task.cleaned_up","task":"far-done"}'
  ledger "$LOCAL_SM" \
    '{"v":1,"ts":1782991100,"event":"task.dispatched","task":"sm-done","kind":"ship","project":"alpha","harness":"claude","model":null}' \
    '{"v":1,"ts":1782991200,"event":"task.cleaned_up","task":"sm-done"}'
}

test_only_work_items_are_agents() {
  local out
  add_records_that_are_not_work
  out=$(view '.agents | map("\(.home)/\(.task)=\(.finished):\(.topic // .unsorted_reason)") | sort | join(" ")')
  assert_not_contains "$out" "old-mate" "a retired mate's own events must not make it an agent, even when tagged"
  assert_not_contains "$out" "parent-replies" "a remote mate's reply channel must not be an agent"
  assert_not_contains "$out" "main/sm1" "a live mate must not be an agent"
  assert_contains "$out" "main/ship-loose=false:no-tag" "untagged open work must stay listed, as open"
  assert_contains "$out" "main/done-loose=true:no-tag" "untagged finished work must stay listed, as finished"
  assert_contains "$out" "main/done-own-id=true:unknown-topic" "work tagged with a topic that does not exist must say so"
  assert_contains "$out" "sm1/sm-done=true:no-tag" "a local secondmate's finished work must be listed with its home"
  assert_contains "$out" "far1/far-done=true:no-tag" "a remote secondmate's finished work must be listed with its home"
  assert_contains "$out" "main/gone-task=true:billing" "finished tagged work must keep its topic"
  assert_equals "main/ship-b" "$(view '.questions | map("\(.home)/\(.task)") | join(" ")')" \
    "a mate's own needs-decision line is not a worker question"
  assert_equals "billing|null" \
    "$(view '[([.updates[] | select(.task == "old-mate")][0].topic), ([.updates[] | select(.task == "parent-replies")][0].topic)] | map(tostring) | join("|")')" \
    "the events of records that are not work stay in the updates, under their tag when they have one"
  pass "only work items are agents; a mate's own records and a reply channel are not"
}

# A board already running when this code lands is replaced by the next board
# command once the code root's commit moves. Nothing is migrated: the view is
# computed again from the same journal and tag files.
test_a_running_board_takes_the_new_rules_without_a_step() {
  local before_pid events_sum tags_sum real_before
  view >/dev/null
  before_pid=$(tb_board_pid "$MAIN")
  events_sum=$(cksum < "$MAIN/data/myshape/events.jsonl")
  tags_sum=$(cat "$MAIN"/data/*/topic "$LOCAL_SM"/data/*/topic "$REMOTE_SM"/data/*/topic | cksum)
  real_before=$(tb_op "$MAIN" dump | jq -r '.agents | map("\(.home)/\(.task)=\(.topic)") | sort | join(" ")')
  git -C "$CODE_ROOT" -c user.name='Firstmate Tests' -c user.email='tests@example.invalid' \
    commit -q --allow-empty -m "the new code lands"
  assert_equals "Billing：" "$(t which ship-a)" "a board command must still answer while the board is replaced"
  [ "$(tb_board_pid "$MAIN")" != "$before_pid" ] || fail "a board on an older commit must be replaced by the next command"
  assert_equals "$events_sum" "$(cksum < "$MAIN/data/myshape/events.jsonl")" "replacing the board must not rewrite the journal"
  assert_equals "$tags_sum" "$(cat "$MAIN"/data/*/topic "$LOCAL_SM"/data/*/topic "$REMOTE_SM"/data/*/topic | cksum)" \
    "replacing the board must not touch any tag file"
  assert_equals "$real_before" "$(view '.agents | map("\(.home)/\(.task)=\(.topic)") | sort | join(" ")')" \
    "every work item must keep its topic across the replacement"
  assert_present "$MAIN/data/old-mate/topic" "the tag placed on a mate's own record must stay on file"
  assert_not_contains "$real_before" "old-mate" "the mate's record must not come back as an agent"
  pass "a running board takes the work-item rule at its next replacement, losing no record or tag"
}

setup_fleet
# Runs after the tests above: it renames and merges topics they rely on.
test_find_traces_renames_merges_and_tasks() {
  local out rc refusal
  t create "Reports" --goal "monthly numbers" --id reports >/dev/null
  t rename reports "Money reports" >/dev/null
  t merge reports billing >/dev/null
  out=$(t find reports) || fail "find failed: $out"
  assert_equals "billing　Billing（一般）" "$(printf '%s\n' "$out" | head -n 1)" "find must lead with where the old id is now"
  assert_contains "$out" "「Reports」改名為「Money reports」" "find must show the rename"
  assert_contains "$out" "「Money reports」（reports）併入「Billing」" "find must show the merge"
  assert_equals "$out" "$(t find 'money REP')" "an old name must find the same topic, ignoring case"
  assert_contains "$(t find ship-a)" "task main/ship-a：Billing（2026-07-01）→ Login（2026-07-02）→ Billing（" \
    "find must show every topic a task was tagged with, oldest first"
  assert_contains "$(t find sm-work)" "task sm1/sm-work：" "find must look for the task in secondmate homes too"
  assert_equals "找不到「nothing-here」。" "$(t find nothing-here)" "find must say when nothing matches"
  assert_equals "找不到「constructor」。" "$(t find constructor)" "find must not trip over names every object inherits"
  rc=0
  t find >/dev/null 2>&1 || rc=$?
  assert_equals 2 "$rc" "find without a keyword is a usage error"
  rc=0
  refusal=$(t find "$(printf 'a\033[31mb')" 2>&1) || rc=$?
  assert_equals 2 "$rc" "find must refuse a keyword with control characters"
  assert_not_contains "$refusal" "$(printf '\033')" "the refusal must not echo the control characters"
  t restart >/dev/null
  assert_equals "$out" "$(t find reports)" "the history must survive a restart"
  assert_contains "$(t find ship-a)" "task main/ship-a：Billing（" "find must read the home afresh on a cold board"
  assert_equals '["merged","renamed"]' "$(jq -c '[.history[].kind] | sort' "$MAIN/data/topics.json")" \
    "the history must be stored in the topic file"
  pass "find traces a topic through renames and merges, and a task through its tags"
}

# Runs last. It counts lines, so nothing after it may add history to login.
test_find_says_who_and_why() {
  local out rc all
  t create "Duplicate" --goal "same thing twice" --id dup >/dev/null
  out=$(t merge dup login --reason "和登入是同一件事") || fail "merge with a reason failed: $out"
  out=$(t split login "Sign-up" --goal "new accounts" --id signup --reason "登入太寬") ||
    fail "split with a reason failed: $out"
  out=$(t find login)
  assert_contains "$out" "「Duplicate」（dup）併入「Login」（用指令；原因：和登入是同一件事）" \
    "find must say a merge was made by a command, and why"
  assert_contains "$out" "拆出「Sign-up」（signup）（用指令；原因：登入太寬）" "find must say why a topic was split off"
  all=$(t find --all login)
  assert_equals "$all" "$(t find login --all)" "--all must work on either side of the keyword"
  printf '%s\n' "$all" | grep -Eq '^  [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z .*併入「Login」' ||
    fail "find --all must print exact times: $all"
  assert_equals "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" "$(printf '%s\n' "$all" | wc -l | tr -d ' ')" \
    "with little history, find --all prints the same lines with longer times"
  t close-propose signup --reason "帳號流程做完了" >/dev/null
  t archive signup >/dev/null
  assert_contains "$(t find signup)" "封存（用指令；原因：帳號流程做完了）" "an archive must carry the close proposal it followed"
  t create "Other" --goal "g" --id other >/dev/null
  rc=0
  out=$(t merge other login --reason "$(printf 'two\nlines')" 2>&1) || rc=$?
  assert_equals 1 "$rc" "a reason of two lines must be refused"
  assert_contains "$out" "原因要是一行" "the refusal must say what is wrong with the reason"
  for out in merge split; do
    rc=0
    if [ "$out" = merge ]; then t merge other login --reason "" >/dev/null 2>&1 || rc=$?
    else t split login "Empty why" --goal g --reason "" >/dev/null 2>&1 || rc=$?; fi
    assert_equals 1 "$rc" "$out with an empty reason must be refused"
  done
  assert_not_contains "$(t list)" "Empty why" "a split refused for its reason must create nothing"
  assert_contains "$(t list)" "other" "a refused merge must leave the topic in place"
  t split login "Sign-up" --goal "new accounts" --id signup2 --reason "x" >/dev/null
  out=$(t split login "Sign-up" --goal "new accounts" --id signup2 --reason "不同的說法")
  assert_contains "$out" "本來就" "repeating a split with another reason must change nothing"
  assert_equals 1 "$(jq '[.history[] | select(.topic == "signup2")] | length' "$MAIN/data/topics.json")" \
    "a repeated split must not be recorded twice"
  assert_equals '["command"]' "$(jq -c '[.history[] | select(.topic == "signup" or .from == "dup") | .by] | unique' "$MAIN/data/topics.json")" \
    "changes made by commands must be recorded as such"
  out=$(t find login)
  t restart >/dev/null
  assert_equals "$out" "$(t find login)" "who and why must survive a restart"
  pass "find says where a change was made and why, and --all prints everything"
}

fm_test_run test_agents_lights_and_placement test_holds_are_placed_and_ordered test_one_decision_at_a_time \
  test_updates_and_topics \
  test_event_follows_the_tag_in_effect test_ledger_is_stored_once_and_survives_rewrites test_home_status \
  test_polling_follows_viewers test_summary_and_which test_summary_on_a_cold_board_reads_the_main_home_first \
  test_dump_is_test_only test_which_follows_a_retag_nobody_is_watching \
  test_a_wrong_summary_can_be_retracted test_only_work_items_are_agents \
  test_a_running_board_takes_the_new_rules_without_a_step \
  test_find_traces_renames_merges_and_tasks test_find_says_who_and_why
