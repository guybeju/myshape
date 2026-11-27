#!/usr/bin/env bash
# fm-board.sh - firstmate's side of the topic board: the commands that read or
# write firstmate's own files on the board's behalf.
#
# Usage:
#   fm-board.sh tag <task-id> <topic-id>
#   fm-board.sh tag <new-task-id> --from <old-task-id>
#   fm-board.sh setup
#   fm-board.sh bind
#   fm-board.sh split <topic-id> <name> --goal <one line> [--id <new-id>] [--reason <one line>] [<task-id> | <secondmate-id>/<task-id>]...
#   fm-board.sh --in-home <secondmate-id> tag <task-id> <topic-id>
#   fm-board.sh --in-home <secondmate-id> answers        (one answer line on stdin)
#   fm-board.sh --in-home <secondmate-id> setup
#   fm-board.sh install-rules
#   fm-board.sh rules
#   fm-board.sh feed <home> <ledger-offset> <prefix-sha256> [<closed-offset> <closed-sha256>]
#   fm-board.sh topics <home> <task-id>...
#   fm-board.sh deliver        (one action record on stdin)
#
# The board itself is bin/myshape.sh; this command is what firstmate adds
# around it. None of these subcommands needs the board service.
#
# tag    Appends "<topic-id> <UTC time>" to this home's data/<task-id>/topic.
#        The last line is the task's current topic. In the main home the topic
#        must be on the board and not archived (merged ids are followed), and
#        --in-home tag runs the same check in the main home before it writes
#        in the secondmate's. A secondmate home's own tag (and one run through
#        fm-on.sh) checks the id against the main home's topic list where
#        fm-dispatch-plan.sh order reads it (bin/fm-queue-source-lib.sh): the
#        main home's data/topics.json when the main home is on this machine,
#        otherwise the queue copy the main home pushed. Merged ids are followed
#        and archived ids refused there too; a refusal from a copy names the
#        copy's time and says to rerun after the next copy. When that list
#        cannot be read - no file or copy, an unreadable one, a copy 60 minutes
#        old or more, or no jq - the tag is written as given with one line on
#        stderr saying why it was not checked. Without jq the main home's
#        check is skipped with a warning too.
#        --from takes the old task's current topic and checks it the same way,
#        in the home it runs in; a refusal adds one line saying the new task
#        was left untagged and to tag it with an open topic instead.
# setup  Creates this home's config/fleet-ledger flag, then binds the board
#        to firstmate as bind does. Safe to repeat.
# bind   Writes this home's config/myshape-aggregator.json, which tells the
#        board to reach firstmate through bin/fm-board.sh feed and deliver:
#        {"v":1,"name":"firstmate","feed":"bin/fm-board.sh","deliver":"bin/fm-board.sh"}.
#        It takes no argument and writes nothing else. A file or link already
#        at that path is never replaced, whatever it says; a secondmate home,
#        which runs no board, gets none. Prints one line. The board runs
#        bin/fm-board.sh without a confirmation on its page only while git
#        tracks it unchanged in the code root.
#        tag and split write the same binding first when it is missing
#        in a home that uses the board (not a secondmate home, and
#        state/myshape/token is there), with one line on stderr; so does the
#        session-start hook, through bind. feed and deliver never write it. To
#        keep the board from running anything, leave another file at that path
#        (an empty one will do): nothing here replaces it.
#
# split makes a new confirmed topic out of part of <topic-id> with
# "myshape.sh split", right after it in the same queue, and retags the named
# tasks to it. Every task must be tagged with <topic-id> now; a task of a local
# secondmate is written as <secondmate-id>/<task-id>, and a remote secondmate's
# task cannot be moved this way. The tasks are checked before anything is
# written. If tagging stops halfway, run the same command again: the topic is
# reused and the rest moved. Main home only.
#
# install-rules writes the board's rules into this home's data/captain.md and
# data/captain-shared.md, each as one block between "<!-- myshape:begin"
# and "<!-- myshape:end -->" lines. An existing block is replaced whole;
# nothing outside the block is changed, and each file is backed up to
# state/fm-board/rules-backup/ before it is written. Main home only; it needs
# neither the board service nor node.
# rules prints one line saying whether each block matches the templates in
# fm-board/rules/.
#
# feed and deliver are the two programs the board service runs (its feed and
# action contracts), and topics is the feed's call for some tasks' tags only;
# bin/fm-board-io-lib.sh holds them and says what each runs. The board sets
# MYSHAPE_HOME to its home, which they use as FM_HOME.
#
# --in-home runs tag, answers, or setup inside a LOCAL registered secondmate
# home. answers forwards stdin to that home's
# "fm-captain-hold.sh answers --source myshape" and returns its output and
# exit code unchanged.
#
# Exit codes: 0 success (including an identical repeat), 1 refused or failed
# with nothing written, 2 usage error. split passes on myshape.sh's exit code
# when the board refuses or cannot be reached.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SCRIPT_DIR/fm-board.sh"
TOPIC="$SCRIPT_DIR/myshape.sh"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
case "${1:-}" in
  feed | topics | deliver) FM_HOME=${MYSHAPE_HOME:-${FM_HOME:-}} ;;
