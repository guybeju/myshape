#!/usr/bin/env bash
# Shared fixtures for the dispatch-plan tests. Sourced after tests/lib.sh and
# the board's test kit (myshape/test/kit/helpers.sh), and after TMP_ROOT is set.
# shellcheck disable=SC2034 # PLAN is read by the sourcing tests.

PLAN="$ROOT/bin/fm-dispatch-plan.sh"

# section <output> <header>: the task ids listed under one section header.
section() {
  printf '%s\n' "$1" | awk -v header="$2" '
    /^[^ ]/ { active = ($0 == header) ; next }
    active { sub(/^  /, ""); split($0, cols, "\t"); printf "%s ", cols[1] }
  '
}

# dp_make_local_mate <name> <id> <parent-home>: a secondmate home on this
# machine whose parent record names <parent-home>, the way upstream seeds one.
dp_make_local_mate() {
  local home
  home=$(tb_make_home "$1")
  printf 'schema=fm-secondmate-parent.v1\nroute=local\nparent_home=%s\n' "$3" > "$home/.fm-secondmate-parent"
  printf '%s\n' "$2" > "$home/.fm-secondmate-home"
  printf '%s\n' "$home"
}

# dp_make_remote_mate <name> <id>: a secondmate home seeded from another
# machine; its parent record names no local home.
dp_make_remote_mate() {
  local home
  home=$(tb_make_home "$1")
  printf 'schema=fm-secondmate-parent.v1\nroute=remote\nparent_host=farbox\n' > "$home/.fm-secondmate-parent"
  printf '%s\n' "$2" > "$home/.fm-secondmate-home"
  printf '%s\n' "$home"
}

# dp_minutes_ago <n>: the UTC time <n> minutes ago, in the copy's format.
dp_minutes_ago() {
  jq -nr --argjson n "$1" '(now - $n * 60) | strftime("%Y-%m-%dT%H:%M:%SZ")'
}

# dp_copy_json <at>: a queue copy with tb_write_topics' queues, topics, merged
# alias and archived topic, made at <at>.
dp_copy_json() {
  jq -nc --arg at "$1" '{
    schema: "fm-dispatch-queues.v1", at: $at,
    queues: {high: ["billing"], normal: ["t2"], later: ["parked"]},
    topics: {billing: {name: "帳務重構"}, t2: {name: "登入頁"}, parked: {name: "之後再說"}, idea: {name: "新點子"}},
    merged: {"old-billing": "billing"},
    archived: {gone: {name: "已結束"}}
  }'
}

# dp_write_copy <home> <at>: place that copy where queues-in keeps it.
dp_write_copy() {
  mkdir -p "$1/state/dispatch-plan"
  dp_copy_json "$2" > "$1/state/dispatch-plan/queues.json"
}
