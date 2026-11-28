#!/usr/bin/env bash
# fm-dispatch-plan.sh machines: placements. Each ready item of every machine is
# placed on every machine with a record: now, after setup with each gap, or
# cannot, which only a declared os= or machine= need gives. Every call runs
# from a scratch code root whose bin/fm-on.sh is a stub printing a fixed far
# record, so nothing here reaches another machine.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "skip: git not found"; exit 0; }
TMP_ROOT=$(fm_test_tmproot dispatch-plan-stage-7-placements)
# shellcheck source=dispatch-plan/test/helpers.sh
. "$ROOT/dispatch-plan/test/helpers.sh"

# The runner's operating system, the one the items declare instead, and how a
# record names that other one, so the cannot cases hold on Linux and macOS.
HERE_OS=$(uname -s)
if [ "$HERE_OS" = Darwin ]; then
  OTHER_NEED=linux
  OTHER_OS=Linux
else
  OTHER_NEED=macos
  OTHER_OS=Darwin
fi

machines() {
  FM_HOME="$1" FM_ROOT_OVERRIDE="$CODE" dp_on_host "$CODE/bin/fm-dispatch-plan.sh" machines "${@:2}"
}

section_lines() {
  printf '%s\n' "$1" | awk -v header="$2" '/^[^ ]/ { on = ($0 == header); next } on { sub(/^  /, ""); print }'
}

# far_record <mate> <jq-filter>: the stub prints this fresh record for <mate>.
far_record() {
  echo record > "$STUB/$1.mode"
  jq -nc --argjson now "$(date +%s)" '{schema: "fm-dispatch-machine.v1", collected_epoch: $now,
    host: {load1: 0.1, load5: 0.1, cores: 8, mem_free_pct: 60, disk_free_mb: 102400},
    workers: [], workers_complete: true, projects: [], ready: [], notes: []}'" | $2" > "$STUB/$1.json"
}

# A main home whose project "sample" has one place, held by main/w1, so each
# of its items waits on this machine. The common list is jq and dp-tool 2.0
# (no such tool exists, so none is run). Two far machines:
#   farok   (farmac): the other OS, both tools, clones sample and other;
#   farbare: no OS reading, jq missing, dp-tool 1.9, no clone of sample, and
#            one item from a program older than needs (no needs key).
# The main items, all repo sample unless said:
#   plain (no needs line)          other (repo other, cloned on farok only)
#   osneed (os=<the other OS>)     pinned (machine=main, with a reason)
#   login (login=gh)               tool (tool=ruby, off the list)
#   proj (project=extra, cloned nowhere)        odd (an unreadable needs line)
# Sets MAIN.
setup_placements() {
  local name=$1
  dp_code_root "$TMP_ROOT/$name-code"
  printf 'jq\t-\ndp-tool\t2.0\n' > "$CODE/dispatch-plan/common-tools.tsv"
  MAIN=$(tb_make_home "$name-main")
  dp_git_dir "$MAIN"
  dp_git_dir "$MAIN/projects/sample"
  mkdir -p "$MAIN/projects/other"
  tb_write_topics "$MAIN"
  printf 'sample 1\n' > "$MAIN/config/project-capacity"
  dp_meta "$MAIN" w1 kind=ship "project=$MAIN/projects/sample" effort=high
  cat > "$MAIN/data/backlog.md" <<EOF
## In flight

## Queued
- [ ] plain - No needs (repo: sample) (kind: ship)
  topic: billing
- [ ] osneed - Other OS only (repo: sample) (kind: ship)
  needs: os=$OTHER_NEED
- [ ] pinned - This machine only (repo: sample) (kind: ship)
  needs: machine=main (主 home 的看板)
- [ ] login - Needs a login (repo: sample) (kind: ship)
  needs: login=gh
- [ ] tool - Needs a tool off the list (repo: sample) (kind: ship)
  needs: tool=ruby
- [ ] proj - Needs another clone (repo: sample) (kind: ship)
  needs: project=extra
- [ ] odd - An unreadable needs line (repo: sample) (kind: ship)
  needs: a fast gpu
- [ ] other - Another repo (repo: other) (kind: ship)

## Done
EOF
  dp_far_mate "$MAIN" farok >/dev/null
  far_record farok '.machine = "farmac" | .platform = {os: "'"$OTHER_OS"'", arch: "arm64"}
    | .homes = [{home: "farok", code: null, role: "user"}] | .projects_cloned = ["farok", "sample", "other"]
    | .tools = [{name: "jq", found: true, version: "1.7.1"}, {name: "dp-tool", found: true, version: "2.1"}]'
  dp_far_mate "$MAIN" farbare >/dev/null
  far_record farbare '.machine = "farbare" | .platform = {os: null, arch: null}
    | .homes = [{home: "farbare", code: null, role: "user"}] | .projects_cloned = ["farbare"]
    | .tools = [{name: "jq", found: false, version: null}, {name: "dp-tool", found: true, version: "1.9"}]
    | .ready = [{home: "farbare", section: "dispatch", id: "old1", topic: null, topic_name: "（未分類）",
                 queue: "none", at: 0, repo: "farbare"}]'
}