esac
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
export FM_HOME
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
RULES_DIR="$FM_ROOT/fm-board/rules"
RULES_BEGIN='<!-- myshape:begin'
RULES_END='<!-- myshape:end -->'
TOPICS_FILE="$DATA/topics.json"

# shellcheck source=bin/fm-primary-scope-lib.sh
. "$SCRIPT_DIR/fm-primary-scope-lib.sh"
# shellcheck source=bin/fm-secondmate-registry-lib.sh
. "$SCRIPT_DIR/fm-secondmate-registry-lib.sh"
# shellcheck source=bin/myshape-lib.sh
. "$SCRIPT_DIR/myshape-lib.sh"
# shellcheck source=bin/fm-board-lib.sh
. "$SCRIPT_DIR/fm-board-lib.sh"
# shellcheck source=bin/fm-timeout-lib.sh
. "$SCRIPT_DIR/fm-timeout-lib.sh"
# shellcheck source=bin/fm-board-io-lib.sh
. "$SCRIPT_DIR/fm-board-io-lib.sh"

usage() {
  sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

usage_error() {
  printf '%s\n' "fm-board.sh: $*（fm-board.sh --help 看用法）" >&2
  exit 2
}

in_secondmate_home() {
  fm_root_is_secondmate_home "$FM_HOME"
}

current_topic_of() {
  local file="$DATA/$1/topic" last
  [ -f "$file" ] || return 1
  last=$(tail -n 1 "$file")
  [ -n "$last" ] || return 1
  printf '%s\n' "${last%% *}"
}

# mate_topic_unchecked <topic-id> <why>: tag as given, saying why it was not checked.
mate_topic_unchecked() {
  printf '%s\n' "沒有檢查 $1 是不是看板上的議題：${2}；照樣寫入標記。" >&2
  printf '%s\n' "$1"
  exit 0
}

# mate_topic_for_tag <topic-id>: in a secondmate home, the topic id a tag
# should record, checked against the main home's topic list wherever order
# reads it (bin/fm-queue-source-lib.sh). Exits 1 after listing the topics when
# the id names no open one; tags as given, with one line on stderr, when that
# list cannot be read. Runs in a subshell, so its libraries stay inside tag.
mate_topic_for_tag() {
  (
    local wanted=$1 file origin rerun='' age resolved
    # shellcheck source=bin/fm-queue-source-lib.sh
    . "$SCRIPT_DIR/fm-queue-source-lib.sh"
    command -v jq >/dev/null 2>&1 || mate_topic_unchecked "$wanted" "找不到 jq（安裝：$(tb_jq_install_hint)）"
    fmq_mate_source "$FM_HOME" "$STATE/dispatch-plan/queues.json"
    file=$FMQ_PATH
    if [ "$FMQ_SOURCE" = root ]; then
      file="$FMQ_PATH/data/topics.json"
      [ -f "$file" ] || mate_topic_unchecked "$wanted" "主 home 還沒有議題檔（${file}）"
      fmq_usable_topic_file "$file" || mate_topic_unchecked "$wanted" "讀不懂主 home 的 ${file}"
      origin="主 home 的議題檔（${file}）"
    else
      [ -f "$file" ] || mate_topic_unchecked "$wanted" "這裡沒有主 home 推來的佇列副本（${file}）"
      age=$(fmq_copy_age "$file") || mate_topic_unchecked "$wanted" "讀不懂主 home 推來的佇列副本（${file}）"
      [ "${age#*$'\t'}" -lt "$FMQ_COPY_STALE_MINUTES" ] ||
        mate_topic_unchecked "$wanted" "主 home 推來的佇列副本是 ${age#*$'\t'} 分鐘前的（${age%%$'\t'*}），太舊"
      origin="主 home 推來的佇列副本（${age%%$'\t'*}）"
      rerun="議題如果是在這份副本之後才建的，等主 home 送來下一份副本再跑一次同一個指令。"
    fi
    resolved=$(tb_resolve_live_topic "$file" "$wanted") || mate_topic_unchecked "$wanted" "讀不懂 ${file}"
    if [ -n "$resolved" ]; then
      printf '%s\n' "$resolved"
      exit 0
    fi
    {
      printf '%s\n' "$wanted 不是看板上還開著的議題（照${origin}），沒有寫入標記。可用的議題："
      jq -r '.topics | to_entries[] | "  \(.key)\t\(.value.name)"' "$file" || true
      [ -z "$rerun" ] || printf '%s\n' "$rerun"
    } >&2
    exit 1
  )
}

# topic_for_tag_here <topic-id>: the topic id a tag in this home should
# record, checked against this home's topic list; fails after saying why.
topic_for_tag_here() {
  if in_secondmate_home; then
    mate_topic_for_tag "$1"
  else
    tb_topic_for_tag "$TOPICS_FILE" "$1"
  fi
}

cmd_tag() {
  local task topic source copied
  case "$#" in
    2)
      task=$1
      topic=$2
      tb_valid_id "$task" || usage_error "task id 格式不對：$task"
      tb_valid_id "$topic" || usage_error "議題 id 格式不對：$topic"
      topic=$(topic_for_tag_here "$topic") || exit 1
      ;;
    3)
      [ "$2" = --from ] || usage_error "tag 的用法是 <task-id> <議題 id> 或 <新 id> --from <舊 id>"
      task=$1
      source=$3
      tb_valid_id "$task" || usage_error "task id 格式不對：$task"
      tb_valid_id "$source" || usage_error "task id 格式不對：$source"
      copied=$(current_topic_of "$source") ||
        tb_die 1 "$source 沒有議題標記，沒有東西可以沿用。"
      topic=$(topic_for_tag_here "$copied") ||
        tb_die 1 "${task} 沒有沿用 ${source} 的議題 ${copied}，還沒有標記；用 tag ${task} <議題 id> 標一個還開著的議題。"
      ;;
    *) usage_error "tag 的用法是 <task-id> <議題 id> 或 <新 id> --from <舊 id>" ;;
  esac
  if [ "$(current_topic_of "$task" || true)" != "$topic" ]; then
    mkdir -p "$DATA/$task"
    printf '%s %s\n' "$topic" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$DATA/$task/topic"
  fi
  printf '%s\n' "ok $task 已標記為 $topic"
}

