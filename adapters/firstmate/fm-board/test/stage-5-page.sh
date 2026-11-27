#!/usr/bin/env bash
# The page in a real browser: a headless Firefox walks the captain's path
# through the board (see stage-5-page.mjs) against stand-in firstmate scripts.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=fm-board/test/helpers.sh
. "$ROOT/fm-board/test/helpers.sh"

for tool in jq node firefox; do
  command -v "$tool" >/dev/null 2>&1 || { echo "skip: $tool not found"; exit 0; }
done
TMP_ROOT=$(fm_test_tmproot tb-s5p)
trap 'tb_stop_boards; fm_test_cleanup' EXIT

export MYSHAPE_TEST=1 MYSHAPE_READ_MS=2000
export FM_SNAPSHOT_NOW=2026-07-25T00:00:00Z
export TB_LOG="$TMP_ROOT/calls.log" TB_PLAY="$TMP_ROOT/play" TB_REMOTES="$TMP_ROOT/remotes"
mkdir -p "$TB_PLAY" "$TB_REMOTES"
: > "$TB_LOG"
CODE_ROOT="$TMP_ROOT/root"
tb_make_fake_root "$CODE_ROOT"
MAIN=$(tb_make_service_home main)
tb_bind_home "$MAIN"

cat > "$TMP_ROOT/topic" <<EOF
#!/usr/bin/env bash
MYSHAPE_HOME="$MAIN" MYSHAPE_ROOT_OVERRIDE="$CODE_ROOT" exec "$CODE_ROOT/bin/myshape.sh" "\$@"
EOF
chmod +x "$TMP_ROOT/topic"
export TB_TOPIC="$TMP_ROOT/topic"
export TB_MAIN="$MAIN"

# A hands-on item with no topic, as an older board adopted it before it kept
# items; the page walk closes it and finds it under 沒有議題.
mkdir -p "$MAIN/data/myshape"
cat > "$MAIN/data/myshape/todos.json" <<'JSON'
{"v": 1, "items": {"loose-hand": {"title": "沒有議題的動手", "topic": null, "action": "插上網路線",
  "guidance": "", "commands": [], "state": "open", "reason": null, "at": "2026-07-20T00:00:00Z",
  "by": "first mate", "ref": "hold", "captain_closes": false, "adopted": true,
  "created_at": "2026-07-20T00:00:00Z"}}}
JSON
"$TB_TOPIC" open >/dev/null || fail "the board did not start"
"$TB_TOPIC" create "Billing" --goal "rework billing" --id billing >/dev/null
"$TB_TOPIC" create "Login" --goal "new login" --id login --queue high >/dev/null
"$TB_TOPIC" create "Parked" --goal "later" --id parked --queue later >/dev/null
"$TB_TOPIC" create "Idea" --goal "queued at once" --id idea >/dev/null
# A hands-on item with guidance, then two commands, the first spanning lines
# and carrying characters a shell would act on; only the captain takes it down.
# shellcheck disable=SC2016  # the commands are literal text, never expanded here
"$TB_TOPIC" todo add todo-1 "Restart x" --topic login --do "重啟 x（路由卡住）" --note "只在你人在電腦前時做。" \
  --cmd "$(printf 'sudo x --now "a b" && echo $HOME `date`\n\tps | grep x')" --cmd "echo two" --captain-closes >/dev/null
# The three other shapes an item can have: a command and no guidance, an action
# alone, and guidance and no command.
"$TB_TOPIC" todo add old-note "Turn on 2FA" --topic idea --do "開 NAS 的兩步驟驗證" --cmd "只在你人在電腦前時做。" >/dev/null
"$TB_TOPIC" todo add old-only "Check the router" --topic idea --do "查路由器的轉址" >/dev/null
"$TB_TOPIC" todo add new-note "Turn on 2FA again" --topic idea --do "開 NAS 的兩步驟驗證" --note "只在你人在電腦前時做。" >/dev/null
cat > "$MAIN/data/backlog.md" <<EOF
## In flight
- [ ] ship-a - Ship A (repo: sample) (kind: ship)

## Queued
- [ ] call-1 - A call (repo: sample) (kind: captain) (hold: 要合併嗎？ 選項：合併 | 先不要) (hold-kind: captain)
  Captain hold set: 2026-07-24T00:00:00Z
  Captain hold on answer: release
