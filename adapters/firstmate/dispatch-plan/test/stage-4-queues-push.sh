#!/usr/bin/env bash
# fm-dispatch-plan.sh queues-push: the main home sends its queue copy to each
# secondmate on another machine. Every push runs from a scratch code root whose
# bin/fm-on.sh is a stub, so nothing here reaches another machine: the stub
# hands the copy to a real queues-in in a scratch "far" home, or fails the way
# a transfer can fail.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot dispatch-plan-stage-4-queues-push)
# shellcheck source=dispatch-plan/test/helpers.sh
. "$ROOT/dispatch-plan/test/helpers.sh"

# push_setup <name> <remote-id>...: a scratch main home with topics, one local
# and the given remote secondmates registered, and a scratch code root whose
# fm-on.sh is the stub. Sets MAIN, CODE and STUB.
push_setup() {
  local name=$1 id script
  shift
  MAIN=$(tb_make_home "$name-main")
  tb_free_port > "$MAIN/config/myshape-port"
  tb_write_topics "$MAIN"
  CODE="$TMP_ROOT/$name-code"
  STUB="$TMP_ROOT/$name-stub"
  mkdir -p "$CODE/bin" "$STUB/far"
  for script in fm-dispatch-plan.sh fm-primary-scope-lib.sh myshape-lib.sh fm-secondmate-registry-lib.sh \
    fm-queue-source-lib.sh; do
    cp "$ROOT/bin/$script" "$CODE/bin/"
  done
  {
    printf '# Secondmates\n'
    printf -- '- sm1 - Local helper (home: %s; scope: sample work; projects: alpha; added 2026-11-01)\n' "$TMP_ROOT/$name-sm1"
    for id in "$@"; do
      printf -- '- %s - Remote helper (host: farbox; root: /srv/fm; home: /srv/fm-home; scope: remote work; projects: beta; added 2026-11-01)\n' "$id"
      mkdir -p "$STUB/far/$id/state" "$STUB/far/$id/data" "$STUB/far/$id/config"
      tb_free_port > "$STUB/far/$id/config/myshape-port"
      printf '%s\n' "$id" > "$STUB/far/$id/.fm-secondmate-home"
    done
  } > "$MAIN/data/secondmates.md"
  write_stub
}

# The stub stands in for bin/fm-on.sh. It records each call in $STUB/calls and
# behaves as $STUB/<id>.mode says: ok (the default), sleep <s> (then ok), down
# (exit 255), silent (exit 0, no output), old (exit 2, no such subcommand) or
# missing (exit 64, no such command on the far side). fm-remote-file.sh, the
# backlog handoff's transfer, is logged and then fails like a lost connection.
write_stub() {
  cat > "$CODE/bin/fm-on.sh" <<EOF
#!/usr/bin/env bash
set -u
[ "\$1" = --stdin ] || { echo "stub: --stdin missing" >&2; exit 90; }
mate=\$2
shift 2
printf '%s %s\n' "\$mate" "\$*" >> "$STUB/calls"
if [ "\$1" = fm-remote-file.sh ]; then cat > /dev/null; echo "ssh: lost" >&2; exit 255; fi
mode=\$(cat "$STUB/\$mate.mode" 2>/dev/null || echo ok)
case "\$mode" in
  sleep*) sleep "\${mode#sleep }" ;;
esac
case "\$mode" in
  ok | sleep*)
    exec env -u FM_ROOT_OVERRIDE -u FM_STATE_OVERRIDE -u FM_DATA_OVERRIDE FM_HOME="$STUB/far/\$mate" "$ROOT/bin/\$1" "\${@:2}" ;;
  down) cat > /dev/null; echo "ssh: connect to host farbox port 22: No route to host" >&2; exit 255 ;;
  silent) cat > /dev/null; exit 0 ;;
  old) cat > /dev/null; echo "fm-dispatch-plan.sh: 不認得的子命令：queues-in" >&2; exit 2 ;;
  missing) cat > /dev/null; echo "error: command is not a genuine executable in the configured remote root" >&2; exit 64 ;;
esac
exit 91
EOF
  chmod +x "$CODE/bin/fm-on.sh"
}

# push [--check]: run queues-push in the scratch main home from the scratch
# code root; prints stdout only.
push() {
  FM_HOME="$MAIN" FM_ROOT_OVERRIDE="$CODE" "$CODE/bin/fm-dispatch-plan.sh" queues-push "$@" 2>/dev/null
}

calls() {
  if [ -f "$STUB/calls" ]; then
    awk '{ printf "%s ", $1 }' "$STUB/calls"
  fi
}

