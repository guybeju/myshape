#!/usr/bin/env bash
# fm-dispatch-plan.sh - firstmate's dispatch plan from the topic board's queues.
#
# Usage:
#   fm-dispatch-plan.sh order
#   fm-dispatch-plan.sh queues-in -
#   fm-dispatch-plan.sh queues-push [--check | --to <secondmate-id>]
#
# order  Prints which queued backlog items to dispatch, hold, and release, in
#        the board's queue order, and under 等你驗證 the hands-on items the
#        captain says are done (state claimed in the board's
#        data/myshape/todos.json, in the main home only). Read-only: it never changes the backlog, and
#        when the queues or the backlog cannot be read it says so and lets
#        dispatch proceed. An item under 該解除 is also listed under 可派, marked
#        as still held, so its place in the order is visible before the hold is
#        lifted. Without usable queues, items the board held earlier are
#        still listed under 停著 so that a leftover hold is not forgotten.
#        Every other queued item is listed under 先不派, after 停著, with why:
#        held by anything else (a captain hold, another hold), or waiting on a
#        blocker that is unfinished or that neither the backlog nor its Done
#        archive knows; upstream's own gates decide those.
#        An untagged item ranks under the topic its bare "topic: <id>" body
#        line names; a tag wins.
#        Where the queues come from:
#          - the main home: its own data/topics.json and data/topics-archive.json;
#          - a secondmate home whose top home on this machine (upstream's
#            fm_firstmate_root_home) is the main home: that home's two files,
#            read live;
#          - any other secondmate home: the queue copy the main home pushed,
#            state/dispatch-plan/queues.json in the top home on this machine.
#        The choice is bin/fm-queue-source-lib.sh's, which fm-board.sh tag uses
#        too. In a secondmate home the first line names the source: the file read,
#        or the copy's time and age, with a warning when the copy is 60
#        minutes old or more (it is still ranked by); or why there is none, and
#        then the backlog is listed in its own order. 等你驗證 is never listed
#        in a secondmate home: the main home's todos name the main home's tasks.
#
# queues-in -
#        In a secondmate home: reads one fm-dispatch-queues.v1 copy (at most
#        262144 bytes) from stdin and keeps it as state/dispatch-plan/queues.json
#        (0700 directory, temporary file and rename), unless the copy kept
#        already is newer: then it prints "ok queues 已有較新的副本…略過" and
#        keeps it. Prints "ok queues 副本已更新（<time>）" when it kept the copy.
#        Refuses in the main home and refuses a malformed copy, writing nothing.
#        Written for bash 3.2 and BSD tools.
#
# queues-push [--check]
#        In the main home: builds the copy from data/topics.json and
#        data/topics-archive.json and sends it, through
#        "fm-on.sh --stdin <id> fm-dispatch-plan.sh queues-in -", to each
#        secondmate in data/secondmates.md on another machine that lacks it:
#        its last delivered copy differs, or was delivered 30 minutes ago or
#        more. Each delivery is kept as state/dispatch-plan/pushed/<id>; a run
#        of failures as pushed/<id>.failing ("<since> <last try> <exit code>"),
#        until a delivery. A failed transfer is tried again at the next run; a
#        far side that refused it (exit 1, 2 or 64, as when it has no
#        queues-in yet) only an hour after the last try. No transfer starts
#        after 18 s and each is cut at 9 s (with timeout or gtimeout when
#        present), so a run stays inside the watcher's 30 s limit; mates left
#        over go first at the next run. It prints one line per mate.
#        --check, for the main home's standing watcher check
#        (state/dispatch-queues.check.sh), prints nothing except one line the
#        first time a mate has gone 60 minutes or more without the main home's
#        copy, counted from its last delivery, or from its first failed try
#        when it never had one; pushed/<id>.warned keeps that to once until the
#        next delivery. It always exits 0, since the watcher drops exit codes
#        and stderr.
#        --to <secondmate-id> does the same for that one remote mate only,
#        right away; the main home runs it before it delivers a page tag or a
#        backlog handoff to that mate, so a topic the board knows is in the
#        mate's copy before the mate is asked to tag with it. Those callers go
#        on with the delivery whatever it returns.
#        Without a usable data/topics.json it sends nothing and exits 0.
#
# Every subcommand needs jq. order also reads this home's data/<task-id>/topic
# tag files and the backlog through fm-fleet-snapshot.sh (--board-input when
# that script offers it, else --json).
#
# Exit codes: 0 success (including the fall-open answers and an older copy
# ignored), 1 refused (and queues-push without --check when a transfer
# failed), 2 usage error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
TOPICS_FILE="$DATA/topics.json"
ARCHIVE_FILE="$DATA/topics-archive.json"
PLAN_STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}/dispatch-plan"
COPY_FILE="$PLAN_STATE/queues.json"
OWN_HOLD_PREFIX='看板佇列：'
COPY_MAX_BYTES=262144
# queues-push sends an unchanged copy again once its last delivery is this old,
# so the age the far side prints means "when the main home last reached it".
COPY_REFRESH_MINUTES=30
# A far side that refused the copy (no queues-in there yet) is tried again
# after this long, not at every run.
REFUSED_RETRY_MINUTES=60
# The watcher cuts a check at 30 s and always reports a cut, so no transfer
# starts after PUSH_START_SECONDS and each is cut at PUSH_TRANSFER_SECONDS.
PUSH_START_SECONDS=18
PUSH_TRANSFER_SECONDS=9
PUSHED_DIR="$PLAN_STATE/pushed"

