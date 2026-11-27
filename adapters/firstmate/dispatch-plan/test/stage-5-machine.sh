#!/usr/bin/env bash
# fm-dispatch-plan.sh machine: this machine's record, fm-dispatch-machine.v1,
# from upstream's own probes and libraries over scratch homes, with the host
# the helpers pin. Every call runs from a scratch code root, so a test may give
# it its own tool list.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "skip: git not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot dispatch-plan-stage-5-machine)
# shellcheck source=dispatch-plan/test/helpers.sh
. "$ROOT/dispatch-plan/test/helpers.sh"

# machine <home> <arg>...: run machine in <home> from the scratch code root,
# on the pinned host.
machine() {
  FM_HOME="$1" FM_ROOT_OVERRIDE="$CODE" dp_on_host "$CODE/bin/fm-dispatch-plan.sh" machine "${@:2}"
}

# A main home with a capped project "sample" (3 places), one local secondmate,
# a one-tool list (so no test runs every tool on the runner), and these task
# records, all of project sample:
#   main/w1  ship, paused in the summary, high effort, direct-PR
#   main/w2  scout, working, xhigh
#   main/w3  ship whose PR is ready: it holds no place
#   main/sm1 the secondmate's own record: a home, not a worker
#   sm1/m1   ship, with no summary entry
# Sets MAIN and MATE.
setup_machine() {
  local name=$1 now
  now=$(date +%s)
  dp_code_root "$TMP_ROOT/$name-code"
  printf 'jq\t-\n' > "$CODE/dispatch-plan/common-tools.tsv"
  MAIN=$(tb_make_home "$name-main")
  dp_git_dir "$MAIN"
  dp_git_dir "$MAIN/projects/sample"
  tb_write_topics "$MAIN"
  printf '# places per project\nsample 3\n' > "$MAIN/config/project-capacity"
  MATE=$(dp_make_local_mate "$name-sm1" sm1 "$MAIN")
  printf -- '- sm1 - Local helper (home: %s; scope: sample work; projects: sample; added 2026-11-01)\n' "$MATE" \
    > "$MAIN/data/secondmates.md"
  dp_meta "$MAIN" w1 kind=ship "project=$MAIN/projects/sample" "spawn_gen=s$((now - 3600)).1" effort=high model=opus mode=direct-PR
  dp_meta "$MAIN" w2 kind=scout "project=$MAIN/projects/sample" "spawn_gen=s$((now - 600)).1" effort=xhigh model=default
  dp_meta "$MAIN" w3 kind=ship "project=$MAIN/projects/sample" pr=https://example.invalid/pr/1 effort=default
  dp_meta "$MAIN" sm1 kind=secondmate "project=$MATE"
  dp_meta "$MATE" m1 kind=ship "project=$MAIN/projects/sample" effort=low
  dp_summary "$MAIN" 40 w1:paused w2:working w3:working
  cat > "$MAIN/data/backlog.md" <<'EOF'
## In flight

## Queued
- [ ] h1 - High one (repo: sample) (kind: ship)
- [ ] d1 - Decided call (repo: sample) (kind: captain)

## Done
EOF
  mkdir -p "$MAIN/data/h1"
  printf 'billing 2026-07-01T00:00:00Z\n' > "$MAIN/data/h1/topic"
  printf '## In flight\n\n## Queued\n- [ ] s1 - Mate work (repo: sample) (kind: ship)\n  topic: t2\n\n## Done\n' \
    > "$MATE/data/backlog.md"
}