reset_calls() {
  rm -f "$STUB/calls"
}

mode() {  # <id> <mode>
  printf '%s\n' "$2" > "$STUB/$1.mode"
}

move_topic() {  # put t2 at the front of high
  jq '.queues.high = ["t2", "billing"] | .queues.normal = []' "$MAIN/data/topics.json" > "$MAIN/data/topics.json.new"
  mv "$MAIN/data/topics.json.new" "$MAIN/data/topics.json"
}

# backdate_delivery <id> <minutes>: make the last delivery to <id> that old.
backdate_delivery() {
  local record="$MAIN/state/dispatch-plan/pushed/$1"
  jq -c --arg at "$(dp_minutes_ago "$2")" '.at = $at' "$record" > "$record.new"
  mv "$record.new" "$record"
}

# A mate with no failing record yet: its first push, delivered or not, must
# not print the shell's "No such file or directory" for pushed/<id>.failing.
test_a_first_push_prints_no_shell_error() {
  local rc=0
  push_setup quiet-stderr far1 far2
  mode far2 down
  FM_HOME="$MAIN" FM_ROOT_OVERRIDE="$CODE" "$CODE/bin/fm-dispatch-plan.sh" queues-push \
    > "$TMP_ROOT/quiet-stderr.out" 2> "$TMP_ROOT/quiet-stderr.err" || rc=$?
  assert_equals "1" "$rc" "a push with a failed transfer must exit 1"
  assert_contains "$(cat "$TMP_ROOT/quiet-stderr.out")" "far1：已送出（" "the reachable mate must still get the copy"
  assert_equals "" "$(cat "$TMP_ROOT/quiet-stderr.err")" "a first push must write nothing to stderr"
  pass "a first push prints no shell error for a mate with no failing record"
}

test_pushes_once_per_mate_whose_copy_differs() {
  local out check
  push_setup differs far1 far2
  out=$(push) || fail "queues-push failed: $out"
  assert_equals "far1 far2 " "$(calls)" "each remote mate, and no local one, must get one push"
  assert_contains "$(head -n 1 "$STUB/calls")" "fm-dispatch-plan.sh queues-in -" "the push must run queues-in on the far side"
  assert_contains "$out" "far1：已送出（" "the report must say the copy went out"
  assert_contains "$(FM_HOME="$STUB/far/far1" "$PLAN" order 2>/dev/null | head -n 1)" "照主 home 推來的佇列副本" \
    "the far side's order must rank by the pushed copy"
  assert_equals "billing t2" "$(jq -r '.queues.high + .queues.normal | join(" ")' "$STUB/far/far2/state/dispatch-plan/queues.json")" \
    "the far side must hold the main home's queues"
  assert_equals "gone" "$(jq -r '.archived | keys | join(" ")' "$STUB/far/far2/state/dispatch-plan/queues.json")" \
    "the copy must carry the archived topics"
  assert_equals "billing" "$(jq -r '.merged["old-billing"]' "$STUB/far/far2/state/dispatch-plan/queues.json")" \
    "the copy must carry the merged ids"
  assert_equals "drwx------" "$(tb_mode "$MAIN/state/dispatch-plan")" "the main home's push records must be private"
  reset_calls
  out=$(push)
  assert_equals "" "$(calls)" "an unchanged copy must not be sent again"
  assert_contains "$out" "far1：副本沒變，上次送達" "the report must say the copy is unchanged"
  move_topic
  check=$(push --check)
  assert_equals "far1 far2 " "$(calls)" "a queue change must be sent to every remote mate once"
  assert_equals "" "$check" "a push that worked must print nothing under --check"
  assert_equals "t2 billing" "$(jq -r '.queues.high | join(" ")' "$STUB/far/far1/state/dispatch-plan/queues.json")" \
    "the far side must get the moved topic"
  pass "queues-push sends one copy to each remote mate whose copy differs, and none when unchanged"
}

test_resends_an_unchanged_copy_after_30_minutes() {
  push_setup refresh far1 far2
  push >/dev/null
  reset_calls
  backdate_delivery far1 29
  backdate_delivery far2 30
  assert_equals "" "$(push --check)" "a refresh must print nothing under --check"
  assert_equals "far2 " "$(calls)" "only a copy delivered 30 minutes ago or more must be sent again"
  reset_calls
  jq -c '.at = "yesterday"' "$MAIN/state/dispatch-plan/pushed/far1" > "$MAIN/state/dispatch-plan/pushed/far1.new"
  mv "$MAIN/state/dispatch-plan/pushed/far1.new" "$MAIN/state/dispatch-plan/pushed/far1"
  push >/dev/null
  assert_equals "far1 " "$(calls)" "a delivery record without a readable time must count as no delivery"
  pass "queues-push sends an unchanged copy again once its last delivery is 30 minutes old"
}

