#!/usr/bin/env bash
# AT4.2: fm-board.sh deliver, the board's action contract on Firstmate's side.
# Each action record runs exactly one command of the table in
# bin/fm-board-io-lib.sh for the main home, a local secondmate (sm1) and a
# remote one (far1), and every result becomes one outcome line. fm-inbox.sh,
# fm-send.sh, fm-captain-hold.sh and fm-on.sh are stand-ins that log what they
# were given; fm-board.sh is the real one behind a logging front.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=fm-board/test/helpers.sh
. "$ROOT/fm-board/test/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot fm-board-stage-2-deliver)
CONTRACT="$ROOT/myshape/test/contract"

# Only scratch homes are written: drop anything that points a run at another home.
unset FM_DATA_OVERRIDE FM_STATE_OVERRIDE FM_CONFIG_OVERRIDE FM_PROJECTS_OVERRIDE FM_TASK_ID FM_TASK_INBOX
export FM_SNAPSHOT_NOW=2026-07-25T00:00:00Z
export TB_LOG="$TMP_ROOT/calls.log" TB_PLAY="$TMP_ROOT/play" TB_REMOTES="$TMP_ROOT/remotes" TB_RAW="$TMP_ROOT/raw"
mkdir -p "$TB_REMOTES"

# FM_HOME is a decoy home: deliver must act for MYSHAPE_HOME instead.
DECOY=$(tb_make_home decoy)
export FM_HOME="$DECOY"
MAIN=$(tb_make_home main)
SM=$(tb_make_secondmate_home sm sm1)
FAR=$(tb_make_secondmate_home remotes/far1 far1)
tb_write_registry "$MAIN" "$SM"
tb_write_topics "$MAIN"
# sm1 is a local secondmate of MAIN, the way upstream seeds one, so its own tag
# checks against MAIN's topic file. Every home gets its own free board port.
printf 'schema=fm-secondmate-parent.v1\nroute=local\nparent_home=%s\n' "$MAIN" > "$SM/.fm-secondmate-parent"
for home in "$DECOY" "$MAIN" "$SM" "$FAR"; do
  tb_free_port > "$home/config/myshape-port"
done

# fronts <code-root>: keep the exact stdin bytes of fm-inbox.sh,
# fm-captain-hold.sh and fm-on.sh --stdin in $TB_RAW/<script> (fm-on.sh reads
# no stdin without --stdin, as the real one does), log fm-on.sh's own argv,
# and log every fm-board.sh run but feed and deliver, which then follows the
# next "<exit code>\t<stderr>" step in $TB_PLAY/fm-board.sh or runs the real one.
# fm-on.sh --stdin <id> fm-dispatch-plan.sh runs the real one in $TB_REMOTES/<id>,
# or fails like a lost connection while $TB_PLAY/push-down exists.
fronts() {
  local fake=$1
  cat > "$fake/bin/fm-inbox.sh" <<'SH'
#!/usr/bin/env bash
set -u
. "$(dirname "$0")/tb-fake-lib.sh"
cat > "$TB_RAW/fm-inbox.sh"
tb_fake fm-inbox.sh "$(cat "$TB_RAW/fm-inbox.sh")" "$@"
exit 0
SH
  cat > "$fake/bin/fm-captain-hold.sh" <<'SH'
#!/usr/bin/env bash
set -u
. "$(dirname "$0")/tb-fake-lib.sh"
cat > "$TB_RAW/fm-captain-hold.sh"
input=$(cat "$TB_RAW/fm-captain-hold.sh")
tb_fake fm-captain-hold.sh "$input" "$@"
printf 'closed: %s\n' "${input%%$'\t'*}"
SH
  mv "$fake/bin/fm-on.sh" "$fake/bin/tb-fm-on.sh"
  cat > "$fake/bin/fm-on.sh" <<'SH'
#!/usr/bin/env bash
set -u
{ printf 'cmd=fm-on.sh\targv='; printf '%s|' "$@"; printf '\thome=%s\n' "${FM_HOME:-}"; } >> "$TB_LOG"
[ "${1:-}" = --stdin ] || exec "$(dirname "$0")/tb-fm-on.sh" "$@"
if [ "${3:-}" = fm-dispatch-plan.sh ]; then
  if [ -e "$TB_PLAY/push-down" ]; then
    cat > /dev/null
    echo "ssh: lost" >&2
    exit 255
  fi
  exec env FM_HOME="$TB_REMOTES/$2" "$(dirname "$0")/fm-dispatch-plan.sh" "${@:4}"
fi
cat > "$TB_RAW/fm-on.sh"
exec "$(dirname "$0")/tb-fm-on.sh" "$@" < "$TB_RAW/fm-on.sh"
SH
  mv "$fake/bin/fm-board.sh" "$fake/bin/tb-real-fm-board.sh"
  cat > "$fake/bin/fm-board.sh" <<'SH'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  feed | deliver) ;;
  *)
    { printf 'cmd=fm-board.sh\targv='; printf '%s|' "$@"; printf '\thome=%s\n' "${FM_HOME:-}"; } >> "$TB_LOG"
    play="$TB_PLAY/fm-board.sh"
    if [ -s "$play" ]; then
      IFS= read -r step < "$play"
      tail -n +2 "$play" > "$play.next"
      mv "$play.next" "$play"
      printf '%s\n' "${step#*$'\t'}" >&2
      exit "${step%%$'\t'*}"
    fi
    ;;
