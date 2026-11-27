#!/usr/bin/env bash
# fm-dispatch-plan.sh machines: every machine's record, rule-v1's verdict on
# each, and what the main first mate does about them. Every call runs from a
# scratch code root whose bin/fm-on.sh is a stub, so nothing here reaches
# another machine: the stub runs the real machine in a scratch far home, prints
# a fixed record, or fails the way a remote call can fail.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "skip: git not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot dispatch-plan-stage-6-machines)
# shellcheck source=dispatch-plan/test/helpers.sh
. "$ROOT/dispatch-plan/test/helpers.sh"

# machines <home> <arg>...: run machines in <home> from the scratch code root,
# on the pinned host.
machines() {
  FM_HOME="$1" FM_ROOT_OVERRIDE="$CODE" dp_on_host "$CODE/bin/fm-dispatch-plan.sh" machines "${@:2}"
}

# label: this machine's label, as its record gives it.
label() {
  machines "$MAIN" --json | jq -r '.machines[0].record.machine'
}

# A main home whose project "sample" admits <limit> workers, held by main/w1
# (ship, paused) and main/w2 (scout, working); main/n1 (normal) queued in main,
# and in the local secondmate sm1 s1 (high, sample) and s2 (normal, a project
# with no line and no clone here). The tool list names jq only, so no test runs
# every tool on the runner. Sets MAIN and MATE.
setup_machines() {
  local name=$1 limit=$2
  dp_code_root "$TMP_ROOT/$name-code"
  printf 'jq\t-\n' > "$CODE/dispatch-plan/common-tools.tsv"
  MAIN=$(tb_make_home "$name-main")
  dp_git_dir "$MAIN"
  dp_git_dir "$MAIN/projects/sample"
  tb_write_topics "$MAIN"
  printf 'sample %s\n' "$limit" > "$MAIN/config/project-capacity"
  MATE=$(dp_make_local_mate "$name-sm1" sm1 "$MAIN")
  printf '# Secondmates\n- sm1 - Local helper (home: %s; scope: sample work; projects: sample; added 2026-11-01)\n' "$MATE" \
    > "$MAIN/data/secondmates.md"
  dp_meta "$MAIN" w1 kind=ship "project=$MAIN/projects/sample" effort=high
  dp_meta "$MAIN" w2 kind=scout "project=$MAIN/projects/sample" effort=xhigh
  dp_summary "$MAIN" 10 w1:paused w2:working
  printf '## In flight\n\n## Queued\n- [ ] n1 - Normal (repo: sample) (kind: ship)\n  topic: t2\n\n## Done\n' \
    > "$MAIN/data/backlog.md"
  cat > "$MATE/data/backlog.md" <<'EOF'
## In flight

## Queued
- [ ] s1 - Mate high (repo: sample) (kind: ship)
  topic: billing
- [ ] s2 - Mate elsewhere (repo: elsewhere) (kind: ship)
  topic: t2

## Done
EOF
}

# section_lines <output> <header>: the lines under one header, without their indent.
section_lines() {
  printf '%s\n' "$1" | awk -v header="$2" '/^[^ ]/ { on = ($0 == header); next } on { sub(/^  /, ""); print }'
}

test_main_home_only_and_usage() {
  local out rc=0
  setup_machines usage 2
  out=$(machines "$MATE" 2>&1) || rc=$?
  expect_code 1 "$rc" "machines in a secondmate home"
  assert_contains "$out" "machines 只能在主 home 跑" "the refusal must say where it runs"
  expect_code 2 "$(tb_code "$MAIN" "$CODE/bin/fm-dispatch-plan.sh" machines extra)" "machines with another argument"
  expect_code 2 "$(tb_code "$MAIN" "$CODE/bin/fm-dispatch-plan.sh" machines --json extra)" "machines --json with another argument"
  pass "machines runs in the main home only and refuses other arguments"
}

