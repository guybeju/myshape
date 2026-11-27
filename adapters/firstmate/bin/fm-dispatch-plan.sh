#!/usr/bin/env bash
# fm-dispatch-plan.sh - firstmate's dispatch plan from the topic board's queues
# and the load of the machines that run its workers.
#
# Usage:
#   fm-dispatch-plan.sh order [--hashtag <name>] [--tsv]
#   fm-dispatch-plan.sh machine [--json]
#   fm-dispatch-plan.sh machines [--json]
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
#        --hashtag <name> keeps every heading but lists only the lines whose
#        topic carries that hashtag in the board's data/myshape/hashtags.json
#        (a merged topic's hashtags count for the topic it went into; the
#        name matches its stored spelling and case and full-width variants).
#        It is a view only and still read-only. It runs in the main home
#        only: a secondmate home's queues may come from the pushed copy,
#        which has no hashtags, so there it is refused with exit 1.
#        Before listing, order asks rule-v1 (see machine) whether this machine
#        can take one more worker now, from its host signals alone. When it
#        says wait, a line after the source line gives why and the work that
#        would be under 可派 is listed under 等機器, right after 可派, instead;
#        an answered decision stays under 可派, since it starts no worker.
#        When the signals cannot be read it says unknown: one line says so
#        and 可派 is listed as before. A room answer adds nothing.
#        --tsv prints the same items for a program, one tab-separated line
#        each and no other line: section (dispatch, machine-wait, hold,
#        release, parked, not-yet), id, topic id, topic name, queue (high,
#        normal, later, archived, none), place in the queue, repo, and work or
#        decision. The hands-on items under 等你驗證 are not listed there.
#
# machine [--json]
#        This machine's record, fm-dispatch-machine.v1, built when asked and
#        kept nowhere: the host's load, memory and disk (fm-capacity.sh's
#        report and fm-lane-vitals-lib.sh's 5-minute load), the workers of
#        every local home (fm_local_firstmate_state_dirs) with the state each
#        home's state/home-summary.json gives them, each project's limit and
#        places held from the root home's config/project-capacity
#        (fm-project-capacity-lib.sh), each home's commit and role
#        (fm-role.sh report), the clone directory names, and the version of
#        each tool on dispatch-plan/common-tools.tsv. --json prints it, with
#        each local home's work under 可派 and 等機器 (order --tsv) as ready[];
#        without --json it prints the machines view of this machine alone.
#        Labels and numbers only, never paths. Read-only. Written for bash
#        3.2 and BSD tools: the main home runs it on the far machine.
#
# machines [--json]
#        In the main home: this machine's record, and the record of the
#        machine of each secondmate in data/secondmates.md on another
#        machine, through "fm-on.sh <id> fm-dispatch-plan.sh machine --json"
#        cut at 20 s. rule-v1 turns each record into room, wait or unknown,
#        with reasons and each project's free places: unknown for a record of
#        another schema, one more than 600 s off this clock, or one without
#        load1, cores or mem_free_pct; wait for load1 >= cores, load5 >= 0.85
#        x cores, mem_free_pct < 10 or disk_free_mb < 5120. It prints one
#        block per machine (verdict, workers, each project's places and its
#        next item), then 該轉告 (lines for secondmates), 該通知 (lines for the
#        captain) and 環境差異 (setup gaps: tools against the common list, a
#        home's commit or role against the main home's, a next item's repo
#        with no clone there). A machine that cannot be reached is 不知道 and
#        counts for nothing. --json prints the records and verdicts instead.
#        Read-only: it never spawns, sends or holds.
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
# that script's argument parser offers it, else --json).
#
# Exit codes: 0 success (including the fall-open answers and an older copy
# ignored), 1 refused (machines outside the main home, and queues-push without
# --check when a transfer failed), 2 usage error.
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
# rule-v1 reads a record this many seconds or more away from the reader's
# clock as unknown: one handed around, or from a far machine whose clock is off.
RECORD_FRESH_SECONDS=600
# machines waits this long for a far machine's record (one fm-on.sh round trip).
REMOTE_RECORD_SECONDS=20
# fm-capacity.sh's report and each tool's version call are cut at these.
HOST_PROBE_SECONDS=10
TOOL_VERSION_SECONDS=5
TOOLS_FILE="$SCRIPT_DIR/../dispatch-plan/common-tools.tsv"

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

# run_bounded <seconds> <command...>: run <command>, cut at <seconds> by
# timeout or gtimeout when one is on PATH (macOS has neither by default), else
# unbounded.
run_bounded() {
  local seconds=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  else
    "$@"
  fi
}

# Print the snapshot JSON, or return non-zero when it cannot be produced. The
# snapshot gives --board-input when it offers it (tb_snapshot_mode), else --json.
order_snapshot() {
  run_bounded 30 env FM_HOME="$FM_HOME" FM_SNAPSHOT_SECONDMATES=1 FM_SNAPSHOT_BUDGET=1 FM_CREW_STATE_NO_FORGE=1 \
    "$SCRIPT_DIR/fm-fleet-snapshot.sh" "$(tb_snapshot_mode "$SCRIPT_DIR")" 2>/dev/null
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

# order_args <arg...>: parse order's flags into ORDER_HASHTAG and ORDER_TSV.
order_args() {
  ORDER_HASHTAG=''
  ORDER_TSV=false
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --hashtag)
        [ "$#" -ge 2 ] && [ -n "$2" ] || usage_error "order 只收 --hashtag <名稱> 與 --tsv"
        ORDER_HASHTAG=$2
        shift 2
        ;;
      --tsv)
        ORDER_TSV=true
        shift
        ;;
      *) usage_error "order 只收 --hashtag <名稱> 與 --tsv" ;;
    esac
  done
}