# placement <json> <home/id> <via>: that placement as
# "<state> <load> gaps=<kind:name,...> check=<n> why=<n>".
placement() {
  jq -r --arg item "$2" --arg via "$3" '.placements[] | select("\(.home)/\(.id)" == $item and .via == $via)
    | "\(.state) \(.load) gaps=\([.gaps[] | "\(.kind):\(.name // "")"] | join(",")) check=\(.to_check | length) why=\(.why | length)"' \
    <<< "$1"
}

# Every item on every machine with a record: no needs line, a gap of each kind,
# cannot from os= and from machine=, and what is only to check.
test_places_each_item_on_each_machine() {
  local out
  setup_placements cases
  out=$(machines "$MAIN" --json) || fail "machines --json failed"
  assert_equals "27" "$(jq '.placements | length' <<< "$out")" "each of 9 ready items must be placed on each of 3 machines"
  assert_equals "now room gaps= check=0 why=0" "$(placement "$out" main/plain farok)" \
    "an item with no needs line must run now where the common list and its clone are"
  assert_equals "after-setup wait gaps=tool:dp-tool check=0 why=0" "$(placement "$out" main/plain here)" \
    "on its own full machine it must wait, and the missing listed tool is a gap"
  assert_equals "after-setup room gaps=tool:jq,tool:dp-tool,clone:sample check=0 why=0" "$(placement "$out" main/plain farbare)" \
    "a missing tool, an older tool and a missing clone must each be a gap"
  assert_equals "cannot wait gaps=tool:dp-tool check=0 why=1" "$(placement "$out" main/osneed here)" \
    "a declared os= the machine does not have must be cannot"
  assert_equals "now room gaps= check=0 why=0" "$(placement "$out" main/osneed farok)" "a declared os= the machine has must run now"
  assert_equals "after-setup room gaps=tool:jq,tool:dp-tool,clone:sample check=1 why=0" "$(placement "$out" main/osneed farbare)" \
    "an os= against a machine whose os was not read must be to check, never cannot"
  assert_contains "$(jq -r '.placements[] | select(.id == "osneed" and .via == "farbare") | .to_check[]' <<< "$out")" \
    "farbare 的作業系統讀不到" "the unread os must be named to check"
  assert_equals "cannot room gaps= check=0 why=1" "$(placement "$out" main/pinned farok)" \
    "a machine= pin to another machine must be cannot there"
  assert_equals "項目宣告 needs: machine=main（主 home 的看板），farmac 不是那台" \
    "$(jq -r '.placements[] | select(.id == "pinned" and .via == "farok") | .why[0]' <<< "$out")" \
    "cannot must say it comes from the item's declaration, with its reason"
  assert_equals "after-setup wait gaps=tool:dp-tool check=0 why=0" "$(placement "$out" main/pinned here)" \
    "a machine= pin must not rule out the machine it names"
  assert_equals "now room gaps= check=1 why=0" "$(placement "$out" main/login farok)" \
    "an unmeasured login must be to check, not a gap"
  assert_equals "gh 的登入（沒有就由 captain 登入，要 captain 在場）" \
    "$(jq -r '.placements[] | select(.id == "login" and .via == "farok") | .to_check[0]' <<< "$out")" \
    "the login must be named to check, with who adds it"
  assert_equals "now room gaps= check=1 why=0" "$(placement "$out" main/tool farok)" \
    "a declared tool off the common list is not measured, so it must be to check"
  assert_equals "after-setup room gaps=clone:extra check=0 why=0" "$(placement "$out" main/proj farok)" \
    "a declared project with no clone must be a gap"
  assert_equals "now room gaps= check=1 why=0" "$(placement "$out" main/odd farok)" \
    "an unreadable needs line must be to check"
  assert_equals "after-setup room gaps=tool:jq,tool:dp-tool,clone:other check=0 why=0" "$(placement "$out" main/other farbare)" \
    "the item's own repo with no clone must be a gap"
  assert_equals "after-setup room gaps=needs:,tool:dp-tool,clone:farbare check=0 why=0" "$(placement "$out" farbare/old1 here)" \
    "an item whose machine sent no needs must not read as runnable anywhere"
  assert_equals '{"what":"clone sample（那台的 home 本身就是它的 clone 時不用）","who":"farbare","cost":"minutes"} {"what":"裝 jq","who":"farbare","cost":"consent"}' \
    "$(jq -rc '[.placements[] | select(.id == "plain" and .via == "farbare") | .gaps[] | {what, who, cost}]
               | (.[2] | tojson) + " " + (.[0] | tojson)' <<< "$out")" \
    "each gap must say what, who adds it and its cost class"
  assert_equals '["room","room","room"]' "$(jq -c '[.machines[].verdict.machine]' <<< "$out")" \
    "rule-v1's verdicts must stay room, wait or unknown, untouched by placements"
  pass "every item is placed on every machine: now, after setup with each gap, or cannot from a declared need"
}

# The text view lists, under 放到別台, the items their own machine holds back
# or rules out, with every other machine's answer and how to move them.
test_lists_what_could_move() {
  local out here lines
  setup_placements text
  out=$(machines "$MAIN") || fail "machines failed"
  here=$(machines "$MAIN" --json | jq -r '.machines[0].record.machine')
  lines=$(section_lines "$out" "放到別台（補不補齊、轉不轉過去，由主 first mate 判斷）：")
  assert_contains "$lines" "main/plain（高，帳務重構）在 $here 先等（sample 上限 1 都佔了）：farmac 可以；farbare 補齊後可以（裝 jq：farbare，要 captain 同意；把 dp-tool 從 1.9 升到 2.0 以上：farbare，要 captain 同意；clone sample（那台的 home 本身就是它的 clone 時不用）：farbare，幾分鐘，不用人）。要轉過去：bin/fm-backlog-handoff.sh farok plain。" \
    "a waiting item must list each other machine's answer and the handoff"
  assert_contains "$lines" "main/osneed（未分類）在 $here 不行（項目宣告 needs: os=$OTHER_NEED，$here 量到的是 $HERE_OS）：farmac 可以；" \
    "an item its own machine rules out must say so from the declaration"
  assert_contains "$lines" "main/login（未分類）在 $here 先等（sample 上限 1 都佔了）：farmac 可以，待查：gh 的登入（沒有就由 captain 登入，要 captain 在場）；" \
    "a login must show as to check"
  assert_not_contains "$lines" "main/pinned" "an item no other machine may take must not be listed while it only waits"
  assert_not_contains "$lines" "farbare/old1" "an item whose own machine has room must not be listed"
  assert_not_contains "$out" "不能跑" "no machine may be said to be unable to run anything"
  pass "放到別台 lists what waits or is ruled out where it is, and where else it could go"
}

# An item in a secondmate's backlog moves only after that mate hands it back.
test_asks_a_mate_to_hand_back() {
  local out
  setup_placements back
  far_record farbare '.machine = "farbare" | .platform = {os: "'"$OTHER_OS"'", arch: "arm64"}
    | .host.load1 = 9 | .homes = [{home: "farbare", code: null, role: "user"}] | .projects_cloned = ["farbare"]
    | .tools = [{name: "jq", found: true, version: "1.7.1"}, {name: "dp-tool", found: true, version: "2.0"}]
    | .ready = [{home: "farbare", section: "machine-wait", id: "busy1", topic: null, topic_name: "（未分類）",
                 queue: "none", at: 0, repo: "sample", needs: []}]'
  out=$(machines "$MAIN") || fail "machines failed"
  assert_contains "$out" "farbare/busy1（未分類，等機器）在 farbare 先等（cpu: 1 分鐘負載 9，8 核心）：" \
    "a far item waiting for its machine must be listed"
  assert_contains "$out" "farmac 可以。要轉過去，先請 farbare 把 busy1 交回主 home（dispatch-plan 規格第 12 節）。" \
    "a mate's item must be asked back before it moves, naming the machine that could take it"
  pass "an item in a secondmate's backlog is asked back before it moves"
}

fm_test_run test_places_each_item_on_each_machine test_lists_what_could_move test_asks_a_mate_to_hand_back