test_record_describes_the_machine() {
  local out
  setup_machine record
  out=$(machine "$MAIN" --json 2> "$TMP_ROOT/record.err") || fail "machine --json failed"
  assert_equals "" "$(cat "$TMP_ROOT/record.err")" "machine --json must not write to stderr"
  assert_equals "fm-dispatch-machine.v1" "$(jq -r .schema <<< "$out")" "the record must name its schema"
  assert_equals "true" "$(jq '(.collected_epoch | type) == "number" and (now - .collected_epoch) < 60' <<< "$out")" \
    "the record must carry the time it was built"
  assert_equals '{"load1":0.1,"load5":0.1,"cores":4,"mem_free_pct":50,"disk_free_mb":102400}' "$(jq -c .host <<< "$out")" \
    "the host must be upstream's probes of the pinned host"
  assert_equals "$(uname -s) $(uname -m)" "$(jq -r '"\(.platform.os) \(.platform.arch)"' <<< "$out")" "the platform must be measured"
  assert_equals "main sm1" "$(jq -r '[.homes[].home] | join(" ")' <<< "$out")" "every local home must be listed, this one first"
  assert_equals "$(git -C "$MAIN" rev-parse HEAD)" "$(jq -r '.homes[0].code' <<< "$out")" "a home must carry its commit"
  assert_equals "user" "$(jq -r '.homes[0].role' <<< "$out")" "a home must carry its role"
  assert_equals "main/w1 main/w2 main/w3 sm1/m1" "$(jq -r '[.workers[] | "\(.home)/\(.id)"] | join(" ")' <<< "$out")" \
    "every ship and scout record must be a worker, and no secondmate record"
  assert_equals '{"kind":"ship","project":"sample","pr_ready":false,"state":"paused","declared":{"effort":"high","model":"opus","mode":"direct-PR"}}' \
    "$(jq -c '.workers[0] | {kind, project, pr_ready, state, declared}' <<< "$out")" "a worker must carry what its record and summary say"
  assert_equals "true" "$(jq '.workers[0] | (.age_s >= 3600 and .age_s < 3660) and (.state_age_s >= 40 and .state_age_s < 100)' <<< "$out")" \
    "a worker must carry its age and the age of its state"
  assert_equals "true null" "$(jq -r '"\(.workers[2].pr_ready) \(.workers[3].state)"' <<< "$out")" \
    "a ready PR must show, and a worker no summary lists has no state"
  assert_equals '[{"name":"sample","limit":3,"held":3}]' "$(jq -c .projects <<< "$out")" \
    "the places held must be counted in every local home, and a ready PR holds none"
  assert_contains "$(jq -r '.projects_cloned | join(" ")' <<< "$out")" "sample" "a home's projects/ clone must be listed"
  assert_equals "true" "$(jq .workers_complete <<< "$out")" "a full walk must say it is complete"
  assert_equals "main:dispatch:h1 sm1:dispatch:s1" "$(jq -r '[.ready[] | "\(.home):\(.section):\(.id)"] | join(" ")' <<< "$out")" \
    "every home's work under 可派 must be listed, and no answered decision"
  assert_not_contains "$out" "$TMP_ROOT" "the record must carry no path"
  pass "machine --json describes the host, homes, workers, places and ready work"
}

# A signal that cannot be read is null with a note, never 0; a walk that
# cannot read a home says the workers may be more.
test_record_names_what_it_could_not_read() {
  local out
  setup_machine unread
  dp_host 0.10 0.10 - 102400 4
  printf -- '- sm9 - Gone helper (home: %s; scope: x; projects: y; added 2026-11-01)\n' "$TMP_ROOT/no-such-home" \
    >> "$MAIN/data/secondmates.md"
  out=$(machine "$MAIN" --json) || fail "machine --json failed without a memory reading"
  dp_calm_host
  assert_equals "null" "$(jq .host.mem_free_pct <<< "$out")" "an unreadable memory must be null, not 0"
  assert_contains "$(jq -r '.notes | join(" ")' <<< "$out")" "mem_free_pct 讀不到" "the note must name the signal"
  assert_equals "false" "$(jq .workers_complete <<< "$out")" "a walk that misses a home must say so"
  printf 'sample 3\nsample 2\n' > "$MAIN/config/project-capacity"
  out=$(machine "$MAIN" --json)
  assert_equals "[]" "$(jq -c .projects <<< "$out")" "an unreadable declaration must give no project"
  assert_contains "$(jq -r '.notes | join(" ")' <<< "$out")" "config/project-capacity 讀不懂" "the note must say the declaration is unreadable"
  pass "machine --json leaves what it cannot read null and says why"
}