esac
exec "$(dirname "$0")/tb-real-fm-board.sh" "$@"
SH
  chmod +x "$fake/bin/fm-inbox.sh" "$fake/bin/fm-captain-hold.sh" "$fake/bin/fm-on.sh" "$fake/bin/fm-board.sh"
}

FAKE="$TMP_ROOT/root"
tb_make_fake_root "$FAKE"
fronts "$FAKE"

# fresh: an empty log, no scripted steps, no saved stdin.
fresh() {
  rm -rf "$TB_PLAY" "$TB_RAW"
  mkdir -p "$TB_PLAY" "$TB_RAW"
  : > "$TB_LOG"
}

# play <key> <step>...: the scripted results of the stand-in <key>, in order.
play() {
  local key=$1
  shift
  printf '%s\n' "$@" > "$TB_PLAY/$key"
}

# record <kind> [jq filter]: the contract's action record of <kind> as the
# fixture's own bytes, or changed by the filter.
record() {
  if [ "$#" -eq 1 ]; then
    cat "$CONTRACT/action-$1.json"
  else
    jq -c "$2" "$CONTRACT/action-$1.json"
  fi
}

# deliver_with <code-root> <stdin>: "<outcome line> exit=<code>"; fails when the
# outcome line is not one line with the keys contract/outcomes.json gives it.
deliver_with() {
  local root=$1 out rc=0 outcome
  out=$(printf '%s' "$2" | MYSHAPE_HOME="$MAIN" FM_ROOT_OVERRIDE="$root" "$root/bin/fm-board.sh" deliver 2>/dev/null) ||
    rc=$?
  [ -n "$out" ] && [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] ||
    fail "deliver must print one line, got: '$out' (exit $rc)"
  outcome=$(jq -r '.outcome' <<< "$out") || fail "deliver printed no JSON: $out"
  assert_equals "$(jq -c --arg o "$outcome" '.[$o] | keys' "$CONTRACT/outcomes.json")" "$(jq -c 'keys' <<< "$out")" \
    "the outcome line must have the keys contract/outcomes.json gives \"$outcome\""
  printf '%s exit=%s\n' "$out" "$rc"
}

deliver() {
  deliver_with "$FAKE" "$1"$'\n'
}

# line <key> <argv joined by |> <home> [stdin]: one expected stand-in log line.
line() {
  printf 'cmd=%s\targv=%s\thome=%s\tstdin=%s\n' "$1" "$2" "$3" "${4:-}"
}

# front_line <script> <argv joined by |> <home>: one expected fm-board.sh or fm-on.sh front log line.
front_line() {
  printf 'cmd=%s\targv=%s\thome=%s\n' "$1" "$2" "$3"
}

hex16() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -c1-16
  else
    printf '%s' "$1" | shasum -a 256 | cut -c1-16
  fi
}

DELIVERED='{"outcome":"delivered"} exit=0'
ELSEWHERE='{"outcome":"handled_elsewhere"} exit=0'

# failed <error> / retry <error>: the expected result of one deliver.
failed() {
  printf '%s exit=0\n' "$(jq -cn --arg e "$1" '{outcome: "failed", error: $e}')"
}

retry() {
  printf '%s exit=0\n' "$(jq -cn --arg e "$1" '{outcome: "retry", error: $e}')"
}

# raw_is <script> <bytes> <msg>: the exact stdin the stand-in was given.
raw_is() {
  printf '%s' "$2" > "$TMP_ROOT/expected-raw"
  cmp -s "$TMP_ROOT/expected-raw" "$TB_RAW/$1" ||
    fail "$3 (expected $(od -c < "$TMP_ROOT/expected-raw" | head -n 4), got $(od -c < "$TB_RAW/$1" | head -n 4))"
}

test_message_and_notice_become_notes() {
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record message)")" "a message must be delivered"
  assert_equals "$(line fm-inbox.sh 'note|--request-id|tb-w-mfz3k1-a1b2c3|-|' "$MAIN" '［議題：帳務重構（billing）］\n先別合併')" \
    "$(cat "$TB_LOG")" "a message must run fm-inbox.sh note with request id tb-<id> for the main home"
  raw_is fm-inbox.sh $'［議題：帳務重構（billing）］\n先別合併' "a message's note body must be the board's exact text"
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record notice)")" "a notice must be delivered"
  assert_equals "$(line fm-inbox.sh 'note|--request-id|tb-w-mfz3k5-a1b2c3|-|' "$MAIN" '議題「帳務重構」離開「待辦」，排在「一般」第 3')" \
    "$(cat "$TB_LOG")" "a notice must run fm-inbox.sh note with its text as the body"
  raw_is fm-inbox.sh '議題「帳務重構」離開「待辦」，排在「一般」第 3' "a notice's note body must be its exact text"
  fresh
  deliver "$(record message '. + {legacy_request_id: "tb-0123456789abcdef"}')" >/dev/null
  assert_contains "$(cat "$TB_LOG")" 'argv=note|--request-id|tb-w-mfz3k1-a1b2c3|-|' \
    "a field the board no longer sends must not change the request id"
  pass "message and notice run fm-inbox.sh note with the board's exact body and request id"
}

