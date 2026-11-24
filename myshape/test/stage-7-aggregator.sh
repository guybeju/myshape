#!/usr/bin/env bash
# The board with an aggregator on the other side, from a board-only root in
# the hardened environment of stage-7-standalone.sh (AT2, AT6, AT7 and AT9 of
# the board-interface test plan, as they stand for B4). Two stubs sit outside
# the root under their own names, each reached through its home's binding
# file and confirmed on the page: stub-fm, Firstmate-shaped, feeds the shared
# fixtures of myshape/test/contract/ for home main and its further homes sm1
# and far1; stub-plain, written only from the contract, feeds a home of its
# own under the name "plain". Each logs every feed call and every action
# record it receives (stub-aggregator/stub-lib.sh). AT9 checks the binding
# and the safety rule from a second board-only root. With
# TB_STAGE7_TRIPWIRES=1 the root also holds a tripwire for every other
# Firstmate script, and the run must leave the trip log empty (AT3.2).
# shellcheck disable=SC2016 # jq filters are literal text.
set -u

# shellcheck source=myshape/test/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"
# shellcheck source=myshape/test/standalone-lib.sh
. "$ROOT/myshape/test/standalone-lib.sh"

for tool in jq node curl git sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "skip: $tool not found"; exit 0; }
done
TMP_ROOT=$(fm_test_tmproot tb-s7a)
case "$TMP_ROOT" in /*) ;; *) echo "not ok - no scratch root" >&2; exit 1 ;; esac
trap 'tb_stop_boards; sig_leftovers; fm_test_cleanup' EXIT
sig_init

sa_init
mkdir -p "$TMP_ROOT/root"
SA_ROOT=$TMP_ROOT/root/board
tb_make_board_root "$SA_ROOT" >/dev/null
[ "${TB_STAGE7_TRIPWIRES:-0}" != 1 ] || sa_trip_root "$SA_ROOT"
BASE_ENV=(MYSHAPE_TEST=1 MYSHAPE_NOTIFY_MS=2000 "MYSHAPE_RETRY_MS=100,200"
  MYSHAPE_READ_MS=300 MYSHAPE_STALE_MS=4000 MYSHAPE_IDLE_MS=600000)
AGG_FM=$TMP_ROOT/agg-fm
AGG_PLAIN=$TMP_ROOT/agg-plain
SA_ENV=("${BASE_ENV[@]}")
STUB_PLAIN=$(sa_install_stub plain "$AGG_PLAIN")
STUB_FM=$(sa_install_stub fm "$AGG_FM")
CONTRACT=$ROOT/myshape/test/contract
FMH=$(sa_home fm)
PH=$(sa_home plain)
sa_decoys "$FMH"
sa_decoys "$PH"
sa_bind "$FMH" "$STUB_FM"
sa_bind "$PH" "$STUB_PLAIN"

# f / p <myshape.sh arguments...>: the board of the stub-fm home, or of the stub-plain home.
f() {
  sa "$FMH" "$@"
}
p() {
  sa "$PH" "$@"
}

base_url() {  # <home>
  printf 'http://127.0.0.1:%s' "$(cat "$1/config/myshape-port")"
}

state_of() {  # <home> [jq arguments...] [jq filter]
  local home=$1
  shift
  [ "$#" -gt 0 ] || set -- .
  curl -s -m 20 -H "Authorization: Bearer $(cat "$home/state/myshape/token")" "$(base_url "$home")/api/state" | jq -c -r "$@"
}

post() {  # <home> <route> <json body>
  local base
  base=$(base_url "$1")
  curl -s -m 20 -H "Authorization: Bearer $(cat "$1/state/myshape/token")" -H "Origin: $base" \
    -H 'Content-Type: application/json' -d "$3" "$base/api/$2"
}

# two_step <home> <route> <json body>: the first request, then the second with its code.
two_step() {
  local code
  code=$(post "$1" "$2" "$3" | jq -r '.confirm')
  post "$1" "$2" "$(jq -c --arg code "$code" '. + {confirm: $code}' <<< "$3")"
}

refresh() {  # <home>
  post "$1" refresh '{}' >/dev/null
}

wait_for() {  # <description> <command...>: retry the command for up to 15 seconds
  local what=$1 tries=0
  shift
  until "$@"; do
    tries=$((tries + 1))
    [ "$tries" -lt 100 ] || fail "timed out waiting for $what"
    sleep 0.15
  done
}

received() {  # <agg-dir> [jq arguments...] [jq filter]: what the filter makes of every action record received, as one array
  local agg=$1
  shift
  [ "$#" -gt 0 ] || set -- .
  jq -r -c -s "$@" "$agg/received.jsonl"
}

is() {  # <expected> <command...>: the command prints exactly <expected>
  [ "$("${@:2}")" = "$1" ]
}

at_least() {  # <n> <command...>: the command prints a number of at least <n>
  [ "$("${@:2}")" -ge "$1" ]
}

received_count() {  # <agg-dir>
  grep -c '' "$1/received.jsonl" || true
}

write_state() {  # <home> <write-id>
  state_of "$1" --arg id "$2" '.writes[] | select(.id == $id) | .state'
}

write_is() {  # <home> <write-id> <state>
  is "$3" write_state "$1" "$2"
}

feeds_of() {  # <agg-dir> <home>: how many feed calls that home got
  awk -v home="$2" '$1 == "feed" && $2 == home' "$1/calls.log" | wc -l | tr -d ' '
}

# --- AT2: stub-fm, Firstmate-shaped ------------------------------------------

test_fm_setup() {
  local home
  for home in main sm1 far1; do cp "$CONTRACT/report-$home.json" "$AGG_FM/fm/$home.json"; done
  cp "$CONTRACT/ledger-main.jsonl" "$AGG_FM/fm/main.ledger"
  f open >/dev/null || fail "the board did not start"
  sa_confirm "$FMH"
  f create "建置" --goal "把 x 建起來" --id solo >/dev/null
  f create "收尾" --goal "收乾淨" --id wrap >/dev/null
  refresh "$FMH"
  wait_for "the fixture to reach the page" is 1 state_of "$FMH" '[.agents[] | select(.task == "t1")] | length'
  pass "the board reads the Firstmate-shaped stub"
}

# AT2.1: what the stub fed is on the page.
test_fm_work_reaches_the_page() {
  local state
  state=$(state_of "$FMH")
  assert_equals "solo|working" "$(jq -r '.agents[] | select(.home == "main" and .task == "t1") | "\(.topic)|\(.light)"' <<< "$state")" \
    "a tagged worker must be under its topic with its light"
  assert_equals "null|no-tag|stuck" "$(jq -r '.agents[] | select(.task == "loose") | "\(.topic)|\(.unsorted_reason)|\(.light)"' <<< "$state")" \
    "an untagged worker must be unsorted"
  assert_equals "q-after=等 t1 完成 q-decide=等你決定 q-parked=停著：等 CI 修好 q-ready=null" \
    "$(jq -r '[.queued[] | select(.topic == "solo") | "\(.task)=\(.waiting)"] | sort | join(" ")' <<< "$state")" \
    "queued items must be under their topic with what each waits for"
  assert_equals "A,B" "$(jq -r '.holds[] | select(.task == "call-close") | .options | join(",")' <<< "$state")" \
    "a hold must carry the options of its last line"
  assert_equals "solo|which way for the cache?" "$(jq -r '.questions[] | select(.task == "t1") | "\(.topic)|\(.summary)"' <<< "$state")" \
    "a worker question must be under its topic"
  assert_equals "task.cleaned_up task.dispatched task.merged task.dispatched task.pr_ready task.status task.dispatched" \
    "$(jq -r '[.updates[] | select(.source == "ledger" and (.task == "t1" or .task == "gone-merged" or .task == "gone-dropped")) | .event] | join(" ")' <<< "$state")" \
    "the timeline must show the fixture ledger, newest first"
  assert_equals "https://example.invalid/pr/7" "$(jq -r '.updates[] | select(.event == "task.pr_ready") | .pr' <<< "$state")" \
    "a PR-ready event must carry its link"
  assert_equals "working：halfway" "$(jq -r '.updates[] | select(.event == "task.status") | .text' <<< "$state")" \
    "a status event must read state：text"
  assert_equals "done|true" "$(jq -r '.agents[] | select(.task == "gone-merged") | "\(.light)|\(.finished)"' <<< "$state")" \
    "a merged worker gone from the report must show as finished"
  assert_equals "unknown|discarded" "$(jq -r '.agents[] | select(.task == "gone-dropped") | "\(.light)|\(.state)"' <<< "$state")" \
    "a ship cleaned up without a merge must show as 已收掉"
  pass "every part of the fed work reaches the page (AT2.1)"
}

# AT2.2: one feed call per home, each with its own cursor.
test_fm_every_home_is_read_with_its_own_cursor() {
  local first ledger_sha
  first=$(awk '$1 == "feed" && $2 == "main" { print $3 " " $4; exit }' "$AGG_FM/calls.log")
  assert_equals "0 -" "$first" "the first read of main must pass 0 -"
  ledger_sha=$(sha256sum < "$AGG_FM/fm/main.ledger" | cut -d' ' -f1)
  printf '%s\n' '{"v":1,"ts":1795000700,"event":"task.status","task":"t1","state":"working","text":"later"}' >> "$AGG_FM/fm/main.ledger"
  refresh "$FMH"
  wait_for "the next read to carry the cursor" grep -q "^feed main $(wc -c < "$CONTRACT/ledger-main.jsonl" | tr -d ' ') $ledger_sha " "$AGG_FM/calls.log"
  [ "$(feeds_of "$AGG_FM" sm1)" -ge 1 ] || fail "home sm1 must be read with its own id"
  [ "$(feeds_of "$AGG_FM" far1)" -ge 1 ] || fail "home far1 must be read with its own id"
  grep -q '^feed far1 0 - ' "$AGG_FM/calls.log" || fail "far1 must be read from its own cursor"
  pass "the feed is called for every home with its own cursor (AT2.2)"
}

# AT2.3: a message keeps its topic and text.
test_fm_message() {
  local id
  : > "$AGG_FM/received.jsonl"
  id=$(post "$FMH" messages '{"topic":"solo","text":"先別合併 $(x) \"q\""}' | jq -r '.write_id')
  wait_for "the message to arrive" write_is "$FMH" "$id" delivered
  assert_equals "{\"v\":1,\"id\":\"$id\",\"attempt\":0,\"kind\":\"message\",\"topic\":{\"id\":\"solo\",\"name\":\"建置\"},\"text\":\"先別合併 \$(x) \\\"q\\\"\"}" \
    "$(head -n 1 "$AGG_FM/received.jsonl")" "the message record must be exact"
  pass "a message reaches the aggregator with its topic and text, byte for byte (AT2.3)"
}

# AT2.4: answers take two steps and carry the mode the hold recorded.
test_fm_answers() {
  local code mode
  : > "$AGG_FM/received.jsonl"
  code=$(post "$FMH" holds/answer '{"home":"main","task":"call-close","answer":"A","label":"A"}' | jq -r '.confirm')
  sleep 0.5
  assert_equals 0 "$(received_count "$AGG_FM")" "nothing may be sent after the first step"
  post "$FMH" holds/answer "{\"home\":\"main\",\"task\":\"call-close\",\"answer\":\"A\",\"label\":\"A\",\"mode\":\"release\",\"confirm\":\"$code\"}" >/dev/null
  wait_for "the answer to arrive" is 1 received_count "$AGG_FM"
  assert_equals "answer|main|call-close|A|A|done|solo" \
    "$(received "$AGG_FM" '.[0] | "\(.kind)|\(.home)|\(.task)|\(.answer)|\(.label)|\(.mode)|\(.topic.id)"')" \
    "a hold recorded close must send done, whatever the request said"
  assert_equals "$(printf '要合併嗎？\n選項：A | B' | sha256sum | cut -d' ' -f1)" "$(received "$AGG_FM" '.[0].question_sha256')" \
    "the record must carry the question's SHA-256"
  for mode in release none; do
    : > "$AGG_FM/received.jsonl"
    two_step "$FMH" holds/answer "{\"home\":\"main\",\"task\":\"call-$mode\",\"answer\":\"好\",\"label\":\"好\"}" >/dev/null
    wait_for "the $mode answer" is 1 received_count "$AGG_FM"
    assert_equals release "$(received "$AGG_FM" '.[0].mode')" "a hold recorded $mode must send release"
  done
  assert_equals null "$(received "$AGG_FM" '.[0].topic')" "a hold with no topic is answered from 未分類 like any other"
  : > "$AGG_FM/received.jsonl"
  two_step "$FMH" holds/answer '{"home":"sm1","task":"call-sm","answer":"好","label":"好"}' >/dev/null
  wait_for "the sm1 answer" is 1 received_count "$AGG_FM"
  assert_equals "sm1|done" "$(received "$AGG_FM" '.[0] | "\(.home)|\(.mode)"')" "an answer to sm1's hold must name home sm1"
  code=$(post "$FMH" holds/answer '{"home":"main","task":"call-close","answer":"B","label":"B"}' | jq -r '.confirm')
  jq '.holds[0].question = "改過的問題"' "$AGG_FM/fm/main.json" > "$AGG_FM/fm/main.json.tmp" && mv "$AGG_FM/fm/main.json.tmp" "$AGG_FM/fm/main.json"
  refresh "$FMH"
  sleep 1
  assert_equals confirm "$(post "$FMH" holds/answer "{\"home\":\"main\",\"task\":\"call-close\",\"answer\":\"B\",\"label\":\"B\",\"confirm\":\"$code\"}" | jq -r '.error')" \
    "a hold changed between the steps must be refused"
  cp "$CONTRACT/report-main.json" "$AGG_FM/fm/main.json"
  pass "answers take two steps, carry the hold's own mode, its digest and its home (AT2.4)"
}

# AT2.5: filing an unsorted worker of a further home.
test_fm_filing() {
  local id
  : > "$AGG_FM/received.jsonl"
  id=$(post "$FMH" agents/tag '{"home":"sm1","task":"sm-loose","topic":"solo"}' | jq -r '.write_id')
  wait_for "the filing to arrive" write_is "$FMH" "$id" delivered
  assert_equals "tag|sm1|sm-loose|solo|" "$(received "$AGG_FM" '.[0] | "\(.kind)|\(.home)|\(.task)|\(.topic)|\(.last_tag_line)"')" \
    "the filing record must name the home, the task, the topic and the tag line it saw"
  refresh "$FMH"
  wait_for "the worker to move under its topic" is solo state_of "$FMH" '.agents[] | select(.task == "sm-loose") | .topic'
  pass "a filed worker of a further home moves under its topic once the aggregator reports the tag (AT2.5)"
}

# AT2.6 and AT2.7: notices of what the captain did on the page.
test_fm_notices() {
  local text
  f create "移動" --goal "g" --id mover --queue later >/dev/null
  f create "併掉" --goal "g" --id gone >/dev/null
  f create "封存" --goal "g" --id shelf >/dev/null
  f create "提議" --goal "g" --id kept >/dev/null
  f close-propose kept --reason "做完了？" >/dev/null
  : > "$AGG_FM/received.jsonl"
  two_step "$FMH" topics/merge '{"from":"gone","into":"wrap"}' >/dev/null
  post "$FMH" topics/archive '{"id":"shelf"}' >/dev/null
  post "$FMH" topics/keep '{"id":"kept"}' >/dev/null
  wait_for "three notices" is 3 received_count "$AGG_FM"
  assert_equals "topic.merged:wrap topic.archived:shelf topic.kept:kept" \
    "$(received "$AGG_FM" 'map("\(.event):\(.topic.id)") | join(" ")')" "a merge, an archive and a keep must each send a notice"
  : > "$AGG_FM/received.jsonl"
  post "$FMH" topics/move '{"id":"mover","queue":"normal"}' >/dev/null
  sleep 1
  assert_equals 0 "$(received_count "$AGG_FM")" "nothing may be sent before the delay"
  wait_for "the dispatchable notice" is 1 received_count "$AGG_FM"
  text=$(received "$AGG_FM" '.[0].text')
  assert_equals "topic.dispatchable|mover" "$(received "$AGG_FM" '.[0] | "\(.event)|\(.topic.id)"')" "a move out of later must send a dispatchable notice"
  assert_equals "議題「移動」離開「待辦」，排在「一般」最後，現在可派" "$text" "the notice must name the queue and the place"
  assert_not_contains "$text" "order" "the notice must not dictate a command"
  assert_not_contains "$text" ".sh" "the notice must name no program"
  : > "$AGG_FM/received.jsonl"
  post "$FMH" topics/move '{"id":"mover","queue":"later"}' >/dev/null
  post "$FMH" topics/move '{"id":"mover","queue":"normal"}' >/dev/null
  post "$FMH" topics/move '{"id":"mover","queue":"later"}' >/dev/null
  sleep 3
  assert_equals 0 "$(received_count "$AGG_FM")" "a topic dragged back before the delay must send nothing"
  post "$FMH" topics/reopen '{"id":"shelf","queue":"high"}' >/dev/null
  wait_for "the reopen notice" is 1 received_count "$AGG_FM"
  assert_contains "$(received "$AGG_FM" '.[0].text')" "議題「封存」重開，排在「高」" "a reopening must send a dispatchable notice"
  pass "merges, archives, keeps and reopenings notify the aggregator, and a dispatchable notice waits and dictates nothing (AT2.6, AT2.7)"
}

# records_of <home> <item>: kind|by|label|outcome|reason|task of every record about that item, oldest first.
records_of() {
  jq -r -s --arg item "$2" '[.[] | select(.src == "board" and .item == $item)
    | "\(.kind)|\(.by)|\(.label)|\(.outcome // "-")|\(.reason // "-")|\(.task)"] | join(" ")' "$1/data/myshape/events.jsonl"
}

todo_view() {  # <home> <task>: the item as the page gets it, or nothing
  state_of "$1" --arg id "$2" '.todos[] | select(.task == $id) | {topic, what, guidance, commands, state, reason}'
}

# AT2.15: the whole life of a hands-on item, with a record for every step.
test_fm_hands_on() {
  local commands
  : > "$AGG_FM/received.jsonl"
  f todo add vpn-login 登入VPN --topic solo --do "用公司帳號登入 VPN" --note "只在公司網路外" \
    --cmd "sudo openconnect vpn.example.com" --cmd "$(printf 'ping -c1 intra\n  && echo ok')" >/dev/null ||
    fail "todo add failed"
  commands=$(jq -cn --arg b "$(printf 'ping -c1 intra\n  && echo ok')" '["sudo openconnect vpn.example.com", $b]')
  assert_equals "$(jq -cn --argjson c "$commands" '{topic: "solo", what: "用公司帳號登入 VPN", guidance: "只在公司網路外", commands: $c, state: "open", reason: null}')" \
    "$(todo_view "$FMH" vpn-login)" "the page must show the item with its guidance and both commands"
  assert_equals "$commands" "$(jq -c '.items["vpn-login"].commands' "$FMH/data/myshape/todos.json")" "todos.json must hold the item"
  assert_equals true "$(post "$FMH" todos/claim '{"task":"vpn-login"}' | jq -r '.ok')" "做完了 on the page failed"
  wait_for "the claim notice" is 1 received_count "$AGG_FM"
  assert_equals "todo.claimed|vpn-login|登入VPN|solo" "$(received "$AGG_FM" '.[0] | "\(.event)|\(.item.id)|\(.item.title)|\(.topic.id)"')" \
    "做完了 must send todo.claimed"
  f todo failed vpn-login --reason "連不上" >/dev/null || fail "todo failed failed"
  assert_equals '"rejected"|"連不上"' "$(todo_view "$FMH" vpn-login | jq -r '"\(.state | tojson)|\(.reason | tojson)"')" \
    "a failed check must put the item back with its reason"
  post "$FMH" todos/claim '{"task":"vpn-login"}' >/dev/null
  wait_for "the second claim" is 2 received_count "$AGG_FM"
  f todo 'done' vpn-login >/dev/null || fail "todo done failed"
  assert_equals "" "$(todo_view "$FMH" vpn-login)" "todo done must take the item off"
  wait_for "the close notice" is 3 received_count "$AGG_FM"
  assert_equals "todo.closed|aggregator|做完了" "$(received "$AGG_FM" '.[2] | "\(.event)|\(.by)|\(.words)"')" "todo done must send todo.closed by the aggregator"
  assert_equals "todo.opened|aggregator|first mate|-|-|null todo.claimed|captain|first mate|-|-|null todo.rejected|aggregator|first mate|-|連不上|null todo.claimed|captain|first mate|-|-|null todo.done|aggregator|first mate|done|-|null" \
    "$(records_of "$FMH" vpn-login)" "every step must leave a record saying who made it"
  assert_contains "$(grep '"item":"vpn-login"' "$FMH/data/myshape/events.jsonl" | tail -n 1)" '"topic":"solo"' "the records must be under the item's topic"

  f todo add drop-me 不要了 --topic solo --do "x" >/dev/null
  two_step "$FMH" todos/drop '{"task":"drop-me"}' >/dev/null
  wait_for "the drop notice" is 4 received_count "$AGG_FM"
  assert_equals "todo.closed|captain|不做了" "$(received "$AGG_FM" '.[3] | "\(.event)|\(.by)|\(.words)"')" "不做了 must send todo.closed by the captain with its words"
  assert_equals "todo.opened|aggregator|first mate|-|-|null todo.dropped|captain|first mate|dropped|-|null" "$(records_of "$FMH" drop-me)" \
    "不做了 must leave the captain's record"

  f todo add gone-now 用不到 --topic solo --do "x" >/dev/null
  f todo obsolete gone-now --reason "改用別的" >/dev/null
  assert_equals "" "$(todo_view "$FMH" gone-now)" "an item made after B3 is taken down at once"
  wait_for "the takedown notice" is 5 received_count "$AGG_FM"
  assert_equals "todo.closed|aggregator|撤下" "$(received "$AGG_FM" '.[4] | "\(.event)|\(.by)|\(.words)"')" "the takedown must send todo.closed by the aggregator"
  assert_contains "$(state_of "$FMH" '[.updates[].text] | join("\n")')" "要你動手「用不到」已撤下：不再需要，改用別的（first mate 用指令）" \
    "the reason must be in the topic's updates"

  f todo add old-one 舊的 --topic solo --do "x" --captain-closes --ref hold >/dev/null
  f todo obsolete old-one --reason "不需要了" >/dev/null
  assert_equals '"obsolete"' "$(todo_view "$FMH" old-one | jq -c '.state')" "an item only the captain closes waits for 好，撤下"
  two_step "$FMH" todos/takedown '{"task":"old-one"}' >/dev/null
  wait_for "the captain's takedown notice" is 6 received_count "$AGG_FM"
  assert_equals "todo.closed|captain|撤下|hold" "$(received "$AGG_FM" '.[5] | "\(.event)|\(.by)|\(.words)|\(.item.ref)"')" \
    "好，撤下 must send todo.closed by the captain, with the item's ref"
  assert_equals "todo.opened|aggregator|first mate|-|-|null todo.obsolete|aggregator|first mate|-|不需要了|null todo.taken_down|captain|first mate|taken_down|-|null" \
    "$(records_of "$FMH" old-one)" "every step of an item only the captain closes must be recorded"
  pass "a hands-on item lives on the board from add to every way out, each step recorded (AT2.15)"
}

# AT2.8 and AT2.9: direct messages.
test_fm_direct() {
  local text id
  : > "$AGG_FM/received.jsonl"
  for text in "/compact" '$x' "!ls" " -x"; do
    assert_equals refused "$(post "$FMH" direct "$(jq -cn --arg t "$text" '{home: "main", task: "t1", text: $t}')" | jq -r '.error')" \
      "a direct message starting '$text' must be refused"
  done
  id=$(post "$FMH" direct '{"home":"far1","task":"far-work","text":"看一下 \"這個\"\n第二行"}' | jq -r '.write_id')
  wait_for "the direct message" write_is "$FMH" "$id" delivered
  assert_equals "direct|far1|far-work|看一下 \"這個\"
第二行" "$(received "$AGG_FM" '.[0] | "\(.kind)|\(.home)|\(.task)|\(.text)"')" "a direct message must reach the right home and task unchanged"
  assert_equals 1 "$(received_count "$AGG_FM")" "the refused messages must send nothing"
  pass "command-like text is refused and a direct message reaches its home and worker unchanged (AT2.8, AT2.9)"
}

# AT2.10: delivery states.
test_fm_delivery_states() {
  local id
  printf '%s\n' '{"outcome":"retry","error":"busy"}' > "$AGG_FM/play"
  : > "$AGG_FM/received.jsonl"
  id=$(post "$FMH" messages '{"topic":"solo","text":"重試"}' | jq -r '.write_id')
  wait_for "a retry then delivery" write_is "$FMH" "$id" delivered
  assert_equals "$id:0 $id:1" "$(received "$AGG_FM" 'map("\(.id):\(.attempt)") | join(" ")')" "a retry must resend the same id with attempt 1"
  printf '%s\n' '{"outcome":"failed","error":"plain says no"}' > "$AGG_FM/play"
  id=$(post "$FMH" messages '{"topic":"solo","text":"失敗"}' | jq -r '.write_id')
  wait_for "the failure" write_is "$FMH" "$id" failed
  assert_equals "plain says no" "$(state_of "$FMH" --arg id "$id" '.writes[] | select(.id == $id) | .error')" "a failure must show the aggregator's error"
  assert_equals ok "$(post "$FMH" writes/resend "{\"write_id\":\"$id\"}" | jq -r 'if .ok then "ok" else .error end')" "a failed write must be resendable"
  wait_for "the resend" write_is "$FMH" "$id" delivered
  printf '%s\n' 'not an outcome' > "$AGG_FM/play"
  id=$(post "$FMH" messages '{"topic":"solo","text":"沒有結果"}' | jq -r '.write_id')
  wait_for "a missing outcome" write_is "$FMH" "$id" failed
  post "$FMH" writes/ignore "{\"write_id\":\"$id\"}" >/dev/null
  assert_equals ignored "$(write_state "$FMH" "$id")" "an ignored write must leave the count"
  printf '%s\n' '{"outcome":"handled_elsewhere"}' > "$AGG_FM/play"
  id=$(post "$FMH" messages '{"topic":"solo","text":"別處"}' | jq -r '.write_id')
  wait_for "handled elsewhere" write_is "$FMH" "$id" handled_elsewhere
  pass "retry, failure, a missing outcome, resend, ignore and handled-elsewhere show as they should (AT2.10)"
}

# A resent filing for a further home, right after a restart and with no page
# open, reconciles against that home: the board reads the root home first to
# learn it.
test_fm_resend_after_a_restart() {
  local id
  printf '%s\n' '{"outcome":"failed","error":"not now"}' > "$AGG_FM/play"
  id=$(post "$FMH" agents/tag '{"home":"sm1","task":"sm-loose","topic":"wrap"}' | jq -r '.write_id')
  wait_for "the filing to fail" write_is "$FMH" "$id" failed
  f restart >/dev/null
  tb_op "$FMH" test-resend "{\"write_id\":\"$id\"}" >/dev/null || fail "the resend was refused"
  wait_for "the resent filing" write_is "$FMH" "$id" delivered
  pass "a filing resent before any read reconciles against its home and is delivered"
}

# AT2.11: a crash while writes are under way.
test_fm_a_crash_mid_write() {
  local message direct_sm direct_far
  f stop >/dev/null
  sa_child_board "$FMH"
  refresh "$FMH"
  wait_for "the further homes to be known again" is 3 state_of "$FMH" '.homes | length'
  printf '%s\n' 'sleep 3 {"outcome":"delivered"}' 'sleep 3 {"outcome":"delivered"}' 'sleep 3 {"outcome":"delivered"}' > "$AGG_FM/play"
  : > "$AGG_FM/received.jsonl"
  message=$(post "$FMH" messages '{"topic":"solo","text":"途中"}' | jq -r '.write_id')
  direct_sm=$(post "$FMH" direct '{"home":"sm1","task":"sm-loose","text":"途中"}' | jq -r '.write_id')
  direct_far=$(post "$FMH" direct '{"home":"far1","task":"far-work","text":"途中"}' | jq -r '.write_id')
  wait_for "all three under way" is 3 received_count "$AGG_FM"
  sa_crash_child "$FMH"
  : > "$AGG_FM/play"
  sleep 3.5
  f open >/dev/null || fail "the next command must bring the board back"
  if signal_dry_run; then
    printf 'ok - skip: the crash checks need the crash the dry run does not send\n'
    return 0
  fi
  wait_for "the message to be resent" write_is "$FMH" "$message" delivered
  assert_equals 2 "$(received "$AGG_FM" --arg id "$message" '[.[] | select(.id == $id)] | length')" \
    "the message in flight must be handed over again under the same id"
  assert_equals "unknown unknown" "$(write_state "$FMH" "$direct_sm") $(write_state "$FMH" "$direct_far")" \
    "a direct message in flight to either further home must become uncertain alike"
  pass "after a crash the message in flight is resent with its id and direct messages become uncertain (AT2.11)"
}

# AT2.12: whole-page states.
test_fm_whole_page_states() {
  local state
  printf 'exit4 far1 is not on the fork\n' > "$AGG_FM/control/far1"
  refresh "$FMH"
  wait_for "far1 to stop reporting" is unreported state_of "$FMH" '.homes[] | select(.id == "far1") | .version'
  state=$(state_of "$FMH")
  assert_equals "far1 is not on the fork" "$(jq -r '.homes[] | select(.id == "far1") | .error' <<< "$state")" "exit 4's line must be far1's banner"
  assert_equals 0 "$(jq '[.agents[] | select(.home == "far1" and .finished == false)] | length' <<< "$state")" "far1's workers must be dropped"
  rm "$AGG_FM/control/far1"
  printf 'garbage\n' > "$AGG_FM/control/sm1"
  refresh "$FMH"
  wait_for "sm1 to report garbage" is "讀到的資料不是合法的 JSON" state_of "$FMH" '.homes[] | select(.id == "sm1") | .error'
  assert_equals 1 "$(state_of "$FMH" '[.agents[] | select(.home == "sm1" and .task == "sm-loose")] | length')" "garbage must keep the last report"
  printf 'schema2\n' > "$AGG_FM/control/sm1"
  refresh "$FMH"
  wait_for "sm1 to be incompatible" is incompatible state_of "$FMH" '.homes[] | select(.id == "sm1") | .version'
  printf 'sleep 30\n' > "$AGG_FM/control/sm1"
  sleep 5
  assert_equals true "$(state_of "$FMH" '.homes[] | select(.id == "sm1") | .stale')" "a home that stops answering must go stale"
  rm "$AGG_FM/control/sm1"
  assert_equals "home far1 的帳本未開，它的 task 不會有更新。在主 home 的終端機跑 bin/fm-on.sh far1 fm-board.sh setup" \
    "$(state_of "$FMH" '.homes[] | select(.id == "far1") | .ledger_hint')" "a ledger-off home must show exactly the fixture's hint"
  assert_equals null "$(state_of "$FMH" '.homes[] | select(.id == "main") | .ledger_hint')" "a home with no hint shows none"
  pass "exit 4, garbage, another schema, a silent feed and the ledger hint each show as they should (AT2.12)"
}

# AT2.13: refresh reads every home at once.
test_fm_refresh() {
  local before
  sleep 1
  before=$(feeds_of "$AGG_FM" far1)
  refresh "$FMH"
  sleep 1
  [ "$(feeds_of "$AGG_FM" far1)" -gt "$before" ] || fail "refresh must read far1, although its cadence is 60 s"
  pass "立刻更新 reads every home at once (AT2.13)"
}

# AT2.14: summaries and lookups through the feed.
test_fm_summaries() {
  assert_equals "建置：" "$(printf '建好了。\n' | f summary t1 ready -)" "summary must name t1's topic"
  assert_equals "建置：" "$(f which t1)" "which must name the same topic"
  assert_equals 1 "$(state_of "$FMH" '[.summaries[] | select(.task == "t1" and .topic == "solo")] | length')" "the summary must be under solo"
  assert_equals "https://example.invalid/pr/7" "$(state_of "$FMH" '.summaries[] | select(.task == "t1") | .pr')" "the summary must carry the fixture's PR link"
  printf 'sm 好了。\n' | f summary --home sm1 sm-loose ready - >/dev/null || fail "--home sm1 must be accepted"
  expect_code 1 "$(printf 'x\n' | sa_code "$FMH" summary --home nope t1 ready -)" "--home of an unknown home"
  assert_contains "$(f find t1)" "建置" "find t1 must list its topic"
  printf '寫錯了\n' | f retract t1 ready - >/dev/null || fail "retract failed"
  printf 'fail no\n' > "$AGG_FM/control/main"
  assert_equals "議題不明（t9）：" "$(printf '沒有標記。\n' | f summary t9 ready -)" "with the feed failing, an untagged task's topic is unknown"
  rm "$AGG_FM/control/main"
  pass "summary, which, find and retract work through the feed, with --home and the fallback (AT2.14)"
}

# --- AT6: stub-plain, written only from the contract --------------------------

test_plain_setup() {
  cat > "$AGG_PLAIN/plain/main.json" <<'JSON'
{
  "tasks": [
    { "id": "j1", "kind": "job", "state": "working" },
    { "id": "j2", "kind": "job", "state": "running" },
    { "id": "j3", "kind": "job", "state": "waiting-review" }
  ],
  "queued": [ { "id": "j9", "title": "下一個", "topic_hint": "solo" } ],
  "holds": [
    { "id": "h-live", "title": "選一個", "question": "用哪個？\n選項：A | B", "hold_bucket": "live" },
    { "id": "h-text", "title": "說說看", "question": "要怎麼做？", "hold_bucket": "live" },
    { "id": "h-dated", "title": "之後", "question": "下週再說", "hold_bucket": "dated", "hold_until": "2026-12-01" },
    { "id": "h-none", "title": "沒有桶", "question": "沒寫 bucket" }
  ],
  "status_decisions": [ { "id": "j2", "key": "k", "summary": "j2 asks the agent" } ],
  "topics": { "j1": "solo 2026-11-18T10:00:00Z", "h-live": "solo 2026-11-18T10:00:00Z" },
  "secondmates": [ { "id": "w2", "read_every_s": 2 } ]
}
JSON
  cat > "$AGG_PLAIN/plain/w2.json" <<'JSON'
{ "code_commit": "plain-0.1", "tasks": [ { "id": "w2-job", "kind": "job", "state": "working" } ],
  "holds": [ { "id": "w2-call", "title": "w2", "question": "好嗎？\n選項：好 | 不好" } ] }
JSON
  p open >/dev/null || fail "the plain board did not start"
  sa_confirm "$PH"
  p create "建置" --goal "把 x 建起來" --id solo >/dev/null
  p create "H1" --goal "g" --id H1 --queue high >/dev/null
  p create "H2" --goal "g" --id H2 --queue high >/dev/null
  p create "A" --goal "g" --id A >/dev/null
  p create "B" --goal "g" --id B >/dev/null
  p create "L" --goal "g" --id L --queue later >/dev/null
  refresh "$PH"
  wait_for "plain's work to reach the page" is 1 state_of "$PH" '[.agents[] | select(.task == "j1")] | length'
  pass "the board reads an aggregator written only from the contract"
}

# AT6.1
test_plain_work() {
  local state
  state=$(state_of "$PH")
  assert_equals "j1=working:working j2=unknown:running j3=unknown:waiting-review" \
    "$(jq -r '[.agents[] | select(.home == "main") | "\(.task)=\(.light):\(.state)"] | sort | join(" ")' <<< "$state")" \
    "lights and raw state words must follow the contract"
  assert_equals "j1" "$(jq -r '[.agents[] | select(.topic == "solo") | .task] | join(" ")' <<< "$state")" "j1 must be under solo"
  assert_equals "h-dated:false h-live:true h-none:true h-text:true" \
    "$(jq -r '[.holds[] | select(.home == "main") | "\(.task):\(.live)"] | sort | join(" ")' <<< "$state")" \
    "the bucketless hold must be live and the dated one deferred"
  assert_equals "A,B" "$(jq -r '.holds[] | select(.task == "h-live") | .options | join(",")' <<< "$state")" "options only where the line is"
  assert_equals "" "$(jq -r '.holds[] | select(.task == "h-text") | .options | join(",")' <<< "$state")" "no options without the line"
  assert_equals "j9|solo|null" "$(jq -r '.queued[] | select(.task == "j9") | "\(.task)|\(.topic)|\(.waiting)"' <<< "$state")" "the queued item must be under its hinted topic"
  assert_equals "j2 asks the agent" "$(jq -r '.questions[] | select(.task == "j2") | .summary' <<< "$state")" "the worker question must show"
  pass "plain's work shows as the contract promises (AT6.1)"
}

# AT6.2 and AT6.3: an absent ledger, then one of plain's own.
test_plain_ledger() {
  awk '$1 == "feed" && $2 == "main" { print $3 " " $4 }' "$AGG_PLAIN/calls.log" | sort -u | grep -vq '^0 -$' &&
    fail "with the ledger absent every feed call must carry 0 -"
  assert_equals 0 "$(grep -c '"src":"ledger"' "$PH/data/myshape/events.jsonl" || true)" "nothing may be stored as ledger events"
  assert_equals 0 "$(state_of "$PH" '[.homes[] | select(.ledger_hint != null)] | length')" "no ledger banner without a hint"
  printf '%s\n' '{"ts":1795000000,"event":"job.started","task":"j1"}' \
    '{"ts":1795000001,"event":"task.status","task":"j1","state":"running","text":"compiling"}' > "$AGG_PLAIN/plain/main.events"
  refresh "$PH"
  wait_for "plain's events" grep -q "^feed main 2 $(printf 'plain-2' | sha256sum | cut -d' ' -f1) " "$AGG_PLAIN/calls.log"
  refresh "$PH"
  sleep 1
  assert_equals 2 "$(grep -c '"src":"ledger"' "$PH/data/myshape/events.jsonl")" "each line must be stored once"
  assert_equals "job.started|" "$(state_of "$PH" '.updates[] | select(.event == "job.started") | "\(.event)|\(.text)"')" "an unknown event shows by its name"
  assert_equals "running：compiling" "$(state_of "$PH" '.updates[] | select(.event == "task.status") | .text')" "a status event reads state：text"
  pass "an absent ledger is fine, and plain's own cursor is handed back unchanged (AT6.2, AT6.3)"
}

# AT6.4: a second home of plain's.
test_plain_second_home() {
  local code
  wait_for "w2 to be read" at_least 1 feeds_of "$AGG_PLAIN" w2
  : > "$AGG_PLAIN/received.jsonl"
  two_step "$PH" holds/answer '{"home":"w2","task":"w2-call","answer":"好","label":"好"}' >/dev/null
  post "$PH" agents/tag '{"home":"w2","task":"w2-job","topic":"solo"}' >/dev/null
  post "$PH" direct '{"home":"w2","task":"w2-job","text":"你好"}' >/dev/null
  wait_for "three w2 actions" is 3 received_count "$AGG_PLAIN"
  assert_equals "w2 w2 w2" "$(received "$AGG_PLAIN" 'map(.home) | join(" ")')" "every action about w2 must name home w2"
  assert_equals "release" "$(received "$AGG_PLAIN" '.[] | select(.kind == "answer") | .mode')" "an unrecorded hold must send release"
  code=0
  printf 'w2 好了。\n' | p summary --home w2 w2-job ready - >/dev/null || code=$?
  assert_equals 0 "$code" "summary --home w2 must be accepted"
  pass "plain's second home is read and written as itself (AT6.4)"
}

# AT6.5: neutral banners for another aggregator.
test_plain_banners() {
  local state
  printf 'exit4 w2 is offline for maintenance\n' > "$AGG_PLAIN/control/w2"
  refresh "$PH"
  wait_for "w2's banner" is unreported state_of "$PH" '.homes[] | select(.id == "w2") | .version'
  assert_equals "w2 is offline for maintenance" "$(state_of "$PH" '.homes[] | select(.id == "w2") | .error')" "exit 4's line must be the banner"
  rm "$AGG_PLAIN/control/w2"
  jq '.code_commit = "plain-0.2"' "$AGG_PLAIN/plain/w2.json" > "$AGG_PLAIN/plain/w2.tmp" && mv "$AGG_PLAIN/plain/w2.tmp" "$AGG_PLAIN/plain/w2.json"
  refresh "$PH"
  wait_for "w2's version" is different state_of "$PH" '.homes[] | select(.id == "w2") | .version'
  state=$(state_of "$PH")
  assert_equals "null" "$(jq -r '.aggregator.update_hint' <<< "$state")" "plain gives no update advice"
  pass "another aggregator's banners carry only its own line and the board's neutral words (AT6.5)"
}

# --- AT7: the agent is held to the captain's units ----------------------------

# AT7.1: work only under a topic or unsorted, and the feed never makes a topic.
test_plain_work_only_under_topics() {
  local before state i
  jq '.tasks += [{"id": "j-unknown", "kind": "job", "state": "working"}, {"id": "j-none", "kind": "job", "state": "working"}]
      | .topics["j-unknown"] = "nope 2026-11-18T10:00:00Z"
      | .queued += [{"id": "q-unknown", "title": "?", "topic_hint": "nope"}]' "$AGG_PLAIN/plain/main.json" > "$AGG_PLAIN/plain/main.tmp"
  mv "$AGG_PLAIN/plain/main.tmp" "$AGG_PLAIN/plain/main.json"
  before=$(sha256sum < "$PH/data/topics.json")
  for i in 1 2 3 4 5 6 7 8 9 10; do
    refresh "$PH"
  done
  state=$(state_of "$PH")
  assert_equals "null|unknown-topic" "$(jq -r '.agents[] | select(.task == "j-unknown") | "\(.topic)|\(.unsorted_reason)"' <<< "$state")" \
    "a task tagged with an unknown id must be unsorted"
  assert_equals "null|no-tag" "$(jq -r '.agents[] | select(.task == "j-none") | "\(.topic)|\(.unsorted_reason)"' <<< "$state")" "an untagged task must be unsorted"
  assert_equals null "$(jq -r '.queued[] | select(.task == "q-unknown") | .topic' <<< "$state")" "a queued item with an unknown hint must be unsorted"
  assert_equals false "$(jq -r '.topics | has("nope")' <<< "$state")" "no topic may appear from the feed"
  assert_equals "$before" "$(sha256sum < "$PH/data/topics.json")" "ten feed cycles must leave topics.json byte-identical"
  pass "work reaches the page only under the captain's topics or unsorted, and the feed makes no topic (AT7.1)"
}

# AT7.2 and AT7.3: topics only through create, at the end; the order readable.
test_plain_topics_and_order() {
  local queues
  p create X --goal g --id X --queue high >/dev/null
  p create Y --goal g --id Y >/dev/null
  expect_code 2 "$(sa_code "$PH" create Z --goal g --first)" "create --first"
  assert_equals "H1 H2 X" "$(p list --json | jq -r '[.[] | select(.queue == "high")] | sort_by(.position) | map(.id) | join(" ")')" "X must go last in 高"
  assert_contains "$(p find X)" "X" "find must know X"
  assert_contains "$(grep '"kind":"topic.created"' "$PH/data/myshape/events.jsonl" | grep '"topic":"X"')" "最後" "the created record must say where X went"
  post "$PH" topics/move '{"id":"Y","queue":"high","before":"H1"}' >/dev/null
  post "$PH" topics/move '{"id":"A","queue":"later"}' >/dev/null
  queues=$(state_of "$PH" '.queues | [.high, .normal, .later] | map(join(",")) | join(" ")')
  assert_equals "$queues" "$(p list --json | jq -r '[("high", "normal", "later") as $q | [.[] | select(.queue == $q)] | sort_by(.position) | map(.id) | join(",")] | join(" ")')" \
    "list --json must give the page's order"
  pass "an agent's topic goes last in its queue, and the captain's order is readable by the agent (AT7.2, AT7.3)"
}

# AT7.4 and AT7.5a: decisions and the captain's presses are the page's alone.
test_plain_the_captains_channel() {
  local op before
  for op in answer holds-answer answers; do
    tb_op "$PH" "$op" '{"home":"main","task":"h-live","answer":"A"}' >/dev/null 2>&1 && fail "the socket must not know $op"
  done
  expect_code 2 "$(sa_code "$PH" answers)" "myshape.sh answers"
  p close-propose B --reason "done?" >/dev/null
  before=$(sha256sum < "$PH/data/topics.json")
  tb_op "$PH" keep '{"id":"B"}' >/dev/null 2>&1 && fail "the socket must refuse keep"
  tb_op "$PH" todo-claim '{"task":"h-live"}' >/dev/null 2>&1 && fail "the socket must refuse todo-claim"
  assert_equals "$before" "$(sha256sum < "$PH/data/topics.json")" "a refused press must change nothing"
  assert_equals true "$(post "$PH" topics/keep '{"id":"B"}' | jq -r '.ok')" "the same press on the page must work"
  pass "answers, 先不關 and 做完了 can only come from the page (AT7.4, AT7.5a)"
}

# AT7.5b: hands-on items stay in the captain's units.
test_plain_hands_on() {
  local before
  before=$(cat "$PH/data/myshape/todos.json" 2>/dev/null || printf 'no file')
  expect_code 1 "$(sa_code "$PH" todo add stray x --topic nope --do x)" "todo add under an unknown topic"
  assert_equals "$before" "$(cat "$PH/data/myshape/todos.json" 2>/dev/null || printf 'no file')" "a refused todo add must store nothing"
  p todo add a-item 甲 --topic A --do "做甲" >/dev/null || fail "todo add failed"
  p todo add b-item 乙 --topic B --do "做乙" >/dev/null
  p todo add c-item 丙 --topic A --do "做丙" >/dev/null
  p todo add d-item 丁 --topic A --do "做丁" --captain-closes --ref legacy >/dev/null
  assert_equals "a-item:A b-item:B c-item:A d-item:A" "$(state_of "$PH" '[.todos[] | "\(.task):\(.topic)"] | sort | join(" ")')" \
    "each item must show only under its topic"
  for op in todo-drop todo-takedown todo-claim; do
    tb_op "$PH" "$op" '{"task":"a-item"}' >/dev/null 2>&1 && fail "the socket must refuse $op"
  done
  assert_equals '"open"' "$(jq -c '.items["a-item"].state' "$PH/data/myshape/todos.json")" "a refused press must change nothing"
  p todo 'done' a-item >/dev/null
  two_step "$PH" todos/drop '{"task":"b-item"}' >/dev/null
  p todo obsolete c-item --reason "用不到" >/dev/null
  p todo obsolete d-item --reason "舊的" >/dev/null
  two_step "$PH" todos/takedown '{"task":"d-item"}' >/dev/null
  assert_equals "[]" "$(state_of "$PH" '[.todos[].task]')" "every item must have left the page"
  assert_equals "todo.opened|aggregator|plain|-|-|null todo.done|aggregator|plain|done|-|null" "$(records_of "$PH" a-item)" "done is the agent's"
  assert_equals "todo.opened|aggregator|plain|-|-|null todo.dropped|captain|plain|dropped|-|null" "$(records_of "$PH" b-item)" "不做了 is the captain's"
  assert_equals "todo.opened|aggregator|plain|-|-|null todo.taken_down|aggregator|plain|taken_down|用不到|null" "$(records_of "$PH" c-item)" \
    "a takedown by the agent carries its reason"
  assert_equals "todo.opened|aggregator|plain|-|-|null todo.obsolete|aggregator|plain|-|舊的|null todo.taken_down|captain|plain|taken_down|-|null" \
    "$(records_of "$PH" d-item)" "an item only the captain closes is taken down by the captain"
  assert_equals "A B A A A B A A A" "$(jq -r -s '[.[] | select(.src == "board" and (.item // "") != "") | .topic] | join(" ")' "$PH/data/myshape/events.jsonl")" \
    "every record must be on the item's topic"
  pass "hands-on items stay under the captain's topics, the captain's presses are the page's, and every step leaves a record (AT7.5b)"
}

# AT7.6: command-made changes are marked as the agent's.
test_plain_changes_are_marked() {
  local events
  p move H2 normal --first >/dev/null
  p rename H2 "H2b" >/dev/null
  p goal H2 "new goal" >/dev/null
  p archive L >/dev/null
  p reopen L --queue later >/dev/null
  p merge Y X --reason r >/dev/null
  p split X "X2" --goal g --id X2 >/dev/null
  p close-propose X2 --reason r >/dev/null
  events=$(grep '"src":"board"' "$PH/data/myshape/events.jsonl")
  for kind in topic.moved topic.renamed topic.goal_changed topic.archived topic.reopened topic.merged topic.split topic.close_proposed; do
    printf '%s\n' "$events" | grep "\"kind\":\"$kind\"" | tail -n 1 | grep -q '（plain 用指令）' ||
      fail "a command-made $kind must be marked plain 用指令: $(printf '%s\n' "$events" | grep "\"kind\":\"$kind\"" | tail -n 1)"
  done
  post "$PH" topics/rename '{"id":"H2","value":"H2c"}' >/dev/null
  grep '"kind":"topic.renamed"' "$PH/data/myshape/events.jsonl" | tail -n 1 | grep -q '（你在頁面上）' ||
    fail "a page-made rename must be marked 你在頁面上"
  assert_contains "$(p find --all H2)" "移到「一般」第 1（用指令）" "find --all must list the move"
  assert_contains "$(p find --all H2)" "目標改為「new goal」（用指令）" "find --all must list the goal change"
  pass "every command-made change to the captain's topics is marked as the agent's (AT7.6)"
}

# AT6.6: no text the board emits names Firstmate.
test_plain_texts_name_no_firstmate() {
  local texts
  texts=$(state_of "$PH"; cat "$AGG_PLAIN/received.jsonl" "$PH/data/myshape/events.jsonl")
  assert_not_contains "$texts" "first mate" "the board's texts must not say first mate"
  assert_not_contains "$texts" "firstmate" "the board's texts must not say firstmate"
  assert_equals plain "$(state_of "$PH" '.aggregator.label')" "the page must use plain's label"
  pass "nothing the board shows, sends or stores names Firstmate (AT6.6)"
}

# --- AT9: the binding and the safety rule -----------------------------------
# A second board-only root, R9, holds a committed copy of stub-plain in its
# bin/ (the one kind of program that needs no confirmation); another copy
# sits outside it in $AGG_B/bin. Both keep their data in $AGG_B.

R9=$TMP_ROOT/root9/board
AGG_B=$TMP_ROOT/agg-bind
OUTSIDE=$AGG_B/bin/stub-plain

r9() {  # <myshape.sh arguments...>: the AT9 home's board, from R9
  local SA_ROOT=$R9
  sa "$BH" "$@"
}

bind_to() {  # <program> [<name>]: the AT9 home's binding names <program>
  sa_bind "$BH" "$@"
}

agg_b() {  # [jq arguments...] <jq filter>: the AT9 home's aggregator block
  state_of "$BH" "${@:1:$#-1}" ".aggregator | ${*: -1}"
}

calls_b() {
  wc -l < "$AGG_B/calls.log" | tr -d ' '
}

message_b() {  # <text>: a page message on the AT9 topic; prints its write id
  post "$BH" messages "$(jq -cn --arg text "$1" '{topic: "bind", text: $text}')" | jq -r '.write_id'
}

received_b() {  # <write-id>: how many times the AT9 stub received it
  jq -s --arg id "$1" '[.[] | select(.id == $id)] | length' "$AGG_B/received.jsonl"
}

test_bind_setup() {
  tb_make_board_root "$R9" >/dev/null
  [ "${TB_STAGE7_TRIPWIRES:-0}" != 1 ] || sa_trip_root "$R9"
  sa_install_stub plain "$AGG_B" >/dev/null
  sa_stub_files plain "$R9/bin" "$AGG_B"
  tb_commit_root "$R9" "a tracked aggregator" >/dev/null
  printf '%s\n' '{"tasks":[{"id":"b1","kind":"job","state":"working"}],"topics":{"b1":"bind 2026-11-18T10:00:00Z"}}' \
    > "$AGG_B/plain/main.json"
  BH=$(sa_home bind)
  r9 open >/dev/null || fail "the AT9 board did not start"
  r9 create "綁定" --goal "接上 aggregator" --id bind >/dev/null
  assert_equals "false|沒有 config/myshape-aggregator.json" "$(agg_b '"\(.connected)|\(.unavailable)"')" \
    "a home with no binding must show only that nothing is connected"
  pass "an unbound board reaches no aggregator"
}

# AT9.5 (first half): a program git tracks unchanged under the code root's bin/
# runs without a confirmation, even when its group may write it.
test_bind_a_tracked_program_needs_no_confirmation() {
  local id
  bind_to bin/stub-plain plain
  chmod 775 "$R9/bin/stub-plain"
  [ -z "$(git -C "$R9" status --porcelain)" ] || fail "a group bit must not count as a change to git"
  r9 open >/dev/null
  assert_equals "true|0" "$(agg_b '"\(.connected)|\(.confirm | length)"')" \
    "a tracked, unchanged program under bin/ must run with nothing to confirm"
  id=$(message_b "直接送")
  wait_for "the message to the tracked program" write_is "$BH" "$id" delivered
  assert_equals 1 "$(received_b "$id")" "the message must be received once"
  assert_contains "$(r9 status)" "程式目錄：$R9" "status must show the code root the command derived"
  pass "a tracked program under bin/ runs without a confirmation, group-writable or not (AT9.5, AT4.6)"
}

# r9_over <override> <myshape.sh arguments...>: r9 with MYSHAPE_ROOT_OVERRIDE
# set in the starter's environment; R9_FROM, when set, is the root the command
# is run from instead of R9, and R9_OVERRIDE_NAME the name set instead.
r9_over() {
  local SA_ROOT=${R9_FROM:-$R9} override=$1 rc=0
  shift
  SA_ENV=("${BASE_ENV[@]}" "${R9_OVERRIDE_NAME:-MYSHAPE_ROOT_OVERRIDE}=$override")
  sa "$BH" "$@" || rc=$?
  SA_ENV=("${BASE_ENV[@]}")
  return "$rc"
}

# security's override tightening: a tracked program needs no confirmation
# only while the override's physical path is the command's own location's;
# any other override, one that cannot be entered included, keeps no such case.
# The name the command read before, FM_ROOT_OVERRIDE, is refused when it names
# another place and is not used when it names the same one.
test_bind_an_override_keeps_the_exemption_only_for_the_own_location() {
  local own other=$TMP_ROOT/root9-other/board link=$TMP_ROOT/root9-link rc=0 out
  own=$(cd "$R9" && pwd -P)
  chmod 755 "$R9/bin/stub-plain"
  r9_over "$R9" restart >/dev/null
  assert_equals "true|0" "$(agg_b '"\(.connected)|\(.confirm | length)"')" \
    "an override naming the command's own location must keep the tracked program exempt"
  assert_contains "$(r9_over "$R9" status)" "程式目錄：$own" "the code root must be the compared own location"
  ln -s "$TMP_ROOT/root9" "$link"
  r9_over "$link/board" restart >/dev/null
  assert_equals "true|0" "$(agg_b '"\(.connected)|\(.confirm | length)"')" \
    "an override reaching the own location through a symlinked directory must keep the exemption"
  R9_FROM=$link/board r9_over "$R9" restart >/dev/null
  assert_equals "true|0" "$(agg_b '"\(.connected)|\(.confirm | length)"')" \
    "a command run through a symlinked directory with the override naming the same place must keep the exemption"
  mkdir -p "$(dirname "$other")"
  git clone -q "$R9" "$other"
  chmod 755 "$other/bin/stub-plain"
  [ -z "$(git -C "$other" status --porcelain)" ] || fail "the other checkout must equal its commit"
  r9_over "$other" restart >/dev/null
  assert_equals "false|1|$other/bin/stub-plain" "$(agg_b '"\(.connected)|\(.confirm | length)|\(.confirm[0].path)"')" \
    "with an override naming another checkout, its tracked program must wait for a confirmation"
  assert_contains "$(r9_over "$other" status)" "程式目錄：$other" "the code root must be the override"
  r9_over "$TMP_ROOT/no-such-root" restart >/dev/null 2>&1 || rc=$?
  assert_equals 69 "$rc" "an override that cannot be entered must start no board"
  out=$(r9_over "$TMP_ROOT/no-such-root" status 2>&1) || true
  assert_contains "$out" "編譯結果不見了" "the refusal must say the board's build is not under that root"
  rc=0
  out=$(R9_OVERRIDE_NAME=FM_ROOT_OVERRIDE r9_over "$own" restart 2>&1) || rc=$?
  assert_equals 0 "$rc" "the old override name naming the command's own location must not be refused: $out"
  assert_equals "true|0" "$(agg_b '"\(.connected)|\(.confirm | length)"')" \
    "the old override name must not be used: the board runs from the command's own root"
  rc=0
  out=$(R9_OVERRIDE_NAME=FM_ROOT_OVERRIDE r9_over "$other" restart 2>&1) || rc=$?
  assert_equals 2 "$rc" "the old override name naming another checkout must be refused"
  assert_contains "$out" "不讀 FM_ROOT_OVERRIDE 了：它指的 $other 和這次用的" "the refusal must name the old name and where it points"
  assert_contains "$out" "要指定請改設 MYSHAPE_ROOT_OVERRIDE" "the refusal must name the board's own name"
  assert_equals "true|0" "$(agg_b '"\(.connected)|\(.confirm | length)"')" "a refused command must leave the running board alone"
  chmod 775 "$R9/bin/stub-plain"
  r9 restart >/dev/null
  assert_equals "true|0" "$(agg_b '"\(.connected)|\(.confirm | length)"')" \
    "without the override the tracked program must run with nothing to confirm again"
  pass "an override keeps the no-confirmation case only when its physical path is the command's own location"
}

# AT9.1: the binding holds paths only; the board adds feed and deliver itself.
test_bind_paths_only() {
  local before id case_json reason
  before=$(calls_b)
  for case_json in \
    '{"v":1,"name":"plain","feed":["bin/stub-plain","feed"],"deliver":"bin/stub-plain"}|不能是陣列' \
    '{"v":1,"name":"plain","feed":"bin/stub-plain","deliver":"bin/stub-plain deliver"}|不能帶參數' \
    '{"v":1,"name":"plain","feed":"bin/stub-plain","deliver":"bin/stub-plain","root":"/elsewhere"}|多了 root'; do
    reason=${case_json#*|}
    printf '%s\n' "${case_json%%|*}" > "$BH/config/myshape-aggregator.json"
    id=$(message_b "不該送出")
    wait_for "the write to wait" write_is "$BH" "$id" waiting
    assert_contains "$(agg_b '.unavailable')" "$reason" "a binding that is not paths only must be refused, saying why"
  done
  assert_equals "$before" "$(calls_b)" "a refused binding must run nothing"
  assert_equals "" "$(awk '$1 != "feed" && $1 != "deliver"' "$AGG_B/calls.log")" \
    "every run must have feed or deliver as its first argument"
  # The same bytes the running board started with: no command replaces it,
  # and the next read of the root home hands the waiting writes over.
  bind_to bin/stub-plain plain
  refresh "$BH"
  wait_for "the waiting writes to go once the binding is right" is 0 state_of "$BH" '[.writes[] | select(.state == "waiting")] | length'
  pass "a binding with arrays, arguments or other keys is refused, runs nothing, and writes wait (AT9.1)"
}

# AT9.2: a confirmation holds for the SHA-256 of the program and of the binding,
# checked before every run.
test_bind_a_confirmation_is_bound_to_the_bytes() {
  local id size
  bind_to "$OUTSIDE" plain
  r9 open >/dev/null
  assert_equals "false|$OUTSIDE" "$(agg_b '"\(.connected)|\(.confirm[0].path)"')" \
    "a program outside the root must wait for a confirmation that shows its full path"
  id=$(message_b "確認之後")
  wait_for "the write to wait for the confirmation" write_is "$BH" "$id" waiting
  sa_confirm "$BH"
  wait_for "the confirmation to release the write" write_is "$BH" "$id" delivered
  assert_equals 1 "$(received_b "$id")" "the released write must be received once"
  cp -p "$OUTSIDE" "$TMP_ROOT/stub-ref"
  size=$(wc -c < "$OUTSIDE")
  sed -i 's/written only from/written ONLY from/' "$OUTSIDE"
  touch -r "$TMP_ROOT/stub-ref" "$OUTSIDE"
  assert_equals "$size" "$(wc -c < "$OUTSIDE")" "the changed program must keep its size"
  id=$(message_b "改了一個字")
  wait_for "a changed program to stop the write" write_is "$BH" "$id" waiting
  assert_equals 0 "$(received_b "$id")" "a program whose bytes changed must not run"
  assert_equals 1 "$(agg_b '.confirm | length')" "the page must ask again"
  sa_confirm "$BH"
  wait_for "the write after the new confirmation" write_is "$BH" "$id" delivered
  assert_equals 1 "$(received_b "$id")" "the write must be received once after the new confirmation"
  bind_to "$OUTSIDE" plain2
  id=$(message_b "設定改了")
  wait_for "a changed binding to stop the write" write_is "$BH" "$id" waiting
  assert_equals 1 "$(agg_b '.confirm | length')" "a changed binding must ask again"
  sa_confirm "$BH"
  wait_for "the write after the binding's confirmation" write_is "$BH" "$id" delivered
  pass "a confirmation holds only for the bytes it saw, of the program and of the binding (AT9.2)"
}

# AT9.3: every program gets the fixed environment, whatever the starter had.
# The canaries are ones the board's own command does not read (it honors
# MYSHAPE_HOME and MYSHAPE_*_OVERRIDE for its paths, so one of those would move
# the board rather than test what reaches the program): FM_HOME,
# FM_DATA_OVERRIDE, FM_SSH_BIN and TMUX are what firstmate's adapter would
# read, SSH_AUTH_SOCK the agent. FM_HOME rides with sa's MYSHAPE_HOME, so the
# command does not refuse it.
test_bind_a_fixed_environment() {
  local names expected id
  : > "$AGG_B/env-probe"
  expected=$(printf '%s\n' HOME LANG MYSHAPE_HOME PATH TMPDIR)
  SA_ENV=("${BASE_ENV[@]}" TB_CANARY=leak FM_SSH_BIN=/decoy SSH_AUTH_SOCK=/decoy TMUX=/decoy FM_HOME=/decoy FM_DATA_OVERRIDE=/decoy)
  SA_CMD_PATH="$SA_PATH::." r9 restart >/dev/null
  SA_ENV=("${BASE_ENV[@]}")
  for program in confirmed exempt; do
    rm -f "$AGG_B/env.main" "$AGG_B/env.deliver"
    refresh "$BH"
    id=$(message_b "環境 $program")
    wait_for "the $program program's environment" write_is "$BH" "$id" delivered
    for probe in main deliver; do
      names=$(grep -v -x -E 'PWD|SHLVL|_|OLDPWD' "$AGG_B/env.$probe")
      assert_equals "$expected" "$names" "the $program program's $probe run must get exactly the fixed names"
      assert_equals "$SA_PATH" "$(cat "$AGG_B/path.$probe")" "PATH must reach the $program program without empty or relative entries"
    done
    [ "$program" = exempt ] && break
    bind_to bin/stub-plain plain
    SA_ENV=("${BASE_ENV[@]}" TB_CANARY=leak FM_SSH_BIN=/decoy SSH_AUTH_SOCK=/decoy TMUX=/decoy FM_HOME=/decoy FM_DATA_OVERRIDE=/decoy)
    SA_CMD_PATH="$SA_PATH::." r9 open >/dev/null
    SA_ENV=("${BASE_ENV[@]}")
  done
  rm -f "$AGG_B/env-probe"
  pass "a confirmed and a tracked program both get only MYSHAPE_HOME, PATH, HOME, LANG and TMPDIR (AT9.3)"
}

# AT9.4: the confirmation is written only by the page.
test_bind_only_the_page_confirms() {
  local before out rc=0
  bind_to "$OUTSIDE" plain
  r9 open >/dev/null
  sa_confirm "$BH"
  assert_present "$BH/data/myshape/confirmations.json" "the confirmation must be kept in the board's data"
  assert_equals "" "$(find "$BH/config" -mindepth 1 -maxdepth 1 ! -name myshape-port ! -name myshape-aggregator.json)" \
    "the confirmation must not be written into config/"
  before=$(cat "$BH/data/myshape/confirmations.json")
  out=$(tb_op "$BH" program-confirm "$(jq -cn --arg path "$OUTSIDE" '{path: $path, sha256: ("0" * 64), binding_sha256: ("0" * 64)}')" 2>&1) || rc=$?
  assert_equals 1 "$rc" "the socket must refuse a confirmation"
  assert_contains "$out" "是使用者在頁面上按的，不能從指令送" "the refusal must say only the page confirms"
  rc=0
  r9 program-confirm >/dev/null 2>&1 || rc=$?
  assert_equals 2 "$rc" "the board's command must have no confirmation subcommand"
  assert_equals "$before" "$(cat "$BH/data/myshape/confirmations.json")" "nothing but the page may change the confirmation"
  mv "$BH/data/myshape/confirmations.json" "$TMP_ROOT/confirmations.json.moved"
  r9 restart >/dev/null
  assert_equals "false|1" "$(agg_b '"\(.connected)|\(.confirm | length)"')" "without the record the page must ask again"
  sa_confirm "$BH"
  pass "only the page's confirm writes the confirmation, into data/myshape/ (AT9.4)"
}

# AT9.5 (second half): everything else waits for a confirmation, or is refused.
test_bind_what_needs_a_confirmation() {
  local program reason home_copy file
  cp "$R9/bin/stub-plain" "$R9/bin/stub-untracked"
  chmod 755 "$R9/bin/stub-untracked"
  # Staged with git add but not committed: not equal to HEAD.
  cp "$R9/bin/stub-plain" "$R9/bin/stub-staged"
  chmod 755 "$R9/bin/stub-staged"
  git -C "$R9" add bin/stub-staged
  mkdir -p "$BH/state/agg"
  sa_stub_files plain "$BH/state/agg" "$AGG_B"
  # A program outside the root waits too: AT9.2.
  for program in bin/stub-untracked bin/stub-staged "$BH/state/agg/stub-plain"; do
    bind_to "$program" plain
    r9 open >/dev/null
    assert_equals 1 "$(agg_b '.confirm | length')" "$program must wait for a confirmation"
  done
  printf '# changed\n' >> "$R9/bin/stub-plain"
  bind_to bin/stub-plain plain
  r9 open >/dev/null
  assert_contains "$(agg_b '.unavailable')" "群組也能寫（權限 0775）" \
    "a tracked program changed before the start is not exempt, and its group bit is refused"
  chmod 755 "$R9/bin/stub-plain"
  r9 open >/dev/null
  assert_equals "1|$R9/bin/stub-plain" "$(agg_b '"\(.confirm | length)|\(.confirm[0].path)"')" \
    "a tracked program changed before the start must wait for a confirmation"
  git -C "$R9" checkout -q -- bin/stub-plain
  git -C "$R9" rm -q --cached bin/stub-staged
  ln -s "$OUTSIDE" "$TMP_ROOT/stub-link"
  cp "$OUTSIDE" "$TMP_ROOT/stub-plain-text" && chmod 644 "$TMP_ROOT/stub-plain-text"
  for program in "$TMP_ROOT/stub-link|是符號連結" "$TMP_ROOT/nothing-here|找不到" "$TMP_ROOT/stub-plain-text|不能執行（權限 0644）"; do
    reason=${program#*|}
    bind_to "${program%%|*}" plain
    r9 open >/dev/null
    assert_contains "$(agg_b '.unavailable')" "$reason" "${program%%|*} must be refused, saying why"
    assert_equals 0 "$(agg_b '.confirm | length')" "${program%%|*} must not be offered for confirmation"
  done
  # Confirmed in AT9.4 under this same binding.
  bind_to "$OUTSIDE" plain
  r9 open >/dev/null
  assert_equals true "$(agg_b '.connected')" "the outside program must be the confirmed one"
  chmod 775 "$OUTSIDE"
  assert_equals "false|$OUTSIDE 的群組也能寫（權限 0775）；需要確認的程式不能讓群組寫，確認了也不執行。要用它，只改這一個檔：chmod g-w $OUTSIDE" \
    "$(agg_b '"\(.connected)|\(.unavailable)"')" "a confirmed program its group may write must be refused, naming the file and its mode"
  assert_contains "$(post "$BH" programs/confirm '{"role":"deliver"}' | jq -r '.message')" "權限 0775" \
    "a group-writable program must not be offered for confirmation"
  chmod 755 "$OUTSIDE"
  # Decoy code roots: in the home, and named by files under its config/, data/
  # and state/; none of them may be where a relative path resolves.
  for home_copy in "$BH" "$BH/config/decoy-root" "$BH/data/decoy-root" "$BH/state/decoy-root"; do
    mkdir -p "$home_copy/bin"
    printf '#!/bin/sh\ntouch %s/home-copy-ran\nexit 1\n' "$BH" > "$home_copy/bin/stub-plain"
    chmod 755 "$home_copy/bin/stub-plain"
  done
  for file in config/myshape-root data/myshape/root state/myshape/root; do
    printf '%s\n' "$BH/${file%%/*}/decoy-root" > "$BH/$file"
  done
  bind_to bin/stub-plain plain
  r9 open >/dev/null
  refresh "$BH"
  wait_for "the root's program to run" is true agg_b '.connected'
  assert_absent "$BH/home-copy-ran" "a relative path must resolve against the code root, never the home or a root named under its config/, data/ or state/"
  assert_contains "$(r9 status)" "程式目錄：$R9" "the code root must stay the one the command derived"
  pass "untracked, changed, home and outside programs wait for a confirmation; a symlink, a missing or a non-executable file, and a group-writable unconfirmable one are refused (AT9.5)"
}

# AT9.6: the undo. With the binding gone nothing runs; restored, the writes go once.
test_bind_the_undo() {
  local before id
  rm "$BH/config/myshape-aggregator.json"
  r9 restart >/dev/null
  before=$(calls_b)
  id=$(message_b "沒有設定")
  wait_for "the write to wait with no binding" write_is "$BH" "$id" waiting
  refresh "$BH"
  assert_equals "$before" "$(calls_b)" "with the binding removed nothing may run"
  bind_to bin/stub-plain plain
  r9 restart >/dev/null
  wait_for "the waiting write once the binding is back" write_is "$BH" "$id" delivered
  assert_equals 1 "$(received_b "$id")" "the waiting write must be received once"
  r9 restart >/dev/null
  refresh "$BH"
  assert_equals 1 "$(received_b "$id")" "another restart must not send it again"
  pass "removing the binding and restarting runs nothing; restoring it delivers the waiting writes once (AT9.6)"
}

test_nothing_is_left() {
  f stop >/dev/null
  p stop >/dev/null
  r9 stop >/dev/null
  sa_check_decoys "$FMH"
  sa_check_decoys "$PH"
  sa_assert_no_boards
  sa_assert_no_trips
  pass "no board is left running and no Firstmate file was reached"
}

fm_test_run test_fm_setup test_fm_work_reaches_the_page test_fm_every_home_is_read_with_its_own_cursor \
  test_fm_message test_fm_answers test_fm_filing test_fm_notices test_fm_hands_on test_fm_direct test_fm_delivery_states \
  test_fm_resend_after_a_restart \
  test_fm_a_crash_mid_write test_fm_whole_page_states test_fm_refresh test_fm_summaries \
  test_plain_setup test_plain_work test_plain_ledger test_plain_second_home test_plain_banners \
  test_plain_work_only_under_topics test_plain_topics_and_order test_plain_the_captains_channel test_plain_hands_on \
  test_plain_changes_are_marked test_plain_texts_name_no_firstmate \
  test_bind_setup test_bind_a_tracked_program_needs_no_confirmation \
  test_bind_an_override_keeps_the_exemption_only_for_the_own_location test_bind_paths_only \
  test_bind_a_confirmation_is_bound_to_the_bytes test_bind_a_fixed_environment test_bind_only_the_page_confirms \
  test_bind_what_needs_a_confirmation test_bind_the_undo test_nothing_is_left
