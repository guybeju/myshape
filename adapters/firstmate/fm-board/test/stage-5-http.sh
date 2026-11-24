#!/usr/bin/env bash
# The browser channel from the outside: the checks every request must pass, the
# two-step confirmation of actions that cannot be taken back, and the API
# routes, all exercised with curl against a running board.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=fm-board/test/helpers.sh
. "$ROOT/fm-board/test/helpers.sh"

for tool in jq node curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "skip: $tool not found"; exit 0; }
done
TMP_ROOT=$(fm_test_tmproot tb-s5)
trap 'tb_stop_boards; fm_test_cleanup' EXIT

export MYSHAPE_TEST=1 MYSHAPE_READ_MS=60000
export FM_SNAPSHOT_NOW=2026-07-25T00:00:00Z
export TB_LOG="$TMP_ROOT/calls.log" TB_PLAY="$TMP_ROOT/play" TB_REMOTES="$TMP_ROOT/remotes"
mkdir -p "$TB_PLAY" "$TB_REMOTES"
: > "$TB_LOG"
CODE_ROOT="$TMP_ROOT/root"
tb_make_fake_root "$CODE_ROOT"
MAIN=$(tb_make_service_home main)
tb_bind_home "$MAIN"

t() {
  MYSHAPE_HOME="$MAIN" MYSHAPE_ROOT_OVERRIDE="$CODE_ROOT" "$CODE_ROOT/bin/myshape.sh" "$@"
}

t open >/dev/null || fail "the board did not start"
t create "Billing" --goal "rework billing" --id billing >/dev/null
t create "Login" --goal "new login" --id login >/dev/null
t create "Idea" --goal "to merge" --id idea --queue later >/dev/null
cat > "$MAIN/data/backlog.md" <<'EOF'
## In flight

## Queued
- [ ] call-1 - A call (repo: sample) (kind: captain) (hold: 要合併嗎？ 選項：合併 | 先不要) (hold-kind: captain)
  Captain hold set: 2026-07-24T00:00:00Z