test_note_outcomes() {
  local kind
  for kind in message notice; do
    fresh
    play fm-inbox.sh $'3\tnot woken yet' $'1\tno inbox here' $'0\t'
    assert_equals "$(retry 'not woken yet')" "$(deliver "$(record "$kind")")" "a $kind note that exits 3 must be retried"
    assert_equals "$(failed 'no inbox here')" "$(deliver "$(record "$kind")")" "a $kind note that exits 1 must fail"
    assert_equals "$DELIVERED" "$(deliver "$(record "$kind")")" "a $kind note that exits 0 is delivered"
  done
  fresh
  play fm-inbox.sh '2'
  assert_equals "$(failed 'exit 2')" "$(deliver "$(record message)")" \
    "a silent failure must name its exit code"
  pass "a note's exit 0 is delivered, 3 retry, anything else failed"
}

test_direct_runs_fm_send() {
  local hex
  hex=$(hex16 w-mfz3k2-a1b2c3)
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record direct)")" "a direct message to main must be delivered"
  assert_equals "$(line fm-send.sh 'ship-a|看一下 CI|' "$MAIN")" "$(cat "$TB_LOG")" \
    "a direct message to main must run fm-send.sh <task> <text>"
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record direct '.home = "sm1"')")" "a direct message to sm1 must be delivered"
  assert_equals "$(line fm-send.sh "sm1|--fire-and-forget|$hex|轉給 ship-a：看一下 CI|" "$MAIN")" "$(cat "$TB_LOG")" \
    "a direct message to a local secondmate must be relayed with a delivery id"
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record direct '.home = "far1"')")" "a direct message to far1 must be delivered"
  deliver "$(record direct '.home = "far1"')" >/dev/null
  deliver "$(record direct '.home = "far1" | .id = "w-other"')" >/dev/null
  assert_equals "$(line fm-send.sh "far1|--fire-and-forget|$hex|轉給 ship-a：看一下 CI|" "$MAIN")"$'\n'"$(line fm-send.sh \
    "far1|--fire-and-forget|$hex|轉給 ship-a：看一下 CI|" "$MAIN")"$'\n'"$(line fm-send.sh \
    "far1|--fire-and-forget|$(hex16 w-other)|轉給 ship-a：看一下 CI|" "$MAIN")" "$(cat "$TB_LOG")" \
    "the delivery id must be the first 16 hex of the record id's SHA-256, the same for the same id"
  [ "$hex" != "$(hex16 w-other)" ] || fail "two ids must give two delivery ids"
  pass "direct runs fm-send.sh to the task in main, and relays through the secondmate otherwise"
}

test_direct_outcomes() {
  fresh
  play fm-send.sh $'1\tfm-send.sh: target ship-a is not resolvable' $'3\tunconfirmed' $'1\tboom'
  assert_equals "$(failed '這個 worker 已經結束或找不到，訊息沒有送出。')" "$(deliver "$(record direct)")" \
    "an unresolvable worker in main must fail with the board's words"
  assert_equals "$(failed 'unconfirmed')" "$(deliver "$(record direct)")" "exit 3 to a main worker must fail"
  assert_equals "$(failed 'boom')" "$(deliver "$(record direct)")" "another failure to a main worker must fail"
  fresh
  play fm-send.sh $'3\tunconfirmed' $'1\tboom'
  assert_equals "$(failed 'unconfirmed')" "$(deliver "$(record direct '.home = "sm1"')")" \
    "exit 3 to a local secondmate must fail"
  assert_equals "$(failed 'boom')" "$(deliver "$(record direct '.home = "sm1"')")" "a failed relay to sm1 must fail"
  fresh
  play fm-send.sh $'3\tunconfirmed' $'1\tboom'
  assert_equals "$(retry 'unconfirmed')" "$(deliver "$(record direct '.home = "far1"')")" \
    "exit 3 to a remote secondmate must be retried"
  assert_equals "$(failed 'boom')" "$(deliver "$(record direct '.home = "far1"')")" "a failed relay to far1 must fail"
  fresh
  assert_equals "$(failed '訊息是空的，或以 /、$、! 或 - 開頭')" "$(deliver "$(record direct '.text = "  /clear"')")" \
    "a direct text that starts like a command must fail"
  assert_equals "$(failed '訊息是空的，或以 /、$、! 或 - 開頭')" "$(deliver "$(record direct '.text = " "')")" \
    "an empty direct text must fail"
  assert_equals "$(failed '不認得 home nobody')" "$(deliver "$(record direct '.home = "nobody"')")" \
    "a direct message to an unknown home must fail"
  assert_equals "$(failed 'task id 格式不對：-x')" "$(deliver "$(record direct '.task = "-x"')")" \
    "a direct message to a malformed task id must fail"
  assert_equals '' "$(cat "$TB_LOG")" "a refused direct message must run nothing"
  pass "fm-send.sh results map to delivered, retry only for a remote relay, and failed"
}