cmd_order() {
  local snapshot tags sm=0 todos=/dev/null hashtags=/dev/null filtered=false verdict
  order_args "$@"
  [ -z "$ORDER_HASHTAG" ] || filtered=true
  require_jq order
  ! in_secondmate_home || sm=1
  if [ "$filtered" = true ] && [ "$sm" -eq 1 ]; then
    tb_die 1 "order --hashtag 只在主 home 用：secondmate home 的佇列副本沒有 hashtag。要看貼著 #${ORDER_HASHTAG#\#} 的項目，請在主 home 跑。"
  fi
  [ "$filtered" = false ] || [ ! -f "$DATA/myshape/hashtags.json" ] || hashtags=$DATA/myshape/hashtags.json
  order_source
  if ! snapshot=$(order_snapshot) || [ -z "$snapshot" ]; then
    [ "$ORDER_TSV" = true ] || printf '%s\n' "讀不到 backlog，照平常的方式派工。"
    return 0
  fi
  tags=$(order_tags)
  if [ "$sm" -eq 0 ] && jq -e '.items | objects' "$DATA/myshape/todos.json" >/dev/null 2>&1; then
    todos=$DATA/myshape/todos.json
  fi
  verdict=$(order_verdict) && [ -n "$verdict" ] || verdict='{"machine":"unknown","reasons":["讀不到這台機器的訊號"]}'
  printf '%s' "$snapshot" | jq -r --arg note "$ORDER_NOTE" --arg tags "$tags" --arg own "$OWN_HOLD_PREFIX" \
    --slurpfile live "$ORDER_TOPICS" --slurpfile gone "$ORDER_ARCHIVE" --slurpfile todos "$todos" \
    --slurpfile hashtags "$hashtags" --arg hashtag "$ORDER_HASHTAG" --argjson filtered "$filtered" \
    --argjson verdict "$verdict" --argjson tsv "$ORDER_TSV" "$(tb_hashtag_fold_jq)
$(tb_hashtag_topics_jq)
$ORDER_JQ" || {
    [ "$ORDER_TSV" = true ] || printf '%s\n' "讀不到 backlog，照平常的方式派工。"
    return 0
  }
}