- [ ] next-1 - Next step (repo: sample) (kind: ship)
- [ ] loose-1 - Loose work (repo: sample) (kind: ship)
- [ ] loose-call - A loose call (repo: sample) (kind: captain) (hold: 這個要不要做？) (hold-kind: captain)
  Captain hold set: 2026-07-24T00:00:00Z
- [ ] wait-1 - Vendor reply (repo: sample) (kind: ship) (hold: waiting for a vendor)

## Done
EOF
mkdir -p "$MAIN/projects/ship-a" "$MAIN/data/ship-a" "$MAIN/data/call-1"
fm_write_meta "$MAIN/state/ship-a.meta" "window=firstmate:fm-ship-a" "worktree=$MAIN/projects/ship-a" \
  "project=sample" "harness=claude" "kind=ship" "mode=ship" "yolo=off"
printf 'working: on it\n' > "$MAIN/state/ship-a.status"
# A second worker whose harness never took its first turn.
tb_seed_unstarted "$CODE_ROOT" quiet-b
mkdir -p "$MAIN/projects/quiet-b"
fm_write_meta "$MAIN/state/quiet-b.meta" "window=firstmate:fm-quiet-b" "worktree=$MAIN/projects/quiet-b" \
  "project=sample" "harness=claude" "kind=ship" "mode=ship" "yolo=off"
printf 'billing 2026-07-01T00:00:00Z\n' > "$MAIN/data/ship-a/topic"
printf 'billing 2026-07-01T00:00:00Z\n' > "$MAIN/data/call-1/topic"
for queued in next-1 wait-1; do
  mkdir -p "$MAIN/data/$queued"
  printf 'billing 2026-07-01T00:00:00Z\n' > "$MAIN/data/$queued/topic"
done
mkdir -p "$MAIN/data/quiet-b"
printf 'parked 2026-07-01T00:00:00Z\n' > "$MAIN/data/quiet-b/topic"
: > "$MAIN/config/fleet-ledger"
# Under 未分類: open-1 is running with no topic; done-1 finished with no tag and
# done-2 with a topic that does not exist; old-mate is a retired mate, not work.
mkdir -p "$MAIN/projects/open-1" "$MAIN/data/done-2"
fm_write_meta "$MAIN/state/open-1.meta" "window=firstmate:fm-open-1" "worktree=$MAIN/projects/open-1" \
  "project=sample" "harness=claude" "kind=ship" "mode=ship" "yolo=off"
printf 'working: nobody tagged me\n' > "$MAIN/state/open-1.status"
printf 'done-2 2026-07-01T00:00:00Z\n' > "$MAIN/data/done-2/topic"
for finished in done-1:ship done-2:scout old-mate:secondmate; do
  printf '{"v":1,"ts":1782864000,"event":"task.dispatched","task":"%s","kind":"%s","project":"sample","harness":"claude","model":null}\n' \
    "${finished%%:*}" "${finished#*:}"
  printf '{"v":1,"ts":1782864100,"event":"task.cleaned_up","task":"%s"}\n' "${finished%%:*}"
done >> "$MAIN/state/fleet-ledger.jsonl"
printf '已落地，沒人標議題。' | "$TB_TOPIC" summary done-1 landed - >/dev/null
# A summary filed under a record that is not work must not bring it back.
printf '一個 mate 的回報。' | "$TB_TOPIC" summary old-mate report - >/dev/null
printf 'PR 開好了，等你看。' | "$TB_TOPIC" summary ship-a ready - >/dev/null
"$TB_TOPIC" create "Side idea" --goal "merge me" --id side >/dev/null
# A scheduled topic with an occurrence open (written in with the board stopped, as
# its clock would); 2099 keeps the clock itself from opening or closing anything.
"$TB_TOPIC" create "Weekly" --goal "週會" --id weekly --queue later >/dev/null
"$TB_TOPIC" stop >/dev/null
cat > "$MAIN/data/myshape/schedules.json" <<'JSON'
{"v": 1, "series": {"weekly": {"topic": "weekly", "title": "Weekly", "rule": "weekly mon 10:00", "tz": "UTC",
  "duration_min": null, "lead_min": null, "rt": "hard-rt", "rt_locked": false, "state": "on", "locked": true,
  "by": "captain", "created_at": "2026-07-01T00:00:00Z", "checked_through": "2099-11-30T09:45:00Z"}},
 "occurrences": {"weekly:20991130T1000Z": {"series": "weekly", "at": "2099-11-30T10:00:00Z", "state": "upcoming",
  "opened_at": "2099-11-30T09:45:00Z", "closes_by": "2099-11-30T11:00:00Z"}},
 "recent": {}, "removed": {}, "outbox": []}