test_answer_runs_the_hold_tool_then_a_note() {
  local answer_line=$'call-1\t合併\tA\tdone' note='note|--request-id|tb-w-mfz3k3-a1b2c3-note|-|'
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record answer)")" "an answer in main must be delivered"
  assert_equals "$(line fm-captain-hold.sh 'answers|--source|myshape|' "$MAIN" "$answer_line")"$'\n'"$(line fm-inbox.sh \
    "$note" "$MAIN" '［議題：帳務重構］已在看板回答 main/call-1：合併')" "$(cat "$TB_LOG")" \
    "an answer in main must run fm-captain-hold.sh answers, then the note"
  raw_is fm-captain-hold.sh "$answer_line"$'\n' "the answer must be one line ending in a newline"
  raw_is fm-inbox.sh '［議題：帳務重構］已在看板回答 main/call-1：合併' "the answer's note must be the board's exact text"
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record answer '.home = "sm1"')")" "an answer in sm1 must be delivered"
  assert_equals "$(front_line fm-board.sh '--in-home|sm1|answers|' "$MAIN")"$'\n'"$(line fm-captain-hold.sh \
    'answers|--source|myshape|' "$SM" "$answer_line")"$'\n'"$(line fm-inbox.sh "$note" "$MAIN" \
    '［議題：帳務重構］已在看板回答 sm1/call-1：合併')" "$(cat "$TB_LOG")" \
    "an answer in sm1 must go through fm-board.sh --in-home sm1 answers to that home's hold tool"
  raw_is fm-captain-hold.sh "$answer_line"$'\n' "the forwarded answer must keep its exact line"
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record answer '.home = "far1" | .mode = "release"')")" \
    "an answer in far1 must be delivered"
  assert_equals "$(front_line fm-on.sh '--stdin|far1|fm-captain-hold.sh|answers|--source|myshape|' "$MAIN")"$'\n'"$(line \
    fm-on.sh.fm-captain-hold.sh 'far1|answers|--source|myshape|' "$MAIN" $'call-1\t合併\tA\trelease')"$'\n'"$(line \
    fm-inbox.sh "$note" "$MAIN" '［議題：帳務重構］已在看板回答 far1/call-1：合併')" "$(cat "$TB_LOG")" \
    "an answer in far1 must run fm-on.sh --stdin far1 fm-captain-hold.sh answers --source myshape"
  raw_is fm-on.sh $'call-1\t合併\tA\trelease\n' "the remote answer must be one line ending in a newline"
  fresh
  deliver "$(record answer '.topic = null')" >/dev/null
  assert_contains "$(cat "$TB_LOG")" "$(line fm-inbox.sh "$note" "$MAIN" '［議題：未分類］已在看板回答 main/call-1：合併')" \
    "an answer without a topic must say 未分類, and its note keeps the tb-<id>-note request id"
  pass "answer runs the hold tool of its home, then the note tb-<id>-note"
}

test_answer_outcomes() {
  local text
  for text in 'skipped: call-1 (already closed)' 'refused: call-1 (task call-1 records a different captain decision)' \
    'skipped: call-1 (not held for the captain)'; do
    fresh
    play fm-captain-hold.sh "1"$'\t'"$text"
    assert_equals "$ELSEWHERE" "$(deliver "$(record answer)")" "\"$text\" must be handled elsewhere"
    assert_not_contains "$(cat "$TB_LOG")" fm-inbox.sh "an answer handled elsewhere must send no note"
  done
  fresh
  play fm-captain-hold.sh $'0\tskipped: call-1 (absent)' $'1\trefused: call-1 (reconcile requests require a bound captured source)' \
    $'0\tskipped: other (already closed)' $'255\tssh: lost'
  assert_equals "$(failed 'skipped: call-1 (absent)')" "$(deliver "$(record answer)")" "another skipped line must fail with it"
  assert_equals "$(failed 'refused: call-1 (reconcile requests require a bound captured source)')" \
    "$(deliver "$(record answer)")" "another refused line must fail with it"
  assert_equals "$(failed 'skipped: other (already closed)')" "$(deliver "$(record answer)")" \
    "a line about another task must not count for this one"
  assert_equals "$(failed 'ssh: lost')" "$(deliver "$(record answer)")" "exit 255 in main must fail"
  fresh
  play fm-captain-hold.sh $'255\tssh: lost'
  assert_equals "$(failed 'ssh: lost')" "$(deliver "$(record answer '.home = "sm1"')")" "exit 255 in sm1 must fail"
  fresh
  play fm-on.sh.fm-captain-hold.sh $'255\tssh: lost' $'1\tboom' $'0\tskipped: call-1 (already closed)'
  assert_equals "$(retry 'ssh: lost')" "$(deliver "$(record answer '.home = "far1"')")" "exit 255 in far1 must be retried"
  assert_equals "$(failed 'boom')" "$(deliver "$(record answer '.home = "far1"')")" "another failure in far1 must fail"
  assert_equals "$ELSEWHERE" "$(deliver "$(record answer '.home = "far1"')")" "an answered remote hold is handled elsewhere"
  fresh
  play fm-inbox.sh $'3\tnot woken yet' $'1\tno inbox here'
  assert_equals "$(retry 'not woken yet')" "$(deliver "$(record answer)")" "a closed answer whose note exits 3 must be retried"
  assert_equals "$(failed 'no inbox here')" "$(deliver "$(record answer)")" "a closed answer whose note fails must fail"
  fresh
  assert_equals "$(failed 'mode 只能是 done 或 release')" "$(deliver "$(record answer '.mode = "maybe"')")" \
    "an answer with an unknown mode must fail"
  assert_equals "$(failed '答案與選項只能有一行，不能有 tab')" "$(deliver "$(record answer '.answer = "a\tb"')")" \
    "an answer with a tab must fail"
  assert_equals "$(failed '作答紀錄不完整')" "$(deliver "$(record answer '.answer = ""')")" "an empty answer must fail"
  assert_equals "$(failed '不認得 home nobody')" "$(deliver "$(record answer '.home = "nobody"')")" \
    "an answer in an unknown home must fail"
  assert_equals '' "$(cat "$TB_LOG")" "a refused answer must run nothing"
  pass "answers results map to a note, handled_elsewhere, retry only for a remote 255, and failed"
}