# Each secondmate on another machine is asked for its machine's record once; a
# machine that does not give one is 不知道, with why, and counts for nothing.
test_asks_each_far_machine() {
  local out far
  setup_machines far 2
  far=$(dp_far_mate "$MAIN" far1)
  printf '## In flight\n\n## Queued\n- [ ] f1 - Far work (repo: far1) (kind: ship)\n\n## Done\n' > "$far/data/backlog.md"
  dp_far_mate "$MAIN" far2 >/dev/null
  echo down > "$STUB/far2.mode"
  dp_far_mate "$MAIN" far3 >/dev/null
  echo old > "$STUB/far3.mode"
  dp_far_mate "$MAIN" far4 >/dev/null
  echo garbage > "$STUB/far4.mode"
  out=$(machines "$MAIN" 2> "$TMP_ROOT/far.err") || fail "machines failed with far machines"
  assert_equals "" "$(cat "$TMP_ROOT/far.err")" "machines must not write to stderr"
  # The main home's order reads the far homes' summaries through the same stub
  # (upstream's snapshot, as before), so only the record calls are counted.
  assert_equals "far1 fm-dispatch-plan.sh machine --json|far2 fm-dispatch-plan.sh machine --json|far3 fm-dispatch-plan.sh machine --json|far4 fm-dispatch-plan.sh machine --json" \
    "$(grep ' fm-dispatch-plan.sh ' "$STUB/calls" | paste -sd '|' -)" "each far secondmate must be asked once for its machine's record"
  assert_contains "$out" "（far1）：可以加（rule-v1）。" "a far machine that answers must get a verdict"
  assert_contains "$out" "far2 那台：不知道（連不到（fm-on.sh 回 255））；不算也不轉交。" "an unreachable machine must be unknown"
  assert_contains "$out" "far3 那台：不知道（那邊的 fm-dispatch-plan.sh 還沒有 machine（回 2）；那台的程式更新到這一版就有）；不算也不轉交。" \
    "a machine on older code must be unknown, with the update that closes the gap"
  assert_contains "$out" "far4 那台：不知道（回來的不是機器紀錄）；不算也不轉交。" "an answer that is not a record must be unknown"
  assert_contains "$(section_lines "$out" "該轉告：")" "far1：$(label) 可以加，下一個是它的 f1（far1，未分類）；請它跑 order。" \
    "a far machine with room whose next work is that mate's must ask it to run order"
  assert_not_contains "$out" "far2：" "an unreachable machine must get no action"
  pass "machines asks each far machine once and counts the ones that do not answer for nothing"
}

# far_verdict <jq-filter>: the verdict machines gives far5's fixed record after
# <jq-filter> changes it, as "<machine> <reasons joined by |>".
far_verdict() {
  jq -c --argjson now "$(date +%s)" "$1" "$TMP_ROOT/base-record.json" > "$STUB/far5.json"
  machines "$MAIN" --json | jq -r '.machines[] | select(.via == "far5") | .verdict | "\(.machine) \(.reasons | join("|"))"'
}

# assert_seconds <low> <high> <verdict> <before> <after> <message>: <verdict>
# is "unknown <before><n><after>" with <n> from <low> to <high>. The view reads
# its clock a few seconds after far_verdict wrote the record.
assert_seconds() {
  local n=${3#"unknown $4"}
  n=${n%"$5"}
  case "$n" in '' | *[!0-9]*) fail "$6 (got: $3)" ;; esac
  [ "$n" -ge "$1" ] && [ "$n" -le "$2" ] || fail "$6 (got: $3)"
}

# rule-v1 over a far machine's record: the design's cases, from the reader's
# side, so a record from another version or clock is judged here.
# shellcheck disable=SC2016 # far_verdict's filters are jq; jq expands $now.
test_rule_v1_judges_each_record() {
  setup_machines rule 2
  dp_far_mate "$MAIN" far5 >/dev/null
  echo record > "$STUB/far5.mode"
  jq -n '{schema: "fm-dispatch-machine.v1", collected_epoch: 0, machine: "farbox",
          host: {load1: 3.67, load5: 2.44, cores: 20, mem_free_pct: 72, disk_free_mb: 320129},
          projects: [{name: "firstmate", limit: 6, held: 3}]}' > "$TMP_ROOT/base-record.json"
  assert_equals "room " "$(far_verdict '.collected_epoch = $now')" "a quiet machine must have room"
  assert_equals "wait cpu: 1 分鐘負載 21.49，20 核心|cpu: 5 分鐘負載 18.36 ≥ 17（核心數 × 0.85）" \
    "$(far_verdict '.collected_epoch = $now | .host.load1 = 21.49 | .host.load5 = 18.36')" "both cpu clauses must be named"
  assert_equals "wait cpu: 5 分鐘負載 18.36 ≥ 17（核心數 × 0.85）" \
    "$(far_verdict '.collected_epoch = $now | .host.load1 = 9.19 | .host.load5 = 18.36')" "a busy 5 minutes must wait after the spike"
  assert_equals "room " "$(far_verdict '.collected_epoch = $now | .host.load1 = 2.86 | .host.load5 = 6.25')" "a cleared load must have room at once"
  assert_equals "room " "$(far_verdict '.collected_epoch = $now | .host.gpu = 1 | .locks = {} | .workers = [{phase: "x"}]')" \
    "unknown keys must change nothing"
  assert_equals "room " "$(far_verdict '.collected_epoch = $now | .host.load5 = null')" "a null load5 must only drop its clause"
  assert_equals "unknown 缺少必要訊號：mem_free_pct" "$(far_verdict '.collected_epoch = $now | del(.host.mem_free_pct)')" \
    "an absent required signal must be unknown"
  assert_equals "wait memory: 可用 0%" "$(far_verdict '.collected_epoch = $now | .host.mem_free_pct = 0')" "a measured 0 must wait"
  assert_equals "wait disk: 剩 5000 MB" "$(far_verdict '.collected_epoch = $now | .host.disk_free_mb = 5000')" "low disk must wait"
  assert_equals "unknown 不認得的紀錄版本 fm-dispatch-machine.v2" \
    "$(far_verdict '.collected_epoch = $now | .schema = "fm-dispatch-machine.v2"')" "another version must be unknown, named"
  assert_seconds 1226 1300 "$(far_verdict '.collected_epoch = $now - 1226')" '紀錄是 ' ' 秒前的' \
    "a record more than 600 s old must be unknown, with its age"
  assert_seconds 800 900 "$(far_verdict '.collected_epoch = $now + 900')" '紀錄的時間比這台快 ' ' 秒' \
    "a record from a clock far ahead must be unknown"
  far_verdict '.collected_epoch = $now | .projects[0].limit = 3' >/dev/null
  assert_equals '[{"name":"firstmate","limit":3,"held":3,"free":0,"verdict":"wait","why":"上限 3 都佔了"}]' \
    "$(machines "$MAIN" --json | jq -c '.machines[] | select(.via == "far5") | .verdict.projects')" \
    "a full project must wait while the machine has room"
  far_verdict '.collected_epoch = $now | .schema = "fm-dispatch-machine.v2"' >/dev/null
  assert_contains "$(machines "$MAIN")" "farbox：不知道（rule-v1：不認得的紀錄版本 fm-dispatch-machine.v2）；不算也不轉交。負載 3.67" \
    "a far record rule-v1 cannot judge must count for nothing"
  pass "rule-v1 judges a far record by its version, its age and upstream's thresholds"
}