# The tools on the common list: found with a version, or not found. machine's
# text view names each gap against the list.
test_tools_on_the_common_list() {
  local out tools
  setup_machine tools
  tools="$TMP_ROOT/tools-bin"
  mkdir -p "$tools"
  printf '#!/usr/bin/env bash\necho "dp-tool-new 2.1.0"\n' > "$tools/dp-tool-new"
  printf '#!/usr/bin/env bash\necho "dp-tool-old v1.9"\n' > "$tools/dp-tool-old"
  chmod +x "$tools/dp-tool-new" "$tools/dp-tool-old"
  printf '# a test list\ndp-tool-new\t2.0\ndp-tool-old\t2.0\ndp-tool-missing\t-\n' > "$CODE/dispatch-plan/common-tools.tsv"
  out=$(PATH="$tools:$PATH" machine "$MAIN" --json) || fail "machine --json failed with a tool list"
  assert_equals '[{"name":"dp-tool-new","found":true,"version":"2.1.0"},{"name":"dp-tool-old","found":true,"version":"1.9"},{"name":"dp-tool-missing","found":false,"version":null}]' \
    "$(jq -c .tools <<< "$out")" "each tool on the list must be found with its version, or not found"
  out=$(PATH="$tools:$PATH" machine "$MAIN") || fail "machine failed with a tool list"
  assert_contains "$out" "dp-tool-old 1.9 低於 2.0（補齊：在那台升級，要 captain 同意）" "an older tool must be a gap to close"
  assert_contains "$out" "dp-tool-missing 沒裝（補齊：在那台安裝，要 captain 同意）" "a missing tool must be a gap to close"
  assert_not_contains "$out" "dp-tool-new" "a tool at or above its version must not be listed"
  mv "$CODE/dispatch-plan/common-tools.tsv" "$CODE/dispatch-plan/common-tools.tsv.off"
  out=$(machine "$MAIN" --json)
  assert_equals "null" "$(jq .tools <<< "$out")" "without a list the tools must be unknown"
  assert_contains "$(jq -r '.notes | join(" ")' <<< "$out")" "沒有共用工具清單" "the note must say the list is missing"
  pass "machine records the common list's tools and names each gap"
}

test_text_view_and_usage() {
  local out
  setup_machine view
  out=$(machine "$MAIN") || fail "machine failed"
  assert_contains "$(printf '%s\n' "$out" | head -n 1)" "（main、sm1）：可以加（rule-v1）。負載 0.1，5 分鐘 0.1，4 核心；記憶體可用 50%；磁碟剩 100 GB。" \
    "the first line must give the verdict and the host"
  assert_contains "$out" "  在跑 4 個：main/w1（ship，high，paused）、main/w2（scout，xhigh，working）、main/w3（ship，working，PR 已就緒）、sm1/m1（ship，low，狀態不知道）。" \
    "the workers line must list each worker"
  assert_contains "$out" "  sample：上限 3，佔用 3，滿了。" "a full project must say so"
  expect_code 2 "$(tb_code "$MAIN" "$CODE/bin/fm-dispatch-plan.sh" machine extra)" "machine with another argument"
  expect_code 2 "$(tb_code "$MAIN" "$CODE/bin/fm-dispatch-plan.sh" machine --json extra)" "machine --json with another argument"
  pass "machine prints the view of this machine, and refuses other arguments"
}

fm_test_run test_record_describes_the_machine test_record_names_what_it_could_not_read \
  test_tools_on_the_common_list test_text_view_and_usage