# no_copies: forget every queue copy pushed to far1 and the main home's records of it.
no_copies() {
  rm -rf "$MAIN/state/dispatch-plan" "$FAR/state/dispatch-plan"
}

# far_copy <topic-id>...: give far1 a copy made a minute ago that knows only these topics.
far_copy() {
  mkdir -p "$FAR/state/dispatch-plan"
  jq -nc --arg at "$(jq -nr '(now - 60) | strftime("%Y-%m-%dT%H:%M:%SZ")')" '$ARGS.positional as $ids | {
    schema: "fm-dispatch-queues.v1", at: $at, queues: {high: [], normal: $ids, later: []},
    topics: ($ids | map({key: ., value: {name: .}}) | from_entries), merged: {}, archived: {}}' \
    --args "$@" > "$FAR/state/dispatch-plan/queues.json"
}

test_tag_runs_fm_board_tag() {
  no_copies
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record tag)")" "a tag in main must be delivered"
  assert_equals "$(front_line fm-board.sh 'tag|ship-a|billing|' "$MAIN")" "$(cat "$TB_LOG")" \
    "a tag in main must run fm-board.sh tag <task> <topic>"
  assert_equals billing "$(tail -n 1 "$MAIN/data/ship-a/topic" | cut -d' ' -f1)" "the tag must land in the main home"
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record tag '.home = "sm1"')")" "a tag in sm1 must be delivered"
  assert_equals "$(front_line fm-board.sh '--in-home|sm1|tag|ship-a|billing|' "$MAIN")"$'\n'"$(front_line fm-board.sh \
    'tag|ship-a|billing|' "$SM")" "$(cat "$TB_LOG")" "a tag in sm1 must run fm-board.sh --in-home sm1 tag"
  assert_equals billing "$(tail -n 1 "$SM/data/ship-a/topic" | cut -d' ' -f1)" "the tag must land in sm1's home"
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record tag '.home = "far1"')")" "a tag in far1 must be delivered"
  assert_equals "$(front_line fm-on.sh '--stdin|far1|fm-dispatch-plan.sh|queues-in|-|' "$MAIN")"$'\n'"$(front_line \
    fm-on.sh 'far1|fm-board.sh|tag|ship-a|billing|' "$MAIN")"$'\n'"$(line fm-on.sh.fm-board.sh \
    'far1|tag|ship-a|billing|' "$MAIN")"$'\n'"$(front_line fm-board.sh 'tag|ship-a|billing|' "$FAR")" "$(cat "$TB_LOG")" \
    "a tag in far1 must send far1 the queue copy, then run fm-on.sh far1 fm-board.sh tag"
  assert_equals billing "$(tail -n 1 "$FAR/data/ship-a/topic" | cut -d' ' -f1)" "the tag must land in far1's home"
  pass "tag runs fm-board.sh tag in the right home"
}

