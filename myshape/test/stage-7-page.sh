#!/usr/bin/env bash
# The page in a real browser with an aggregator on the other side (AT10 of the
# board-interface test plan, as it stands for B4): a headless Firefox walks
# the page of a board-only root whose other side is stub-plain, bound outside
# the root and confirmed on the page, and of a root with nothing on the other
# side (stage-7-page.mjs). Both run in the hardened
# environment of stage-7-standalone.sh.
# shellcheck disable=SC2016 # jq filters are literal text.
set -u

# shellcheck source=myshape/test/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"
# shellcheck source=myshape/test/standalone-lib.sh
. "$ROOT/myshape/test/standalone-lib.sh"

for tool in jq node curl git firefox; do
  command -v "$tool" >/dev/null 2>&1 || { echo "skip: $tool not found"; exit 0; }
done
TMP_ROOT=$(fm_test_tmproot tb-s7p)
case "$TMP_ROOT" in /*) ;; *) echo "not ok - no scratch root" >&2; exit 1 ;; esac
trap 'tb_stop_boards; sig_leftovers; fm_test_cleanup' EXIT
sig_init

sa_init
mkdir -p "$TMP_ROOT/root"
BASE_ENV=(MYSHAPE_TEST=1 MYSHAPE_NOTIFY_MS=2000 MYSHAPE_READ_MS=1000 MYSHAPE_STALE_MS=5000 "MYSHAPE_RETRY_MS=100,200")

# topic_wrapper <file> <root> <home> <env words...>: a script that runs that
# root's myshape.sh for that home in the clean environment; the page script
# calls it as TB_TOPIC.
topic_wrapper() {
  local file=$1 root=$2 home=$3
  shift 3
  {
    printf '#!/bin/sh\n'
    printf 'exec env -i HOME=%q PATH=%q LANG=C.UTF-8 TMPDIR=%q MYSHAPE_HOME=%q' "$TMP_ROOT/h" "$SA_PATH" "$SA_TMPDIR" "$home"
    printf ' %q' "$@"
    printf ' %q "$@"\n' "$root/bin/myshape.sh"
  } > "$file"
  chmod +x "$file"
}

test_the_page_with_an_aggregator() {
  local home agg program out rc=0
  agg=$TMP_ROOT/agg
  SA_ROOT=$TMP_ROOT/root/board
  tb_make_board_root "$SA_ROOT" >/dev/null
  SA_ENV=("${BASE_ENV[@]}")
  program=$(sa_install_stub plain "$agg")
  home=$(sa_home main)
  sa_decoys "$home"
  sa_bind "$home" "$program" plain
  cat > "$agg/plain/main.json" <<'JSON'
{
  "tasks": [
    { "id": "j1", "kind": "job", "state": "working" },
    { "id": "j2", "kind": "job", "state": "running" },
    { "id": "j-loose", "kind": "job", "state": "working" }
  ],
  "queued": [ { "id": "j9", "title": "下一步", "hold": "等供應商", "topic_hint": "solo" }, { "id": "q-loose", "title": "沒有議題的排隊" } ],
  "holds": [
    { "id": "h1", "title": "選一個", "question": "用哪個？\n選項：A | B", "hold_bucket": "live" },
    { "id": "h-loose", "title": "沒有議題的決定", "question": "要不要？\n選項：要 | 不要", "hold_bucket": "live" }
  ],
  "status_decisions": [ { "id": "j2", "key": "k", "summary": "j2 問 agent 的事" } ],
  "topics": { "j1": "solo 2026-11-18T10:00:00Z", "j2": "solo 2026-11-18T10:00:00Z", "h1": "solo 2026-11-18T10:00:00Z" },
  "secondmates": [ { "id": "w2", "read_every_s": 1 } ]
}
JSON
  printf '%s\n' '{ "tasks": [ { "id": "w2-job", "kind": "job", "state": "working" } ] }' > "$agg/plain/w2.json"
  printf '%s\n' '{"ts":1795000000,"event":"task.pr_ready","task":"j1","pr":"https://example.invalid/pr/9"}' > "$agg/plain/main.events"
  topic_wrapper "$TMP_ROOT/topic" "$SA_ROOT" "$home" "${SA_ENV[@]}"
  cat > "$TMP_ROOT/recommit" <<SH
#!/bin/sh
printf 'changed\n' >> "$SA_ROOT/myshape/public/note.txt"
git -C "$SA_ROOT" add -A
git -C "$SA_ROOT" -c user.name=t -c user.email=t@example.invalid commit -qm "a new commit"
SH
  chmod +x "$TMP_ROOT/recommit"
  sa "$home" open >/dev/null || fail "the board did not start"
  sa "$home" create "建置" --goal "把 x 建起來" --id solo >/dev/null
  sa "$home" create "之後" --goal "g" --id later-one --queue later >/dev/null
  printf '建好了。\n' | sa "$home" summary j1 ready - >/dev/null
  out=$(TB_TOPIC="$TMP_ROOT/topic" TB_AGG="$agg" TB_PROGRAM="$program" TB_RECOMMIT="$TMP_ROOT/recommit" TB_PAGE_MODE=connected \
    node "$ROOT/myshape/test/kit/browser.mjs" "$(sa "$home" open)" "$ROOT/myshape/test/stage-7-page.mjs" 2>&1) || rc=$?
  assert_equals 0 "$rc" "the browser walk with an aggregator failed: $out"
  sa "$home" stop >/dev/null
  sa_check_decoys "$home"
  pass "the program's confirmation, drag, topic page, answer, banners, the agent's name and the reload all work with stub-plain on the other side (AT9.2, AT10.1-10.5, 10.7, 10.8)"
}

test_the_page_with_nothing_connected() {
  local home out rc=0
  SA_ROOT=$TMP_ROOT/root/alone
  tb_make_board_root "$SA_ROOT" >/dev/null
  SA_ENV=("${BASE_ENV[@]}")
  home=$(sa_home alone)
  topic_wrapper "$TMP_ROOT/topic-alone" "$SA_ROOT" "$home" "${SA_ENV[@]}"
  sa "$home" open >/dev/null || fail "the board did not start"
  sa "$home" create "一" --goal "g" --id one >/dev/null
  sa "$home" create "二" --goal "g" --id two --queue later >/dev/null
  out=$(TB_TOPIC="$TMP_ROOT/topic-alone" TB_PAGE_MODE=alone \
    node "$ROOT/myshape/test/kit/browser.mjs" "$(sa "$home" open)" "$ROOT/myshape/test/stage-7-page.mjs" 2>&1) || rc=$?
  assert_equals 0 "$rc" "the browser walk with nothing connected failed: $out"
  sa "$home" stop >/dev/null
  pass "with nothing connected the page shows one plain note and no red mark (AT10.6)"
}

test_nothing_is_left() {
  sa_assert_no_boards
  sa_assert_no_trips
  pass "no board is left running and no Firstmate file was reached"
}

fm_test_run test_the_page_with_an_aggregator test_the_page_with_nothing_connected test_nothing_is_left