BINDING_TEXT='{"v":1,"name":"firstmate","feed":"bin/fm-board.sh","deliver":"bin/fm-board.sh"}'

BINDING_FILE="$CONFIG/myshape-aggregator.json"

binding_present() {
  [ -e "$BINDING_FILE" ] || [ -L "$BINDING_FILE" ]
}

# write_binding: the one writer of config/myshape-aggregator.json. Writes
# BINDING_TEXT and nothing else; a hard link puts it in place, and a link
# never replaces what is already at that path, a file or a symlink. Returns
# 1 when something was already there; dies when it could not write.
write_binding() {
  local tmp
  mkdir -p "$CONFIG"
  tmp=$(mktemp "$CONFIG/.myshape-aggregator.XXXXXX") || tb_die 1 "寫不進 ${CONFIG}，aggregator 設定沒有寫。"
  if ! { printf '%s\n' "$BINDING_TEXT" > "$tmp" && chmod 644 "$tmp"; }; then
    rm -f -- "$tmp"
    tb_die 1 "寫不進 ${BINDING_FILE}，aggregator 設定沒有寫。"
  fi
  if ln -- "$tmp" "$BINDING_FILE" 2>/dev/null; then
    rm -f -- "$tmp"
    return 0
  fi
  rm -f -- "$tmp"
  binding_present || tb_die 1 "寫不進 ${BINDING_FILE}，aggregator 設定沒有寫。"
  return 1
}