test_tag_outcomes() {
  local out
  fresh
  out=$(deliver "$(record tag '.topic = "nope"')")
  assert_contains "$out" '"outcome":"failed"' "a tag the main home refuses must fail"
  assert_contains "$out" 'billing' "the failure must carry the refusal, which lists the usable topics"
  assert_contains "$(deliver "$(record tag '.home = "sm1" | .topic = "nope"')")" '"outcome":"failed"' \
    "a tag refused for sm1 must fail"
  fresh
  play fm-board.sh $'255\tssh: odd' $'255\tssh: odd'
  assert_equals "$(failed 'ssh: odd')" "$(deliver "$(record tag)")" "exit 255 in main must fail"
  assert_equals "$(failed 'ssh: odd')" "$(deliver "$(record tag '.home = "sm1"')")" "exit 255 in sm1 must fail"
  fresh
  play fm-on.sh.fm-board.sh $'255\tssh: lost' $'1\tboom'
  assert_equals "$(retry 'ssh: lost')" "$(deliver "$(record tag '.home = "far1"')")" "exit 255 in far1 must be retried"
  assert_equals "$(failed 'boom')" "$(deliver "$(record tag '.home = "far1"')")" "another failure in far1 must fail"
  fresh
  assert_equals "$(failed 'task 或議題 id 格式不對')" "$(deliver "$(record tag '.topic = "bad id"')")" \
    "a malformed topic id must fail"
  assert_equals "$(failed '不認得 home nobody')" "$(deliver "$(record tag '.home = "nobody"')")" \
    "a tag in an unknown home must fail"
  assert_equals '' "$(cat "$TB_LOG")" "a refused tag must run nothing"
  pass "tag exit 0 is delivered, a remote 255 retry, anything else failed"
}

# The board made the drag, so the topic exists; a far side whose copy is behind
# must still take it, because the main home sends the copy first.
test_remote_tag_sends_the_copy_first() {
  local out
  no_copies
  jq '.topics.fresh = {name: "剛建的", goal: "g", status: "confirmed"} | .queues.normal += ["fresh"]' \
    "$MAIN/data/topics.json" > "$MAIN/data/topics.json.new"
  mv "$MAIN/data/topics.json.new" "$MAIN/data/topics.json"
  far_copy billing t2
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record tag '.home = "far1" | .task = "ship-f" | .topic = "fresh"')")" \
    "a drag to a topic newer than far1's copy must be delivered"
  assert_equals fresh "$(cut -d' ' -f1 "$FAR/data/ship-f/topic")" "the tag must land in far1's home"
  assert_equals '"剛建的"' "$(jq -c '.topics.fresh.name' "$FAR/state/dispatch-plan/queues.json")" \
    "far1 must now hold the main home's copy"
  no_copies
  far_copy billing t2
  fresh
  : > "$TB_PLAY/push-down"
  assert_equals "$DELIVERED" "$(deliver "$(record tag '.home = "far1" | .task = "ship-g" | .topic = "billing"')")" \
    "a tag must still be delivered when the copy cannot be sent"
  assert_equals billing "$(cut -d' ' -f1 "$FAR/data/ship-g/topic")" "the tag must run against far1's older copy"
  out=$(deliver "$(record tag '.home = "far1" | .task = "ship-h" | .topic = "fresh"')")
  assert_contains "$out" '"outcome":"failed"' "with no copy sent, a topic newer than far1's copy is refused there"
  assert_contains "$out" "等主 home 送來下一份副本再跑一次" "the refusal must say to rerun after the next copy"
  assert_absent "$FAR/data/ship-h" "a refused tag must write nothing in far1"
  no_copies
  assert_equals "$DELIVERED" "$(deliver "$(record tag '.home = "far1" | .task = "ship-i" | .topic = "fresh"')")" \
    "with no copy at all, far1 must tag as given"
  rm -f "$TB_PLAY/push-down"
  no_copies
  tb_write_topics "$MAIN"
  pass "a remote tag sends that mate the queue copy first, and goes on when it cannot"
}

test_malformed_records_fail() {
  local input
  fresh
  assert_equals "$(failed '沒有收到動作紀錄')" "$(deliver_with "$FAKE" '')" "empty stdin must fail"
  for input in 'not json' '[]' '{"v":2,"id":"x","kind":"message"}' '{"v":1,"kind":"message"}' '{"v":1,"id":"x"}'; do
    assert_equals "$(failed '動作紀錄不是合法的 JSON 物件')" "$(deliver "$input")" "a malformed record must fail: $input"
  done
  assert_equals "$(failed '不認得的動作：dance')" "$(deliver "$(record message '.kind = "dance"')")" \
    "an unknown kind must fail"
  assert_equals "$(failed '訊息沒有議題')" "$(deliver "$(record message 'del(.topic)')")" "a message without a topic must fail"
  assert_equals "$(failed '訊息沒有議題')" "$(deliver "$(record message '.topic = "billing"')")" "a message whose topic is a string must fail"
  assert_equals '' "$(cat "$TB_LOG")" "a malformed record must run nothing"
  expect_code 2 "$(MYSHAPE_HOME="$MAIN" FM_ROOT_OVERRIDE="$FAKE" "$FAKE/bin/fm-board.sh" deliver extra \
    < /dev/null >/dev/null 2>&1; printf '%s' "$?")" "deliver with an argument"
  pass "malformed or empty stdin, an unknown kind and an unknown home each give a failed outcome line"
}

