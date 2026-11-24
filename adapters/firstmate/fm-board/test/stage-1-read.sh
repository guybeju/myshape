#!/usr/bin/env bash
# Behavior of fm-topic-board-read.sh against the real fm-fleet-snapshot.sh.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=fm-board/test/helpers.sh
. "$ROOT/fm-board/test/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot myshape-stage-1-read)

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

write_fleet() {
  local home=$1
  cat > "$home/data/backlog.md" <<'EOF'
## In flight
- [ ] run-a - Running A (repo: sample) (kind: ship) (since 2026-07-07)

## Queued
- [ ] live-hold - Live call (repo: sample) (kind: captain) (hold: choose a route) (hold-kind: captain)
  Captain hold set: 2026-07-20T00:00:00Z
  Captain hold origin: run-a
  Captain hold on answer: release
- [ ] dated-hold - Dated call (repo: sample) (kind: captain) (hold: revisit later) (hold-kind: captain) (hold-until: 2026-12-01)
  Captain hold set: 2026-07-20T00:00:00Z
  Captain hold on answer: later
- [ ] plain-hold - Not a captain hold (repo: sample) (kind: ship) (hold: waiting for a vendor)
- [ ] queued - Plain queued (repo: sample) (kind: ship)
- [ ] handed - Handed off (repo: sample) (kind: ship)
  Some context for the mate.
  topic: billing

## Done
EOF
  mkdir -p "$home/projects/w" "$home/data/run-a"
  fm_write_meta "$home/state/run-a.meta" "window=firstmate:fm-run-a" "worktree=$home/projects/w" \
    "project=sample" "harness=claude" "kind=ship" "mode=ship" "yolo=off"
  printf 'needs-decision: choose an API shape\n' > "$home/state/run-a.status"
  printf 'billing 2026-07-01T00:00:00Z\nt2 2026-07-02T00:00:00Z\n' > "$home/data/run-a/topic"
}

read_board() {  # <home> <args...>
  local home=$1
  shift
  FM_SNAPSHOT_NOW=2026-07-25T00:00:00Z tb_run "$home" "$BOARD_READ" "$@"
}