test_retries_a_failed_transfer_at_the_next_run() {
  local out
  push_setup retry far1 far2
  mode far1 down
  mode far2 silent
  out=$(push)
  assert_contains "$out" "far1：送不出去（連不到，fm-on.sh 回 255" "the report must say why far1 failed"
  assert_contains "$out" "far2：送不出去（那邊沒有回 ok queues）" "an answer without the ok line is not a delivery"
  reset_calls
  assert_equals "" "$(push --check)" "a failure under an hour old must print nothing under --check"
  assert_equals "far1 far2 " "$(calls)" "a failed transfer must be retried at the next run"
  mode far1 ok
  mode far2 ok
  reset_calls
  out=$(push)
  assert_contains "$out" "far1：已送出" "the retry must deliver once the far side answers"
  assert_contains "$out" "far2：已送出" "the retry must deliver once the far side answers"
  reset_calls
  push >/dev/null
  assert_equals "" "$(calls)" "after the delivery nothing more may be sent"
  pass "queues-push retries a failed transfer at the next run"
}

test_does_not_hammer_a_mate_without_queues_in() {
  local out failing
  push_setup old far1 far2
  mode far1 old
  mode far2 missing
  push >/dev/null
  reset_calls
  out=$(push)
  assert_equals "" "$(calls)" "a mate whose far side cannot take the copy must not be tried at every run"
  assert_contains "$out" "far1：那邊還不能收副本（那邊的 fm-dispatch-plan.sh 沒有 queues-in（回 2），可能還沒更新到這一版）" \
    "the report must say why far1 is waiting"
  assert_contains "$out" "far2：那邊還不能收副本（那邊的 fm-dispatch-plan.sh 沒有 queues-in（回 64）" "far2 must wait too"
  move_topic
  push >/dev/null
  assert_equals "" "$(calls)" "a queue change alone must not retry it"
  failing="$MAIN/state/dispatch-plan/pushed/far1.failing"
  read -r since _ rc < "$failing"
  printf '%s %s %s\n' "$since" "$(($(date +%s) - 3600))" "$rc" > "$failing"
  mode far1 ok
  out=$(push)
  assert_equals "far1 " "$(calls)" "it must be tried again an hour after the last try"
  assert_contains "$out" "far1：已送出" "the hourly retry must deliver once the far side is updated"
  pass "queues-push tries a mate without queues-in at most once an hour"
}

# Four mates whose transfers take 6 s each: transfers start at about 0, 6 and
# 12 s, and the fourth would start at about 18 s, at the bound. Each transfer
# ends on its own well inside the per-transfer limit, so nothing is signalled.
test_stops_starting_transfers_after_18_seconds() {
  local out id
  push_setup bound far1 far2 far3 far4
  for id in far1 far2 far3 far4; do
    mode "$id" "sleep 6"
  done
  out=$(push)
  assert_equals "far1 far2 far3 " "$(calls)" "no transfer may start after 18 s"
  assert_contains "$out" "far4：這一輪的時間用完，下一輪再送" "the report must name the mate left over"
  reset_calls
  out=$(push --check)
  assert_equals "far4 " "$(calls)" "the next run must send to the mate left over"
  assert_equals "" "$out" "the next run must print nothing under --check"
  pass "queues-push starts no transfer after 18 s and leaves the rest to the next run"
}

test_prints_the_behind_line_once_per_episode() {
  local out failing
  push_setup behind far1 far2
  push >/dev/null
  mode far1 down
  move_topic
  backdate_delivery far1 61
  out=$(push --check)
  assert_equals "看板佇列副本：far1 已經 61 分鐘沒收到主 home 的副本（連不到，fm-on.sh 回 255），它的 order 照舊的副本排；跑 bin/fm-dispatch-plan.sh queues-push 看細節。" \
    "$out" "a mate 60 minutes behind must get exactly one line"
  assert_equals "" "$(push --check)" "the line must not repeat while the episode lasts"
  assert_not_contains "$(push)" "看板佇列副本：" "the bare report must not print the wake line"
  mode far1 ok
  assert_equals "" "$(push --check)" "a delivery ends the episode silently"
  mode far1 down
  jq '.queues.later = []' "$MAIN/data/topics.json" > "$MAIN/data/topics.json.new"
  mv "$MAIN/data/topics.json.new" "$MAIN/data/topics.json"
  backdate_delivery far1 75
  assert_contains "$(push --check)" "看板佇列副本：far1 已經 75 分鐘" "a new episode must print its line again"
  push_setup never far1
  mode far1 down
  push >/dev/null
  failing="$MAIN/state/dispatch-plan/pushed/far1.failing"
  read -r _ last rc < "$failing"
  printf '%s %s %s\n' "$(($(date +%s) - 3700))" "$last" "$rc" > "$failing"
  assert_equals "看板佇列副本：far1 已經 61 分鐘沒收到主 home 的副本（連不到，fm-on.sh 回 255），它的 order 照 backlog 原本的順序排；跑 bin/fm-dispatch-plan.sh queues-push 看細節。" \
    "$(push --check)" "a mate never reached for an hour must get the line too"
  pass "queues-push --check prints the behind line once per episode"
}

