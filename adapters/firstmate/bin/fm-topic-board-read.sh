#!/usr/bin/env bash
# fm-topic-board-read.sh - read-only summary of one home for the topic board.
#
# Usage:
#   fm-topic-board-read.sh [--closed-since <offset> <sha>] <ledger-offset> <prefix-sha256>
#   fm-topic-board-read.sh --in-home <secondmate-id> [--closed-since <offset> <sha>] <ledger-offset> <prefix-sha256>
#
# Prints one JSON object describing this home: its tasks and their current
# state, its queued backlog items, its captain holds, worker needs-decision
# questions, every topic tag
# file, and the fleet-ledger lines written since <ledger-offset>. The first call
# passes "0 -"; each later call passes the previous output's ledger.to_offset
# and ledger.to_prefix_sha256. The main home's output also lists the registered
# secondmates. --in-home reads a LOCAL registered secondmate home instead.
#
# Task state, holds, and worker questions come from fm-fleet-snapshot.sh
# --board-input when the snapshot beside it offers that option (its argument
# parser has that case label; tb_snapshot_mode in bin/fm-board-lib.sh), else --json; this script does
# not parse status logs or state files itself. The exceptions
# are two lines of a hold's body: its origin ("Captain hold origin:") and what
# answering it does ("Captain hold on answer: close|release", from
# fm-captain-hold.sh hold --on-answer), reported as on_answer, null when the
# hold records neither value.
#
# ledger.status is "delta" (lines follow), "absent" (no ledger file), or
# "continuity-broken" (the ledger is shorter than <ledger-offset> or its first
# <ledger-offset> bytes no longer hash to <prefix-sha256>; re-read from "0 -").
# Only complete lines are returned, at most 256 KiB per call; ledger.more is
# true when that cap cut the read short.
#
# holds[].hold_set is the hold's "Captain hold set:" stamp from the snapshot
# (UTC ISO, a date for an older stamp, or null).
#
# closed_holds lists closed decisions: every newest resolution record
# ("Resolution recorded by fm-captain-hold." or the retired fm-decision-hold's)
# on a live backlog row, released ones on open rows included, plus those on rows
# that Done retention appended to the markdown archive since --closed-since's
# cursor. Each is {id, title, origin, mode, answer, label, source, digest,
# occurrence, opened_at, closed_at}: mode is the record's Resolution mode
# ("" for a record without one); a keyed answer ("Captain answered this call
# through <source>.") gives source, answer and label, any other record gives
# source "" and its first line as answer (cut to 300 characters); occurrence
# is the row's count of resolution records; opened_at and closed_at are epoch
# seconds from state/captain-hold-events.jsonl (fm-captain-hold.sh writes one
# line per hold and resolution; the earliest line of that task, occurrence and
# event), or null when the home has no such line. The main home's closed
# holds whose reason starts with 動手： are left out: those are hands-on items
# from before the board kept them, whose close the board already recorded as
# the item's own.
# closed_cursor is the archive cursor to pass back as --closed-since:
# {status, to_offset, to_prefix_sha256, more}. Without --closed-since the status
# is "start" and the cursor is the archive's end, so the first read reports no
# archive row; "delta" reports the rows after the cursor; "continuity-broken"
# (the archive no longer starts with the cursor's bytes) and "absent" (no
# markdown archive) report none, the first with the archive's end as the new
# cursor. At most 256 KiB of the archive per call, cut before a row; more is
# true when that cap cut it short. A failure in this part leaves both keys out
# rather than failing the read.
#
# Before it reads anything, it checks that the Firstmate scripts beside it
# have what a true report needs beyond upstream's main (tb_capability_gap in
# bin/fm-board-lib.sh, which only reads their text). When one is missing it
# prints the one line naming it on stderr and exits 4, so the board shows that
# line for the home instead of a report that is wrong.
#
# "schema" is this output format's version. This script writes nothing in the
# home. Exit codes: 0 success, 1 failure (nothing is printed), 2 usage error,
# 4 a capability missing (nothing is printed on stdout).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
SCHEMA=1
LEDGER_MAX_BYTES=262144
TODO_MARKER='動手：'
ARCHIVE_MAX_BYTES=262144