# shellcheck source=bin/fm-primary-scope-lib.sh
. "$SCRIPT_DIR/fm-primary-scope-lib.sh"
# shellcheck source=bin/myshape-lib.sh
. "$SCRIPT_DIR/myshape-lib.sh"
# shellcheck source=bin/fm-secondmate-registry-lib.sh
. "$SCRIPT_DIR/fm-secondmate-registry-lib.sh"
# shellcheck source=bin/fm-queue-source-lib.sh
. "$SCRIPT_DIR/fm-queue-source-lib.sh"
# shellcheck source=bin/fm-board-lib.sh
. "$SCRIPT_DIR/fm-board-lib.sh"

usage() {
  sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

usage_error() {
  printf '%s\n' "fm-dispatch-plan.sh: $*（fm-dispatch-plan.sh --help 看用法）" >&2
  exit 2
}

in_secondmate_home() {
  fm_root_is_secondmate_home "$FM_HOME"
}

require_jq() {
  command -v jq >/dev/null 2>&1 ||
    tb_die 1 "$1 需要 jq，但找不到。安裝：$(tb_jq_install_hint)"
}

# Print the snapshot JSON, or return non-zero when it cannot be produced. The
# snapshot gives --board-input when it offers it (tb_snapshot_mode), else --json.
order_snapshot() {
  local -a runner=()
  if command -v timeout >/dev/null 2>&1; then
    runner=(timeout 30)
  fi
  FM_HOME="$FM_HOME" FM_SNAPSHOT_SECONDMATES=1 FM_SNAPSHOT_BUDGET=1 FM_CREW_STATE_NO_FORGE=1 \
    "${runner[@]+"${runner[@]}"}" "$SCRIPT_DIR/fm-fleet-snapshot.sh" "$(tb_snapshot_mode "$SCRIPT_DIR")" 2>/dev/null
}

# One "<task-id>\t<last tagged topic id>" line per tagged task in this home.
order_tags() {
  local file task last
  for file in "$DATA"/*/topic; do
    [ -f "$file" ] || continue
    task=${file%/topic}
    task=${task##*/}
    last=$(tail -n 1 "$file")
    [ -n "$last" ] || continue
    printf '%s\t%s\n' "$task" "${last%% *}"
  done
}