cmd_bind() {
  [ "$#" -eq 0 ] || usage_error "bind 不收參數"
  if in_secondmate_home; then
    printf '%s\n' "ok bind secondmate home 不跑看板，不寫 aggregator 設定"
  elif ! binding_present && write_binding; then
    printf '%s\n' "ok bind 看板的 aggregator 設定已寫：firstmate"
  elif [ "$(cat "$BINDING_FILE" 2>/dev/null)" = "$BINDING_TEXT" ]; then
    printf '%s\n' "ok bind aggregator 設定本來就是 firstmate"
  else
    printf '%s\n' "ok bind config/myshape-aggregator.json 已經有別的內容，沒有改"
  fi
}

# ensure_binding: before a subcommand that reaches the board, writes the
# missing binding in a home that uses the board (not a secondmate home, and
# state/myshape/token is there), saying so in one line on stderr. A command
# the board itself runs (feed, deliver, and the tag deliver runs for a filing)
# has MYSHAPE_HOME set by the board, and never writes it.
ensure_binding() {
  [ -z "${MYSHAPE_HOME:-}" ] || return 0
  in_secondmate_home && return 0
  [ -f "$STATE/myshape/token" ] || return 0
  binding_present && return 0
  if write_binding; then
    printf '%s\n' "看板的 aggregator 設定原本不在，已寫好：firstmate（config/myshape-aggregator.json）" >&2
  fi
}

cmd_setup() {
  [ "$#" -eq 0 ] || usage_error "setup 不收參數"
  if [ -e "$CONFIG/fleet-ledger" ]; then
    printf '%s\n' "ok setup 帳本本來就開著"
  else
    mkdir -p "$CONFIG"
    : > "$CONFIG/fleet-ledger"
    printf '%s\n' "ok setup 帳本已開"
  fi
  cmd_bind
}

# The data directory holding <task-spec>'s tag file: this home's for "<task>",
# a local secondmate's for "<secondmate-id>/<task>". Prints nothing and returns
# 1, after explaining, when the spec is malformed or the home is remote.
split_task_data() {
  local spec=$1 home
  case "$spec" in
    */*)
      if ! tb_valid_id "${spec%%/*}" || ! tb_valid_id "${spec#*/}"; then
        printf '%s\n' "${spec}：task 要寫成 <task-id> 或 <secondmate-id>/<task-id>。" >&2
        return 1
      fi
      home=$(tb_local_secondmate_home "$DATA/secondmates.md" "${spec%%/*}") || {
        printf '%s\n' "${spec}：split 只能搬主 home 和已註冊的本機 secondmate 的 task；遠端 secondmate 的請它自己跑 tag。" >&2
        return 1
      }
      printf '%s\n' "$home/data"
      ;;
    *)
      tb_valid_id "$spec" || {
        printf '%s\n' "${spec}：task id 格式不對。" >&2
        return 1
      }
      printf '%s\n' "$DATA"
      ;;
  esac
}

# Why <task-spec> cannot move from topic <source> to <new>, or nothing when it can.
split_task_problem() {
  local spec=$1 source=$2 new=$3 data file current
  data=$(split_task_data "$spec" 2>&1) || {
    printf '%s\n' "$data"
    return 0
  }
  file="$data/${spec#*/}/topic"
  [ -s "$file" ] || {
    printf '%s\n' "${spec}：沒有議題標記，不在 $source 裡。"
    return 0
  }
  current=$(tail -n 1 "$file")
  current=${current%% *}
  [ "$current" = "$new" ] && return 0
  [ "$(tb_resolve_live_topic "$TOPICS_FILE" "$current")" = "$source" ] ||
    printf '%s\n' "${spec}：現在標的是 ${current}，不在 $source 裡。"
}

# The topic id in the board's answer to a split: the second word of its first line.
split_new_id() {
  printf '%s\n' "$1" | awk 'NR == 1 { print $2 }'
}