# shellcheck source=bin/fm-primary-scope-lib.sh
. "$SCRIPT_DIR/fm-primary-scope-lib.sh"
# shellcheck source=bin/fm-secondmate-registry-lib.sh
. "$SCRIPT_DIR/fm-secondmate-registry-lib.sh"
# shellcheck source=bin/myshape-lib.sh
. "$SCRIPT_DIR/myshape-lib.sh"
# shellcheck source=bin/fm-board-lib.sh
. "$SCRIPT_DIR/fm-board-lib.sh"
# shellcheck source=bin/fm-tasks-axi-lib.sh
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"

usage_error() {
  printf '%s\n' "fm-topic-board-read.sh: $*" >&2
  printf '%s\n' "usage: fm-topic-board-read.sh [--in-home <secondmate-id>] [--closed-since <offset> <sha>] <ledger-offset> <prefix-sha256>" >&2
  exit 2
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

file_size() {
  wc -c < "$1" | tr -d ' '
}

# Print <file> from byte <offset> on. The reader takes only the first piece and
# then closes the pipe, which kills tail mid-write; that is expected, and must
# not fail the pipeline under pipefail.
ledger_from() {
  tail -c "+$(($1 + 1))" "$2" 2>/dev/null || true
}

# Write the ledger section of the output to <out-file>.
ledger_section() {
  local offset=$1 prefix=$2 out=$3 ledger="$STATE/fleet-ledger.jsonl"
  local size remaining newlines consumed more=false to_offset to_prefix=-
  if [ ! -f "$ledger" ]; then
    jq -n '{status: "absent", to_offset: 0, to_prefix_sha256: "-", more: false, lines: []}' > "$out"
    return 0
  fi
  size=$(file_size "$ledger")
  if [ "$offset" -gt "$size" ] ||
    { [ "$offset" -gt 0 ] && [ "$(head -c "$offset" "$ledger" | sha256_stdin)" != "$prefix" ]; }; then
    jq -n '{status: "continuity-broken", to_offset: 0, to_prefix_sha256: "-", more: false, lines: []}' > "$out"
    return 0
  fi
  remaining=$((size - offset))
  ledger_from "$offset" "$ledger" | head -c "$LEDGER_MAX_BYTES" > "$WORK/chunk"
  newlines=$(wc -l < "$WORK/chunk" | tr -d ' ')
  if [ "$newlines" -gt 0 ]; then
    head -n "$newlines" "$WORK/chunk" > "$WORK/lines"
  elif [ "$remaining" -gt "$LEDGER_MAX_BYTES" ]; then
    # One line longer than the cap: return that single line whole when it is
    # already terminated, so the reader can never get stuck in front of it.
    ledger_from "$offset" "$ledger" | head -n 1 > "$WORK/lines"
    [ "$(tail -c 1 "$WORK/lines" | wc -l | tr -d ' ')" -eq 1 ] || : > "$WORK/lines"
  else
    : > "$WORK/lines"
  fi
  consumed=$(file_size "$WORK/lines")
  to_offset=$((offset + consumed))
  if [ "$to_offset" -gt 0 ]; then
    to_prefix=$(head -c "$to_offset" "$ledger" | sha256_stdin)
  fi
  if [ "$consumed" -gt 0 ] && [ "$remaining" -gt "$LEDGER_MAX_BYTES" ]; then
    more=true
  fi
  jq -R -n --argjson to_offset "$to_offset" --arg to_prefix "$to_prefix" --argjson more "$more" \
    '{status: "delta", to_offset: $to_offset, to_prefix_sha256: $to_prefix, more: $more, lines: [inputs]}' \
    < "$WORK/lines" > "$out"
}

# Write {"<task-id>": "<tag file content>"} for every tagged task to <out-file>.
topics_section() {
  tb_tag_files_json "$DATA"/*/topic > "$1"
}

# Write the registered secondmates as a JSON array to <out-file>.
secondmates_section() {
  local out=$1 reg="$DATA/secondmates.md" line
  if [ -f "$reg" ] && [ ! -L "$reg" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in '- '*) ;; *) continue ;; esac
      secondmate_registry_parse_line "$line" || continue
      jq -n --arg id "$SECONDMATE_REGISTRY_ID" --arg home "$SECONDMATE_REGISTRY_HOME" \
        --argjson remote "$SECONDMATE_REGISTRY_REMOTE" '{id: $id, remote: ($remote == 1), home: $home}'
    done < "$reg"
  fi | jq -s '.' > "$out"
}

# The commit of the code this home runs. A home is normally its own checkout,
# and a local secondmate home can lag behind the main home whose script is
# reading it, so the home's own HEAD is preferred over the code root's.
home_commit() {
  local top
  top=$(git -C "$FM_HOME" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$(cd "$FM_HOME" && pwd -P)" ]; then
    git -C "$FM_HOME" rev-parse HEAD 2>/dev/null && return 0
  fi
  git -C "$FM_ROOT" rev-parse HEAD 2>/dev/null || true
}

# The markdown archive Done retention appends to: the [markdown] archive key of
# the backlog root's .tasks.toml, else done-archive.md beside the backlog.
# Returns 1 when the backend is not markdown.
archive_path() {
  local root archive backend
  root=$(cd "$DATA/.." 2>/dev/null && pwd -P) || return 1
  backend=$(fm_tasks_axi_backend "$root" 2>/dev/null) || return 1
  [ "$backend" = markdown ] || return 1
  archive=''
  if [ -f "$root/.tasks.toml" ]; then
    archive=$(LC_ALL=C awk '
      /^[[:space:]]*\[/ { section = $0; gsub(/[[:space:]]/, "", section); next }
      section == "[markdown]" && $0 ~ /^[[:space:]]*archive[[:space:]]*=/ {
        value = $0
        sub(/^[^=]*=[[:space:]]*/, "", value)
        sub(/[[:space:]]*#.*$/, "", value)
        gsub(/^"|"$/, "", value)
        print value
        exit
      }' "$root/.tasks.toml")
  fi
  case "$archive" in
    '') printf '%s\n' "$DATA/done-archive.md" ;;
    /*) printf '%s\n' "$archive" ;;
    *) printf '%s\n' "$root/$archive" ;;
  esac
}

# The byte length of <file>'s first <limit> bytes that end before a row or a
# section header, so a cut never splits an archived row; all of them when the
# piece holds no such line after its first.
archive_cut() {
  local file=$1 limit=$2
  head -c "$limit" "$file" | LC_ALL=C awk '
    { if (NR > 1 && ($0 ~ /^- \[.\] / || $0 ~ /^## /)) cut = bytes; bytes += length($0) + 1 }
    END { print (cut > 0 ? cut : bytes) }'
}

# Write the archive part of the closed decisions to <out-file>:
# {status, to_offset, to_prefix_sha256, more, rows: [{id, title, hold, body}]}.
# <offset> is "" when the caller passed no cursor. It runs where a failure does
# not stop the script, so every step that can fail returns 1 itself.
archive_section() {
  local offset=$1 prefix=$2 out=$3 archive size to_offset more=false to_prefix=- lines cut
  if ! archive=$(archive_path); then
    jq -n '{status: "absent", to_offset: 0, to_prefix_sha256: "-", more: false, rows: []}' > "$out" || return 1
    return 0
  fi
  size=0
  if [ -e "$archive" ]; then
    [ -f "$archive" ] && [ -r "$archive" ] || return 1
    size=$(file_size "$archive") || return 1
  fi
  if [ -z "$offset" ] || [ "$offset" -gt "$size" ] ||
    { [ "$offset" -gt 0 ] && [ "$(head -c "$offset" "$archive" | sha256_stdin)" != "$prefix" ]; }; then
    if [ "$size" -gt 0 ]; then to_prefix=$(head -c "$size" "$archive" | sha256_stdin) || return 1; fi
    jq -n --arg status "$([ -z "$offset" ] && echo start || echo continuity-broken)" \
      --argjson to_offset "$size" --arg to_prefix "$to_prefix" \
      '{status: $status, to_offset: $to_offset, to_prefix_sha256: $to_prefix, more: false, rows: []}' > "$out" ||
      return 1
    return 0
  fi
  : > "$WORK/archive-delta" || return 1
  if [ "$size" -gt 0 ]; then ledger_from "$offset" "$archive" > "$WORK/archive-delta" || return 1; fi
  # Only complete lines: a row still being appended waits for the next read.
  lines=$(wc -l < "$WORK/archive-delta" | tr -d ' ') || return 1
  head -n "$lines" "$WORK/archive-delta" > "$WORK/archive-lines" || return 1
  if [ "$(file_size "$WORK/archive-lines")" -gt "$ARCHIVE_MAX_BYTES" ]; then
    cut=$(archive_cut "$WORK/archive-lines" "$ARCHIVE_MAX_BYTES") || return 1
    head -c "$cut" "$WORK/archive-lines" > "$WORK/archive-piece" || return 1
    mv "$WORK/archive-piece" "$WORK/archive-lines" || return 1
    more=true
  fi
  to_offset=$((offset + $(file_size "$WORK/archive-lines")))
  if [ "$to_offset" -gt 0 ]; then to_prefix=$(head -c "$to_offset" "$archive" | sha256_stdin) || return 1; fi
  jq -R -n --argjson to_offset "$to_offset" --arg to_prefix "$to_prefix" --argjson more "$more" '
    def close: if .cur != null then .rows += [.cur] | .cur = null else . end;
    (reduce inputs as $line ({rows: [], cur: null};
      if ($line | test("^- \\[.\\] ")) then close | .cur = {raw: $line, body: []}
      elif .cur != null and ($line | test("^\\s")) then
        if ($line | test("^\\s*$")) then . else .cur.body += [$line | sub("^  "; "")] end
      elif ($line == "") then .
      else close end) | close | .rows) as $rows
    | {status: "delta", to_offset: $to_offset, to_prefix_sha256: $to_prefix, more: $more,
       rows: [ $rows[]
               | (.raw | capture("^- \\[.\\] (?<id>[^ ]+) - (?<rest>.*)$")) as $row
               | {id: $row.id,
                  title: ($row.rest | sub(" \\((repo|kind|since|done|hold|hold-kind|until|pr|report|priority|blocked-by|blocked)[:)].*$"; "")),
                  hold: (($row.rest | capture("\\(hold: (?<h>[^)]*)\\)") | .h) // ""
                         | . as $h
                         | if startswith("fm-hold-v1:") then (try (.[11:] | @base64d) catch $h) else . end),
                  body: .body} ]}
  ' < "$WORK/archive-lines" > "$out" || return 1
}

# Write {"<task>\t<occurrence>\t<event>": <earliest epoch>} from the hold
# lines fm-captain-hold.sh appends, to <out-file>; {} when there are none.
hold_times() {
  local out=$1 file="$STATE/captain-hold-events.jsonl"
  if [ ! -e "$file" ]; then
    printf '{}\n' > "$out"
    return 0
  fi
  [ -f "$file" ] && [ -r "$file" ] || return 1
  jq -R -n '
    reduce (inputs | fromjson? | objects
            | select(.v == 1 and (.ts | type) == "number" and (.task | type) == "string"
                     and (.occurrence | type) == "number" and (.event == "held" or .event == "resolved"))
           ) as $line ({};
      ("\($line.task)\t\($line.occurrence)\t\($line.event)") as $key
      | if .[$key] == null or .[$key] > $line.ts then .[$key] = $line.ts else . end)
  ' < "$file" > "$out" || return 1
}

# Write {closed_holds, closed_cursor} to <out-file> from the snapshot, the
# archive part and the hold times; nothing when any of them failed.
closed_section() {
  local offset=$1 prefix=$2 out=$3 is_secondmate=$4
  archive_section "$offset" "$prefix" "$WORK/archive" || return 1
  hold_times "$WORK/hold-times" || return 1
  jq -n --argjson is_secondmate "$is_secondmate" --arg marker "$TODO_MARKER" \
    --slurpfile snapshot "$WORK/snapshot" --slurpfile archive "$WORK/archive" \
    --slurpfile times "$WORK/hold-times" '
    def cut: if length > 300 then .[0:300] else . end;
    def first_capture($re; $name): [ .[] | capture($re) | .[$name] ][0];
    # The newest resolution record of a body, or null when it has none.
    def resolution:
      . as $lines
      | [ range(0; $lines | length)
          | select($lines[.] | test("^Resolution recorded by fm-(captain|decision)-hold\\.$")) ] as $starts
      | if ($starts | length) == 0 then null else
          $lines[$starts[0]:($starts[1] // ($lines | length))] as $block
          | ([ range(0; $block | length)
               | select($block[.] == "Captain decision:" or $block[.] == "Reconciliation evidence:") ][0]) as $at
          | (if $at == null then [] else $block[($at + 1):] end) as $words
          | ([ $words[0] // "" | capture("^Captain answered this (call|decision) through (?<s>.*)\\.$") | .s ][0]) as $source
          | {mode: ($block | first_capture("^Resolution mode: (?<v>.*)$"; "v") // ""),
             digest: ($block | first_capture("^Decision digest: (?<v>.*)$"; "v") // ""),
             source: ($source // ""),
             answer: ((if $source == null then $words[0]
                       else ($words | first_capture("^Answer: (?<v>.*)$"; "v")) end) // "" | cut),
             label: ((if $source == null then null
                      else ($words | first_capture("^Answer as shown to the captain: (?<v>.*)$"; "v")) end) // "" | cut),
             occurrence: ($starts | length),
             origin: ($lines | first_capture("^Captain hold origin: (?<v>.*)$"; "v") // "")}
        end;
    def handson($hold): ($is_secondmate | not) and ($hold | startswith($marker));
    $times[0] as $t
    | ([ $snapshot[0].backlog.records[]
         | select(.structured == true and (handson(.hold_reason // "") | not))
         | {id, title: (.title // ""), body: (.body_lines // [])} ]
       + [ $archive[0].rows[] | select(handson(.hold) | not) | {id, title, body} ]) as $rows
    | {closed_holds: [ $rows[]
                       | (.body | resolution) as $r
                       | select($r != null)
                       | {id, title} + $r
                         + {opened_at: $t["\(.id)\t\($r.occurrence)\theld"],
                            closed_at: $t["\(.id)\t\($r.occurrence)\tresolved"]} ],
       closed_cursor: ($archive[0] | del(.rows))}
  ' > "$out"
}

# Refuses an offset that is not a non-negative integer or a hash that is not '-' or 64 hex.
check_cursor() {  # <offset> <prefix-sha256>
  case "$1" in '' | *[!0-9]*) usage_error "the offset must be a non-negative integer: $1" ;; esac
  if [ "$2" != - ]; then
    case "$2" in *[!0-9a-f]*) usage_error "the prefix hash must be 64 hex characters or '-'" ;; esac
    [ "${#2}" -eq 64 ] || usage_error "the prefix hash must be 64 hex characters or '-'"
  fi
}

main() {
  local offset prefix home is_secondmate=false ledger_enabled=false code_commit gap
  local closed_offset='' closed_prefix=-
  if [ "${1:-}" = --in-home ]; then
    [ "$#" -eq 4 ] || [ "$#" -eq 7 ] ||
      usage_error "--in-home needs a secondmate id, an offset, and a prefix hash"
    home=$(tb_local_secondmate_home "$DATA/secondmates.md" "$2") || exit 1
    shift 2
    tb_exec_in_home "$home" "$SCRIPT_DIR/fm-topic-board-read.sh" "$@"
  fi
  if [ "${1:-}" = --closed-since ]; then
    [ "$#" -eq 5 ] || usage_error "--closed-since needs an offset and a prefix hash"
    check_cursor "$2" "$3"
    closed_offset=$2
    closed_prefix=$3
    shift 3
  fi
  [ "$#" -eq 2 ] || usage_error "expected an offset and a prefix hash"
  check_cursor "$1" "$2"
  offset=$1
  prefix=$2
  gap=$(tb_capability_gap "$SCRIPT_DIR") || {
    printf '%s\n' "$gap" >&2
    exit 4
  }
  command -v jq >/dev/null 2>&1 ||
    tb_die 1 "fm-topic-board-read.sh needs jq, which was not found. Install: $(tb_jq_install_hint)"

  WORK=$(mktemp -d "${TMPDIR:-/tmp}/fm-topic-board-read.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT

  FM_HOME="$FM_HOME" FM_SNAPSHOT_SECONDMATES=1 FM_SNAPSHOT_BUDGET=1 FM_CREW_STATE_NO_FORGE=1 \
    "$SCRIPT_DIR/fm-fleet-snapshot.sh" "$(tb_snapshot_mode "$SCRIPT_DIR")" > "$WORK/snapshot" ||
    tb_die 1 "fm-topic-board-read.sh: fm-fleet-snapshot.sh failed"

  ledger_section "$offset" "$prefix" "$WORK/ledger"
  topics_section "$WORK/topics"
  if fm_root_is_secondmate_home "$FM_HOME"; then
    is_secondmate=true
    printf '[]\n' > "$WORK/secondmates"
  else
    secondmates_section "$WORK/secondmates"
  fi
  if [ -e "$CONFIG/fleet-ledger" ]; then
    ledger_enabled=true
  fi
  code_commit=$(home_commit)
  closed_section "$closed_offset" "$closed_prefix" "$WORK/closed" "$is_secondmate" 2>/dev/null ||
    printf '{}\n' > "$WORK/closed"

  jq -n --argjson schema "$SCHEMA" --arg code_commit "$code_commit" \
    --argjson ledger_enabled "$ledger_enabled" --argjson is_secondmate "$is_secondmate" \
    --slurpfile snapshot "$WORK/snapshot" --slurpfile ledger "$WORK/ledger" \
    --slurpfile topics "$WORK/topics" --slurpfile secondmates "$WORK/secondmates" \
    --slurpfile closed "$WORK/closed" '
    $snapshot[0] as $snap
    | {
        schema: $schema,
        code_commit: $code_commit,
        generated: $snap.generated,
        ledger_enabled: $ledger_enabled,
        tasks: [ $snap.tasks[]
                 | {id, kind, state: (.current_state.state // "unknown"),
                    source: (.current_state.source // ""), detail: (.current_state.detail // ""),
                    unstarted: (.current_state.state == "working"
                                and .current_state.detail == "harness busy (fm-spawn)")} ],
        holds: [ $snap.backlog.records[]
                 | select(.structured == true and .hold_kind == "captain"
                          and .hold_reason != null and .state != "done")
                 | {id, title, question: .hold_reason, hold_bucket, hold_until,
                    unresolved_blocker_ids: (.unresolved_blocker_ids // []),
                    hold_age_days, hold_set: (.hold_set // null),
                    origin: ([ (.body_lines // [])[]
                               | capture("^Captain hold origin: (?<origin>.*)$")
                               | .origin ][0] // ""),
                    on_answer: ([ (.body_lines // [])[]
                                  | capture("^Captain hold on answer: (?<v>close|release)$")
                                  | .v ][0] // null)} ],
        queued: [ $snap.backlog.records[]
                  | select(.structured == true and .state == "queued")
                  | {id, kind: (.kind // ""), title: (.title // ""), hold: .hold_reason,
                     captain: (.hold_kind == "captain"),
                     blockers: (.unresolved_blocker_ids // []),
                     topic_hint: ([ (.body_lines // [])[]
                                    | capture("^topic: *(?<topic>[A-Za-z0-9._-]+) *$") | .topic ][0] // null)} ],
        status_decisions: [ $snap.tasks[] | .id as $id
                            | (.hints.open_decisions // [])[]
                            | select(.verb == "needs-decision")
                            | {id: $id, key, summary} ],
        topics: $topics[0],
        ledger: $ledger[0]
      } + ($closed[0] // {})
    | if $is_secondmate then . else . + {secondmates: $secondmates[0]} end
  ' > "$WORK/output" || tb_die 1 "fm-topic-board-read.sh: could not assemble the output"
  cat "$WORK/output"
}

main "$@"