test_answer_with_the_real_hold_tool() {
  local root home out
  command -v tasks-axi >/dev/null 2>&1 || { pass "skip: tasks-axi not found"; return 0; }
  root="$TMP_ROOT/real-root"
  tb_make_fake_root "$root"
  fronts "$root"
  rm "$root/bin/fm-captain-hold.sh"
  ln -s "$ROOT/bin/fm-captain-hold.sh" "$root/bin/fm-captain-hold.sh"
  home=$MAIN
  printf '## In flight\n\n## Queued\n\n## Done\n' > "$home/data/backlog.md"
  FM_HOME="$home" FM_ROOT_OVERRIDE="$root" "$root/bin/fm-captain-hold.sh" hold call-1 --title "Merge it?" \
    --reason "要合併嗎？" --on-answer close >/dev/null || fail "the real hold tool refused to hold call-1"
  assert_equals 'call-1|close' \
    "$(FM_HOME="$home" FM_ROOT_OVERRIDE="$root" "$root/bin/fm-topic-board-read.sh" 0 - | jq -r '.holds[] | "\(.id)|\(.on_answer)"')" \
    "call-1 must be held for the captain before it is answered"
  fresh
  out=$(deliver_with "$root" "$(record answer)"$'\n')
  assert_equals "$DELIVERED" "$out" "an answer must be delivered through the real hold tool"
  assert_equals "$(line fm-inbox.sh 'note|--request-id|tb-w-mfz3k3-a1b2c3-note|-|' "$home" \
    '［議題：帳務重構］已在看板回答 main/call-1：合併')" "$(cat "$TB_LOG")" "the real hold tool's closed: must lead to the note"
  assert_equals 0 "$(FM_HOME="$home" FM_ROOT_OVERRIDE="$root" "$root/bin/fm-topic-board-read.sh" 0 - | jq '.holds | length')" \
    "the answer must close the hold"
  assert_equals "$DELIVERED" "$(deliver_with "$root" "$(record answer)"$'\n')" "repeating the same answer must be delivered again"
  assert_equals "$ELSEWHERE" "$(deliver_with "$root" "$(record answer '.answer = "不要"')"$'\n')" \
    "a different answer to a closed hold must be handled elsewhere"
  pass "an answer is delivered against the real fm-captain-hold.sh"
}

# A hands-on item closed on the board is a note when the captain closed it and
# nothing when the aggregator did. An item an older board adopted (ref "hold")
# is no different: its old captain hold is not touched, so a hold still open
# stays in the backlog, where the board shows it as a decision.
test_closed_item_is_only_a_note() {
  local closed note
  closed=$(record notice-todo-closed)
  note=$(line fm-inbox.sh 'note|--request-id|tb-w-mfz3k9-a1b2c3|-|' "$MAIN" '使用者在看板上：「登入 VPN」不做了（vpn-login）')
  fresh
  assert_equals "$DELIVERED" "$(deliver "$closed")" "the captain's 不做了 on an adopted item must be delivered"
  assert_equals "$note" "$(cat "$TB_LOG")" "the captain's close of an adopted item must be only the note"
  fresh
  assert_equals "$DELIVERED" \
    "$(deliver "$(record notice-todo-closed '.words = "撤下" | .text = "使用者在看板上：「登入 VPN」撤下（vpn-login）"')")" \
    "好，撤下 on an adopted item must be delivered"
  assert_equals "$(line fm-inbox.sh 'note|--request-id|tb-w-mfz3k9-a1b2c3|-|' "$MAIN" '使用者在看板上：「登入 VPN」撤下（vpn-login）')" \
    "$(cat "$TB_LOG")" "好，撤下 on an adopted item must be only the note"
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record notice-todo-closed '.by = "aggregator" | .words = "做完了"')")" \
    "todo done on an adopted item must be delivered"
  assert_equals "" "$(cat "$TB_LOG")" "todo done on an adopted item runs nothing"
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record notice-todo-closed '.item.ref = ""')")" "the captain's close of a new item"
  assert_equals "$note" "$(cat "$TB_LOG")" "the captain's close of a new item is only a note"
  fresh
  assert_equals "$DELIVERED" "$(deliver "$(record notice-todo-closed '.item.ref = "" | .by = "aggregator"')")" \
    "the aggregator's close of a new item"
  assert_equals "" "$(cat "$TB_LOG")" "the aggregator's own close of a new item runs nothing"
  fresh
  assert_equals "$(failed '項目 id 格式不對：bad id')" "$(deliver "$(record notice-todo-closed '.item.id = "bad id"')")" \
    "a malformed item id fails"
  assert_equals "" "$(cat "$TB_LOG")" "a refused close runs nothing"
  pass "a closed hands-on item is a note for the captain's close and nothing for the aggregator's, adopted or not"
}

# schedule_notice <id> <event> <text>: the contract's notice record as the
# board's schedule clock sends it, under a fixed id, with an occurrence.
schedule_notice() {
  jq -c --arg id "$1" --arg event "$2" --arg text "$3" '.id = $id | .event = $event | .text = $text
    | .occurrence = {key: "weekly-sync:20261130T0200Z", at: "2026-11-30T02:00:00Z",
        local: "2026-11-30T10:00+08:00", phase: "pre", late_min: 0, rt: "hard-rt",
        expires_at: "2026-11-30T02:00:00Z"}' "$CONTRACT/action-notice.json"
}