# split <source> <name> --goal <line> [--id <id>] [<task-spec>...]: split a new
# topic off <source> and retag the named tasks to it. The tasks are checked
# before anything is written. Tagging happens after the topic exists, so a run
# that stops halfway is finished by running the same command again.
cmd_split() {
  local goal="" id="" reason="" has_reason=0 plan made new source spec problem problems="" failed=0
  local -a words=() request=() tasks=()
  if in_secondmate_home; then
    tb_die 1 "議題檔只在主 home；這裡是 secondmate home，不能跑 split。"
  fi
  command -v jq >/dev/null 2>&1 || tb_die 1 "split 需要 jq，但找不到。安裝：$(tb_jq_install_hint)"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --goal | --id | --reason)
        [ "$#" -ge 2 ] || usage_error "$1 後面要有值"
        case "$1" in
          --goal) goal=$2 ;;
          --id) id=$2 ;;
          --reason)
            reason=$2
            has_reason=1
            ;;
        esac
        shift 2
        ;;
      --*) usage_error "split 不認得 $1" ;;
      *)
        words+=("$1")
        shift
        ;;
    esac
  done
  if [ "${#words[@]}" -lt 2 ] || [ -z "$goal" ]; then
    usage_error "split 的用法是 <來源議題> <新名稱> --goal <一行> [--id <id>] [--reason <一行>] [<task>|<secondmate-id>/<task>]…"
  fi
  request=(split "${words[0]}" "${words[1]}" --goal "$goal")
  [ -z "$id" ] || request+=(--id "$id")
  # An empty reason is passed on so the board refuses it, the same as for merge.
  [ "$has_reason" -eq 0 ] || request+=(--reason "$reason")
  [ "${#words[@]}" -le 2 ] || tasks=("${words[@]:2}")
  # Each step below runs a command as its own process. Called as a function
  # behind "||", a step would run with errexit off and could carry on after a
  # failure.
  tb_board_env
  plan=$(env "${TB_BOARD_ENV[@]}" "$TOPIC" "${request[@]}" --dry) || exit $?
  source=$(tb_resolve_live_topic "$TOPICS_FILE" "${words[0]}")
  for spec in ${tasks[@]+"${tasks[@]}"}; do
    problem=$(split_task_problem "$spec" "$source" "$(split_new_id "$plan")")
    [ -z "$problem" ] || problems+="$problem"$'\n'
  done
  if [ -n "$problems" ]; then
    printf '%s' "$problems" >&2
    tb_die 1 "有 task 不能搬，什麼都沒有改。"
  fi
  # The id comes from the split that was really made: another writer may have
  # taken the planned id since the check.
  made=$(env "${TB_BOARD_ENV[@]}" "$TOPIC" "${request[@]}") || exit $?
  printf '%s\n' "$made"
  new=$(split_new_id "$made")
  tb_valid_id "$new" || tb_die 1 "看不懂看板回的議題 id，沒有搬任何 task：$made"
  for spec in ${tasks[@]+"${tasks[@]}"}; do
    case "$spec" in
      */*) "$SELF" --in-home "${spec%%/*}" tag "${spec#*/}" "$new" || failed=1 ;;
      *) "$SELF" tag "$spec" "$new" || failed=1 ;;
    esac
  done
  [ "$failed" -eq 0 ] || tb_die 1 "有 task 沒有標成功；修好之後原樣再跑一次同一個指令就會接著做完。"
}

cmd_in_home() {
  local id home topic
  [ "$#" -ge 2 ] || usage_error "--in-home 的用法是 --in-home <secondmate-id> <tag|answers|setup> …"
  id=$1
  shift
  case "$1" in
    tag | answers | setup) ;;
    *) usage_error "--in-home 只支援 tag、answers、setup，不支援 $1" ;;
  esac
  home=$(tb_local_secondmate_home "$DATA/secondmates.md" "$id") || exit 1
  if [ "$1" = tag ] && [ "$#" -eq 3 ]; then
    tb_valid_id "$2" || usage_error "task id 格式不對：$2"
    tb_valid_id "$3" || usage_error "議題 id 格式不對：$3"
    topic=$(tb_topic_for_tag "$TOPICS_FILE" "$3")
    set -- tag "$2" "$topic"
  fi
  if [ "$1" = answers ]; then
    [ "$#" -eq 1 ] || usage_error "answers 不收參數，答案一行走 stdin"
    tb_exec_in_home "$home" "$SCRIPT_DIR/fm-captain-hold.sh" answers --source myshape
  fi
  tb_exec_in_home "$home" "$SELF" "$@"
}