JSON
"$TB_TOPIC" open >/dev/null || fail "the board did not start again"

test_the_captains_path() {
  local url out
  url=$("$TB_TOPIC" open)
  out=$(node "$ROOT/myshape/test/kit/browser.mjs" "$url" "$ROOT/fm-board/test/stage-5-page.mjs" 2>&1) ||
    fail "the browser walk-through failed: $out"
  grep -q 'stdin=call-1	合併	合併	release' "$TB_LOG" || fail "the answer chosen in the page did not reach the hold"
  grep -q 'stdin=看板上輪到 main/loose-call 的決定了（沒有議題）$' "$TB_LOG" ||
    fail "the loose call's turn did not reach firstmate as one notice"
  grep -q 'stdin=［議題：Billing X（billing）］\\n先做這個' "$TB_LOG" || fail "the message typed in the page did not reach firstmate"
  grep -q 'argv=ship-a|看一下 CI|' "$TB_LOG" || fail "the direct message typed in the page did not reach the agent"
  grep -q 'argv=ship-a|/compact|' "$TB_LOG" && fail "a command-like direct message reached the agent"
  assert_equals "login" "$(jq -r '.merged.side' "$MAIN/data/topics.json")" "the merge confirmed in the page did not happen"
  assert_equals "parked login" "$(jq -r '.queues.high | join(" ")' "$MAIN/data/topics.json")" "the drag did not reorder the queue"
  assert_equals "done|captain" "$(jq -r '.recent.weekly[0] | "\(.outcome)|\(.by)"' "$MAIN/data/myshape/schedules.json")" \
    "the captain's close of the open occurrence did not reach the schedule"
  pass "the page works end to end in a real browser"
}

# profiles_of <pid>: the throwaway Firefox profiles a browser.mjs run owns.
profiles_of() {
  find "$HOME" -maxdepth 1 -name "tb-firefox-tmp-$1-*" 2>/dev/null
}

test_a_killed_run_leaves_no_profile_behind() {
  local url pid tries dead stale
  url=$("$TB_TOPIC" open)
  printf 'export default () => new Promise(() => {});\n' > "$TMP_ROOT/hang.mjs"
  node "$ROOT/myshape/test/kit/browser.mjs" "$url" "$TMP_ROOT/hang.mjs" >/dev/null 2>&1 &
  pid=$!
  for tries in $(seq 1 50); do
    [ -n "$(profiles_of "$pid")" ] && break
    sleep 0.1
  done
  [ -n "$(profiles_of "$pid")" ] || fail "the run never created its profile (after $tries tries)"
  kill -TERM "$pid"
  wait "$pid" 2>/dev/null
  assert_equals "" "$(profiles_of "$pid")" "a terminated run must remove its Firefox profile"

  # A run killed outright cannot clean up; the next run removes what it left.
  sleep 0 &
  dead=$!
  wait "$dead"
  stale="$HOME/tb-firefox-tmp-$dead-stale"
  mkdir "$stale"
  printf 'export default () => {};\n' > "$TMP_ROOT/noop.mjs"
  node "$ROOT/myshape/test/kit/browser.mjs" "$url" "$TMP_ROOT/noop.mjs" >/dev/null 2>&1 ||
    { rmdir "$stale" 2>/dev/null; fail "the follow-up run failed"; }
  [ -e "$stale" ] && { rmdir "$stale"; fail "the next run must sweep a dead run's profile"; }
  pass "a killed browser run leaves no profile in the home directory"
}

fm_test_run test_the_captains_path test_a_killed_run_leaves_no_profile_behind
"$TB_TOPIC" stop >/dev/null