test_runs_only_where_there_is_something_to_send() {
  local rc out
  push_setup none
  out=$(push) || fail "queues-push failed with no remote mates"
  assert_equals "沒有遠端的 second mate；沒有要送的。" "$out" "no remote mate must be said plainly"
  assert_equals "" "$(push --check)" "no remote mate must print nothing under --check"
  push_setup nofile far1
  rm "$MAIN/data/topics.json"
  out=$(push) || fail "queues-push failed without a topic file"
  assert_equals "主 home 沒有可用的議題檔，沒有東西可以送。" "$out" "a missing topic file must be said plainly"
  assert_equals "" "$(push --check)" "a missing topic file must print nothing under --check"
  assert_equals "" "$(calls)" "nothing may be sent without a topic file"
  rc=0
  out=$(FM_HOME="$STUB/far/far1" FM_ROOT_OVERRIDE="$CODE" "$CODE/bin/fm-dispatch-plan.sh" queues-push 2>&1) || rc=$?
  expect_code 1 "$rc" "queues-push in a secondmate home"
  assert_contains "$out" "queues-push 只能在主 home 跑" "the refusal must explain itself"
  expect_code 2 "$(tb_code "$MAIN" "$CODE/bin/fm-dispatch-plan.sh" queues-push --now)" "queues-push with an unknown flag"
  pass "queues-push refuses outside the main home and sends nothing without a topic file"
}

# push_code <args>...: queues-push's exit code in the scratch main home.
push_code() {
  local rc=0
  push "$@" >/dev/null || rc=$?
  printf '%s\n' "$rc"
}

test_to_sends_one_mate_its_copy_now() {
  local out
  push_setup to far1 far2
  out=$(push --to far2) || fail "queues-push --to failed: $out"
  assert_equals "far2 " "$(calls)" "--to must send to the one mate named and no other"
  assert_equals "far2：已送出（$(jq -r .at "$MAIN/state/dispatch-plan/pushed/far2")）" "$out" "--to must print that mate's line only"
  assert_absent "$STUB/far/far1/state/dispatch-plan/queues.json" "--to far2 must not reach far1"
  reset_calls
  expect_code 0 "$(push_code --to far2)" "--to with an unchanged copy"
  assert_equals "" "$(calls)" "--to must not resend a copy the mate already has"
  move_topic
  push --to far2 >/dev/null
  assert_equals "far2 " "$(calls)" "--to must send a changed copy at once"
  assert_equals "t2 billing" "$(jq -r '.queues.high | join(" ")' "$STUB/far/far2/state/dispatch-plan/queues.json")" \
    "the mate must hold the changed queues"
  reset_calls
  mode far1 down
  expect_code 1 "$(push_code --to far1)" "--to whose transfer fails"
  assert_present "$MAIN/state/dispatch-plan/pushed/far1.failing" "--to must keep the failure where queues-push keeps it"
  mode far1 ok
  reset_calls
  push >/dev/null
  assert_equals "far1 " "$(calls)" "the next full push must retry the mate --to could not reach"
  mode far2 old
  move_topic
  jq '.queues.later = []' "$MAIN/data/topics.json" > "$MAIN/data/topics.json.new"
  mv "$MAIN/data/topics.json.new" "$MAIN/data/topics.json"
  push --to far2 >/dev/null
  reset_calls
  out=$(push --to far2)
  assert_equals "" "$(calls)" "--to must not retry a far side that refused the copy within the hour"
  assert_contains "$out" "far2：那邊還不能收副本" "--to must say why it waits"
  pass "queues-push --to sends one remote mate the current copy now, with the same records as queues-push"
}

