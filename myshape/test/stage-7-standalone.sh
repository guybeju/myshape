#!/usr/bin/env bash
# The board alone: its command and service run from a board-only root (only
# the board's own files), in a clean environment with a system-only PATH, next
# to decoy Firstmate files, with nothing on the other side until AT8.4 puts a
# stub aggregator there (AT0, AT1, AT8 of the board-interface test plan). With TB_STAGE7_TRIPWIRES=1 the root's bin/
# and a bin/ beside the root also hold a tripwire for every other Firstmate
# script and library, and the run must leave the trip log empty (AT3.2).
# shellcheck disable=SC2016 # jq filters and the patterns of the static check are literal text.
set -u

# shellcheck source=myshape/test/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"
# shellcheck source=myshape/test/standalone-lib.sh
. "$ROOT/myshape/test/standalone-lib.sh"

for tool in jq node curl git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "skip: $tool not found"; exit 0; }
done
TMP_ROOT=$(fm_test_tmproot tb-s7)
case "$TMP_ROOT" in /*) ;; *) echo "not ok - no scratch root" >&2; exit 1 ;; esac
trap 'tb_stop_boards; sig_leftovers; fm_test_cleanup' EXIT
sig_init

sa_init
mkdir -p "$TMP_ROOT/root"
SA_ROOT=$TMP_ROOT/root/board
ROOT_COMMIT=$(tb_make_board_root "$SA_ROOT")
if [ "${TB_STAGE7_TRIPWIRES:-0}" = 1 ]; then
  sa_trip_root "$SA_ROOT"
  ROOT_COMMIT=$(tb_commit_root "$SA_ROOT" "tripwires")
fi
SA_ENV=(MYSHAPE_TEST=1 MYSHAPE_NOTIFY_MS=2000 "MYSHAPE_RETRY_MS=100,200"
  MYSHAPE_RESUME_MS=1000 MYSHAPE_READ_MS=300 MYSHAPE_STALE_MS=1000)
AGG=$TMP_ROOT/agg
MAIN=$(sa_home main)
sa_decoys "$MAIN"

t() {
  sa "$MAIN" "$@"
}

# queues <home>: "high:a,b normal:c later:" from list --json, then the same
# from plain list; the two must agree.
queues() {
  local json plain
  json=$(sa "$1" list --json | jq -r '
    [("high", "normal", "later") as $q
     | "\($q):\([.[] | select(.queue == $q)] | sort_by(.position) | map(.id) | join(","))"] | join(" ")')
  plain=$(sa "$1" list | awk -F '\t' '$3 != "-" { rows[$3] = rows[$3] (rows[$3] == "" ? "" : ",") $1 }
    END { printf "high:%s normal:%s later:%s\n", rows["high"], rows["normal"], rows["later"] }')
  [ "$json" = "$plain" ] || fail "list and list --json disagree: '$json' against '$plain'"
  printf '%s\n' "$json"
}

base_url() {  # <home>
  printf 'http://127.0.0.1:%s' "$(cat "$1/config/myshape-port")"
}

api_state() {  # <home> [jq arguments...] [jq filter]
  local home=$1
  shift
  [ "$#" -gt 0 ] || set -- .
  curl -s -m 20 -H "Authorization: Bearer $(cat "$home/state/myshape/token")" "$(base_url "$home")/api/state" | jq -c -r "$@"
}

api() {  # <home> <route> <json body>
  local base
  base=$(base_url "$1")
  curl -s -m 20 -H "Authorization: Bearer $(cat "$1/state/myshape/token")" -H "Origin: $base" \
    -H 'Content-Type: application/json' -d "$3" "$base/api/$2"
}

http_code() {  # <curl arguments...>
  curl -s -o /dev/null -m 20 -w '%{http_code}' "$@"
}

test_the_environment_is_hardened() {
  local path
  assert_contains "$SA_PATH" "$SA_PATHTRIP:/usr/bin:/bin" "the board's PATH must be the tripwire directory and the system"
  [ -x "$SA_PATHTRIP/fm-board.sh" ] || fail "firstmate's adapter must have a tripwire on the PATH: the board names no program of its own"
  [ -x "$SA_PATHTRIP/fm-tasks-axi.sh" ] || fail "every other Firstmate script must have a tripwire on the PATH"
  [ -x "$SA_PATHTRIP/fm-inbox.sh" ] || fail "the programs the board ran before B2 must have tripwires on the PATH"
  # shellcheck disable=SC2086 # the file list is a list of words.
  assert_equals "$(cd "$ROOT" && git ls-files -s $TB_BOARD_FILES | awk '{print $4}' | sort | sha256sum)" \
    "$(cd "$SA_ROOT" && git ls-files $TB_BOARD_FILES | sort | sha256sum)" \
    "the board-only root must hold exactly the board's files"
  assert_equals "" "$(cd "$SA_ROOT" && git ls-files | grep -v -e '^bin/myshape\.sh$' -e '^bin/myshape-lib\.sh$' -e '^myshape/' |
    grep -v -e '^bin/fm-' || true)" "the board-only root must hold nothing else"
  # With tripwires around the board, the name holds a committed tripwire.
  [ ! -e "$SA_ROOT/bin/fm-board.sh" ] || grep -q '^exit 97$' "$SA_ROOT/bin/fm-board.sh" ||
    fail "the board-only root must not hold firstmate's adapter"
  [ "$ROOT_COMMIT" != "$(git -C "$ROOT" rev-parse HEAD)" ] || fail "the root must have its own commit"
  # No stage-7 script may reach the real checkout's board or its fixtures. The
  # patterns are split so this check cannot match its own text.
  ! grep -nE '\$''(TOPIC|BOARD_READ|BOARD)\b|tb_make_fake''_root' "$ROOT"/myshape/test/stage-7-*.sh \
    "$ROOT/myshape/test/standalone-lib.sh" || fail "a stage-7 script uses the real checkout's commands"
  ! grep -n '\$ROOT''/bin' "$ROOT"/myshape/test/stage-7-*.sh || fail "only the tripwire builder may name the checkout's bin/"
  assert_equals 1 "$(grep -c '\$ROOT"/bin' "$ROOT/myshape/test/standalone-lib.sh")" "only the tripwire builder may name the checkout's bin/"
  pass "the board runs from its own root, with a clean environment, a system PATH, and tripwires"
}

test_help_needs_nothing() {
  local out err rc=0 before
  before=$(find "$MAIN" "$SA_ROOT" -newer "$MAIN.decoys" | sort)
  out=$(sa "$MAIN" --help 2>"$TMP_ROOT/help.err") || rc=$?
  err=$(cat "$TMP_ROOT/help.err")
  assert_equals 0 "$rc" "--help must exit 0"
  assert_contains "$out" "myshape.sh - the topic board's command." "--help must print the usage header"
  assert_equals "" "$err" "--help must write nothing on stderr"
  assert_equals "$before" "$(find "$MAIN" "$SA_ROOT" -newer "$MAIN.decoys" | sort)" "--help must create no file"
  pass "--help works with nothing but the board's own files"
}

test_the_token_guard() {
  local out rc=0 decoy=$TMP_ROOT/decoy-overrides
  local -a env=("${SA_ENV[@]}")
  mkdir -p "$decoy"
  export MYSHAPE_ROOT_OVERRIDE=$decoy MYSHAPE_DATA_OVERRIDE=$decoy \
    MYSHAPE_STATE_OVERRIDE=$decoy MYSHAPE_CONFIG_OVERRIDE=$decoy
  out=$(t create "Alpha" --goal "first" --id a 2>&1) || rc=$?
  assert_equals 1 "$rc" "create before the first open must be refused"
  assert_equals "這裡沒有看板（找不到 state/myshape/token）；要在這裡開看板先跑 myshape.sh open。" "$out" \
    "the refusal must say there is no board and name open"
  assert_absent "$MAIN/state/myshape" "a refused create must write nothing"
  assert_absent "$MAIN/data/topics.json" "a refused create must write no topic"
  out=$(t open) || fail "open must start the board: $out"
  out=$(t create "Alpha" --goal "first" --id a) || fail "create after open must succeed: $out"
  assert_equals "ok a 已建立，排在「一般」最後" "$out" "create must report where the topic landed"
  jq -e '.topics.a.name == "Alpha"' "$MAIN/data/topics.json" >/dev/null || fail "the topic must be in the home's own file"
  assert_equals "" "$(ls -A "$decoy")" "override variables in the caller's environment must not steer the board"
  unset MYSHAPE_ROOT_OVERRIDE MYSHAPE_DATA_OVERRIDE MYSHAPE_STATE_OVERRIDE MYSHAPE_CONFIG_OVERRIDE
  # The names the command read before it had its own, inside the clean
  # environment: the three directory ones are not read; FM_HOME and
  # FM_ROOT_OVERRIDE naming another place are refused, naming the same place
  # they are not.
  SA_ENV=("${env[@]}" FM_DATA_OVERRIDE="$decoy" FM_STATE_OVERRIDE="$decoy" FM_CONFIG_OVERRIDE="$decoy")
  out=$(t list --json) || fail "the old directory names must not stop a command: $out"
  SA_ENV=("${env[@]}")
  assert_equals a "$(printf '%s' "$out" | jq -r '.[].id')" "the old directory names must not move the board's state or data"
  SA_ENV=("${env[@]}" MYSHAPE_HOME= FM_HOME="$decoy")
  rc=0
  out=$(t create "Gamma" --goal "third" --id c 2>&1) || rc=$?
  SA_ENV=("${env[@]}")
  assert_equals 2 "$rc" "FM_HOME naming another home, without MYSHAPE_HOME, must be refused"
  assert_contains "$out" "要指定請改設 MYSHAPE_HOME" "the refusal must name the board's own name"
  SA_ENV=("${env[@]}" FM_ROOT_OVERRIDE="$decoy")
  rc=0
  out=$(t create "Gamma" --goal "third" --id c 2>&1) || rc=$?
  SA_ENV=("${env[@]}")
  assert_equals 2 "$rc" "FM_ROOT_OVERRIDE naming another root, without MYSHAPE_ROOT_OVERRIDE, must be refused"
  assert_contains "$out" "要指定請改設 MYSHAPE_ROOT_OVERRIDE" "the refusal must name the board's own name"
  jq -e '.topics.c == null' "$MAIN/data/topics.json" >/dev/null || fail "a refused command must write nothing"
  assert_equals "" "$(ls -A "$decoy")" "the old names must not steer the board"
  # FM_HOME naming the very home the command resolves (here its own root,
  # whose board never ran) is not refused: the token guard answers.
  SA_ENV=("${env[@]}" MYSHAPE_HOME= FM_HOME="$SA_ROOT")
  rc=0
  out=$(t list 2>&1) || rc=$?
  SA_ENV=("${env[@]}")
  assert_equals 1 "$rc" "FM_HOME naming the home the command resolves must not be refused"
  assert_contains "$out" "這裡沒有看板" "the command must go on to the token guard"
  pass "every subcommand but open waits for the board's token, only the clean environment reaches the board, and an old name pointing elsewhere is refused"
}

test_open_and_the_running_service() {
  local out pid args
  out=$(t open)
  [[ "$out" =~ ^http://127\.0\.0\.1:$(cat "$MAIN/config/myshape-port")/#t=[0-9a-f]{64}$ ]] ||
    fail "open must print the board's URL with its token: $out"
  assert_equals "-rw-------" "$(tb_mode "$MAIN/state/myshape/token")" "the token must be 0600"
  assert_equals "srw-------" "$(tb_mode "$MAIN/state/myshape/board.sock")" "the socket must be 0600"
  pid=$(tb_board_pid "$MAIN")
  args=$(ps -o args= -p "$pid")
  assert_contains "$args" "$SA_ROOT/myshape/dist/board-server.js" "the service must run the board-only root's build"
  assert_contains "$args" "--root $SA_ROOT" "the service must be given the board-only root"
  assert_contains "$(t status)" "程式版本：$ROOT_COMMIT" "status must name the board-only root's commit"
  assert_equals "$(sha256sum < "$SA_ROOT/myshape/public/index.html")" \
    "$(curl -s -m 20 "$(base_url "$MAIN")/" | sha256sum)" "the page must come from the board-only root"
  pass "open prints the URL, keeps the token and socket private, and the service runs from the board-only root"
}

test_the_agents_topic_commands() {
  local out
  t create "Beta" --goal "second" --id b >/dev/null
  t create "High one" --goal "h" --id h1 --queue high >/dev/null
  t create "High two" --goal "h" --id h2 --queue high >/dev/null
  assert_equals "high:h1,h2 normal:a,b later:" "$(queues "$MAIN")" "a new topic must go last in its queue"
  assert_equals "ok a 本來就有這個議題，在「一般」" "$(t create "Alpha" --goal "first")" "a repeat must print the same topic's id"
  assert_equals 4 "$(jq '.topics | length' "$MAIN/data/topics.json")" "a repeat must make no topic"
  expect_code 2 "$(sa_code "$MAIN" create "Gamma")" "create without a goal"
  assert_equals 4 "$(jq '.topics | length' "$MAIN/data/topics.json")" "a create without a goal must write nothing"

  t move b normal --first >/dev/null
  assert_equals "high:h1,h2 normal:b,a later:" "$(queues "$MAIN")" "move --first must lead the queue"
  t move a later >/dev/null
  assert_equals "high:h1,h2 normal:b later:a" "$(queues "$MAIN")" "move must go last in the new queue"
  t move a high --before h2 >/dev/null
  assert_equals "high:h1,a,h2 normal:b later:" "$(queues "$MAIN")" "move --before must land before that topic"

  t rename a "Alpha two" >/dev/null
  t goal a "the first, again" >/dev/null
  assert_equals "Alpha two|the first, again" "$(jq -r '.topics.a | "\(.name)|\(.goal)"' "$MAIN/data/topics.json")" \
    "rename and goal must change the topic"
  t archive h1 >/dev/null
  assert_equals "archived" "$(t list --all --json | jq -r '.[] | select(.id == "h1") | .status')" "archive must archive"
  t reopen h1 --queue normal >/dev/null
  assert_equals "high:a,h2 normal:b,h1 later:" "$(queues "$MAIN")" "reopen must put the topic back last in its queue"
  t merge b a --reason "same work" >/dev/null || fail "merge failed"
  assert_equals "null" "$(jq -r '.topics.b' "$MAIN/data/topics.json")" "a merged topic must be gone"
  t close-propose a --reason "looks done" >/dev/null || fail "close-propose failed"
  assert_equals "looks done|confirmed" "$(jq -r '.topics.a | "\(.close_proposal.reason)|\(.status)"' "$MAIN/data/topics.json")" \
    "a close proposal must be carried by the topic, which stays open"
  t split a "Alpha part" --goal "a part" --id a2 >/dev/null || fail "split failed"
  assert_equals "high:a,a2,h2 normal:h1 later:" "$(queues "$MAIN")" "a split topic must sit right after its source"

  out=$(t find b)
  assert_equals "a　Alpha two（高）" "$(printf '%s\n' "$out" | head -n 1)" "find must lead with the topic b went into"
  assert_contains "$out" "「Beta」（b）併入「Alpha two」（用指令；原因：same work）" "find must say b was merged by a command, and why"
  out=$(t find --all a)
  printf '%s\n' "$out" | grep -E '^  [0-9]{4}-' | grep -vq '用指令' && fail "every history line must say a command made it: $out"
  assert_contains "$out" "用指令" "find --all must list the command-made history"
  pass "every topic command an agent runs works on the board alone"
}

test_summaries_with_nothing_connected() {
  local out started elapsed
  started=$(date +%s)
  out=$(printf '建好了。\n' | t summary t1 ready -) || fail "summary failed with nothing connected: $out"
  elapsed=$(($(date +%s) - started))
  assert_equals "議題不明（t1）：" "$out" "summary must fall back to the task id"
  [ "$elapsed" -le 15 ] || fail "summary took $elapsed seconds with nothing connected"
  assert_equals "議題不明（t1）：" "$(t which t1)" "which must fall back the same way"
  grep -q '"task":"t1"' "$MAIN/data/myshape/summaries.jsonl" || fail "the summary must be stored"
  printf '寫錯了\n' | t retract t1 ready - >/dev/null || fail "retract failed"
  assert_equals 0 "$(api_state "$MAIN" '[.summaries[]? | select(.task == "t1")] | length')" "retract must take the summary off the board"
  pass "summary, which, and retract work with nothing connected"
}

test_the_http_side() {
  local base token state
  base=$(base_url "$MAIN")
  token=$(cat "$MAIN/state/myshape/token")
  curl -s -m 20 -D "$TMP_ROOT/headers" -o /dev/null "$base/"
  grep -qi '^content-security-policy:' "$TMP_ROOT/headers" || fail "the page must carry its CSP header"
  assert_equals 200 "$(http_code "$base/")" "the page must load"
  assert_equals 401 "$(http_code "$base/api/state")" "the state needs the token"
  assert_equals 403 "$(http_code -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -H 'Origin: http://evil.example' -d '{}' "$base/api/refresh")" "a foreign Origin must be refused"
  assert_equals 403 "$(http_code -H 'Host: evil.example' "$base/")" "a foreign Host must be refused"
  assert_equals 403 "$(http_code -H 'Host: 127.0.0.1:1' "$base/")" "our address on another port must be refused"
  api "$MAIN" refresh '{}' >/dev/null
  sleep 2
  state=$(api_state "$MAIN")
  assert_equals "a a2 h2|h1|" "$(printf '%s' "$state" | jq -r '[.queues.high, .queues.normal, .queues.later] | map(join(" ")) | join("|")')" \
    "the state must carry the topics in their queues"
  assert_equals "main" "$(printf '%s' "$state" | jq -r '[.homes[].id] | join(" ")')" \
    "the board must know only home main, whatever firstmate's registry says"
  assert_not_contains "$state" "ship-a" "the board must not read firstmate's ledger"
  assert_equals "false|沒有 config/myshape-aggregator.json|null" \
    "$(printf '%s' "$state" | jq -r '"\(.aggregator.connected)|\(.aggregator.unavailable)|\(.homes[0].error)"')" \
    "home main must show only that nothing is connected: no binding"
  pass "the page's HTTP checks hold, and the board shows only its own data"
}

# A split that names tasks is a usage error of the board's split; the
# subcommands Firstmate took over are not the board's at all.
test_old_forms() {
  local form out rc
  rc=0
  out=$(t split a Part --goal g t1 2>&1) || rc=$?
  assert_equals 2 "$rc" "split with tasks must be a usage error"
  assert_contains "$out" "split 的用法：myshape.sh split <from> <name> --goal <…>" "split with tasks must get the board's usage line"
  for form in "tag t1 a" "--in-home sm1 tag t1 a" "setup" "install-rules" "order"; do
    rc=0
    # shellcheck disable=SC2086 # each form is a list of words.
    out=$(t $form 2>&1) || rc=$?
    assert_equals 2 "$rc" "'$form' must be a usage error"
    assert_contains "$out" "不認得的子命令" "'$form' must not be a subcommand of the board"
  done
  assert_absent "$MAIN/data/t1" "an old form must write no tag"
  pass "split with tasks gets the board's usage line, the subcommands Firstmate took over are unknown, and nothing is written"
}

# new_writes <ids-json>: the writes the board shows that are not in <ids-json>.
new_writes() {
  api_state "$MAIN" --argjson before "$1" '[.writes[] | select(.id as $id | $before | index($id) | not)]'
}

# waiting_ids: every write still waiting, oldest first, from the audit log.
waiting_ids() {
  api_state "$MAIN" '[.writes[] | select(.state == "waiting")] | sort_by(.created_at) | map(.id) | join(" ")'
}

# AT8.1: with nothing on the other side, every page action takes effect at once.
test_page_actions_complete_with_nothing_connected() {
  local code
  BEFORE_AT8=$(api_state "$MAIN" '[.writes[].id]')
  t create "One" --goal "g" --id one >/dev/null
  t create "Two" --goal "g" --id two >/dev/null
  t create "Three" --goal "g" --id three >/dev/null
  t create "Four" --goal "g" --id four >/dev/null
  t create "Five" --goal "g" --id five --queue later >/dev/null
  t create "Six" --goal "g" --id six --queue later >/dev/null
  t create "Seven" --goal "g" --id seven --queue later >/dev/null
  t close-propose four --reason "done?" >/dev/null
  code=$(api "$MAIN" topics/merge '{"from":"two","into":"one"}' | jq -r '.confirm')
  assert_equals true "$(api "$MAIN" topics/merge "{\"from\":\"two\",\"into\":\"one\",\"confirm\":\"$code\"}" | jq -r '.ok')" \
    "the second merge step must merge"
  assert_equals true "$(api "$MAIN" topics/archive '{"id":"three"}' | jq -r '.ok')" "archive must work"
  assert_equals true "$(api "$MAIN" topics/keep '{"id":"four"}' | jq -r '.ok')" "keep must work"
  assert_equals true "$(api "$MAIN" topics/move '{"id":"five","queue":"normal"}' | jq -r '.ok')" "move must work"
  api "$MAIN" messages '{"topic":"one","text":"先做這個"}' | jq -e '.write_id' >/dev/null || fail "a message must be accepted"
  api "$MAIN" topics/rename '{"id":"one","value":"One two"}' >/dev/null
  api "$MAIN" topics/goal '{"id":"one","value":"both"}' >/dev/null
  api "$MAIN" topics/reopen '{"id":"three","queue":"later"}' >/dev/null
  t todo add by-hand "手動" --topic one --do "做一下" >/dev/null || fail "todo add must work with nothing connected"
  t todo add old-hand "舊的" --topic one --do "做舊的" --captain-closes >/dev/null
  t todo obsolete old-hand --reason "不用了" >/dev/null
  code=$(api "$MAIN" todos/drop '{"task":"by-hand"}' | jq -r '.confirm')
  assert_equals true "$(api "$MAIN" todos/drop "{\"task\":\"by-hand\",\"confirm\":\"$code\"}" | jq -r '.ok')" "不做了 must work"
  code=$(api "$MAIN" todos/takedown '{"task":"old-hand"}' | jq -r '.confirm')
  assert_equals true "$(api "$MAIN" todos/takedown "{\"task\":\"old-hand\",\"confirm\":\"$code\"}" | jq -r '.ok')" "好，撤下 must work"
  assert_equals '{}' "$(jq -c '.items' "$MAIN/data/myshape/todos.json")" "不做了 and 好，撤下 must take effect at once"
  assert_equals "null|One two|both|null" \
    "$(jq -r '"\(.topics.two)|\(.topics.one.name)|\(.topics.one.goal)|\(.topics.four.close_proposal)"' "$MAIN/data/topics.json")" \
    "the merge, rename, goal and keep must take effect at once"
  assert_equals "three=later five=normal" \
    "$(t list --json | jq -r '[.[] | select(.id == "three" or .id == "five") | "\(.id)=\(.queue)"] | sort | reverse | join(" ")')" \
    "the reopen and the move must take effect at once"
  pass "with nothing connected every page action takes effect at once"
}

# AT8.2: nothing is shown as failed while nobody is there to receive it.
test_nothing_fails_with_nothing_connected() {
  local writes
  sleep 3.5
  writes=$(new_writes "$BEFORE_AT8")
  assert_equals 7 "$(printf '%s' "$writes" | jq 'length')" \
    "the merge, the archive, the keep, the message, 不做了, 好，撤下 and five's dispatchable notice are the seven writes"
  assert_equals "waiting:0" "$(printf '%s' "$writes" | jq -r 'map("\(.state):\(.attempt)") | unique | join(" ")')" \
    "every write must wait at attempt 0"
  assert_equals "message notice" "$(printf '%s' "$writes" | jq -r 'map(.kind) | unique | join(" ")')" \
    "the writes are a message and notices"
  assert_equals 0 "$(api_state "$MAIN" '[.writes[] | select(.state == "failed" or .state == "undelivered" or .state == "unknown")] | length')" \
    "no write may count as failed, undelivered or unknown"
  assert_equals "false|null" "$(api_state "$MAIN" '"\(.aggregator.connected)|\(.homes[0].error)"')" \
    "home main must show only the not-connected note"
  pass "with nothing connected the writes wait at attempt 0 and none counts as failed"
}

# AT8.3: the waiting writes and the delay before a dispatchable notice both
# survive the service dying.
test_waiting_survives_a_crash() {
  local waiting after
  waiting=$(waiting_ids)
  t stop >/dev/null
  sa_child_board "$MAIN"
  sa_crash_child "$MAIN"
  t open >/dev/null || fail "the next command must bring the board back"
  sleep 1.5
  assert_equals "$waiting" "$(waiting_ids)" "(a) the same writes must still wait after a crash and the resume window"
  assert_equals 0 "$(api_state "$MAIN" '[.writes[] | select(.state == "waiting" and .attempt != 0)] | length')" \
    "(a) a waiting write must stay at attempt 0"

  t stop >/dev/null
  sa_child_board "$MAIN"
  api "$MAIN" topics/move '{"id":"six","queue":"normal"}' >/dev/null
  sleep 1
  sa_crash_child "$MAIN"
  t open >/dev/null
  sleep 2.5
  after=$(api_state "$MAIN" '[.writes[] | select(.kind == "notice" and .topic == "six")] | length')
  assert_equals 1 "$after" "(b) six's notice must be recorded once its delay ends after a crash"

  api "$MAIN" topics/move '{"id":"seven","queue":"normal"}' >/dev/null
  t restart >/dev/null
  api "$MAIN" topics/move '{"id":"seven","queue":"later"}' >/dev/null
  sleep 2.5
  assert_equals 0 "$(api_state "$MAIN" '[.writes[] | select(.topic == "seven")] | length')" \
    "(c) a topic moved out and back across a restart must send nothing"
  pass "waiting writes and a pending dispatchable notice survive a crash and a restart"
}

# AT8.4: once an aggregator is there, it gets every waiting write once, in
# order: bound outside the root, at the page's confirmation, without a restart.
test_an_aggregator_receives_the_waiting_writes() {
  local waiting received later
  waiting=$(waiting_ids)
  sa_bind "$MAIN" "$(sa_install_stub plain "$AGG")"
  printf '{}\n' > "$AGG/plain/main.json"
  t open >/dev/null || fail "open with the binding failed"
  sleep 1
  assert_equals "" "$(jq -r -s 'map(.id) | join(" ")' "$AGG/received.jsonl")" \
    "a program outside the root must not get a write before the page confirms it"
  sa_confirm "$MAIN"
  sleep 2
  received=$(jq -r -s 'map(.id) | join(" ")' "$AGG/received.jsonl")
  assert_equals "$waiting" "$received" "every waiting write must reach the aggregator once, oldest first"
  assert_equals 0 "$(api_state "$MAIN" '[.writes[] | select(.state == "waiting")] | length')" "nothing may still wait"
  assert_equals "delivered" "$(api_state "$MAIN" --arg ids "$waiting" '[.writes[] | select(.id as $id | $ids | split(" ") | index($id))] | map(.state) | unique | join(" ")')" \
    "every released write must be delivered"
  later=$(api "$MAIN" messages '{"topic":"one","text":"之後的"}' | jq -r '.write_id')
  sleep 1
  assert_equals "$later" "$(jq -r -s 'last | .id' "$AGG/received.jsonl")" "a write made after connecting must come after them"
  t restart >/dev/null
  sleep 1.5
  assert_equals "$(( $(wc -w <<< "$waiting") + 1 ))" "$(grep -c '' "$AGG/received.jsonl")" \
    "another restart must send nothing again"
  pass "a connected aggregator receives every waiting write once, in record order, before newer ones"
}

# AT8.5: a connected aggregator's failures still show.
test_a_connected_aggregators_failures_show() {
  local failed tired
  printf '%s\n' '{"outcome":"failed","error":"refused by plain"}' > "$AGG/play"
  failed=$(api "$MAIN" messages '{"topic":"one","text":"會失敗"}' | jq -r '.write_id')
  sleep 1
  assert_equals "failed|refused by plain" \
    "$(api_state "$MAIN" --arg id "$failed" '.writes[] | select(.id == $id) | "\(.state)|\(.error)"')" \
    "a failed outcome must show as failed with its reason"
  printf '%s\n' '{"outcome":"retry"}' '{"outcome":"retry"}' '{"outcome":"retry"}' > "$AGG/play"
  tired=$(api "$MAIN" messages '{"topic":"one","text":"一直重試"}' | jq -r '.write_id')
  sleep 2
  assert_equals "undelivered" "$(api_state "$MAIN" --arg id "$tired" '.writes[] | select(.id == $id) | .state')" \
    "retries that run out must end undelivered"
  pass "with an aggregator connected, failures and spent retries still show"
}

test_status_and_stop() {
  local out port
  out=$(t status)
  assert_contains "$out" "看板服務：在跑" "status must report the running service"
  assert_contains "$out" "程式版本：$ROOT_COMMIT" "status must report the board-only root's commit"
  printf '%s\n' "$out" | grep -q '^規則' && fail "status must print no rules line, though captain.md holds a block"
  port=$(cat "$MAIN/config/myshape-port")
  t stop >/dev/null || fail "stop failed"
  assert_equals 0 "$(tb_board_count "$MAIN")" "stop must end the service"
  assert_equals "" "$(tb_listeners "$port")" "nothing may listen on the port after stop"
  pass "status reports the service and the root's commit, with no rules line, and stop stops it"
}

test_only_the_boards_files() {
  local file extra=""
  for file in data/topics.json data/topics-archive.json data/myshape/events.jsonl data/myshape/todos.json \
    data/myshape/summaries.jsonl data/myshape/notify-pending.json state/myshape/audit.jsonl state/myshape/port \
    state/myshape/service.log state/myshape/token; do
    assert_present "$MAIN/$file" "the board must have written $file"
  done
  assert_absent "$MAIN/state/myshape/pid" "stop must remove the pid file"
  assert_absent "$MAIN/state/myshape/board.sock" "stop must remove the socket"
  while IFS= read -r file; do
    case " $SA_DECOYS " in *" $file "*) continue ;; esac
    case "$file" in
      config/myshape-port | data/topics.json | data/topics-archive.json | data/myshape/events.jsonl | \
        data/myshape/summaries.jsonl | data/myshape/offsets.json | data/myshape/notify-pending.json | \
        data/myshape/aggregator.json | data/myshape/todos.json | data/myshape/decisions.json | \
        data/myshape/confirmations.json | config/myshape-aggregator.json | state/myshape/token | \
        state/myshape/port | state/myshape/service.log | state/myshape/service.log.1 | \
        state/myshape/audit.jsonl | state/myshape/startup-error) ;;
      *) extra+=" $file" ;;
    esac
  done <<< "$(cd "$MAIN" && find . -type f -o -type s | sed 's|^\./||' | sort)"
  assert_equals "" "$extra" "every file in the home must be a decoy or one of the board's own"
  sa_check_decoys "$MAIN"
  pass "the board wrote only its own files and left firstmate's untouched"
}

test_lifecycle() {
  local home pid token holder port out rc fake broken
  home=$(sa_home life)
  sa_decoys "$home"
  sa "$home" open >/dev/null || fail "open failed"
  pid=$(tb_board_pid "$home")
  token=$(cat "$home/state/myshape/token")
  sa "$home" restart >/dev/null || fail "restart failed"
  assert_not_equals "$pid" "$(tb_board_pid "$home")" "restart must start a new service"
  assert_equals "$token" "$(cat "$home/state/myshape/token")" "restart must keep the token"
  sa "$home" reset-token >/dev/null || fail "reset-token failed"
  assert_equals 401 "$(http_code -H "Authorization: Bearer $token" "$(base_url "$home")/api/state")" "the old token must stop working"
  assert_equals 200 "$(http_code -H "Authorization: Bearer $(cat "$home/state/myshape/token")" "$(base_url "$home")/api/state")" \
    "the new token must work"
  sa "$home" stop >/dev/null

  port=$(cat "$home/config/myshape-port")
  # The holder lets go by itself after 8 s, so a signal dry run, which ends nothing, still frees the port.
  node -e 'require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1"); setTimeout(() => process.exit(0), 8000);' "$port" &
  holder=$!
  sleep 0.5
  rc=0
  out=$(sa "$home" open 2>&1) || rc=$?
  kill_own_child "$holder"
  wait "$holder" 2>/dev/null
  assert_equals 69 "$rc" "open on a taken port must exit 69"
  assert_contains "$out" "埠 $port 被別的程式佔用" "open must say why it could not start"
  assert_present "$home/state/myshape/startup-error" "a failed start must leave its reason"
  sa "$home" open >/dev/null || fail "open must succeed once the port is free"
  assert_absent "$home/state/myshape/startup-error" "a good start must remove the old reason"
  sa "$home" stop >/dev/null

  fake=$TMP_ROOT/old-node
  mkdir -p "$fake"
  printf '#!/bin/sh\necho 20\n' > "$fake/node"
  chmod +x "$fake/node"
  rc=0
  out=$(SA_CMD_PATH="$fake:$SA_PATH" sa "$home" open 2>&1) || rc=$?
  assert_equals 69 "$rc" "open with node 20 must exit 69"
  assert_contains "$out" "node 版本低於 22" "open must say node is too old"

  broken=$TMP_ROOT/root/broken
  cp -R "$SA_ROOT" "$broken"
  rm "$broken/myshape/dist/board-server.js"
  rc=0
  out=$(SA_ROOT=$broken sa "$home" open 2>&1) || rc=$?
  assert_equals 69 "$rc" "a root without its build must exit 69"
  assert_contains "$out" "編譯結果不見了" "the missing build must be named"
  assert_not_contains "$out" "/updatefirstmate" "the board must not send the user to another tool"
  sa_check_decoys "$home"
  pass "restart, reset-token, a taken port, an old node, and a missing build behave on the board alone"
}

test_nothing_is_left() {
  sa_assert_no_boards
  sa_assert_no_trips
  pass "no board is left running and no Firstmate file was reached"
}

fm_test_run test_the_environment_is_hardened test_help_needs_nothing test_the_token_guard \
  test_open_and_the_running_service test_the_agents_topic_commands test_summaries_with_nothing_connected \
  test_the_http_side test_old_forms test_page_actions_complete_with_nothing_connected \
  test_nothing_fails_with_nothing_connected test_waiting_survives_a_crash \
  test_an_aggregator_receives_the_waiting_writes test_a_connected_aggregators_failures_show test_status_and_stop \
  test_only_the_boards_files test_lifecycle test_nothing_is_left
