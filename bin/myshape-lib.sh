#!/usr/bin/env bash
# The topic board's own shell helpers: id checks, error exits, and reading
# which live topic an id names. Sourced only; defines functions, has no side
# effects on source, and sources nothing. bin/myshape.sh needs no other
# library; Firstmate's side of the board sources it too.

# tb_valid_id <value>: 0 when <value> is a usable task id or topic id. The
# grammar is the one topic ids share with task ids: [A-Za-z0-9._-], at most 128
# characters, never starting with '.' or '-' (so it can be neither a hidden
# path component nor mistaken for an option).
tb_valid_id() {
  case "$1" in
    '' | .* | -* | *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  [ "${#1}" -le 128 ]
}

# tb_die <exit-code> <message>: print one line to stderr and exit.
tb_die() {
  local code=$1
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

# tb_jq_install_hint: the install line used when jq is missing, worded like
# the install lines upstream's bootstrap prints.
tb_jq_install_hint() {
  printf '%s\n' "brew install jq  # or the platform's package manager"
}

# tb_resolve_live_topic <topics-file> <topic-id>: the live (unarchived) id that
# <topic-id> resolves to through the merged table, or nothing when it resolves
# to no live topic or the file does not exist. Fails when jq cannot read it.
tb_resolve_live_topic() {
  [ -f "$1" ] || return 0
  jq -r --arg id "$2" '
    . as $doc
    | {id: $id, hops: 0}
    | until(.hops > 64 or (($doc.merged // {})[.id] == null);
            {id: ($doc.merged[.id]), hops: (.hops + 1)})
    | .id as $final
    | if $doc.topics[$final] != null then $final else empty end
  ' "$1"
}

# tb_topic_for_tag <topics-file> <topic-id>: the topic id a tag should record
# for <topic-id>: the live topic it resolves to. Exits 1 after listing the live
# topics when there is none. Without jq it warns and prints <topic-id> as given.
tb_topic_for_tag() {
  local file=$1 wanted=$2 resolved
  if ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' "警告：找不到 jq，沒有檢查 $wanted 是不是看板上的議題。安裝：$(tb_jq_install_hint)" >&2
    printf '%s\n' "$wanted"
    return 0
  fi
  resolved=$(tb_resolve_live_topic "$file" "$wanted") ||
    tb_die 1 "讀不懂 ${file}，沒有寫入標記。"
  if [ -z "$resolved" ]; then
    {
      printf '%s\n' "$wanted 不是看板上還開著的議題，沒有寫入標記。可用的議題："
      [ ! -f "$file" ] || jq -r '.topics | to_entries[] | "  \(.key)\t\(.value.name)"' "$file" || true
    } >&2
    exit 1
  fi
  printf '%s\n' "$resolved"
}