# The actions: a secondmate whose work is next on a machine with room is asked
# to run order; a full project whose higher item is in another home tells the
# lower home to let it go first and the captain once; a project number tighter
# than an idle machine is the captain's to know.
test_tells_and_notifies() {
  local out here
  setup_machines act 2
  out=$(machines "$MAIN") || fail "machines failed"
  here=$(label)
  assert_contains "$out" "$here（main、sm1）：可以加（rule-v1）。負載 0.1，5 分鐘 0.1，4 核心；記憶體可用 50%；磁碟剩 100 GB。" \
    "the machine's line must give its verdict and host"
  assert_contains "$out" "  在跑 2 個：main/w1（ship，high，paused）、main/w2（scout，xhigh，working）。" "the workers must be listed"
  assert_contains "$out" "$(printf '  sample：上限 2，佔用 2，滿了。\n    下一個：sm1/s1（高，帳務重構）')" \
    "a full project must show its next item across homes"
  assert_contains "$out" "  elsewhere：這台沒有設上限（config/project-capacity），下一個：sm1/s2（一般，登入頁）。" \
    "a project with no line must say so"
  assert_equals "sm1：$here 可以加，下一個是它的 s2（elsewhere，一般）；請它跑 order。
main：sample 滿了，sm1/s1（高）排在 main/n1（一般）前面；下一個位子讓給 s1。" "$(section_lines "$out" "該轉告：")" \
    "該轉告 must ask the mate to run order and the lower home to let the higher item go first"
  assert_equals "$here 的 sample 滿了：先讓 sm1/s1（高），main/n1（一般）等下一個位子。
$here 的 sample 上限 2 比機器緊：佔位的 2 個裡 1 個 paused、1 個是 scout；2 個項目在等。" \
    "$(section_lines "$out" "該通知（同一件事只說一次）：")" "該通知 must tell the captain of the inversion and the tight number"
  dp_host 9.19 3.00 50 102400 4
  out=$(machines "$MAIN")
  dp_calm_host
  assert_contains "$out" "$here（main、sm1）：先等（rule-v1：cpu: 1 分鐘負載 9.19，4 核心）。" "a busy machine must wait, with why"
  assert_contains "$out" "    下一個：sm1/s1（高，帳務重構，等機器）" "work waiting for the machine must say so"
  assert_not_contains "$out" "請它跑 order" "a busy machine must ask no one to dispatch"
  assert_not_contains "$out" "比機器緊" "a busy machine is not idle, so no number is tighter than it"
  printf 'sample 5\n' > "$MAIN/config/project-capacity"
  out=$(machines "$MAIN")
  assert_contains "$out" "  sample：上限 5，佔用 2，還能派 3。" "a project with places must say how many"
  assert_equals "sm1：$here 可以加，下一個是它的 s1（sample，高）；請它跑 order。" "$(section_lines "$out" "該轉告：")" \
    "a mate must be asked once, for its first next item"
  assert_equals "" "$(section_lines "$out" "該通知（同一件事只說一次）：")" "nothing must be for the captain"
  pass "machines tells the secondmates and the captain what the records say"
}