## Done
EOF
mkdir -p "$MAIN/data/call-1"
printf 'billing 2026-07-01T00:00:00Z\n' > "$MAIN/data/call-1/topic"
URL=$(t open)
PORT=$(cat "$MAIN/config/myshape-port")
TOKEN=${URL##*#t=}
BASE="http://127.0.0.1:$PORT"
ORIGIN="Origin: $BASE"
AUTH="Authorization: Bearer $TOKEN"
JSON="Content-Type: application/json"

# status <curl args...>: the HTTP status of one request.
status() {
  curl -s -o /dev/null -m 10 -w '%{http_code}' "$@"
}

# api <route> <json body>: POST as the page would; prints the response body.
api() {
  curl -s -m 20 -H "$AUTH" -H "$ORIGIN" -H "$JSON" -d "$2" "$BASE/api/$1"
}

state() {
  curl -s -m 20 -H "$AUTH" "$BASE/api/state" | jq -r "$1"
}

test_request_checks() {
  local big icon
  assert_equals 200 "$(status "$BASE/")" "the page itself needs no token"
  assert_equals 200 "$(status -H "Host: localhost:$PORT" "$BASE/")" "localhost with the right port is this board"
  assert_equals 403 "$(status -H 'Host: evil.example' "$BASE/")" "a foreign Host must be refused (DNS rebinding)"
  assert_equals 403 "$(status -H 'Host: 127.0.0.1:1' "$BASE/")" "the right address with the wrong port must be refused"
  assert_equals 401 "$(status "$BASE/api/state")" "reading the board needs the token"
  assert_equals 401 "$(status -H 'Authorization: Bearer wrong' "$BASE/api/state")" "a wrong token must be refused"
  assert_equals 401 "$(status "$BASE/api/state?token=$TOKEN")" "the token is accepted only in the header"
  assert_equals 200 "$(status -H "$AUTH" "$BASE/api/state")" "the right token reads the board"
  assert_equals 403 "$(status -H "$AUTH" -H "$JSON" -d '{}' "$BASE/api/refresh")" "a change without Origin must be refused"
  assert_equals 403 "$(status -H "$AUTH" -H "$JSON" -H 'Origin: null' -d '{}' "$BASE/api/refresh")" "Origin: null must be refused"
  assert_equals 403 "$(status -H "$AUTH" -H "$JSON" -H 'Origin: http://evil.example' -d '{}' "$BASE/api/refresh")" "a foreign Origin must be refused (CSRF)"
  assert_equals 403 "$(status -H "$AUTH" -H "$JSON" -H "Origin: http://127.0.0.1:1" -d '{}' "$BASE/api/refresh")" "our address on another port is a foreign Origin"
  assert_equals 415 "$(status -H "$AUTH" -H "$ORIGIN" -H 'Content-Type: text/plain' -d '{}' "$BASE/api/refresh")" "only application/json may change anything"
  assert_equals 415 "$(status -H "$AUTH" -H "$ORIGIN" -d 'a=b' "$BASE/api/refresh")" "a form post must be refused"
  assert_equals 400 "$(status -H "$AUTH" -H "$ORIGIN" -H "$JSON" -d '{' "$BASE/api/refresh")" "malformed JSON must be refused"
  assert_equals 400 "$(status -H "$AUTH" -H "$ORIGIN" -H "$JSON" -d '[1]' "$BASE/api/refresh")" "a JSON body that is not an object must be refused"
  big=$(head -c 70000 /dev/zero | tr '\0' 'x')
  assert_equals 413 "$(printf '{"text":"%s"}' "$big" | status -H "$AUTH" -H "$ORIGIN" -H "$JSON" --data-binary @- "$BASE/api/messages")" \
    "a body over 64 KiB must be refused"
  assert_equals 405 "$(status -X OPTIONS -H 'Origin: http://evil.example' -H 'Access-Control-Request-Method: POST' "$BASE/api/refresh")" \
    "a preflight must not be answered"
  assert_equals 405 "$(status -X DELETE -H "$AUTH" -H "$ORIGIN" "$BASE/api/state")" "other methods must be refused"
  assert_equals 400 "$(status -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Key: x' -H 'Sec-WebSocket-Version: 13' "$BASE/")" \
    "a WebSocket upgrade must be refused"
  assert_equals 404 "$(status "$BASE/assets/..%2f..%2fstate%2fmyshape%2ftoken")" "an encoded path must not escape the assets"
  assert_equals 404 "$(status --path-as-is "$BASE/assets/../../state/myshape/token")" "a dotted path must not escape the assets"
  assert_equals 404 "$(status "$BASE/assets/board-server.js")" "server code must not be served"
  icon=$(curl -s -m 5 "$BASE/" | sed -n 's/.*<link rel="icon"[^>]* href="\([^"]*\)".*/\1/p')
  assert_equals "/assets/icon.svg" "$icon" "the page must name its own icon, so the browser does not ask for /favicon.ico"
  assert_equals "200 image/svg+xml" "$(curl -s -m 5 -o /dev/null -w '%{http_code} %{content_type}' "$BASE$icon")" \
    "the icon the page names must be served"
  assert_equals 404 "$(status -H "$AUTH" "$BASE/api/nope")" "an unknown API route is 404"
  printf 'GET / HTTP/1.1\r\nHost: \xff\xfe\x00bad\r\n\r\n' | curl -s -m 5 "telnet://127.0.0.1:$PORT" >/dev/null 2>&1 || true
  printf 'NOT HTTP AT ALL\r\n\r\n' | curl -s -m 5 "telnet://127.0.0.1:$PORT" >/dev/null 2>&1 || true
  assert_equals 200 "$(status -H "$AUTH" "$BASE/api/state")" "the board must survive garbage on the wire"
  pass "every request passes the Host, token, Origin, content-type, and size checks"
}

test_response_headers_and_exposure() {
  local headers audit="$MAIN/state/myshape/audit.jsonl"
  for path in / /assets/board.js /api/state /api/nope; do
    headers=$(curl -s -D - -o /dev/null -H "$AUTH" "$BASE$path")
    printf '%s' "$headers" | grep -qi "^content-security-policy: default-src 'self'; frame-ancestors 'none'" ||
      fail "$path must carry the content security policy"
    printf '%s' "$headers" | grep -qi '^x-frame-options: DENY' || fail "$path must forbid framing"
    printf '%s' "$headers" | grep -qi '^access-control-' && fail "$path must not send any CORS header"
  done
  assert_equals "127.0.0.1:$PORT" "$(tb_listeners "$PORT")" "the board must listen on 127.0.0.1 and nowhere else"
  curl -s "$BASE/" | grep -q "$TOKEN" && fail "the page must not embed the token"
  curl -s "$BASE/" | grep -q "Billing" && fail "the page must not embed any board data"
  grep -q '"rejected":"origin is not this board"' "$audit" || fail "a rejected request must be recorded"
  grep -q '"rejected":"missing or wrong token"' "$audit" || fail "a request with a bad token must be recorded"
  grep -q "$TOKEN" "$audit" && fail "the audit log must never contain the token"
  assert_equals "-rw-------" "$(tb_mode "$audit")" "the audit log must stay 0600"
  pass "responses carry the security headers and nothing leaks into the page or the log"
}

test_topic_routes() {
  local version
  api refresh '{}' >/dev/null
  assert_equals "billing login" "$(state '.queues.normal | join(" ")')" "the state must carry the queues"
  version=$(state '"\(.boot_id):\(.version)"')
  assert_equals false "$(curl -s -H "$AUTH" "$BASE/api/state?v=$version" | jq -r '.changed')" "an unchanged board answers changed: false"
  api topics/move '{"id":"login","queue":"high"}' >/dev/null
  assert_equals "login|billing" "$(state '"\(.queues.high | join(","))|\(.queues.normal | join(","))"')" "move must change the queue"
  assert_equals true "$(curl -s -H "$AUTH" "$BASE/api/state?v=$version" | jq -r '.changed')" "a change must show up for a poller"
  api topics/move '{"id":"billing","queue":"high","before":"login"}' >/dev/null
  assert_equals "billing login" "$(state '.queues.high | join(" ")')" "move with before must insert ahead of it"
  api topics/move '{"id":"billing","queue":"high"}' >/dev/null
  assert_equals "login billing" "$(state '.queues.high | join(" ")')" "a drop with no before lands at the end"
  api topics/rename '{"id":"billing","value":"Billing 2"}' >/dev/null
  api topics/goal '{"id":"billing","value":"a new goal"}' >/dev/null
  assert_equals "Billing 2|a new goal" "$(state '.topics.billing | "\(.name)|\(.goal)"')" "rename and goal must change the topic"
  t close-propose billing --reason "done" >/dev/null
  assert_equals "done" "$(state '.topics.billing.close_reason')" "a close proposal must reach the page"
  api topics/keep '{"id":"billing"}' >/dev/null
  assert_equals "null" "$(state '.topics.billing.close_reason')" "keep must clear the close proposal"
  api topics/archive '{"id":"login"}' >/dev/null
  assert_equals "archived" "$(state '.topics.login.status')" "archive must archive"
  api topics/reopen '{"id":"login"}' >/dev/null
  assert_equals "normal" "$(state '.topics.login.queue')" "reopen must queue the topic again"
  assert_equals "refused" "$(api topics/rename '{"id":"nope","value":"x"}' | jq -r '.error')" "a refused operation reports why"
  assert_equals 409 "$(status -H "$AUTH" -H "$ORIGIN" -H "$JSON" -d '{"id":"nope","value":"x"}' "$BASE/api/topics/rename")" "a refused operation is 409"
  assert_equals 400 "$(status -H "$AUTH" -H "$ORIGIN" -H "$JSON" -d '{}' "$BASE/api/topics/move")" "a malformed operation is 400"
  assert_equals 404 "$(status -H "$AUTH" -H "$ORIGIN" -H "$JSON" -d '{"name":"x","goal":"y"}' "$BASE/api/topics/create")" \
    "creating topics is not offered to the browser"
  assert_equals 404 "$(status -H "$AUTH" -H "$ORIGIN" -H "$JSON" -d '{"id":"billing"}' "$BASE/api/topics/confirm")" \
    "the browser has nothing to confirm: every topic is confirmed when it is made"
  pass "the topic routes do what the same myshape.sh subcommands do"
}

test_merge_takes_two_steps() {
  local code
  code=$(api topics/merge '{"from":"idea","into":"billing"}' | jq -r '.confirm')
  [ "${#code}" -eq 32 ] || fail "the first merge request must return a confirmation code"
  assert_equals "confirmed" "$(state '.topics.idea.status')" "the first request must not merge"
  got=$(api topics/merge "{\"from\":\"idea\",\"into\":\"login\",\"confirm\":\"$code\"}" | jq -r '.error')
  assert_equals "confirm" "$got" \
    "a code must not work for another target"
  got=$(api topics/merge "{\"from\":\"idea\",\"into\":\"billing\",\"confirm\":\"$code\"}" | jq -r '.error')
  assert_equals "confirm" "$got" \
    "a code is void once it has been presented, even wrongly"
  code=$(api topics/merge '{"from":"idea","into":"billing"}' | jq -r '.confirm')
  got=$(api topics/merge "{\"from\":\"idea\",\"into\":\"billing\",\"confirm\":\"$code\"}" | jq -r '.ok')
  assert_equals true "$got" \
    "the second request with the code must merge"
  assert_equals "null" "$(state '.topics.idea')" "the merged topic must be gone"
  pass "merging topics needs a code bound to exactly that merge"
}

answer_step1() {
  api holds/answer '{"home":"main","task":"call-1","answer":"合併","label":"合併"}' | jq -r '.confirm'
}

test_answer_takes_two_steps() {
  local code before
  api refresh '{}' >/dev/null
  assert_equals "合併|先不要" "$(state '.holds[] | select(.task == "call-1") | .options | join("|")')" "the hold must be on the board"
  before=$(grep -c '^cmd=fm-captain-hold.sh' "$TB_LOG" || true)
  assert_equals "release false" "$(state '.holds[] | select(.task == "call-1") | "\(.on_answer) \(.on_answer_recorded)"')" \
    "a hold that records no outcome must be shown as released, and as not recorded"
  assert_equals "confirm" "$(api holds/answer '{"home":"main","task":"call-1","answer":"合併","label":"合併","confirm":"00000000000000000000000000000000"}' | jq -r '.error')" \
    "an invented code must not answer"
  code=$(answer_step1)
  got=$(api holds/answer "{\"home\":\"main\",\"task\":\"call-1\",\"answer\":\"先不要\",\"label\":\"x\",\"confirm\":\"$code\"}" | jq -r '.error')
  assert_equals "confirm" "$got" \
    "a code must not work for another answer"
  code=$(answer_step1)
  sed -i.bak 's/要合併嗎？/要現在合併嗎？/' "$MAIN/data/backlog.md"
  api refresh '{}' >/dev/null
  got=$(api holds/answer "{\"home\":\"main\",\"task\":\"call-1\",\"answer\":\"合併\",\"label\":\"合併\",\"confirm\":\"$code\"}" | jq -r '.error')
  assert_equals "confirm" "$got" \
    "a code must not work once the question changed"
  code=$(answer_step1)
  awk '{ print } /^  Captain hold set: / && held { print "  Captain hold on answer: close" } { held = /^- \[ \] call-1 / }' \
    "$MAIN/data/backlog.md" > "$MAIN/data/backlog.md.new" && mv "$MAIN/data/backlog.md.new" "$MAIN/data/backlog.md"
  api refresh '{}' >/dev/null
  assert_equals "close true" "$(state '.holds[] | select(.task == "call-1") | "\(.on_answer) \(.on_answer_recorded)"')" \
    "a recorded close must reach the page"
  got=$(api holds/answer "{\"home\":\"main\",\"task\":\"call-1\",\"answer\":\"合併\",\"label\":\"合併\",\"confirm\":\"$code\"}" | jq -r '.error')
  assert_equals "confirm" "$got" \
    "a code must not work once what answering does changed"
  code=$(answer_step1)
  t restart >/dev/null
  api refresh '{}' >/dev/null
  got=$(api holds/answer "{\"home\":\"main\",\"task\":\"call-1\",\"answer\":\"合併\",\"label\":\"合併\",\"confirm\":\"$code\"}" | jq -r '.error')
  assert_equals "confirm" "$got" \
    "a restart must void outstanding codes"
  assert_equals "$before" "$(grep -c '^cmd=fm-captain-hold.sh' "$TB_LOG" || true)" "nothing may reach the hold before a valid second step"

  code=$(answer_step1)
  got=$(api holds/answer "{\"home\":\"main\",\"task\":\"call-1\",\"answer\":\"合併\",\"label\":\"合併\",\"confirm\":\"$code\",\"mode\":\"release\"}" | jq -r '.ok')
  assert_equals true "$got" \
    "the second step with the code must answer"
  sleep 1
  grep '^cmd=fm-captain-hold.sh' "$TB_LOG" | tail -n 1 | grep -q 'stdin=call-1	合併	合併	done' ||
    fail "the answer must close as the hold recorded, whatever mode the request names"
  assert_equals "refused" "$(api holds/answer '{"home":"main","task":"nope","answer":"x","label":"x"}' | jq -r '.error')" \
    "answering a hold that is not there is refused"
  pass "answering a hold needs a code bound to the hold, its question, and the answer"
}

test_messages_and_writes() {
  local id
  id=$(api messages '{"topic":"billing","text":"先做這個"}' | jq -r '.write_id')
  sleep 1
  got=$(state ".writes[] | select(.id == \"$id\") | .state")
  also=$(grep "\"write_id\":\"$id\"" "$MAIN/state/myshape/audit.jsonl" | head -n 1 | jq -r '.sending.channel')
  assert_equals "delivered|browser" "$got|$also" \
    "a message from the page is delivered and recorded as coming from the browser"
  assert_equals "refused" "$(api direct '{"home":"main","task":"ship-a","text":"/compact"}' | jq -r '.error')" \
    "a direct message that looks like a command is refused"
  printf '1\n' > "$TB_PLAY/fm-send.sh"
  id=$(api direct '{"home":"main","task":"ship-a","text":"看一下"}' | jq -r '.write_id')
  sleep 1
  got=$(state ".writes[] | select(.id == \"$id\") | .state")
  assert_equals "failed" "$got" "a failed direct message shows as failed"
  got=$(api writes/resend "{\"write_id\":\"$id\"}" | jq -r '.ok')
  assert_equals true "$got" "a failed write can be resent in one step"
  sleep 1
  got=$(state ".writes[] | select(.id == \"$id\") | .state")
  assert_equals "delivered" "$got" "the resend delivers it"
  printf '1\n' > "$TB_PLAY/fm-send.sh"
  id=$(api direct '{"home":"main","task":"ship-a","text":"不管了"}' | jq -r '.write_id')
  sleep 1
  got=$(api writes/ignore "{\"write_id\":\"$id\"}" | jq -r '.ok')
  assert_equals true "$got" "a failed write can be ignored"
  got=$(state ".writes[] | select(.id == \"$id\") | .state")
  assert_equals "ignored" "$got" "ignore marks the write"
  mkdir -p "$MAIN/data"
  id=$(api agents/tag '{"home":"main","task":"loose","topic":"login"}' | jq -r '.write_id')
  sleep 1
  assert_equals login "$(cut -d' ' -f1 "$MAIN/data/loose/topic")" "tagging an agent from the page writes the tag"
  pass "messages, direct messages, tags, resend, and ignore work through the API"
}

test_quiet_polling_is_not_a_change() {
  local version
  t stop >/dev/null
  MYSHAPE_READ_MS=300 MYSHAPE_STALE_MS=4000 MYSHAPE_IDLE_MS=2000 t open >/dev/null
  AUTH="Authorization: Bearer $(cat "$MAIN/state/myshape/token")"
  curl -s -H "$AUTH" "$BASE/api/state" >/dev/null
  sleep 2
  version=$(state '"\(.boot_id):\(.version)"')
  sleep 1.5
  assert_equals false "$(curl -s -H "$AUTH" "$BASE/api/state?v=$version" | jq -r '.changed')" \
    "polls that find nothing new must not make the page redraw"
  : > "$MAIN/config/fleet-ledger"
  sleep 1.5
  assert_equals true "$(curl -s -H "$AUTH" "$BASE/api/state?v=$version" | jq -r '.changed')" \
    "a poll that finds something new must reach the page"
  version=$(state '"\(.boot_id):\(.version)"')
  # Nobody asks for long enough that polling stops and the home goes stale.
  sleep 6.5
  assert_equals "true|true" "$(curl -s -H "$AUTH" "$BASE/api/state?v=$version" | jq -r '"\(.changed)|\(.homes[0].stale)"')" \
    "a home going stale must reach the page even though no read reported it"
  t stop >/dev/null
  t open >/dev/null
  pass "the page is told about changes, including staleness, and nothing else"
}

# board_lines: how many system records the board has saved.
board_lines() {
  grep -c '"src":"board"' "$MAIN/data/myshape/events.jsonl" || true
}

# records_after <kinds> <what> <command...>: run the command and require that
# exactly these record kinds ("-" for none) were saved, in order, each with a
# record id and who made it. A write's record lands when it is delivered.
records_after() {
  local kinds=$1 what=$2 before want got expected waited=0
  shift 2
  before=$(board_lines)
  "$@" >/dev/null || fail "$what: the command failed"
  want=$before
  # shellcheck disable=SC2086 # the kinds are a list of words.
  [ "$kinds" = - ] || want=$((before + $(printf '%s\n' $kinds | wc -l)))
  while [ "$(board_lines)" -lt "$want" ] && [ "$waited" -lt 100 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  sleep 0.5
  got=$(grep '"src":"board"' "$MAIN/data/myshape/events.jsonl" | tail -n +$((before + 1)) |
    jq -r 'if .rid != null and .by != null then .kind else "no-rid-or-by" end' | tr '\n' ' ')
  expected=""
  # shellcheck disable=SC2086 # the kinds are a list of words.
  [ "$kinds" = - ] || expected=$(printf '%s ' $kinds)
  assert_equals "$expected" "$got" "$what must save exactly its records"
}

# two_step <route> <json body without confirm>: both requests of a page action that takes two.
two_step() {
  local code
  code=$(api "$1" "$2" | jq -r '.confirm')
  api "$1" "${2%\}},\"confirm\":\"$code\"}" | jq -e '.ok == true' >/dev/null
}

# Guard 3.5: every socket operation and every page route, sent once, saves
# the records it should, and only those; a new operation or route without a
# case here fails.
test_every_change_leaves_a_record() {
  local covered_ops covered_routes ops routes id
  ops=$(node --input-type=module -e "import('$ROOT/myshape/dist/ops.js').then((m) => console.log(Object.entries(m.OPERATIONS).filter(([, op]) => op.channel !== 'page').map(([name]) => name).sort().join(' ')))")
  routes=$(node --input-type=module -e "import('$ROOT/myshape/dist/api.js').then((m) => console.log(Object.keys(m.ROUTES).sort().join('|')))")
  covered_ops="archive close-propose create goal merge move rename reopen split todo-add todo-done todo-failed todo-obsolete"
  covered_routes="GET state|POST agents/tag|POST direct|POST holds/answer|POST messages|POST programs/confirm|POST refresh|POST todos/claim|POST todos/drop|POST todos/takedown|POST topics/archive|POST topics/goal|POST topics/keep|POST topics/merge|POST topics/move|POST topics/rename|POST topics/reopen|POST writes/ignore|POST writes/resend"
  assert_equals "$covered_ops" "$ops" "every socket operation needs a case here"
  assert_equals "$covered_routes" "$routes" "every page route needs a case here"

  records_after topic.created "create" t create "Rec" --goal "g" --id rec
  records_after topic.created "create" t create "Rec two" --goal "g" --id rec2
  records_after topic.merged "merge" t merge rec2 rec
  records_after topic.close_proposed "close-propose" t close-propose rec --reason "done"
  records_after topic.moved "move" t move rec high
  records_after topic.split "split" t split rec "Part" --goal "g" --id recpart
  records_after topic.renamed "rename" t rename recpart "Part two"
  records_after topic.goal_changed "goal" t goal recpart "g2"
  records_after topic.archived "archive" t archive recpart
  records_after topic.reopened "reopen" t reopen recpart
  records_after todo.opened "todo add" t todo add it1 "買 ASUS 路由器" --topic rec --do "到店家下單 ASUS 路由器"
  records_after todo.claimed "todos/claim" api todos/claim '{"task":"it1"}'
  records_after todo.rejected "todo failed" t todo failed it1 --reason "路由器還沒送到"
  records_after todo.claimed "todos/claim" api todos/claim '{"task":"it1"}'
  records_after todo.done "todo done" t todo "done" it1
  records_after todo.opened "todo add" t todo add it2 "Item two" --topic rec --do "do it"
  records_after todo.taken_down "todo obsolete" t todo obsolete it2 --reason "not needed"

  records_after topic.moved "topics/move" api topics/move '{"id":"rec","queue":"normal"}'
  records_after topic.renamed "topics/rename" api topics/rename '{"id":"rec","value":"Rec three"}'
  records_after topic.goal_changed "topics/goal" api topics/goal '{"id":"rec","value":"g3"}'
  records_after topic.kept "topics/keep" api topics/keep '{"id":"rec"}'
  records_after topic.archived "topics/archive" api topics/archive '{"id":"recpart"}'
  records_after topic.reopened "topics/reopen" api topics/reopen '{"id":"recpart"}'
  records_after topic.merged "topics/merge" two_step topics/merge '{"from":"recpart","into":"rec"}'
  t todo add it4 "Item four" --topic rec --do "do it" >/dev/null
  records_after todo.claimed "todos/claim" api todos/claim '{"task":"it4"}'
  t todo add it5 "Item five" --topic rec --do "do it" >/dev/null
  records_after todo.dropped "todos/drop" two_step todos/drop '{"task":"it5"}'
  t todo add it6 "Item six" --topic rec --do "do it" --captain-closes >/dev/null
  t todo obsolete it6 --reason "not needed" >/dev/null
  records_after todo.taken_down "todos/takedown" two_step todos/takedown '{"task":"it6"}'
  records_after agent.tagged "agents/tag" api agents/tag '{"home":"main","task":"loose","topic":"rec"}'
  api refresh '{}' >/dev/null
  records_after hold.answered "holds/answer" two_step holds/answer '{"home":"main","task":"call-1","answer":"合併","label":"合併"}'
  records_after - "messages" api messages '{"topic":"rec","text":"hi"}'
  printf '1\n1\n' > "$TB_PLAY/fm-send.sh"
  records_after - "direct" api direct '{"home":"main","task":"ship-a","text":"look"}'
  id=$(state '[.writes[] | select(.kind == "direct" and .state == "failed")][-1].id')
  records_after - "writes/resend" api writes/resend "{\"write_id\":\"$id\"}"
  id=$(state '[.writes[] | select(.kind == "direct" and .state == "failed")][-1].id')
  records_after - "writes/ignore" api writes/ignore "{\"write_id\":\"$id\"}"
  records_after - "refresh" api refresh '{}'
  # A program the board cannot vouch for: a write waits for it, and the page's
  # confirmation saves its record and the record of the write it releases.
  printf '#!/bin/sh\nexec %s/bin/fm-board.sh "$@"\n' "$CODE_ROOT" > "$TMP_ROOT/outside-fm-board"
  chmod 755 "$TMP_ROOT/outside-fm-board"
  jq -cn --arg p "$TMP_ROOT/outside-fm-board" '{v: 1, name: "firstmate", feed: $p, deliver: $p}' \
    > "$MAIN/config/myshape-aggregator.json"
  t open >/dev/null
  records_after - "a message that waits" api messages '{"topic":"rec","text":"等確認"}'
  records_after "program.confirmed writes.released" "programs/confirm" two_step programs/confirm '{"role":"deliver"}'
  tb_bind_home "$MAIN"
  t open >/dev/null
  records_after - "GET state" state '.version'
  assert_equals "todo.done todo.claimed todo.rejected todo.claimed todo.opened" \
    "$(state '.closed_todos[] | select(.item == "it1") | .records | map(.event) | join(" ")')" \
    "the closed item must list every step of its life, newest first"
  # The page's lines for that item, as the topic page prints them, when asked for.
  [ -z "${FM_TEST_RECORD_LINES:-}" ] ||
    state '.closed_todos[] | select(.item == "it1") | .records[] | "\(.ts | strflocaltime("%m-%d %H:%M"))  \(.text)"' \
      > "$FM_TEST_RECORD_LINES"
  pass "every socket operation and page route saves exactly its records, each with an id and who made it"
}

# hold <args...>: the real fm-captain-hold.sh against the scratch main home, as
# first mate runs it there (the fake root's copy is a stand-in for the deliverer).
captain_hold() {
  env -u FM_ROOT_OVERRIDE FM_HOME="$MAIN" "$ROOT/bin/fm-captain-hold.sh" "$@"
}

# answer_both: the page's answer reaches the backlog through the real intake, as
# the deliverer runs it; an answer goes through the same intake by hand, which
# the page never sent; and first mate records an answer the captain gave in
# chat; then the board reads the home.
answer_both() {
  printf 'dec-page\t要\t要\tdone\n' | captain_hold answers --source myshape >/dev/null || return 1
  printf 'dec-hand\t好\t\tdone\n' | captain_hold answers --source myshape >/dev/null || return 1
  printf '不要，先不加密\n' > "$TMP_ROOT/chat-decision"
  captain_hold answer dec-chat --decision-file "$TMP_ROOT/chat-decision" >/dev/null || return 1
  api refresh '{}'
}

# The decisions of a home, opened and closed outside the page, leave one
# opening and one closing each on their topic's page: one answered on the page
# (its close is the page's own hold.answered) and one answered in chat (its
# close comes from the home's backlog, at the time fm-captain-hold.sh logged).
test_decisions_open_and_close_once() {
  local lines chat_at
  if ! command -v tasks-axi >/dev/null 2>&1; then
    pass "skip: tasks-axi not found"
    return
  fi
  api refresh '{}' >/dev/null
  captain_hold hold dec-page --title "NAS 兩步驗證" --reason "NAS 要不要開兩步驗證？ 選項：要 | 不要" --on-answer close \
    >/dev/null || fail "holding dec-page failed"
  captain_hold hold dec-chat --title "備份加密" --reason "備份要不要加密？ 選項：要 | 不要" --on-answer close \
    >/dev/null || fail "holding dec-chat failed"
  captain_hold hold dec-hand --title "換路由器" --reason "要換路由器嗎？ 選項：好 | 不要" --on-answer close \
    >/dev/null || fail "holding dec-hand failed"
  mkdir -p "$MAIN/data/dec-page" "$MAIN/data/dec-chat" "$MAIN/data/dec-hand"
  printf 'billing %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" |
    tee "$MAIN/data/dec-page/topic" "$MAIN/data/dec-hand/topic" > "$MAIN/data/dec-chat/topic"
  records_after "hold.opened hold.opened hold.opened" "three decisions opened outside the page" api refresh '{}'
  records_after - "a read that finds them again" api refresh '{}'
  records_after hold.answered "the page's answer" two_step holds/answer \
    '{"home":"main","task":"dec-page","answer":"要","label":"要"}'
  records_after "hold.closed hold.closed" "the answers reaching the backlog" answer_both
  records_after - "a read that finds nothing new" api refresh '{}'
  lines=$(state '[.updates[] | select((.task // "" | startswith("dec-")) and (.event | startswith("hold.")))] | reverse | .[]
    | "\(.task) \(.event)"' | sort | tr '\n' ' ')
  assert_equals "dec-chat hold.closed dec-chat hold.opened dec-hand hold.closed dec-hand hold.opened dec-page hold.answered dec-page hold.opened " "$lines" \
    "each decision must have exactly one opening and one closing"
  assert_equals "billing billing billing billing billing billing" \
    "$(state '[.updates[] | select((.task // "" | startswith("dec-")) and (.event | startswith("hold.")))] | map(.topic) | join(" ")')" \
    "every line of both decisions must be on their topic's page"
  chat_at=$(jq -r 'select(.task == "dec-chat" and .event == "resolved") | .ts' "$MAIN/state/captain-hold-events.jsonl" | head -n 1)
  assert_equals "$chat_at" "$(state '.updates[] | select(.task == "dec-chat" and .event == "hold.closed") | .ts')" \
    "the chat answer's close must carry the time fm-captain-hold.sh logged"
  assert_equals "待決事項「備份加密」已回答：不要，先不加密（經聊天）" \
    "$(state '.updates[] | select(.task == "dec-chat" and .event == "hold.closed") | .text')" \
    "the chat answer's close must say what was answered and through where, with no 'at the latest'"
  assert_equals "待決事項「換路由器」已回答：好（經看板）" \
    "$(state '.updates[] | select(.task == "dec-hand" and .event == "hold.closed") | .text')" \
    "an answer through the page's intake that the page never sent still closes, through the board"
  # The page's lines for the decisions, as the topic page prints them, when asked for.
  [ -z "${FM_TEST_DECISION_LINES:-}" ] ||
    state '.updates[] | select((.task // "" | startswith("dec-")) and (.event | startswith("hold.")))
      | "\(.ts | strflocaltime("%m-%d %H:%M"))  \(.home)/\(.task) \(.text)"' > "$FM_TEST_DECISION_LINES"
  pass "a decision answered on the page, one through its intake by hand and one in chat each leave one opening and one closing"
}

test_reset_token() {
  t reset-token >/dev/null
  assert_equals 401 "$(status -H "$AUTH" "$BASE/api/state")" "the old token must stop working after a reset"
  assert_equals 200 "$(status -H "Authorization: Bearer $(cat "$MAIN/state/myshape/token")" "$BASE/api/state")" "the new token must work"
  pass "reset-token invalidates the old token at once"
}

fm_test_run test_request_checks test_response_headers_and_exposure test_topic_routes test_merge_takes_two_steps \
  test_answer_takes_two_steps test_messages_and_writes test_quiet_polling_is_not_a_change \
  test_every_change_leaves_a_record test_decisions_open_and_close_once test_reset_token
t stop >/dev/null