# order_source: choose where the queues come from. Sets ORDER_TOPICS and
# ORDER_ARCHIVE to the files to rank by (/dev/null for none), and ORDER_NOTE to
# the line naming the source or why there is none.
order_source() {
  local copy age
  ORDER_TOPICS=/dev/null
  ORDER_ARCHIVE=/dev/null
  ORDER_NOTE=''
  if ! in_secondmate_home; then
    if [ ! -f "$TOPICS_FILE" ]; then
      ORDER_NOTE='還沒有議題檔；照 backlog 原本的順序列出。'
    elif ! fmq_usable_topic_file "$TOPICS_FILE"; then
      ORDER_NOTE="讀不懂 ${TOPICS_FILE}；照 backlog 原本的順序列出。"
    else
      ORDER_TOPICS=$TOPICS_FILE
      if [ -f "$ARCHIVE_FILE" ] && jq -e '.topics | type == "object"' "$ARCHIVE_FILE" >/dev/null 2>&1; then
        ORDER_ARCHIVE=$ARCHIVE_FILE
      fi
    fi
    return 0
  fi
  fmq_mate_source "$FM_HOME" "$COPY_FILE"
  if [ "$FMQ_SOURCE" = root ]; then
    order_source_root "$FMQ_PATH"
    return 0
  fi
  copy=$FMQ_PATH
  if [ ! -f "$copy" ]; then
    ORDER_NOTE='這裡沒有主 home 推來的佇列副本；照 backlog 原本的順序列出。'
  elif ! age=$(fmq_copy_age "$copy"); then
    ORDER_NOTE="讀不懂主 home 推來的佇列副本（${copy}）；照 backlog 原本的順序列出。"
  else
    ORDER_TOPICS=$copy
    ORDER_NOTE="照主 home 推來的佇列副本（${age%%$'\t'*}，${age#*$'\t'} 分鐘前）。"
    if [ "${age#*$'\t'}" -ge "$FMQ_COPY_STALE_MINUTES" ]; then
      ORDER_NOTE="${ORDER_NOTE}副本超過一小時沒更新：主 home 可能沒有 first mate 在跑，或連不到這台；仍照副本排。"
    fi
  fi
}

# order_source_root <root>: rank by the root home's published files, read live.
order_source_root() {
  local file="$1/data/topics.json" archive="$1/data/topics-archive.json"
  if [ ! -f "$file" ]; then
    ORDER_NOTE='還沒有議題檔；照 backlog 原本的順序列出。'
  elif ! fmq_usable_topic_file "$file"; then
    ORDER_NOTE="讀不懂 ${file}；照 backlog 原本的順序列出。"
  else
    ORDER_TOPICS=$file
    ORDER_NOTE="照主 home 的議題順序（直接讀 ${file}）。"
    if [ -f "$archive" ] && jq -e '.topics | type == "object"' "$archive" >/dev/null 2>&1; then
      ORDER_ARCHIVE=$archive
    fi
  fi
}