# A notice whose event this side does not know is an ordinary note: its exact
# text under request id tb-<id>, and nothing else is run, whatever else the
# record carries. The board's schedule clock sends such events.
test_unknown_notice_event_is_a_note() {
  local text='排程「週會」11-30（一）10:00 開始，還有 15 分鐘（議題 billing，這一場 weekly-sync:20261130T0200Z）（hard-rt）'
  local missed='排程「看信」11-27（五）06:00 錯過了：看板當時沒在跑，這一場沒有通知（議題 billing，這一場 mail-0600:20261126T2200Z）（soft-rt）'
  fresh
  assert_equals "$DELIVERED" \
    "$(deliver "$(schedule_notice w-s-weekly-sync-20261130T0200Z-pre schedule.upcoming "$text")")" \
    "a notice with an unknown event must be delivered"
  assert_equals "$(line fm-inbox.sh 'note|--request-id|tb-w-s-weekly-sync-20261130T0200Z-pre|-|' "$MAIN" "$text")" \
    "$(cat "$TB_LOG")" "an unknown event must run only fm-inbox.sh note, with request id tb-<id>"
  raw_is fm-inbox.sh "$text" "an unknown event's note body must be its exact text, without the occurrence"
  fresh
  assert_equals "$DELIVERED" \
    "$(deliver "$(schedule_notice w-s-mail-0600-20261126T2200Z-missed schedule.missed "$missed" | jq -c '.by = "aggregator"')")" \
    "an unknown event that names the aggregator must still be delivered"
  assert_equals "$(line fm-inbox.sh 'note|--request-id|tb-w-s-mail-0600-20261126T2200Z-missed|-|' "$MAIN" "$missed")" \
    "$(cat "$TB_LOG")" "only todo.closed skips the note for the aggregator's own act"
  pass "a notice with an event this side does not know is its text as a note, under tb-<id>"
}

# notes_for <home> <request id>: the notes the real inbox holds under that request id, waiting or handled.
notes_for() {
  grep -rlxF --include='*.note' "request_id=$2" "$1/state/inbox" 2>/dev/null || true
}

# The same notices against the real fm-inbox.sh in a scratch home: the inbox
# accepts the fixed ids' request ids, up to the longest a 64-character schedule
# id gives (93 characters), keeps exactly one note per id however often it is
# delivered, and keeps the text as its body. Whether the wake step succeeds
# under the fake root is not asserted: a note saved but not announced is a
# retry, which the board repeats under the same id.
test_schedule_notice_with_the_real_inbox() {
  local root home id long note body outcome out
  [ -x "$ROOT/bin/fm-inbox.sh" ] || { pass "skip: no fm-inbox.sh in this root"; return 0; }
  root="$TMP_ROOT/real-inbox-root"
  tb_make_fake_root "$root"
  fronts "$root"
  rm "$root/bin/fm-inbox.sh"
  ln -s "$ROOT/bin/fm-inbox.sh" "$root/bin/fm-inbox.sh"
  home=$MAIN
  id=w-s-weekly-sync-20261130T0200Z-pre
  long="w-s-$(printf 'a%.0s' $(seq 1 64))-20261130T0200Z-missed"
  assert_equals 93 "$(printf 'tb-%s' "$long" | wc -c | tr -d ' ')" "the longest fixed id's request id is 93 characters"
  for outcome in first again; do
    fresh
    out=$(deliver_with "$root" "$(schedule_notice "$id" schedule.upcoming '排程「週會」11-30（一）10:00 開始')"$'\n')
    case "$out" in
      "$DELIVERED" | '{"outcome":"retry",'*) ;;
      *) fail "the real inbox must take a schedule notice ($outcome), got: $out" ;;
    esac
  done
  assert_equals 1 "$(notes_for "$home" "tb-$id" | wc -l | tr -d ' ')" \
    "the real inbox must keep exactly one note for a fixed id delivered twice"
  note=$(notes_for "$home" "tb-$id")
  body=$(sed '1,/^--$/d' "$note")
  assert_equals '排程「週會」11-30（一）10:00 開始' "$body" "the note's body must be the notice's text"
  out=$(deliver_with "$root" "$(schedule_notice "$long" schedule.missed '排程「看信」錯過了')"$'\n')
  case "$out" in
    "$DELIVERED" | '{"outcome":"retry",'*) ;;
    *) fail "the real inbox must take the longest fixed id, got: $out" ;;
  esac
  assert_equals 1 "$(notes_for "$home" "tb-$long" | wc -l | tr -d ' ')" \
    "the real inbox must keep the longest fixed id's note"
  pass "the real fm-inbox.sh keeps one note per schedule notice id, the longest included"
}

fm_test_run test_message_and_notice_become_notes test_note_outcomes test_direct_runs_fm_send \
  test_direct_outcomes test_answer_runs_the_hold_tool_then_a_note test_answer_outcomes \
  test_tag_runs_fm_board_tag test_tag_outcomes test_remote_tag_sends_the_copy_first test_malformed_records_fail \
  test_answer_with_the_real_hold_tool test_closed_item_is_only_a_note \
  test_unknown_notice_event_is_a_note test_schedule_notice_with_the_real_inbox
