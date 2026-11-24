#!/usr/bin/env bash
# The board tree loads no Firstmate file, holds no Firstmate words, knows no
# machine, and tells the dispatcher nothing (AT3 of the board-interface test
# plan, as it stands for B3):
#   - a static scan of the board's own files for Firstmate script and data
#     names, each allowed only on a line pinned below by file and exact text;
#   - a word scan of the string literals of myshape/src and the code lines of
#     bin/myshape.sh: no "first mate", "firstmate" or "/updatefirstmate";
#   - runs of stage-7-standalone.sh and stage-7-aggregator.sh with tripwires
#     named after every other Firstmate script and library, which must leave
#     the trip log empty, and a check that those tripwires do fire;
#   - two further homes that differ only in being called remote are read and
#     written alike, and no board type has a machine field;
#   - nothing in the command or its help that dictates what to dispatch.
# The board's unit tests (*.test.ts) are not in the name scan: the board never
# loads them. The word scan covers them too, with no exception.
# shellcheck disable=SC2016 # jq filters and the pinned lines are literal text.
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
TMP_ROOT=$(fm_test_tmproot tb-s7i)
case "$TMP_ROOT" in /*) ;; *) echo "not ok - no scratch root" >&2; exit 1 ;; esac
trap 'tb_stop_boards; sig_leftovers; fm_test_cleanup' EXIT
sig_init

FIRSTMATE_NAMES='fm-[A-Za-z0-9_-]+\.sh|secondmates\.md|captain(-shared)?\.md|fleet-ledger|\.fm-secondmate-home|backlog\.md|fm-hold-v1'

# The board tree: its command, its library, and everything the service and the
# page load.
board_files() {
  (cd "$ROOT" && { printf '%s\n' bin/myshape.sh bin/myshape-lib.sh
    find myshape/src myshape/public myshape/dist -type f ! -name '*.test.ts'; } | LC_ALL=C sort)
}

# scan: "<file>\t<line without leading blanks>" for every line of the board tree
# that names a Firstmate script or data file other than the board's own two.
scan() {
  local file hit line
  while IFS= read -r file; do
    while IFS= read -r hit; do
      line=${hit#*:}
      printf '%s' "$line" | grep -qE "$FIRSTMATE_NAMES" || continue
      printf '%s\t%s\n' "$file" "$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//')"
    done <<< "$(cd "$ROOT" && grep -nE "$FIRSTMATE_NAMES" "$file" || true)"
  done <<< "$(board_files)"
}

# The lines allowed to name a Firstmate file: none (AT3.1's empty allow-list).
# The service runs only the programs a home's binding file names, and the
# command no longer points at any Firstmate command, so the board's code names
# none. A line added here is one more that may.
pinned() {
  :
}

# The only code lines of the board's command that may name one of the names it
# read before it had its own: its refusal of FM_HOME and FM_ROOT_OVERRIDE.
old_name_lines() {
  cat <<'PINS'
refuse_old_name FM_HOME "${FM_HOME:-}" "${MYSHAPE_HOME:-}" MYSHAPE_HOME "$BOARD_HOME"
refuse_old_name FM_ROOT_OVERRIDE "${FM_ROOT_OVERRIDE:-}" "${MYSHAPE_ROOT_OVERRIDE:-}" \
PINS
}

test_the_scan_finds_only_pinned_lines() {
  local found new gone
  found=$(scan | LC_ALL=C sort)
  new=$(LC_ALL=C comm -23 <(printf '%s\n' "$found") <(pinned | LC_ALL=C sort))
  gone=$(LC_ALL=C comm -13 <(printf '%s\n' "$found") <(pinned | LC_ALL=C sort))
  assert_equals "" "$new" "a line of the board tree names a Firstmate file without being pinned"
  assert_equals "" "$gone" "a pinned line is gone; update the pinned list"
  assert_equals '. "$SCRIPT_DIR/myshape-lib.sh"' "$(cd "$ROOT" && grep -E '^[[:space:]]*(\.|source)[[:space:]]+["$]' bin/myshape.sh)" \
    "myshape.sh must source only myshape-lib.sh"
  assert_equals "" "$(cd "$ROOT" && grep -E '^[[:space:]]*(\.|source)[[:space:]]+["$]' bin/myshape-lib.sh || true)" \
    "myshape-lib.sh must source nothing"
  assert_equals "" "$(cd "$ROOT" && grep -rn 'FM_HOME' myshape/src || true)" "the board's code must not name FM_HOME"
  assert_equals "$(old_name_lines)" \
    "$(cd "$ROOT" && grep -h 'FM_' bin/myshape.sh bin/myshape-lib.sh | grep -vE '^[[:space:]]*#' | sed -E 's/^[[:space:]]+//' || true)" \
    "the board's command may name the names it read before only where it refuses them"
  pass "the board tree names Firstmate files only on the pinned lines, and its command sources only its own library"
}

# The scan must see a new name: plant one in a copy and look.
test_the_scan_catches_a_new_name() {
  local saved=$ROOT copy=$TMP_ROOT/scan-copy found
  mkdir -p "$copy/bin" "$copy/myshape"
  (cd "$ROOT" && cp bin/myshape.sh bin/myshape-lib.sh "$copy/bin/")
  cp -R "$ROOT/myshape/src" "$ROOT/myshape/public" "$ROOT/myshape/dist" "$copy/myshape/"
  printf '%s\n' '  "$SCRIPT_DIR/fm-fleet-snapshot.sh" --json' >> "$copy/bin/myshape.sh"
  printf '%s\n' 'const registry = "data/secondmates.md";' >> "$copy/myshape/src/poller.ts"
  ROOT=$copy
  found=$(scan | LC_ALL=C sort | LC_ALL=C comm -23 - <(pinned | LC_ALL=C sort))
  ROOT=$saved
  assert_contains "$found" "$(printf 'bin/myshape.sh\t"$SCRIPT_DIR/fm-fleet-snapshot.sh" --json')" "the scan must report a new script call"
  assert_contains "$found" "$(printf 'myshape/src/poller.ts\tconst registry = "data/secondmates.md";')" "the scan must report a new data name"
  pass "the scan reports a new Firstmate script or data name"
}

test_the_board_trips_no_wire() {
  local out rc script
  for script in stage-7-standalone.sh stage-7-aggregator.sh; do
    rc=0
    out=$(TB_STAGE7_TRIPWIRES=1 "${BASH:-bash}" "$ROOT/myshape/test/$script" 2>&1) || rc=$?
    assert_equals 0 "$rc" "$script must pass with tripwires around the board: $out"
    assert_contains "$out" "ok - no board is left running and no Firstmate file was reached" "the tripwire run of $script must check its log"
  done
  pass "the board's command and service, alone and with stub aggregators, run beside tripwires for every other Firstmate file and trip none"
}

# literal_words <file-or-directory>: every string literal of the .ts files
# there that names Firstmate (myshape/test/word-scan.mjs). The scan also must
# have read every file to its end.
literal_words() {
  local unread
  unread=$(node "$ROOT/myshape/test/word-scan.mjs" "$ROOT/myshape/node_modules/typescript" "$1" check)
  [ -z "$unread" ] || fail "the word scan did not read every file to its end: $unread"
  node "$ROOT/myshape/test/word-scan.mjs" "$ROOT/myshape/node_modules/typescript" "$1"
}

# AT3.1b: the words the board shows, sends and stores.
test_no_firstmate_words() {
  local found
  found=$(literal_words "$ROOT/myshape/src")
  assert_equals "" "$found" "no string literal of the board's code may name Firstmate"
  found=$(cd "$ROOT" && grep -nEi 'first mate|firstmate|/updatefirstmate' bin/myshape.sh | grep -vE '^[0-9]+:[[:space:]]*#' || true)
  assert_equals "" "$found" "no code line of myshape.sh may name Firstmate"
  pass "the board's texts name no Firstmate, with no exception (AT3.1b)"
}

# The word scan must see a word in a string, also inside a template and after
# a regular expression, and skip a comment.
test_the_word_scan_catches_a_word() {
  local copy=$TMP_ROOT/word-copy found
  mkdir -p "$copy"
  printf '%s\n' 'const a = `會通知 ${x} 和 first mate`;' '// a comment about firstmate' 'const b = { c: "x" };' \
    'const r = /[`"]/.test(a);' 'const d = "給 first mate";' > "$copy/a.ts"
  found=$(literal_words "$copy/a.ts" | sed 's|^.*: ||')
  assert_equals "$(printf '%s\n' ' 和 first mate' '給 first mate')" "$found" "the scan must find both strings and skip the comment"
  pass "the word scan reports Firstmate's name in a string and only there"
}

# AT3.5: no type of the board's has a machine field, and the feed schema documents none.
test_no_machine_field() {
  local found
  found=$(cd "$ROOT/myshape/src" && grep -nE '^[[:space:]]*(readonly[[:space:]]+)?(remote|machine|host|placement)\??:' \
    report.ts view.ts topics.ts writes.ts actions.ts poller.ts commands.ts binding.ts confirmations.ts || true)
  assert_equals "" "$found" "no board type may have a remote, machine, host or placement field"
  found=$(awk '/^## 4\. /{on=1; next} /^## /{on=0} on' "$ROOT/myshape/spec/contracts.markdown" | grep -nE '"(remote|machine|host|placement)"' || true)
  assert_equals "" "$found" "the feed schema must document no machine field"
  pass "no board type or feed field knows a machine (AT3.5)"
}

# AT3.4: two further homes that differ only in what the aggregator calls them.
remote_post() {  # <route> <json body>
  local base
  base="http://127.0.0.1:$(cat "$REMOTE_HOME/config/myshape-port")"
  curl -s -m 20 -H "Authorization: Bearer $(cat "$REMOTE_HOME/state/myshape/token")" -H "Origin: $base" \
    -H 'Content-Type: application/json' -d "$2" "$base/api/$1"
}

remote_state() {  # [jq arguments...] <jq filter>
  curl -s -m 20 -H "Authorization: Bearer $(cat "$REMOTE_HOME/state/myshape/token")" \
    "http://127.0.0.1:$(cat "$REMOTE_HOME/config/myshape-port")/api/state" | jq -c -r "$@"
}

feeds() {  # <agg-dir> <home>
  awk -v home="$2" '$1 == "feed" && $2 == home' "$1/calls.log" | wc -l | tr -d ' '
}

test_remote_means_nothing_to_the_board() {
  local agg=$TMP_ROOT/agg-remote a b code
  sa_init
  mkdir -p "$TMP_ROOT/remote"
  SA_ROOT=$TMP_ROOT/remote/board
  tb_make_board_root "$SA_ROOT" >/dev/null
  SA_ENV=(MYSHAPE_TEST=1 MYSHAPE_READ_MS=300 "MYSHAPE_RETRY_MS=100" MYSHAPE_STALE_MS=600000 MYSHAPE_IDLE_MS=600000)
  REMOTE_HOME=$(sa_home remote-main)
  sa_bind "$REMOTE_HOME" "$(sa_install_stub fm "$agg")"
  jq '.secondmates = [{id: "h1", remote: false, read_every_s: 1, read_timeout_s: 1}, {id: "h2", remote: true, read_every_s: 1, read_timeout_s: 1}]' \
    "$ROOT/myshape/test/contract/report-main.json" > "$agg/fm/main.json"
  for a in h1 h2; do
    jq '.tasks = [{id: "w", kind: "ship", state: "working", source: "", detail: ""}]
      | .holds = [{id: "c", title: "T", question: "Q", hold_bucket: "live", hold_until: null, unresolved_blocker_ids: [],
                   hold_age_days: 0, origin: "", on_answer: "close"}]' "$ROOT/myshape/test/contract/report-sm1.json" > "$agg/fm/$a.json"
  done
  sa "$REMOTE_HOME" open >/dev/null || fail "the board did not start"
  sa_confirm "$REMOTE_HOME"
  sa "$REMOTE_HOME" create T --goal g --id t >/dev/null
  remote_post refresh '{}' >/dev/null
  sleep 7
  a=$(feeds "$agg" h1)
  b=$(feeds "$agg" h2)
  [ "$a" -ge 5 ] && [ $((a - b)) -le 1 ] && [ $((b - a)) -le 1 ] || fail "(a) both homes must be read at the same interval: h1 $a, h2 $b"

  printf 'sleep 3\n' > "$agg/control/h1"
  printf 'sleep 3\n' > "$agg/control/h2"
  remote_post refresh '{}' >/dev/null
  sleep 2
  a=$(remote_state '.homes[] | select(.id == "h1") | .error' | sed 's/ h1 / <home> /')
  [ "$a" != null ] || fail "(b) the short timeout must cut the read"
  assert_equals "$a" "$(remote_state '.homes[] | select(.id == "h2") | .error' | sed 's/ h2 / <home> /')" \
    "(b) both homes must time out with the same error, apart from their id"
  rm "$agg/control/h1" "$agg/control/h2"
  sleep 3

  : > "$agg/received.jsonl"
  for a in h1 h2; do
    code=$(remote_post holds/answer "{\"home\":\"$a\",\"task\":\"c\",\"answer\":\"x\",\"label\":\"x\"}" | jq -r '.confirm')
    remote_post holds/answer "{\"home\":\"$a\",\"task\":\"c\",\"answer\":\"x\",\"label\":\"x\",\"confirm\":\"$code\"}" >/dev/null
    remote_post agents/tag "{\"home\":\"$a\",\"task\":\"w\",\"topic\":\"t\"}" >/dev/null
    remote_post direct "{\"home\":\"$a\",\"task\":\"w\",\"text\":\"hi\"}" >/dev/null
  done
  sleep 2
  assert_equals "$(jq -c -s '[.[] | select(.home == "h1") | del(.id, .home)]' "$agg/received.jsonl")" \
    "$(jq -c -s '[.[] | select(.home == "h2") | del(.id, .home)]' "$agg/received.jsonl")" "(c) the records must be identical apart from home"
  assert_equals 6 "$(grep -c '' "$agg/received.jsonl")" "(c) an answer, a filing and a direct message to each home"
  assert_equals 0 "$(grep -cE '"(remote|placement|machine|host)"' "$agg/received.jsonl" || true)" "(f) no action record may carry a placement"

  printf '%s\n' 'sleep 3 {"outcome":"delivered"}' 'sleep 3 {"outcome":"delivered"}' > "$agg/play"
  a=$(remote_post direct '{"home":"h1","task":"w","text":"in flight"}' | jq -r '.write_id')
  b=$(remote_post direct '{"home":"h2","task":"w","text":"in flight"}' | jq -r '.write_id')
  sleep 1
  sa "$REMOTE_HOME" restart >/dev/null
  sleep 3.5
  assert_equals "unknown unknown" "$(remote_state --arg a "$a" --arg b "$b" '[.writes[] | select(.id == $a or .id == $b) | .state] | join(" ")')" \
    "(d) a direct message in flight to either home must become uncertain"

  printf 'exit4 cannot report\n' > "$agg/control/h1"
  printf 'exit4 cannot report\n' > "$agg/control/h2"
  remote_post refresh '{}' >/dev/null
  sleep 2
  assert_equals "$(remote_state '.homes[] | select(.id == "h1") | del(.id, .last_ok_seconds_ago)')" \
    "$(remote_state '.homes[] | select(.id == "h2") | del(.id, .last_ok_seconds_ago)')" "(e) exit 4 must give both the same banner form"
  assert_equals "$(remote_state '.homes[] | select(.id == "h1") | keys')" "$(remote_state '.homes[] | select(.id == "h2") | keys')" \
    "(f) both homes must have the same keys"
  assert_equals false "$(remote_state '[.homes[] | has("remote")] | any')" "(f) no home may carry remote"
  rm "$agg/control/h1" "$agg/control/h2"

  jq '.secondmates = [{id: "h1", remote: false, read_every_s: 1}, {id: "h2", remote: true, read_every_s: 3}]' \
    "$agg/fm/main.json" > "$agg/fm/main.tmp" && mv "$agg/fm/main.tmp" "$agg/fm/main.json"
  remote_post refresh '{}' >/dev/null
  sleep 1
  : > "$agg/calls.log"
  sleep 6.2
  a=$(feeds "$agg" h1)
  b=$(feeds "$agg" h2)
  [ "$a" -ge 5 ] && [ "$b" -ge 1 ] && [ "$b" -le 3 ] || fail "the intervals must follow the hints: h1 $a reads, h2 $b reads in 6 s"
  sa "$REMOTE_HOME" stop >/dev/null
  pass "two homes differing only in remote are read, timed out, written, settled and shown alike, and follow their own hints (AT3.4)"
}

# The tripwires must fire: a board-only root whose command sources a Firstmate
# library and runs a Firstmate script through PATH trips both.
test_the_tripwires_fire() {
  local home
  sa_init
  SA_ROOT=$TMP_ROOT/trip/board
  mkdir -p "$TMP_ROOT/trip"
  tb_make_board_root "$SA_ROOT" >/dev/null
  sa_trip_root "$SA_ROOT"
  sed -i.bak 's|^\. "\$SCRIPT_DIR/myshape-lib.sh"$|&\n. "$SCRIPT_DIR/fm-primary-scope-lib.sh"\nfm-fleet-snapshot.sh --json >/dev/null 2>\&1 \|\| true|' \
    "$SA_ROOT/bin/myshape.sh"
  home=$(sa_home trip-home)
  sa "$home" --help >/dev/null 2>&1 || true
  assert_grep 'sourced fm-primary-scope-lib.sh' "$SA_TRIP_LOG" "a sourced Firstmate library must trip its wire"
  assert_grep 'ran fm-fleet-snapshot.sh --json' "$SA_TRIP_LOG" "a Firstmate script found through PATH must trip its wire"
  pass "the tripwires catch a sourced library and a script found through PATH"
}

test_nothing_dictates_the_dispatcher() {
  local out
  assert_equals "" "$(cd "$ROOT" && board_files | xargs grep -nE 'fm-tasks-axi|fm-spawn|unhold|--reason "看板佇列：' || true)" \
    "the board tree must not name the dispatcher's commands"
  assert_equals "" "$(cd "$ROOT" && grep -nE '(^|[^a-z-])order\)' bin/myshape.sh || true)" \
    "order must not be a subcommand of the board's command"
  # The tripwire test above left a board-only root and a home behind.
  out=$(sa "$TMP_ROOT/trip-home" --help)
  assert_equals "" "$(printf '%s\n' "$out" | grep -E '^  myshape\.sh (order|hold|unhold|dispatch)' || true)" \
    "--help must list no dispatch subcommand"
  assert_not_contains "$out" "fm-dispatch-plan" "--help must name no dispatch command"
  assert_not_contains "$out" "fm-tasks-axi" "--help must name no backlog command"
  pass "nothing in the board's command or help dictates what to dispatch"
}

fm_test_run test_the_scan_finds_only_pinned_lines test_the_scan_catches_a_new_name test_no_firstmate_words \
  test_the_word_scan_catches_a_word test_no_machine_field test_the_board_trips_no_wire \
  test_the_tripwires_fire test_nothing_dictates_the_dispatcher test_remote_means_nothing_to_the_board