# The jq program of order: it ranks the snapshot's queued records by the
# board's queues and prints the sections, or with $tsv the tab-separated lines.
# shellcheck disable=SC2016 # jq, not the shell, expands these $names.
ORDER_JQ='
    ($live[0] // null) as $doc
    | (if $filtered then hashtag_topics($hashtags[0] // {}; $doc // {}; $hashtag) else null end) as $tagged
    | def shown: $tagged == null or (.topic as $t | $t != null and any($tagged[]; . == $t));
      ($gone[0].topics // $doc.archived // {}) as $archived
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
           name: ($p.name // "（未分類）"), repo: ($r.repo // ""),
           decision: ($r.kind == "captain"),
           own_hold: (($r.hold_reason // "") | startswith($own)),
           other_hold: ($r.hold_reason != null and ((($r.hold_reason // "") | startswith($own)) | not)),
           captain_hold: ($r.hold_kind == "captain"),
           waits: ($r.unresolved_blocker_ids // []),
           blocked: (($r.unresolved_blocker_ids // []) | length > 0),
           parked: ($p.queue == "later" or $p.queue == "archived")} | select(shown) ] as $items
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
      ($verdict.machine // "unknown") as $machine
    | ($ready | map(select($machine != "wait" or .decision))) as $dispatch
    | ($ready | map(select($machine == "wait" and (.decision | not)))) as $waiting
    | def held_mark: if .own_hold then "\t← 還被看板的 hold 擋著，先照「該解除」解除" else "" end;
      def row($section):
        [$section, .id, (.topic // ""), .name, .queue, (.at | tostring), .repo,
         (if .decision then "decision" else "work" end)]
        | map(tostring | gsub("[\t\n]"; " ")) | join("\t");
      if $tsv then
        ($dispatch[] | row("dispatch")), ($waiting[] | row("machine-wait")), ($to_hold[] | row("hold")),
        ($to_release[] | row("release")), ($parked[] | row("parked")), ($unplaced[] | row("not-yet"))
      else
      (if $note != "" then $note else empty end),
      (if $machine == "wait" then
         "這台機器先等（rule-v1：\($verdict.reasons | join("；"))）；「等機器」的項目先不派，下一輪再看；captain 明講要做的照派。"
       elif $machine == "unknown" then
         "看不出這台機器能不能再加（rule-v1：\(($verdict.reasons // []) | join("；"))）；照「可派」派。"
       else empty end),
      (if $filtered then "只列議題貼著 #\($hashtag | ltrimstr("#")) 的項目。" else empty end),
      "可派：",
      ($dispatch[] | line + held_mark
        + (if .decision then "\t← 決定事項，使用者已經回答；沒有工作要派，照回答處理後關掉" else "" end)),
      (if $machine == "wait" then "等機器：", ($waiting[] | line + held_mark) else empty end),
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
         | {id: .key, topic: $topic, name: ($p.name // "（未分類）"), queue: $p.queue} | select(shown) ] as $claimed
       | if ($claimed | length) == 0 then empty
         else "等你驗證：",
              ($claimed[] | line + "\t← 使用者說做完了；驗證後跑 bin/myshape.sh todo done \(.id)，沒成功就跑 bin/myshape.sh todo failed \(.id) --reason <一行>")
         end)
      end
'

# --- this machine's signals and rule-v1 --------------------------------------

# The jq turning fm-capacity.sh's report line ($line) and the vitals probe's
# 5-minute load ($load5) into {host, notes}. A signal that cannot be read is
# null, never 0, and notes says which.
# shellcheck disable=SC2016 # jq, not the shell, expands these $names.
HOST_JQ='
  def field($key): ($line | capture("(^| )" + $key + "=(?<v>[^ ]+)") | .v) // null;
  def number: if . == null or . == "" then null else (try tonumber catch null) | if . == null then null else . + 0 end end;
  {load1: (field("load1") | number), load5: ($load5 | number), cores: (field("cores") | number),
   mem_free_pct: (field("mem_free_pct") | number), disk_free_mb: (field("disk_free_mb") | number)} as $host
  | {host: $host,
     notes: ((if $line | startswith("capacity: ") then [] else ["讀不到 fm-capacity.sh 的報告"] end)
             + [$host | to_entries[] | select(.value == null) | "\(.key) 讀不到"])}'

# rule_v1($now; $fresh): a stateless function of one record and the reader's
# clock. unknown for another schema, a record more than $fresh seconds off the
# clock, or one without load1, cores or mem_free_pct; otherwise wait when any
# of upstream's own thresholds holds (fm-capacity.sh's fixed cpu, memory and
# disk constraints, and its cpu gate's 0.85 x cores reopen line for load5),
# else room. A null or absent signal is unknown and its clause is not judged;
# unknown keys are ignored. Each project line gets its free places.
# shellcheck disable=SC2016 # jq, not the shell, expands these $names.
RULE_V1_JQ='
  def machine_schema: "fm-dispatch-machine.v1";
  def rule_v1($now; $fresh):
    def known: type == "number";
    def shown: (. * 100 | round) / 100 | tostring;
    (if type == "object" then . else {} end) as $r
    | ($r.host | if type == "object" then . else {} end) as $h
    | [("load1", "cores", "mem_free_pct") | select(($h[.] | known) | not)] as $missing
    | (if $r.schema != machine_schema then ["不認得的紀錄版本 \($r.schema // "（沒有 schema）")"]
       elif ($r.collected_epoch | known) | not then ["紀錄沒有收集的時間"]
       elif $now - $r.collected_epoch > $fresh then ["紀錄是 \($now - $r.collected_epoch | floor) 秒前的"]
       elif $r.collected_epoch - $now > $fresh then ["紀錄的時間比這台快 \($r.collected_epoch - $now | floor) 秒"]
       elif ($missing | length) > 0 then ["缺少必要訊號：\($missing | join("、"))"]
       else [] end) as $unknown
    | (if ($unknown | length) > 0 then [] else
         [ (if $h.load1 >= $h.cores then "cpu: 1 分鐘負載 \($h.load1 | shown)，\($h.cores) 核心" else empty end),
           (if ($h.load5 | known) and $h.load5 >= $h.cores * 0.85
            then "cpu: 5 分鐘負載 \($h.load5 | shown) ≥ \($h.cores * 0.85 | shown)（核心數 × 0.85）" else empty end),
           (if $h.mem_free_pct < 10 then "memory: 可用 \($h.mem_free_pct | shown)%" else empty end),
           (if ($h.disk_free_mb | known) and $h.disk_free_mb < 5120
            then "disk: 剩 \($h.disk_free_mb | shown) MB" else empty end) ]
       end) as $waits
    | (if ($unknown | length) > 0 then "unknown" elif ($waits | length) > 0 then "wait" else "room" end) as $machine
    | {decider: "rule-v1", machine: $machine, reasons: ($unknown + $waits),
       projects: [ ($r.projects | if type == "array" then .[] else empty end)
                   | select(type == "object" and (.name | type) == "string" and (.limit | known) and (.held | known))
                   | ([.limit - .held, 0] | max) as $free
                   | {name, limit, held, free: $free,
                      verdict: (if $free == 0 or $machine == "wait" then "wait"
                                elif $machine == "unknown" then "unknown" else "room" end),
                      why: (if $free == 0 then "上限 \(.limit) 都佔了" elif $machine == "wait" then "機器先等"
                            elif $machine == "unknown" then "機器不知道" else "還能派 \($free)" end)} ]};'

# host_load5: the 5-minute load average from upstream's vitals probe, empty
# when it cannot be read. The libraries load in a subshell, so none of their
# globals reach the caller.
host_load5() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/fm-timeout-lib.sh" && . "$SCRIPT_DIR/fm-lane-vitals-lib.sh" &&
      fm_lane_vitals_probe "$(uname -s 2>/dev/null)" 0 && printf '%s\n' "${LV_LOAD5:-}"
  ) 2>/dev/null
}

# host_json: this machine's {host, notes}, from upstream's own probes:
# fm-capacity.sh's report line for load1, cores, mem_free_pct and disk_free_mb,
# and fm-lane-vitals-lib.sh for load5. Both have Darwin branches, and
# FM_PROC_ROOT_OVERRIDE replaces /proc for both.
host_json() {
  local line load5
  line=$(run_bounded "$HOST_PROBE_SECONDS" env FM_HOME="$FM_HOME" "$SCRIPT_DIR/fm-capacity.sh" </dev/null 2>/dev/null |
    head -n 1) || true
  load5=$(host_load5) || load5=''
  jq -nc --arg line "$line" --arg load5 "$load5" "$HOST_JQ"
}

# order_verdict: rule-v1's answer for this machine from its host signals
# alone, as one JSON object; project places stay fm-spawn.sh's to enforce.
order_verdict() {
  local now host
  now=$(date +%s)
  host=$(host_json) || return 1
  printf '%s' "$host" | jq -c --argjson now "$now" --argjson fresh "$RECORD_FRESH_SECONDS" "$RULE_V1_JQ"'
    {schema: machine_schema, collected_epoch: $now, host: .host} | rule_v1($now; $fresh)'
}

# --- the machine record ------------------------------------------------------

# home_label <home>: "main" for a primary home, else its secondmate id.
home_label() {
  local id
  if fm_root_is_secondmate_home "$1"; then
    IFS= read -r id < "$1/.fm-secondmate-home" || true
    printf '%s\n' "${id//[[:space:]]/}"
  else
    printf 'main\n'
  fi
}

# in_home <home> <command...>: run <command> against <home>; the path overrides
# that point at this home are kept only when <home> is this home.
in_home() {
  local home=$1
  shift
  if [ "$home" = "$FM_HOME" ]; then
    "$@"
  else
    env -u FM_STATE_OVERRIDE -u FM_DATA_OVERRIDE -u FM_CONFIG_OVERRIDE -u FM_PROJECTS_OVERRIDE \
      FM_HOME="$home" "$@"
  fi
}

# home_summary_states <home>: the generated_epoch of <home>'s
# state/home-summary.json on the first line, then "<task-id>\t<state>" per
# endpoint it lists; nothing when the summary is absent or of another schema.
home_summary_states() {
  jq -r 'select(.schema == "fm-secondmate-home-summary.v1")
         | "\(.generated_epoch // "")", (.endpoints[]? | select(type == "object") | "\(.id)\t\(.state // "")")' \
    "$1/state/home-summary.json" 2>/dev/null || true
}

# facts_worker <home-label> <meta> <summary-states>: one worker line for a
# ship or scout record (a secondmate record is a home, not a worker).
facts_worker() {
  local meta=$2 id kind spawn state pr=0
  kind=$(fm_meta_get "$meta" kind)
  [ "$kind" != secondmate ] || return 0
  id=$(basename "$meta" .meta)
  spawn=$(sed -n 's/^spawn_gen=s\([0-9][0-9]*\)\..*/\1/p' "$meta" 2>/dev/null | tail -n 1)
  state=$(printf '%s\n' "$3" | awk -F'\t' -v id="$id" 'NR > 1 && $1 == id { print $2; exit }')
  [ -z "$(fm_meta_get "$meta" pr)" ] || pr=1
  printf 'worker\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$id" "$kind" \
    "$(basename "$(fm_meta_get "$meta" project)")" "$spawn" "$pr" "$(fm_meta_get "$meta" effort)" \
    "$(fm_meta_get "$meta" model)" "$(fm_meta_get "$meta" mode)" "$state" "$(printf '%s\n' "$3" | head -n 1)"
}

# facts_home <home> <state-dir>: the home line, its clone names and its workers.
facts_home() {
  local home=$1 label summary meta dir role
  label=$(home_label "$home")
  role=$(in_home "$home" "$SCRIPT_DIR/fm-role.sh" report 2>/dev/null </dev/null |
    sed -n 's/^fm-role: \([^ ]*\).*/\1/p' | head -n 1) || role=''
  printf 'home\t%s\t%s\t%s\t%s\n' "$label" "$home" "$(git -C "$home" rev-parse HEAD 2>/dev/null)" "$role"
  printf 'cloned\t%s\n' "$(basename "$home")"
  for dir in "$home"/projects/*/; do
    [ ! -d "$dir" ] || printf 'cloned\t%s\n' "$(basename "$dir")"
  done
  summary=$(home_summary_states "$home")
  for meta in "$2"/*.meta; do
    [ -f "$meta" ] && [ ! -L "$meta" ] || continue
    facts_worker "$label" "$meta" "$summary"
  done
}

# project_dir_named <name>: a clone directory on this machine named <name>: a
# worker's project, a local home itself, or a home's projects/<name>.
project_dir_named() {
  local state home meta dir
  for state in "${FM_LOCAL_FIRSTMATE_STATES[@]}"; do
    for meta in "$state"/*.meta; do
      [ -f "$meta" ] || continue
      dir=$(fm_meta_get "$meta" project)
      if [ -n "$dir" ] && [ "$(basename "$dir")" = "$1" ] && [ -d "$dir" ]; then
        printf '%s\n' "$dir"
        return 0
      fi
    done
    home=$(dirname "$state")
    [ "$state" != "$FACTS_FIRST" ] || home=$FM_HOME
    if [ "$(basename "$home")" = "$1" ]; then
      printf '%s\n' "$home"
      return 0
    elif [ -d "$home/projects/$1" ]; then
      printf '%s\n' "$home/projects/$1"
      return 0
    fi
  done
  return 1
}

# project_held <name>: the places held in <name>'s capacity, counted the way
# fm-spawn.sh counts them (fm_project_capacity_occupants, by the clone's
# origin); 0 when no clone of that name is on this machine, since no worker of
# it can start here; empty when the records cannot all be read.
project_held() {
  local dir lock
  dir=$(project_dir_named "$1") || {
    printf '0\n'
    return 0
  }
  lock=$(fm_treehouse_project_lock_path "$dir") || return 0
  fm_project_capacity_occupants "$lock" "$dir" "$FACTS_FIRST" '' || return 0
  printf '%s\n' "$FM_PROJECT_CAPACITY_OCCUPANTS"
}

# facts_projects: one project line per project the root home's
# config/project-capacity declares, with its places held.
facts_projects() {
  local cfg line name
  cfg=$(fm_project_capacity_config_dir "$FM_HOME" "${FM_CONFIG_OVERRIDE:-$FM_HOME/config}") || {
    printf 'note\t找不到這台最上層的 home，專案上限讀不到\n'
    return 0
  }
  [ -f "$cfg/project-capacity" ] || return 0
  fm_project_capacity_lookup "$cfg" '' || {
    printf 'note\t這台的 config/project-capacity 讀不懂；fm-spawn.sh 照它拒絕這台每個新的 ship 與 scout\n'
    return 0
  }
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    line=${line%"${line##*[![:space:]]}"}
    name=${line%"${line##*[[:space:]]}"}
    name=${name%"${name##*[![:space:]]}"}
    name=${name#"${name%%[![:space:]]*}"}
    [ -n "$name" ] && fm_project_capacity_lookup "$cfg" "$name" && [ -n "$FM_PROJECT_CAPACITY" ] || continue
    printf 'project\t%s\t%s\t%s\n' "$name" "$FM_PROJECT_CAPACITY" "$(project_held "$name")"
  done < "$cfg/project-capacity"
}

# facts_walk: home, cloned, worker, project and note lines for every local
# home on this machine (upstream's fm_local_firstmate_state_dirs), and an
# incomplete line when that walk could not read every home.
facts_walk() {
  local state home
  FACTS_FIRST=${FM_STATE_OVERRIDE:-$FM_HOME/state}
  fm_local_firstmate_state_dirs "$FACTS_FIRST" || printf 'incomplete\n'
  for state in "${FM_LOCAL_FIRSTMATE_STATES[@]}"; do
    home=$(dirname "$state")
    [ "$state" != "$FACTS_FIRST" ] || home=$FM_HOME
    facts_home "$home" "$state"
  done
  facts_projects
}

# machine_facts: facts_walk with upstream's libraries loaded in a subshell, so
# none of their globals reach the caller.
machine_facts() {
  (
    # shellcheck source=/dev/null
    { . "$SCRIPT_DIR/fm-wake-lib.sh" && . "$SCRIPT_DIR/fm-backend.sh" &&
      . "$SCRIPT_DIR/fm-project-capacity-lib.sh"; } >/dev/null 2>&1 || {
      printf 'note\t讀不到上游的函式庫（fm-wake-lib.sh、fm-backend.sh、fm-project-capacity-lib.sh）\nincomplete\n'
      exit 0
    }
    facts_walk
  ) 2>/dev/null
}

# machine_tools: a tools-listed line and one "tool <name> <found 1|0>
# <version>" line per tool on the common list; a note when there is no list.
machine_tools() {
  local name out version
  [ -f "$TOOLS_FILE" ] || {
    printf 'note\t沒有共用工具清單（dispatch-plan/common-tools.tsv），工具待查\n'
    return 0
  }
  printf 'tools-listed\n'
  while IFS=$'\t' read -r name _ || [ -n "$name" ]; do
    case "$name" in '' | '#'*) continue ;; esac
    if command -v "$name" >/dev/null 2>&1; then
      out=$(run_bounded "$TOOL_VERSION_SECONDS" "$name" --version </dev/null 2>/dev/null) || true
      version=$(printf '%s\n' "$out" |
        awk 'match($0, /[0-9]+(\.[0-9]+)+/) { print substr($0, RSTART, RLENGTH); exit }')
      printf 'tool\t%s\t1\t%s\n' "$name" "$version"
    else
      printf 'tool\t%s\t0\t\n' "$name"
    fi
  done < "$TOOLS_FILE"
}

# machine_ready <facts>: one ready line per piece of work each local home lists
# under 可派 or 等機器 (its order --tsv), in that home's order.
machine_ready() {
  local label dir
  printf '%s\n' "$1" | awk -F'\t' '$1 == "home" { print $2 "\t" $3 }' | while IFS=$'\t' read -r label dir; do
    in_home "$dir" "$SCRIPT_DIR/fm-dispatch-plan.sh" order --tsv </dev/null 2>/dev/null |
      awk -F'\t' -v home="$label" '($1 == "dispatch" || $1 == "machine-wait") && $8 == "work" { print "ready\t" home "\t" $0 }' ||
      true
  done
}

# The jq building the record from the fact lines on stdin, $host ({host,
# notes}), $now, $machine, $os and $arch. Paths in the facts stay out of it.
# shellcheck disable=SC2016 # jq, not the shell, expands these $names.
RECORD_JQ='
  def text: if . == null or . == "" then null else . end;
  def count: text | if . == null then null else (try tonumber catch null) end;
  def since: count | if . == null then null else $now - . end;
  [inputs | split("\t")] as $rows
  | def rows($kind): $rows[] | select(.[0] == $kind);
    {schema: machine_schema, collected_epoch: $now, machine: $machine, platform: {os: $os, arch: $arch},
     host: $host.host,
     homes: [rows("home") | {home: .[1], code: (.[3] | text), role: (.[4] | text)}],
     workers: [rows("worker") | {home: .[1], id: .[2], kind: (.[3] | text), project: (.[4] | text),
       age_s: (.[5] | since), pr_ready: (.[6] == "1"), state: (.[10] | text),
       state_age_s: (if (.[10] | text) == null then null else (.[11] | since) end),
       declared: {effort: (.[7] | text), model: (.[8] | text), mode: (.[9] | text)}}],
     workers_complete: ([rows("incomplete")] | length == 0),
     projects: [rows("project") | {name: .[1], limit: (.[2] | count), held: (.[3] | count)}],
     projects_cloned: ([rows("cloned") | .[1]] | unique),
     tools: (if [rows("tools-listed")] | length > 0
             then [rows("tool") | {name: .[1], found: (.[2] == "1"), version: (.[3] | text)}] else null end),
     ready: [rows("ready") | {home: .[1], section: .[2], id: .[3], topic: (.[4] | text), topic_name: .[5],
       queue: .[6], at: (.[7] | count // 0), repo: (.[8] | text)}],
     notes: ($host.notes + [rows("note") | .[1]])}'

# machine_record: this machine's fm-dispatch-machine.v1 record, on one line.
machine_record() {
  local now host facts machine
  now=$(date +%s)
  host=$(host_json) || host='{"host":{},"notes":["讀不到這台機器的訊號"]}'
  facts=$(machine_facts)
  machine=$(hostname 2>/dev/null) || machine=''
  machine=${machine%%.*}
  [ -n "$machine" ] || machine=$(uname -n 2>/dev/null) || machine=''
  { printf '%s\n' "$facts"; machine_tools; machine_ready "$facts"; } |
    jq -Rnc --argjson now "$now" --argjson host "$host" --arg machine "${machine%%.*}" \
      --arg os "$(uname -s 2>/dev/null)" --arg arch "$(uname -m 2>/dev/null)" "$RULE_V1_JQ$RECORD_JQ"
}

# --- the machines view -------------------------------------------------------

# The jq of the view, over {now, fresh, list (the common tools, {name,
# floor}), machines ([{via, record, error}])}; $json picks the records and
# verdicts instead of the text. Every action line comes from the records as
# they are now: nothing is remembered between runs.
# shellcheck disable=SC2016 # jq, not the shell, expands these $names.
MACHINES_VIEW_JQ='
  def qname: {high: "高", normal: "一般", later: "待辦", archived: "已封存", none: "未分類"}[.] // .;
  def qrank: {high: 0, normal: 1}[.] // 2;
  def shown: if type == "number" then ((. * 100 | round) / 100 | tostring) else "不知道" end;
  def word: {room: "可以加", wait: "先等", unknown: "不知道"}[.];
  def version_key: split(".") | map(tonumber? // 0);
  def item_text:
    "\(.home)/\(.id)（\(if .queue == "none" then "未分類" else "\(.queue | qname)，\(.topic_name)" end)"
    + (if .section == "machine-wait" then "，等機器" else "" end) + "）";
  def unlisted($names): select((.repo // "") as $r | $names | index($r) | not);
  def entry($now; $fresh):
    (.record | if type == "object" then . else null end) as $rec
    | (if $rec != null then ($rec | rule_v1($now; $fresh))
       else {decider: "rule-v1", machine: "unknown", reasons: [.error // "沒有紀錄"], projects: []} end) as $verdict
    | ($rec.homes // [] | map(.home)) as $homes
    | [($rec.ready // [])[] | select(type == "object")] as $ready
    | {via, error, record: $rec, verdict: $verdict, label: ($rec.machine // "\(.via) 那台"),
       items: ([range(0; $ready | length) as $i | $ready[$i]
                | . + {seq: $i, home_at: (.home as $h | $homes | index($h) // 99)}]
               | sort_by([(.queue | qrank), (.at // 0), .home_at, .seq]))};
  def host_text:
    (.record.host // {}) as $h
    | "負載 \($h.load1 | shown)，5 分鐘 \($h.load5 | shown)，\($h.cores | shown) 核心；記憶體可用 "
      + (if ($h.mem_free_pct | type) == "number" then "\($h.mem_free_pct)%" else "不知道" end) + "；磁碟剩 "
      + (if ($h.disk_free_mb | type) == "number" then "\($h.disk_free_mb / 1024 | floor) GB" else "不知道" end) + "。";
  def header:
    if .record == null then "\(.label)：不知道（\(.error // "沒有紀錄")）；不算也不轉交。"
    else .label + (.record.homes // [] | map(.home) | if length > 0 then "（\(join("、"))）" else "" end)
      + "：\(.verdict.machine | word)（rule-v1"
      + (if (.verdict.reasons | length) > 0 then "：" + (.verdict.reasons | join("；")) else "" end) + "）"
      + (if .verdict.machine == "unknown" then "；不算也不轉交" else "" end) + "。" + host_text end;
  def worker_text:
    "\(.home)/\(.id)（"
    + ([.kind, .declared.effort, (.state // "狀態不知道")] | map(select(. != null and . != "default")) | join("，"))
    + (if (.state_age_s // 0) > 600 then "，\(.state_age_s) 秒前的狀態" else "" end)
    + (if .pr_ready then "，PR 已就緒" else "" end) + "）";
  def workers_line:
    (.record.workers // []) as $w
    | "  " + (if ($w | length) == 0 then "沒有在跑的 worker" else "在跑 \($w | length) 個：\($w | map(worker_text) | join("、"))" end)
      + (if .record.workers_complete == false then "（有 home 沒讀到，可能不只這些）" else "" end) + "。";
  def project_lines:
    . as $m
    | ($m.record.projects // []) as $declared
    | ($declared | map(.name)) as $names
    | ( $declared[] | . as $p
        | ([$m.verdict.projects[] | select(.name == $p.name)][0]) as $v
        | ([$m.items[] | select(.repo == $p.name)][0]) as $next
        | "  \($p.name)：上限 \($p.limit)，"
          + (if $v == null then "佔用讀不到。" elif $v.free == 0 then "佔用 \($v.held)，滿了。"
             else "佔用 \($v.held)，還能派 \($v.free)。" end),
          (if $next != null then "    下一個：\($next | item_text)" else empty end) ),
      ( [$m.items[] | unlisted($names)] | group_by(.repo // "") | sort_by(.[0] | [(.queue | qrank), .at, .home_at, .seq])
        | .[] | "  \(.[0].repo // "（沒寫 repo）")：這台沒有設上限（config/project-capacity），下一個：\(.[0] | item_text)。" );
  def inversions:
    . as $m
    | $m.verdict.projects[] | select(.free == 0) | .name as $n
    | [$m.items[] | select(.repo == $n)] as $its
    | select(($its | length) > 0) | $its[0] as $top
    | [$its[] | select(.home != $top.home)] | group_by(.home) | map(.[0])[]
    | select([(.queue | qrank), .at] > [($top.queue | qrank), $top.at])
    | {project: $n, top: $top, low: .};
  def tell_lines:
    . as $m
    | select($m.verdict.machine != "unknown")
    | ($m.verdict.projects | map(.name)) as $names
    | ( select($m.verdict.machine == "room")
        | [ ($m.verdict.projects[] | select(.free > 0) | .name as $n
             | [$m.items[] | select(.repo == $n)][0] | select(. != null)),
            ([$m.items[] | unlisted($names)] | group_by(.repo // "") | .[] | .[0]) ]
        | map(select(.home != "main")) | unique_by(.home) | .[]
        | "  \(.home)：\($m.label) 可以加，下一個是它的 \(.id)（\(.repo // "沒寫 repo")，\(.queue | qname)）；請它跑 order。" ),
      ( inversions
        | "  \(.low.home)：\(.project) 滿了，\(.top.home)/\(.top.id)（\(.top.queue | qname)）排在 \(.low.home)/\(.low.id)（\(.low.queue | qname)）前面；下一個位子讓給 \(.top.id)。" );
  def notify_lines:
    . as $m
    | select($m.verdict.machine != "unknown")
    | ( inversions
        | "  \($m.label) 的 \(.project) 滿了：先讓 \(.top.home)/\(.top.id)（\(.top.queue | qname)），\(.low.home)/\(.low.id)（\(.low.queue | qname)）等下一個位子。" ),
      ( select($m.verdict.machine == "room")
        | $m.verdict.projects[] | select(.free == 0) | . as $p
        | [$m.items[] | select(.repo == $p.name)] as $its | select(($its | length) > 0)
        | [($m.record.workers // [])[] | select(.project == $p.name and (.pr_ready | not))] as $holders
        | "  \($m.label) 的 \($p.name) 上限 \($p.limit) 比機器緊：佔位的 \($p.held) 個裡 "
          + "\([$holders[] | select(.state == "paused")] | length) 個 paused、\([$holders[] | select(.kind == "scout")] | length) 個是 scout；"
          + "\($its | length) 個項目在等。" );
  def env_lines($list; $main):
    . as $m
    | select($m.record != null) | $m.record as $r
    | ( if ($r.tools | type) != "array" then "  \($m.label)：沒有工具的紀錄（那台的程式可能還沒更新到這一版），工具待查。"
        else $list[] as $e
          | ([$r.tools[] | select(.name == $e.name)][0]) as $t
          | if $t == null then "  \($m.label)：\($e.name) 待查（那台的清單沒有它）。"
            elif ($t.found | not) then "  \($m.label)：\($e.name) 沒裝（補齊：在那台安裝，要 captain 同意）。"
            elif $e.floor == null then empty
            elif $t.version == null then "  \($m.label)：\($e.name) 的版本讀不到，待查。"
            elif ($t.version | version_key) < ($e.floor | version_key)
            then "  \($m.label)：\($e.name) \($t.version) 低於 \($e.floor)（補齊：在那台升級，要 captain 同意）。"
            else empty end
        end ),
      ( ($r.homes // [])[] | select(.home != "main" or $m.via != "here")
        | ( if $main.code == null then empty
            elif .code == null then "  \($m.label)/\(.home) 的 commit 讀不到，待查。"
            elif .code != $main.code
            then "  \($m.label)/\(.home) 的程式在 \(.code[0:7])，主 home 在 \($main.code[0:7])（補齊：更新那個 home）。"
            else empty end ),
          ( if $main.role != null and .role != $main.role
            then "  \($m.label)/\(.home) 的 role 是 \(.role // "讀不到")，主 home 是 \($main.role)（補齊：查那個 home 的 role 繼承）。"
            else empty end ) ),
      ( [$m.items[] | select(.repo != null and (.repo as $x | ($r.projects_cloned // []) | index($x) | not))]
        | group_by(.repo) | .[] | .[0]
        | "  \($m.label) 沒有 \(.repo) 的 clone，\(.home)/\(.id) 要用（補齊：那台的 second mate clone \(.repo)，幾分鐘）。" );
  def view:
  .now as $now | .fresh as $fresh | .list as $list
  | [.machines[] | entry($now; $fresh)] as $ms
  | ([$ms[] | select(.via == "here") | (.record.homes // [])[] | select(.home == "main")][0] // {}) as $main
  | [$ms[] | select(.record != null) | {label, p: "\(.record.platform.os // "?") \(.record.platform.arch // "?")"}] as $platforms
  | if $json then {schema: "fm-dispatch-machines.v1", at: $now, machines: [$ms[] | {via, record, verdict, error}]}
    else
      ($ms[] | (header, (select(.record != null) | workers_line, project_lines))),
      "該轉告：", ($ms[] | tell_lines),
      "該通知（同一件事只說一次）：", ($ms[] | notify_lines),
      "環境差異：", ($ms[] | env_lines($list; $main)),
      (if ($platforms | map(.p) | unique | length) > 1
       then "  作業系統：" + ($platforms | map("\(.label) 是 \(.p)") | join("，")) + "。" else empty end),
      (if ($platforms | length) > 0 then "  登入（例如 gh）：還沒有不用連網的檢查，每台都待查。" else empty end)
    end;'

# tools_list_json: the common tool list as [{name, floor}] (floor null when
# the line gives none).
tools_list_json() {
  [ -f "$TOOLS_FILE" ] || {
    printf '[]\n'
    return 0
  }
  jq -Rnc '[inputs | select(length > 0 and (startswith("#") | not)) | split("\t")
            | {name: .[0], floor: ((.[1] // "") | if . == "" or . == "-" then null else . end)}]' < "$TOOLS_FILE"
}

# machines_view <json true|false> <entries>: print the view of <entries>, a
# JSON array of {via, record, error}.
machines_view() {
  jq -nr --argjson json "$1" --argjson machines "$2" --argjson list "$(tools_list_json)" \
    --argjson now "$(date +%s)" --argjson fresh "$RECORD_FRESH_SECONDS" \
    "$RULE_V1_JQ$MACHINES_VIEW_JQ"'
    {now: $now, fresh: $fresh, list: $list, machines: $machines} | view
    | if type == "string" then . else tojson end' 2>/dev/null ||
    tb_die 1 "machines：做不出機器的檢視。"
}

# remote_why <rc>: why a far machine gave no record, in one phrase.
remote_why() {
  case "$1" in
    0) printf '回來的不是機器紀錄' ;;
    124) printf '%s 秒沒有回應' "$REMOTE_RECORD_SECONDS" ;;
    255) printf '連不到（fm-on.sh 回 255）' ;;
    2 | 64) printf '那邊的 fm-dispatch-plan.sh 還沒有 machine（回 %s）；那台的程式更新到這一版就有' "$1" ;;
    *) printf 'fm-on.sh 回 %s' "$1" ;;
  esac
}

# remote_entry <secondmate-id>: the {via, record, error} of that mate's machine.
remote_entry() {
  local out rc=0
  out=$(run_bounded "$REMOTE_RECORD_SECONDS" "$SCRIPT_DIR/fm-on.sh" "$1" fm-dispatch-plan.sh machine --json \
    </dev/null 2>/dev/null) || rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1; then
    printf '%s' "$out" | jq -c --arg via "$1" '{via: $via, record: ., error: null}'
  else
    jq -nc --arg via "$1" --arg error "$(remote_why "$rc")" '{via: $via, record: null, error: $error}'
  fi
}

# here_entry: the {via, record, error} of this machine.
here_entry() {
  local record
  if record=$(machine_record) && [ -n "$record" ]; then
    printf '%s' "$record" | jq -c '{via: "here", record: ., error: null}'
  else
    jq -nc '{via: "here", record: null, error: "這台的紀錄做不出來"}'
  fi
}

# machine [--json]: this machine's record, or the view of this machine alone.
cmd_machine() {
  local entry
  case "$#:${1:-}" in
    0: | 1:--json) ;;
    *) usage_error "machine 只收 --json" ;;
  esac
  require_jq machine
  entry=$(here_entry)
  if [ "${1:-}" = --json ]; then
    printf '%s' "$entry" | jq -ce '.record | objects' || tb_die 1 "machine：這台的紀錄做不出來。"
    return 0
  fi
  machines_view false "[$entry]"
}

# machines [--json]: every machine's record and verdict, and what to do.
cmd_machines() {
  local json=false entries mate
  case "$#:${1:-}" in
    0:) ;;
    1:--json) json=true ;;
    *) usage_error "machines 只收 --json" ;;
  esac
  ! in_secondmate_home ||
    tb_die 1 "machines 只能在主 home 跑：它看每一台機器；secondmate home 用 machine 看自己這台。"
  require_jq machines
  entries=$(
    {
      here_entry
      for mate in $(remote_mates); do
        remote_entry "$mate"
      done
    } | jq -sc '.'
  )
  machines_view "$json" "$entries"
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
  err=$(mktemp "$PUSHED_DIR/.stderr.XXXXXX") || return 1
  out=$(run_bounded "$PUSH_TRANSFER_SECONDS" "$SCRIPT_DIR/fm-on.sh" --stdin "$1" fm-dispatch-plan.sh queues-in - \
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
    machine) cmd_machine "$@" ;;
    machines) cmd_machines "$@" ;;
    queues-in) cmd_queues_in "$@" ;;
    queues-push) cmd_queues_push "$@" ;;
    *) usage_error "不認得的子命令：$sub" ;;
  esac
}

main "$@"