# block_at <file> <begin-marker> <end-marker>: where that marker's block sits
# in <file>: prints "none", "ok <begin-line> <end-line>", or "broken <what is
# wrong>" when the two markers do not form exactly one block. A marker line may
# be indented or carry text after the marker, so a block that an editor or a
# curation pass reshaped is still found.
block_at() {
  awk -v begin="$2" -v end="$3" '
    { line = $0; sub(/^[ \t]+/, "", line) }
    index(line, begin) == 1 { begins = begins " " NR; b++ }
    index(line, end) == 1 { ends = ends " " NR; e++ }
    END {
      if (b == 0 && e == 0) print "none"
      else if (b == 1 && e == 1 && begins + 0 < ends + 0) print "ok" begins ends
      else print "broken 開頭標記在第" (b ? begins : " -") " 行，結尾標記在第" (e ? ends : " -") " 行"
    }
  ' "$1"
}

# The "vN" on a block's first line, for people; the content decides what is
# current.
rules_version() {
  sed -n -E '1s/^.*myshape:begin (v[0-9]*).*$/\1/p'
}

# block_text <file> <block_at answer>: the lines of that block.
block_text() {
  local first last
  read -r _ first last <<< "$2"
  sed -n "${first},${last}p" "$1"
}

# One file's rules state: 未裝, 和範本相同（vN）, 和範本不同（vN）, or 標記不完整.
rules_state() {  # <file> <template>
  local file=$1 template=$2 block installed
  [ -f "$file" ] || { printf '未裝'; return 0; }
  block=$(block_at "$file" "$RULES_BEGIN" "$RULES_END")
  case "$block" in
    broken*) printf '標記不完整' ;;
    none) printf '未裝' ;;
    *)
      installed=$(block_text "$file" "$block")
      if [ "$installed" = "$(cat "$template")" ]; then
        printf '和範本相同（%s）' "$(printf '%s\n' "$installed" | rules_version)"
      else
        printf '和範本不同（%s）' "$(printf '%s\n' "$installed" | rules_version)"
      fi
      ;;
  esac
}

cmd_rules() {
  [ "$#" -eq 0 ] || usage_error "rules 不收參數"
  printf '規則：captain.md %s；captain-shared.md %s\n' \
    "$(rules_state "$DATA/captain.md" "$RULES_DIR/captain.block.md.tmpl")" \
    "$(rules_state "$DATA/captain-shared.md" "$RULES_DIR/captain-shared.block.md.tmpl")"
}

# without_block <file> <block_at answer> [replacement-file]: <file> with that
# block taken out, or replaced by the replacement's lines. Bytes outside the
# block are kept as they are.
without_block() {
  local file=$1 first last
  read -r _ first last <<< "$2"
  head -n "$((first - 1))" "$file"
  [ -z "${3:-}" ] || cat "$3"
  tail -n "+$((last + 1))" "$file"
}

# Print what <file> should contain once <template> is installed, or return 1
# after explaining why the file is left alone. The block with this marker is
# replaced in place; without one, the template is appended.
rules_new_content() {  # <file> <template> [header-template]
  local file=$1 template=$2 header=${3:-} block
  if [ ! -f "$file" ]; then
    [ -z "$header" ] || cat "$header"
    cat "$template"
    return 0
  fi
  block=$(block_at "$file" "$RULES_BEGIN" "$RULES_END")
  case "$block" in
    broken*)
      printf '%s\n' "${file##*/}：標記不成對（${block#broken }），沒有動這個檔。請手動整理成一對標記，或把它們都刪掉。" >&2
      return 1
      ;;
    none)
      cat "$file"
      [ -z "$(tail -c 1 "$file")" ] || printf '\n'
      [ ! -s "$file" ] || printf '\n'
      cat "$template"
      ;;
    *) without_block "$file" "$block" "$template" ;;
  esac
}

# Upstream's own check of a shared preference file's header: prints the first
# required phrase that is missing and returns 1, or prints nothing and returns
# 0. Run in a subshell so the library it comes from defines nothing here.
shared_header_gap() {
  (
    # shellcheck source=bin/fm-config-inherit-lib.sh
    . "$SCRIPT_DIR/fm-config-inherit-lib.sh" >/dev/null 2>&1 && shared_captain_header_valid "$1"
  )
}