# 環境差異: gaps against the common tool list, the main home's commit and
# role, a next item's missing clone, and a different operating system. A gap
# is something to close, named with who closes it.
test_names_environment_gaps() {
  local out here far6
  setup_machines env 2
  printf 'maintainer github.com/guybeju/firstmate\n' > "$MAIN/config/firstmate-role"
  dp_git_dir "$MATE" "the secondmate home"
  printf 'jq\t-\n' > "$CODE/dispatch-plan/common-tools.tsv"
  dp_far_mate "$MAIN" far6 >/dev/null
  echo record > "$STUB/far6.mode"
  dp_far_mate "$MAIN" far7 >/dev/null
  echo record > "$STUB/far7.mode"
  far6=$(jq -nc --argjson now "$(date +%s)" '{schema: "fm-dispatch-machine.v1", collected_epoch: $now, machine: "farmac",
    platform: {os: "Plan9", arch: "mips"}, host: {load1: 0.5, cores: 8, mem_free_pct: 60},
    homes: [{home: "far6", code: null, role: "maintainer"}], tools: [{name: "jq", found: false, version: null}],
    projects_cloned: ["far6"], ready: [{home: "far6", section: "dispatch", id: "f9", topic_name: "（未分類）", queue: "none", at: 0, repo: "other"}]}')
  printf '%s\n' "$far6" > "$STUB/far6.json"
  printf '%s\n' "$far6" | jq -c '.machine = "faroldbox" | del(.tools) | .platform = {os: "Plan9", arch: "mips"} | .ready = []' \
    > "$STUB/far7.json"
  out=$(machines "$MAIN") || fail "machines failed"
  here=$(label)
  assert_equals "$here/sm1 的程式在 $(git -C "$MATE" rev-parse HEAD | cut -c1-7)，主 home 在 $(git -C "$MAIN" rev-parse HEAD | cut -c1-7)（補齊：更新那個 home）。
$here/sm1 的 role 是 user，主 home 是 maintainer（補齊：查那個 home 的 role 繼承）。
$here 沒有 elsewhere 的 clone，sm1/s2 要用（補齊：那台的 second mate clone elsewhere，幾分鐘）。
farmac：jq 沒裝（補齊：在那台安裝，要 captain 同意）。
farmac/far6 的 commit 讀不到，待查。
farmac 沒有 other 的 clone，far6/f9 要用（補齊：那台的 second mate clone other，幾分鐘）。
faroldbox：沒有工具的紀錄（那台的程式可能還沒更新到這一版），工具待查。
faroldbox/far6 的 commit 讀不到，待查。
作業系統：$here 是 $(uname -s) $(uname -m)，farmac 是 Plan9 mips，faroldbox 是 Plan9 mips。
登入（例如 gh）：還沒有不用連網的檢查，每台都待查。" "$(section_lines "$out" "環境差異：")" \
    "each gap must be named with what closes it, and the logins left to check"
  assert_not_contains "$out" "不行" "no machine may be said to be unable"
  pass "machines names each setup gap against the list, the main home and the other machines"
}

test_json_gives_records_and_verdicts() {
  local out
  setup_machines json 2
  dp_far_mate "$MAIN" far8 >/dev/null
  echo down > "$STUB/far8.mode"
  out=$(machines "$MAIN" --json) || fail "machines --json failed"
  assert_equals "fm-dispatch-machines.v1" "$(jq -r .schema <<< "$out")" "the document must name its schema"
  assert_equals "here:room:fm-dispatch-machine.v1 far8:unknown:null" \
    "$(jq -r '[.machines[] | "\(.via):\(.verdict.machine):\(.record.schema)"] | join(" ")' <<< "$out")" \
    "each machine must carry its record and verdict, or none and why"
  assert_equals '[{"name":"sample","limit":2,"held":2,"free":0,"verdict":"wait","why":"上限 2 都佔了"}]' \
    "$(jq -c '.machines[0].verdict.projects' <<< "$out")" "the verdict must give each project's free places"
  assert_equals "連不到（fm-on.sh 回 255）" "$(jq -r '.machines[1].error' <<< "$out")" "an unreachable machine must say why"
  pass "machines --json gives every record and verdict"
}

fm_test_run test_main_home_only_and_usage test_asks_each_far_machine test_rule_v1_judges_each_record \
  test_tells_and_notifies test_names_environment_gaps test_json_gives_records_and_verdicts