test_to_refuses_anything_but_a_remote_mate() {
  local out rc
  push_setup to-refuse far1
  rc=0
  out=$(tb_run "$MAIN" "$CODE/bin/fm-dispatch-plan.sh" queues-push --to sm1 2>&1) || rc=$?
  expect_code 1 "$rc" "--to a local secondmate"
  assert_contains "$out" "sm1 不是 data/secondmates.md 裡另一台機器上的 second mate" "the refusal must name the mate"
  expect_code 1 "$(tb_code "$MAIN" "$CODE/bin/fm-dispatch-plan.sh" queues-push --to nobody)" "--to an unregistered id"
  expect_code 2 "$(tb_code "$MAIN" "$CODE/bin/fm-dispatch-plan.sh" queues-push --to 'bad id')" "--to a malformed id"
  expect_code 2 "$(tb_code "$MAIN" "$CODE/bin/fm-dispatch-plan.sh" queues-push --to)" "--to without an id"
  expect_code 2 "$(tb_code "$MAIN" "$CODE/bin/fm-dispatch-plan.sh" queues-push --check --to far1)" "--to with --check"
  expect_code 1 "$(tb_code "$STUB/far/far1" "$CODE/bin/fm-dispatch-plan.sh" queues-push --to far1)" "--to in a secondmate home"
  assert_equals "" "$(calls)" "a refused --to must send nothing"
  rm "$MAIN/data/topics.json"
  out=$(push --to far1) || fail "--to failed without a topic file"
  assert_equals "主 home 沒有可用的議題檔，沒有東西可以送。" "$out" "--to without a topic file must say so"
  assert_equals "" "$(calls)" "--to without a topic file must send nothing"
  assert_absent "$MAIN/state/dispatch-plan" "--to without a topic file must write nothing"
  pass "queues-push --to refuses anything but a remote mate and sends nothing without a topic file"
}

# A routed item's "topic:" line must be in the mate's copy when it tags the
# item at intake, so the backlog handoff to a remote mate pushes first. The
# handoff runs from the scratch code root against an outbox already staged;
# its transfer fails right after it starts, so nothing is delivered.
test_handoff_pushes_the_copy_first() {
  local script out rc
  push_setup handoff far1 far2
  for script in "$ROOT"/bin/*; do
    [ -e "$CODE/bin/${script##*/}" ] || ln -s "$script" "$CODE/bin/"
  done
  mkdir -p "$MAIN/data/handoff"
  printf '## In flight\n\n## Queued\n- [ ] r1 - Routed (repo: sample) (kind: ship)\n  topic: billing\n\n## Done\n' \
    > "$MAIN/data/handoff/far1.outbox.md"
  rc=0
  out=$(FM_HOME="$MAIN" FM_ROOT_OVERRIDE="$CODE" "$CODE/bin/fm-backlog-handoff.sh" --resume-pending 2>&1) || rc=$?
  expect_code 1 "$rc" "a handoff whose transfer fails"
  assert_contains "$out" "outbox preserved" "the failed transfer must keep the outbox"
  assert_equals "far1 fm-dispatch-plan.sh queues-in -" "$(head -n 1 "$STUB/calls")" "the handoff must push the copy first"
  assert_contains "$(sed -n 2p "$STUB/calls")" "far1 fm-remote-file.sh put state/handoff/far1.outbox.md" \
    "the handoff's own transfer must follow the push"
  assert_equals "far1 far1 " "$(calls)" "the handoff must push to the mate it hands off to, and no other"
  assert_equals billing "$(jq -r '.queues.high[0]' "$STUB/far/far1/state/dispatch-plan/queues.json")" \
    "the mate must hold the main home's copy"
  reset_calls
  mode far1 down
  move_topic
  rc=0
  out=$(FM_HOME="$MAIN" FM_ROOT_OVERRIDE="$CODE" "$CODE/bin/fm-backlog-handoff.sh" --resume-pending 2>&1) || rc=$?
  assert_equals "far1 far1 " "$(calls)" "a push that fails must not stop the handoff's transfer"
  assert_contains "$(sed -n 2p "$STUB/calls")" "fm-remote-file.sh put" "the transfer must still run after a failed push"
  pass "a backlog handoff to a remote mate pushes the copy first and goes on when the push fails"
}

fm_test_run test_a_first_push_prints_no_shell_error test_pushes_once_per_mate_whose_copy_differs \
  test_resends_an_unchanged_copy_after_30_minutes \
  test_retries_a_failed_transfer_at_the_next_run test_does_not_hammer_a_mate_without_queues_in \
  test_stops_starting_transfers_after_18_seconds test_prints_the_behind_line_once_per_episode \
  test_runs_only_where_there_is_something_to_send test_to_sends_one_mate_its_copy_now \
  test_to_refuses_anything_but_a_remote_mate test_handoff_pushes_the_copy_first