# Install one template into one preference file; prints what happened.
install_rules_file() {  # <file> <template> [header-template]
  local file=$1 template=$2 header=${3:-} name=${1##*/} gap fresh before after backup
  if [ -n "$header" ] && [ -f "$file" ]; then
    gap=$(shared_header_gap "$file") || {
      printf '%s\n' "${name}：檔頭不合上游的要求（少了「${gap}」），沒有動這個檔。" >&2
      return 1
    }
  fi
  fresh="$STATE/fm-board/rules.new.$$"
  rules_new_content "$file" "$template" "$header" > "$fresh" || {
    rm -f "$fresh"
    return 1
  }
  after=$(rules_version < "$template")
  if [ ! -f "$file" ]; then
    mkdir -p "$DATA"
    mv "$fresh" "$file"
    printf '%s\n' "${name}：新增（${after}）"
  elif cmp -s "$fresh" "$file"; then
    rm -f "$fresh"
    printf '%s\n' "${name}：已是最新（${after}）"
  else
    before=$(rules_state "$file" "$template")
    backup="$STATE/fm-board/rules-backup/$name.$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$file" "$backup"
    mv "$fresh" "$file"
    case "$before" in
      未裝) printf '%s\n' "${name}：新增（${after}），原檔備份在 $backup" ;;
      *) printf '%s\n' "${name}：已更新（$before → ${after}），原檔備份在 $backup" ;;
    esac
  fi
}

list_secondmate_ids() {
  local reg="$DATA/secondmates.md" line
  [ -f "$reg" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '- '*) ;; *) continue ;; esac
    secondmate_registry_parse_line "$line" || continue
    printf '%s ' "$SECONDMATE_REGISTRY_ID"
  done < "$reg"
}

cmd_install_rules() {
  local failed=0 secondmates
  [ "$#" -eq 0 ] || usage_error "install-rules 不收參數"
  if in_secondmate_home; then
    tb_die 1 "install-rules 只能在主 home 跑。secondmate home 的共用偏好檔是主 home 傳過來的唯讀複本，改了會被當成漂移。什麼都沒有寫。"
  fi
  [ -d "$FM_HOME" ] || tb_die 1 "找不到 home：${FM_HOME}。什麼都沒有寫。"
  [ -f "$RULES_DIR/captain.block.md.tmpl" ] || tb_die 1 "找不到規則範本（${RULES_DIR}）。什麼都沒有寫。"
  mkdir -p "$STATE/fm-board/rules-backup"
  chmod 700 "$STATE/fm-board" "$STATE/fm-board/rules-backup"
  install_rules_file "$DATA/captain.md" "$RULES_DIR/captain.block.md.tmpl" || failed=1
  install_rules_file "$DATA/captain-shared.md" "$RULES_DIR/captain-shared.block.md.tmpl" \
    "$RULES_DIR/captain-shared.header.md.tmpl" || failed=1
  secondmates=$(list_secondmate_ids)
  printf '%s\n' "已註冊的 secondmate：${secondmates:-（沒有）}"
  printf '%s\n' "提醒：共用段會叫每個 secondmate 跑 fm-board.sh；還沒更新到有這支指令的 home 會找不到它。"
  printf '%s\n' "生效時間：主 first mate 是下一次 session 開始或下一次壓縮後；secondmate 是主 home 下一次 bootstrap 傳播共用檔之後、它下次啟動時。"
  "$SCRIPT_DIR/fm-startup-memory-budget.sh" report 2>&1 || printf '%s\n' "（讀不到啟動記憶的預算，沒有檢查用量。）"
  return "$failed"
}

main() {
  [ "$#" -gt 0 ] || usage_error "少了子命令"
  local sub=$1
  shift
  # The subcommands that reach the board write a missing binding first; feed,
  # topics and deliver, which the board itself runs, never do.
  case "$sub" in
    tag | split) ensure_binding ;;
  esac
  case "$sub" in
    -h | --help) usage ;;
    --in-home) cmd_in_home "$@" ;;
    tag) cmd_tag "$@" ;;
    setup) cmd_setup "$@" ;;
    bind) cmd_bind "$@" ;;
    split) cmd_split "$@" ;;
    install-rules) cmd_install_rules "$@" ;;
    rules) cmd_rules "$@" ;;
    feed) cmd_feed "$@" ;;
    topics) cmd_topics "$@" ;;
    deliver) cmd_deliver "$@" ;;
    *) usage_error "不認得的子命令：$sub" ;;
  esac
}

main "$@"