test_first_read_reports_the_whole_home() {
  local home out
  home=$(tb_make_home read-full)
  write_fleet "$home"
  out=$(read_board "$home" 0 -) || fail "first read failed"
  assert_equals 1 "$(printf '%s' "$out" | jq -r '.schema')" "schema must be 1"
  assert_equals "$(git -C "$ROOT" rev-parse HEAD)" "$(printf '%s' "$out" | jq -r '.code_commit')" \
    "code_commit must be the code root's commit"
  assert_equals false "$(printf '%s' "$out" | jq -r '.ledger_enabled')" "ledger must be reported closed"
  assert_equals absent "$(printf '%s' "$out" | jq -r '.ledger.status')" "a missing ledger must be absent"
  assert_equals 'run-a|ship|unknown|false' \
    "$(printf '%s' "$out" | jq -r '.tasks[] | "\(.id)|\(.kind)|\(.state)|\(.unstarted)"')" \
    "tasks must carry id, kind, state, and whether the harness is still on its spawn seed"
  assert_equals 'live-hold|live|run-a|choose a route|Live call' \
    "$(printf '%s' "$out" | jq -r '.holds[] | select(.id == "live-hold") | "\(.id)|\(.hold_bucket)|\(.origin)|\(.question)|\(.title)"')" \
    "a live captain hold must carry its bucket, origin, question, and title"
  assert_equals 'dated|2026-12-01|' \
    "$(printf '%s' "$out" | jq -r '.holds[] | select(.id == "dated-hold") | "\(.hold_bucket)|\(.hold_until)|\(.origin)"')" \
    "a dated captain hold must carry its date and an empty origin"
  assert_equals 'live-hold=release dated-hold=null' \
    "$(printf '%s' "$out" | jq -r '[.holds[] | "\(.id)=\(.on_answer)"] | join(" ")')" \
    "a hold must report its recorded answer outcome, and null for none or an unknown value"
  assert_equals 2 "$(printf '%s' "$out" | jq -r '.holds | length')" "only captain holds belong in holds[]"
  assert_equals 'live-hold|captain|Live call|choose a route|true dated-hold|captain|Dated call|revisit later|true plain-hold|ship|Not a captain hold|waiting for a vendor|false queued|ship|Plain queued||false handed|ship|Handed off||false ' \
    "$(printf '%s' "$out" | jq -r '.queued[] | "\(.id)|\(.kind)|\(.title)|\(.hold // "")|\(.captain)"' | tr '\n' ' ')" \
    "queued[] must list every queued backlog item with its title, hold reason, and whether the hold is the captain's"
  assert_equals '[]' "$(printf '%s' "$out" | jq -c '[.queued[] | select(.id == "run-a")]')" "an in-flight item is not queued"
  assert_equals 'queued=null handed=billing' \
    "$(printf '%s' "$out" | jq -r '[.queued[] | select(.id == "handed" or .id == "queued") | "\(.id)=\(.topic_hint)"] | join(" ")')" \
    "queued[] must carry the topic named on a \"topic:\" line of the item's body, and null without one"
  assert_equals 'run-a|default|choose an API shape' \
    "$(printf '%s' "$out" | jq -r '.status_decisions[] | "\(.id)|\(.key)|\(.summary)"')" \
    "a worker needs-decision must be listed"
  assert_equals "$(cat "$home/data/run-a/topic")" "$(printf '%s' "$out" | jq -r '.topics["run-a"]')" \
    "topics must carry each tag file verbatim"
  assert_equals '[]' "$(printf '%s' "$out" | jq -c '.secondmates')" "a main home with no registry has no secondmates"
  pass "the first read reports tasks, captain holds, worker questions, tags, and versions"
}

test_ledger_delta_and_continuity() {
  local home ledger out offset sha
  home=$(tb_make_home read-ledger)
  ledger="$home/state/fleet-ledger.jsonl"
  : > "$home/config/fleet-ledger"
  printf '%s\n' '{"v":1,"ts":"t1","event":"task.dispatched","task":"a"}' \
    '{"v":1,"ts":"t2","event":"task.status","task":"a"}' > "$ledger"
  printf '%s' '{"v":1,"ts":"t3","event":"task.sta' >> "$ledger"
  out=$(read_board "$home" 0 -) || fail "ledger read failed"
  assert_equals true "$(printf '%s' "$out" | jq -r '.ledger_enabled')" "ledger must be reported open"
  assert_equals 'delta|2|false' \
    "$(printf '%s' "$out" | jq -r '.ledger | "\(.status)|\(.lines | length)|\(.more)"')" \
    "only complete lines may be returned, and a half line is not more data"
  assert_equals '{"v":1,"ts":"t2","event":"task.status","task":"a"}' \
    "$(printf '%s' "$out" | jq -r '.ledger.lines[1]')" "lines must be returned verbatim"
  offset=$(printf '%s' "$out" | jq -r '.ledger.to_offset')
  sha=$(printf '%s' "$out" | jq -r '.ledger.to_prefix_sha256')
  assert_equals "$(head -n 2 "$ledger" | wc -c | tr -d ' ')" "$offset" "to_offset must stop after the last complete line"
  assert_equals "$(head -n 2 "$ledger" | sha_of)" "$sha" "to_prefix_sha256 must hash the consumed prefix"

  printf '%s\n' 'tus","task":"a"}' '{"v":1,"ts":"t4","event":"task.merged","task":"a"}' >> "$ledger"
  out=$(read_board "$home" "$offset" "$sha") || fail "delta read failed"
  assert_equals 'delta|2' "$(printf '%s' "$out" | jq -r '.ledger | "\(.status)|\(.lines | length)"')" \
    "the next read must return only the new complete lines"
  assert_equals '{"v":1,"ts":"t3","event":"task.status","task":"a"}' \
    "$(printf '%s' "$out" | jq -r '.ledger.lines[0]')" "the completed half line must come back whole"
  assert_equals "$(wc -c < "$ledger" | tr -d ' ')" "$(printf '%s' "$out" | jq -r '.ledger.to_offset')" \
    "to_offset must reach the end of the file"

  out=$(read_board "$home" "$offset" "$(printf 'x' | sha_of)") || fail "mismatched-prefix read failed"
  assert_equals continuity-broken "$(printf '%s' "$out" | jq -r '.ledger.status')" \
    "a prefix hash mismatch must break continuity"
  printf '%s\n' '{"v":1,"ts":"n1","event":"task.dispatched","task":"b"}' > "$ledger"
  out=$(read_board "$home" "$offset" "$sha") || fail "truncated-ledger read failed"
  assert_equals 'continuity-broken|0' \
    "$(printf '%s' "$out" | jq -r '.ledger | "\(.status)|\(.lines | length)"')" \
    "a ledger shorter than the offset must break continuity and return nothing"
  out=$(read_board "$home" 5 -) || fail "offset-without-hash read failed"
  assert_equals continuity-broken "$(printf '%s' "$out" | jq -r '.ledger.status')" \
    "a non-zero offset without a prefix hash must break continuity"
  pass "ledger reads are incremental, verbatim, and detect a rewritten ledger"
}

# A ledger far larger than one read: whatever feeds the first piece is cut off
# mid-write when the piece is full, and that must not fail the read.
test_a_very_large_ledger_can_be_read() {
  local home ledger out
  home=$(tb_make_home read-huge)
  ledger="$home/state/fleet-ledger.jsonl"
  awk 'BEGIN { for (i = 0; i < 60000; i++) printf "{\"v\":1,\"ts\":\"t\",\"event\":\"task.status\",\"task\":\"t%d\",\"pad\":\"%0100d\"}\n", i, 0 }' > "$ledger"
  out=$(read_board "$home" 0 -) || fail "the first read of a very large ledger failed"
  assert_equals 'delta|true' "$(printf '%s' "$out" | jq -r '.ledger | "\(.status)|\(.more)"')" \
    "the first read must return a piece and say there is more"
  awk 'BEGIN { printf "{\"pad\":\"%0400000d\"}\n", 0; for (i = 0; i < 60000; i++) printf "{\"pad\":\"%0100d\"}\n", 0 }' > "$ledger"
  out=$(read_board "$home" 0 -) || fail "reading a line longer than one piece, with much more after it, failed"
  assert_equals 1 "$(printf '%s' "$out" | jq -r '.ledger.lines | length')" "the over-long line must come back whole, by itself"
  pass "a ledger many times the size of one read is still read"
}

test_large_ledger_is_read_in_bounded_pieces() {
  local home ledger out offset sha total=0 rounds=0 lines
  home=$(tb_make_home read-large)
  ledger="$home/state/fleet-ledger.jsonl"
  awk 'BEGIN { for (i = 0; i < 4000; i++) printf "{\"v\":1,\"ts\":\"t\",\"event\":\"task.status\",\"task\":\"t%d\",\"pad\":\"%0100d\"}\n", i, 0 }' > "$ledger"
  offset=0
  sha=-
  while :; do
    out=$(read_board "$home" "$offset" "$sha") || fail "large read failed"
    lines=$(printf '%s' "$out" | jq -r '.ledger.lines | length')
    [ "$(printf '%s' "$out" | jq -r '.ledger.lines | map(length + 1) | add // 0')" -le 262144 ] ||
      fail "one read returned more than 256 KiB of ledger"
    total=$((total + lines))
    rounds=$((rounds + 1))
    offset=$(printf '%s' "$out" | jq -r '.ledger.to_offset')
    sha=$(printf '%s' "$out" | jq -r '.ledger.to_prefix_sha256')
    [ "$(printf '%s' "$out" | jq -r '.ledger.more')" = true ] || break
    [ "$rounds" -lt 20 ] || fail "more never became false"
  done
  assert_equals 4000 "$total" "following more must return every line exactly once"
  [ "$rounds" -gt 1 ] || fail "a ledger over 256 KiB must take more than one read"
  pass "a large ledger is returned in pieces of at most 256 KiB"
}

test_secondmates_and_in_home() {
  local home sm out
  home=$(tb_make_home read-main)
  sm=$(tb_make_secondmate_home read-sm sm1)
  tb_write_registry "$home" "$sm"
  write_fleet "$sm"
  out=$(read_board "$home" 0 -) || fail "main read failed"
  assert_equals "sm1|false|$sm far1|true|/srv/fm-home" \
    "$(printf '%s' "$out" | jq -r '[.secondmates[] | "\(.id)|\(.remote)|\(.home)"] | join(" ")')" \
    "the main home must list every registered secondmate"
  assert_equals 0 "$(printf '%s' "$out" | jq -r '.holds | length')" "the main home must not report another home's holds"
  out=$(read_board "$home" --in-home sm1 0 -) || fail "--in-home read failed"
  assert_equals 2 "$(printf '%s' "$out" | jq -r '.holds | length')" "--in-home must read the secondmate home"
  assert_equals false "$(printf '%s' "$out" | jq -r 'has("secondmates")')" "a secondmate home must not output secondmates"
  expect_code 1 "$(tb_code "$home" "$BOARD_READ" --in-home far1 0 -)" "--in-home with a remote secondmate"
  expect_code 1 "$(tb_code "$home" "$BOARD_READ" --in-home nobody 0 -)" "--in-home with an unknown secondmate"
  fm_git_init_commit "$sm"
  assert_equals "$(git -C "$sm" rev-parse HEAD)" "$(read_board "$home" --in-home sm1 0 - | jq -r '.code_commit')" \
    "a home that is its own checkout must report its own commit, not the reading home's"
  pass "the main home lists secondmates and --in-home reads a local secondmate home"
}

test_usage_and_failure() {
  local home root out
  home=$(tb_make_home read-usage)
  expect_code 2 "$(tb_code "$home" "$BOARD_READ")" "no arguments"
  expect_code 2 "$(tb_code "$home" "$BOARD_READ" -1 -)" "a negative offset"
  expect_code 2 "$(tb_code "$home" "$BOARD_READ" 0 nothex)" "a malformed prefix hash"
  expect_code 2 "$(tb_code "$home" "$BOARD_READ" 0 - extra)" "an extra argument"
  root="$TMP_ROOT/read-root"
  mkdir -p "$root/bin"
  cp "$ROOT"/bin/fm-topic-board-read.sh "$ROOT"/bin/myshape-lib.sh "$ROOT"/bin/fm-board-lib.sh \
    "$ROOT"/bin/fm-primary-scope-lib.sh "$ROOT"/bin/fm-secondmate-registry-lib.sh "$ROOT"/bin/fm-tasks-axi-lib.sh "$root/bin/"
  printf '#!/usr/bin/env bash\necho partial\nexit 1\n' > "$root/bin/fm-fleet-snapshot.sh"
  chmod +x "$root/bin/fm-fleet-snapshot.sh"
  out=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$root" "$root/bin/fm-topic-board-read.sh" 0 - 2>/dev/null) &&
    fail "a failed snapshot must fail the read"
  assert_equals "" "$out" "a failed read must not print partial JSON"
  pass "bad arguments are usage errors and a failed snapshot prints nothing"
}

test_a_spawn_seeded_worker_is_unstarted() {
  local home root
  home=$(tb_make_home read-unstarted)
  write_fleet "$home"
  root="$TMP_ROOT/read-unstarted-root"
  mkdir -p "$root/bin"
  cp "$ROOT"/bin/fm-topic-board-read.sh "$ROOT"/bin/myshape-lib.sh "$ROOT"/bin/fm-board-lib.sh \
    "$ROOT"/bin/fm-primary-scope-lib.sh "$ROOT"/bin/fm-secondmate-registry-lib.sh "$ROOT"/bin/fm-tasks-axi-lib.sh "$root/bin/"
  tb_seed_unstarted "$root" run-a
  assert_equals 'run-a|working|true' \
    "$(FM_HOME="$home" FM_ROOT_OVERRIDE="$root" "$root/bin/fm-topic-board-read.sh" 0 - |
      jq -r '.tasks[] | "\(.id)|\(.state)|\(.unstarted)"')" \
    "a worker still on fm-spawn's busy seed has not started"
  pass "a worker whose harness never took its first turn is reported as unstarted"
}

# bash 3.2 (the /bin/bash of macOS) reads the bytes of a non-ASCII character
# that directly follows "$name" as part of the name, and then fails on an
# unbound variable. Linux cannot show that failure, so the shape is checked.
# The board's own two scripts have the same check in myshape/test/stage-1-topic.sh.
test_variables_are_braced_before_wide_characters() {
  local hits
  hits=$(LC_ALL=C grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~]' "$ROOT/bin/fm-topic-board-read.sh" || true)
  assert_equals "" "$hits" "fm-topic-board-read.sh: write \${name} when a non-ASCII character follows the variable"
  pass "no variable is directly followed by a non-ASCII character"
}

fm_test_run test_first_read_reports_the_whole_home test_ledger_delta_and_continuity \
  test_a_very_large_ledger_can_be_read test_large_ledger_is_read_in_bounded_pieces \
  test_secondmates_and_in_home test_usage_and_failure \
  test_a_spawn_seeded_worker_is_unstarted test_variables_are_braced_before_wide_characters