cmd_order() {
  local snapshot tags sm=0 todos=/dev/null
  [ "$#" -eq 0 ] || usage_error "order 不收參數"
  require_jq order
  ! in_secondmate_home || sm=1
  order_source
  if ! snapshot=$(order_snapshot) || [ -z "$snapshot" ]; then
    printf '%s\n' "讀不到 backlog，照平常的方式派工。"
    return 0
  fi
  tags=$(order_tags)
  if [ "$sm" -eq 0 ] && jq -e '.items | objects' "$DATA/myshape/todos.json" >/dev/null 2>&1; then
    todos=$DATA/myshape/todos.json
  fi
  printf '%s' "$snapshot" | jq -r --arg note "$ORDER_NOTE" --arg tags "$tags" --arg own "$OWN_HOLD_PREFIX" \
    --slurpfile live "$ORDER_TOPICS" --slurpfile gone "$ORDER_ARCHIVE" --slurpfile todos "$todos" '
    ($live[0] // null) as $doc
    | ($gone[0].topics // $doc.archived // {}) as $archived
    | ($tags | split("\n") | map(select(length > 0) | split("\t") | {key: .[0], value: .[1]})
       | from_entries) as $tag
    | def resolve: {id: ., hops: 0}
        | until(.hops > 64 or ((($doc.merged // {})[.id]) == null);
                {id: ($doc.merged[.id]), hops: (.hops + 1)})
        | .id;
      def place($topic):
        if $doc == null or $topic == null then {queue: "none"}
        elif ($archived[$topic] != null) then {queue: "archived", name: $archived[$topic].name}
        else ( [ ("high", "normal", "later") as $q
                 | ($doc.queues[$q] // []) | index($topic) as $at
                 | select($at != null) | {queue: $q, at: $at, name: $doc.topics[$topic].name} ][0]
               // {queue: "none"} )
        end;
      def queue_name: {high: "高", normal: "一般", later: "待辦", archived: "已封存", none: "-"}[.];
      [ .backlog.records | to_entries[]
        | select(.value.structured == true and .value.state == "queued")
        | .key as $index | .value as $r
        | ($tag[$r.id]
           // ([ ($r.body_lines // [])[] | capture("^topic: *(?<topic>[A-Za-z0-9._-]+) *$") | .topic ][0])
           | if . == null then null else resolve end) as $topic
        | place($topic) as $p
        | {id: $r.id, index: $index, topic: $topic, queue: $p.queue, at: ($p.at // 0),
           name: ($p.name // "（未分類）"),
           decision: ($r.kind == "captain"),
           own_hold: (($r.hold_reason // "") | startswith($own)),
           other_hold: ($r.hold_reason != null and ((($r.hold_reason // "") | startswith($own)) | not)),
           captain_hold: ($r.hold_kind == "captain"),
           waits: ($r.unresolved_blocker_ids // []),
           blocked: (($r.unresolved_blocker_ids // []) | length > 0),
           parked: ($p.queue == "later" or $p.queue == "archived")} ] as $items
    | def line: "  \(.id)\t\(.name)\t\(.queue | queue_name)";
      def rank: {high: 0, normal: 1, none: 2}[.queue];
      ($items | map(select((.parked | not) and (.other_hold | not) and (.blocked | not)
                           and ($doc != null or (.own_hold | not))))
       | sort_by([rank, .at, .index])) as $ready
    | ($items | map(select(.parked and (.own_hold | not) and (.other_hold | not)))) as $to_hold
    | ($items | map(select($doc != null and .own_hold and (.parked | not)))) as $to_release
    | ($items | map(select(.own_hold and (.parked or $doc == null)))) as $parked
    | ([$ready[], $to_hold[], $to_release[], $parked[]] | map(.index)) as $placed
    | ($items | map(select(.index as $i | any($placed[]; . == $i) | not))) as $unplaced
    | ([.backlog.records[] | select(.structured == true) | {key: .id, value: true}] | from_entries) as $known
    | def why:
        [ (if .other_hold and .captain_hold then "等使用者決定（captain hold）"
           elif .other_hold then "被看板以外的 hold 擋著"
           else empty end),
          (.waits | map(select($known[.] == true))
           | if length > 0 then "等 \(join("、")) 完成" else empty end),
          (.waits | map(select($known[.] != true))
           | if length > 0 then "找不到它等的 \(join("、"))（不在 backlog，也不在封存檔）" else empty end) ]
        | join("；");
      (if $note != "" then $note else empty end),
      "可派：",
      ($ready[] | line
        + (if .own_hold then "\t← 還被看板的 hold 擋著，先照「該解除」解除" else "" end)
        + (if .decision then "\t← 決定事項，使用者已經回答；沒有工作要派，照回答處理後關掉" else "" end)),
      "該 hold：",
      ($to_hold[] | line + "\t→ bin/fm-tasks-axi.sh hold \(.id) --reason \"\($own)議題 \(.topic) 在\(if .queue == "archived" then "封存" else "待辦" end)\""),
      "該解除：",
      ($to_release[] | line + "\t→ bin/fm-tasks-axi.sh unhold \(.id)"),
      "停著：",
      ($parked[] | line),
      "先不派：",
      ($unplaced[] | line + "\t← " + why),
      ([ ($todos[0].items // {}) | to_entries[] | select(.value.state == "claimed")
         | (.value.topic | if . == null then null else resolve end) as $topic
         | place($topic) as $p
         | {id: .key, name: ($p.name // "（未分類）"), queue: $p.queue} ] as $claimed
       | if ($claimed | length) == 0 then empty
         else "等你驗證：",
              ($claimed[] | line + "\t← 使用者說做完了；驗證後跑 bin/myshape.sh todo done \(.id)，沒成功就跑 bin/myshape.sh todo failed \(.id) --reason <一行>")
         end)
  ' || {
    printf '%s\n' "讀不到 backlog，照平常的方式派工。"
    return 0
  }
}

PUSH_CHECK=0
PUSH_COPY=''
PUSH_NOW=0

# remote_mates: the id of every secondmate on another machine in this home's
# registry, one per line.
remote_mates() {
  local line
  [ -f "$DATA/secondmates.md" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    secondmate_registry_parse_line "$line" || continue
    [ "$SECONDMATE_REGISTRY_REMOTE" = 1 ] || continue
    case "$SECONDMATE_REGISTRY_ID" in .*) continue ;; esac
    printf '%s\n' "$SECONDMATE_REGISTRY_ID"
  done < "$DATA/secondmates.md"
}

# build_copy <file>: write the fm-dispatch-queues.v1 copy of this home's
# published topic files into <file>; returns 1 when there is no usable file.
build_copy() {
  local archive=/dev/null
  [ -f "$TOPICS_FILE" ] && fmq_usable_topic_file "$TOPICS_FILE" || return 1
  if [ -f "$ARCHIVE_FILE" ] && jq -e '.topics | type == "object"' "$ARCHIVE_FILE" >/dev/null 2>&1; then
    archive=$ARCHIVE_FILE
  fi
  jq -nc --slurpfile live "$TOPICS_FILE" --slurpfile gone "$archive" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    def names: with_entries(select(.value | type == "object")
                            | .value = {name: (.value.name | if type == "string" then . else "" end)});
    def ids: if type == "array" then map(select(type == "string")) else [] end;
    $live[0] as $d
    | {schema: "fm-dispatch-queues.v1", at: $at,
       queues: {high: ($d.queues.high | ids), normal: ($d.queues.normal | ids), later: ($d.queues.later | ids)},
       topics: ($d.topics | names),
       merged: (($d.merged // {}) | if type == "object" then with_entries(select(.value | type == "string")) else {} end),
       archived: (($gone[0].topics // {}) | names)}' > "$1"
}

report() {
  [ "$PUSH_CHECK" = 1 ] || printf '%s\n' "$*"
}

# failing_field <mate> <1|2|3>: since, last try, or exit code of the failing
# run of transfers to <mate>, from pushed/<mate>.failing ("<since> <last> <rc>").
failing_field() {
  local since last rc
  read -r since last rc 2>/dev/null < "$PUSHED_DIR/$1.failing" || return 1
  case "$2" in
    1) printf '%s\n' "$since" ;;
    2) printf '%s\n' "$last" ;;
    *) printf '%s\n' "$rc" ;;
  esac
}

# why <rc>: what a transfer's exit code means, in one phrase.
why() {
  case "$1" in
    "$NO_OK_LINE") printf '那邊沒有回 ok queues' ;;
    1) printf '那邊拒收（回 1）' ;;
    2 | 64) printf '那邊的 fm-dispatch-plan.sh 沒有 queues-in（回 %s），可能還沒更新到這一版' "$1" ;;
    124) printf '超過 %s 秒沒做完' "$PUSH_TRANSFER_SECONDS" ;;
    255) printf '連不到，fm-on.sh 回 255' ;;
    *) printf 'fm-on.sh 回 %s' "$1" ;;
  esac
}

# delivered_at <mate>: the time of the copy last delivered to <mate>; returns
# 1 when there is no record or its time cannot be read.
delivered_at() {
  jq -er '.at | select(type == "string" and ((try fromdateiso8601 catch null) != null))' \
    "$PUSHED_DIR/$1" 2>/dev/null
}

# minutes_since <iso-time>: whole minutes from <iso-time> to now, at least 0.
minutes_since() {
  jq -nr --arg at "$1" --argjson now "$PUSH_NOW" '[(($now - ($at | fromdateiso8601)) / 60 | floor), 0] | max'
}

# copy_is_due <mate>: whether <mate> lacks this copy, or got it so long ago
# that it is sent again.
copy_is_due() {
  local at
  at=$(delivered_at "$1") || return 0
  [ "$(jq -cS 'del(.at)' "$PUSHED_DIR/$1" 2>/dev/null)" = "$(jq -cS 'del(.at)' "$PUSH_COPY")" ] || return 0
  [ "$(minutes_since "$at")" -ge "$COPY_REFRESH_MINUTES" ]
}

# refused_wait <mate>: minutes left before a far side that refused the copy is
# tried again; returns 1 when nothing holds the mate back.
refused_wait() {
  local rc last left
  rc=$(failing_field "$1" 3) || return 1
  case "$rc" in 1 | 2 | 64) ;; *) return 1 ;; esac
  last=$(failing_field "$1" 2) || return 1
  left=$((REFUSED_RETRY_MINUTES - (PUSH_NOW - last) / 60))
  [ "$left" -gt 0 ] || return 1
  printf '%s\n' "$left"
}

# write_record <file> <text>: replace <file> with <text> through a rename.
write_record() {
  local tmp
  tmp=$(mktemp "$PUSHED_DIR/.record.XXXXXX") || return 1
  printf '%s\n' "$2" > "$tmp" && mv -f "$tmp" "$1"
}

record_delivery() {
  local tmp
  tmp=$(mktemp "$PUSHED_DIR/.record.XXXXXX") || return 1
  cp "$PUSH_COPY" "$tmp" && mv -f "$tmp" "$PUSHED_DIR/$1"
  rm -f "$PUSHED_DIR/$1.failing" "$PUSHED_DIR/$1.warned"
}

record_failure() {  # <mate> <rc>
  local since
  since=$(failing_field "$1" 1) || since=$PUSH_NOW
  write_record "$PUSHED_DIR/$1.failing" "$since $PUSH_NOW $2"
}

# The code transfer returns when the far side exited 0 without saying it took
# the copy.
NO_OK_LINE=250

# transfer <mate>: send the copy; prints the far side's first stderr line and
# returns the exit code, or 0 only when the far side said it took the copy.
transfer() {
  local out rc=0 err
  local -a runner=()
  if command -v timeout >/dev/null 2>&1; then
    runner=(timeout "$PUSH_TRANSFER_SECONDS")
  elif command -v gtimeout >/dev/null 2>&1; then
    runner=(gtimeout "$PUSH_TRANSFER_SECONDS")
  fi
  err=$(mktemp "$PUSHED_DIR/.stderr.XXXXXX") || return 1
  out=$("${runner[@]+"${runner[@]}"}" "$SCRIPT_DIR/fm-on.sh" --stdin "$1" fm-dispatch-plan.sh queues-in - \
    < "$PUSH_COPY" 2> "$err") || rc=$?
  head -n 1 "$err"
  rm -f "$err"
  [ "$rc" -ne 0 ] || printf '%s\n' "$out" | grep -q '^ok queues ' || return "$NO_OK_LINE"
  return "$rc"
}

# warn_if_behind <mate>: under --check, print one line the first time <mate>
# has gone 60 minutes or more without the main home's copy.
warn_if_behind() {
  local mate=$1 at since minutes basis rc reason
  if at=$(delivered_at "$mate"); then
    since=$(jq -nr --arg at "$at" '$at | fromdateiso8601')
    basis='照舊的副本排'
  else
    since=$(failing_field "$mate" 1) || return 0
    basis='照 backlog 原本的順序排'
  fi
  minutes=$(((PUSH_NOW - since) / 60))
  [ "$minutes" -ge "$FMQ_COPY_STALE_MINUTES" ] || return 0
  [ "$PUSH_CHECK" = 1 ] && [ ! -e "$PUSHED_DIR/$mate.warned" ] || return 0
  rc=$(failing_field "$mate" 3) && reason=$(why "$rc") || reason='這一輪沒輪到'
  printf '%s\n' "看板佇列副本：${mate} 已經 ${minutes} 分鐘沒收到主 home 的副本（${reason}），它的 order ${basis}；跑 bin/fm-dispatch-plan.sh queues-push 看細節。"
  : > "$PUSHED_DIR/$mate.warned"
}

# push_mate <mate> <start-seconds>: send the copy to <mate> if it is due.
push_mate() {
  local mate=$1 start=$2 left err rc=0 at
  if ! copy_is_due "$mate"; then
    at=$(delivered_at "$mate")
    report "${mate}：副本沒變，上次送達 ${at}（$(minutes_since "$at") 分鐘前）"
    return 0
  fi
  if left=$(refused_wait "$mate"); then
    report "${mate}：那邊還不能收副本（$(why "$(failing_field "$mate" 3)")），${left} 分鐘後再試"
  elif [ $((SECONDS - start)) -ge "$PUSH_START_SECONDS" ]; then
    report "${mate}：這一輪的時間用完，下一輪再送"
  else
    write_record "$PUSHED_DIR/$mate.tried" "$PUSH_NOW"
    err=$(transfer "$mate") || rc=$?
    if [ "$rc" -eq 0 ]; then
      record_delivery "$mate"
      report "${mate}：已送出（$(jq -r .at "$PUSH_COPY")）"
      return 0
    fi
    record_failure "$mate" "$rc"
    report "${mate}：送不出去（$(why "$rc")${err:+：$err}）；$(at=$(delivered_at "$mate") && printf '上次送達 %s' "$at" || printf '還沒送達過')"
    PUSH_FAILED=1
  fi
  warn_if_behind "$mate"
}

PUSH_FAILED=0

# mates_by_last_try: remote mates, the one tried longest ago first, so a mate
# left over by the time bound goes first at the next run.
mates_by_last_try() {
  local mate tried
  remote_mates | while IFS= read -r mate; do
    tried=$(cat "$PUSHED_DIR/$mate.tried" 2>/dev/null) || tried=0
    case "$tried" in '' | *[!0-9]*) tried=0 ;; esac
    printf '%s %s\n' "$tried" "$mate"
  done | sort -n -k1,1 | cut -d' ' -f2
}

# queues-push [--check | --to <secondmate-id>]: send this home's queue copy to
# each remote mate, or to the one named.
cmd_queues_push() {
  local mates mate start target=''
  case "$#:${1:-}" in
    0:) ;;
    1:--check) PUSH_CHECK=1 ;;
    2:--to)
      target=$2
      tb_valid_id "$target" || usage_error "queues-push --to：secondmate id 格式不對：$target"
      ;;
    *) usage_error "queues-push 只收 --check 或 --to <secondmate-id>" ;;
  esac
  ! in_secondmate_home ||
    tb_die 1 "queues-push 只能在主 home 跑：secondmate home 收副本，不送。"
  require_jq queues-push
  mates=$(remote_mates)
  if [ -n "$target" ]; then
    printf '%s\n' "$mates" | grep -qxF -- "$target" ||
      tb_die 1 "queues-push --to：${target} 不是 data/secondmates.md 裡另一台機器上的 second mate；什麼都沒有送。"
  elif [ -z "$mates" ]; then
    report '沒有遠端的 second mate；沒有要送的。'
    return 0
  fi
  if [ ! -f "$TOPICS_FILE" ] || ! fmq_usable_topic_file "$TOPICS_FILE"; then
    report '主 home 沒有可用的議題檔，沒有東西可以送。'
    return 0
  fi
  { mkdir -p "$PUSHED_DIR" && chmod 700 "$PLAN_STATE" "$PUSHED_DIR"; } ||
    tb_die 1 "queues-push：建不了 ${PUSHED_DIR}；什麼都沒有送。"
  PUSH_COPY=$(mktemp "$PUSHED_DIR/.copy.XXXXXX") || tb_die 1 "queues-push：在 ${PUSHED_DIR} 開不了暫存檔。"
  trap '[ -z "$PUSH_COPY" ] || rm -f "$PUSH_COPY"' EXIT
  build_copy "$PUSH_COPY" || tb_die 1 "queues-push：做不出佇列副本；什麼都沒有送。"
  PUSH_NOW=$(date +%s)
  start=$SECONDS
  if [ -n "$target" ]; then
    push_mate "$target" "$start"
  else
    for mate in $(mates_by_last_try); do
      push_mate "$mate" "$start"
    done
  fi
  [ "$PUSH_CHECK" = 1 ] || [ "$PUSH_FAILED" = 0 ]
}

QUEUES_IN_TMP=''

# queues-in -: keep the copy on stdin as this home's queue copy, unless the
# copy already kept is newer. Written for bash 3.2 and BSD tools, since it runs
# on the far machine.
cmd_queues_in() {
  local at kept_at size
  [ "$#" -eq 1 ] && [ "$1" = - ] || usage_error "queues-in 只收一個參數 -，副本從 stdin 讀"
  in_secondmate_home ||
    tb_die 1 "queues-in 只能在 secondmate home 跑：主 home 用自己的議題檔。什麼都沒有寫。"
  require_jq queues-in
  { mkdir -p "$PLAN_STATE" && chmod 700 "$PLAN_STATE"; } ||
    tb_die 1 "queues-in：建不了 ${PLAN_STATE}；什麼都沒有寫。"
  QUEUES_IN_TMP=$(mktemp "$PLAN_STATE/.queues-in.XXXXXX") ||
    tb_die 1 "queues-in：在 ${PLAN_STATE} 開不了暫存檔；什麼都沒有寫。"
  trap '[ -z "$QUEUES_IN_TMP" ] || rm -f "$QUEUES_IN_TMP"' EXIT
  head -c "$((COPY_MAX_BYTES + 1))" > "$QUEUES_IN_TMP"
  size=$(wc -c < "$QUEUES_IN_TMP" | tr -d ' ')
  [ "$size" -le "$COPY_MAX_BYTES" ] ||
    tb_die 1 "queues-in：收到的副本超過 ${COPY_MAX_BYTES} 位元組；什麼都沒有寫。"
  at=$(jq -rs "$FMQ_COPY_VALID"' if length == 1 and (.[0] | valid_copy) then .[0].at else error("invalid") end' \
    "$QUEUES_IN_TMP" 2>/dev/null) ||
    tb_die 1 "queues-in：收到的不是可用的佇列副本（fm-dispatch-queues.v1）；什麼都沒有寫。"
  if kept_at=$(jq -r "$FMQ_COPY_VALID"' if valid_copy then .at else error("invalid") end' "$COPY_FILE" 2>/dev/null) &&
    [[ "$at" < "$kept_at" ]]; then
    printf '%s\n' "ok queues 已有較新的副本（${kept_at}），這一份（${at}）略過"
    return 0
  fi
  mv -f "$QUEUES_IN_TMP" "$COPY_FILE" || tb_die 1 "queues-in：寫不進 ${COPY_FILE}；原來的副本沒有動。"
  QUEUES_IN_TMP=''
  printf '%s\n' "ok queues 副本已更新（${at}）"
}

main() {
  [ "$#" -gt 0 ] || usage_error "少了子命令"
  local sub=$1
  shift
  case "$sub" in
    -h | --help) usage ;;
    order) cmd_order "$@" ;;
    queues-in) cmd_queues_in "$@" ;;
    queues-push) cmd_queues_push "$@" ;;
    *) usage_error "不認得的子命令：$sub" ;;
  esac
}

main "$@"
