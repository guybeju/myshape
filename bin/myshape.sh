#!/usr/bin/env bash
# myshape.sh - the topic board's command.
#
# Usage:
#   myshape.sh list [--all] [--json] [--hashtag <name>]
#   myshape.sh create <name> --goal <one line> [--id <id>] [--queue high|normal|later] [--hashtag <name>]...
#   myshape.sh hashtag <topic-id> +<name> | --remove <name>
#   myshape.sh merge <old-topic-id> <new-topic-id> [--reason <one line>]
#   myshape.sh close-propose <topic-id> --reason <text>
#   myshape.sh move <topic-id> <queue> [--before <topic-id> | --first]
#   myshape.sh rename <topic-id> <name>
#   myshape.sh split <topic-id> <name> --goal <one line> [--id <new-id>] [--reason <one line>]
#   myshape.sh goal <topic-id> <one line>
#   myshape.sh archive <topic-id>
#   myshape.sh reopen <topic-id> [--queue <queue>]
#   myshape.sh summary [--home <secondmate-id>] <task-id> <ready|report|failed|landed> -
#   myshape.sh retract [--home <secondmate-id>] <task-id> <ready|report|failed|landed> -
#   myshape.sh which [--home <secondmate-id>] <task-id>
#   myshape.sh find [--all] <keyword>
#   myshape.sh todo add <task-id> <title> --topic <topic-id> --do <one line> [--note <text>] [--cmd <command>]... [--ref <text>] [--captain-closes]
#   myshape.sh todo done <task-id>
#   myshape.sh todo failed <task-id> --reason <one line>
#   myshape.sh todo obsolete <task-id> --reason <one line>
#   myshape.sh schedule add <topic-id> --daily|--weekly <days> --at HH:MM [--tz <zone>] [--duration <min>] [--lead <min>] [--rt soft-rt|hard-rt|none]
#   myshape.sh schedule edit <topic-id> [--daily|--weekly <days>] [--at HH:MM] [--tz <zone>] [--duration <min>] [--lead <min>]
#   myshape.sh schedule pause <topic-id>
#   myshape.sh schedule resume <topic-id>
#   myshape.sh schedule skip <topic-id>
#   myshape.sh schedule rt <topic-id> soft-rt|hard-rt|none
#   myshape.sh schedule delete <topic-id>
#   myshape.sh schedule take <key> [--note <one line>]
#   myshape.sh schedule close <key> done|skipped [--note <one line>]
#   myshape.sh open | status | stop | restart | reset-token
#
# Every subcommand except open runs only in a home where the board has run:
# one with state/myshape/token, which the service writes the first time it
# starts and never deletes. Anywhere else it is refused with exit 1 and nothing
# is written; open starts a board there.
#
# list only reads files; it does not need the board service, so it keeps
# working when the service is down. Every other subcommand talks to the board
# service over its Unix socket and, except for status and stop, starts the
# service first when it is not running. They need node 22 or newer. Repeating
# any of them unchanged is safe.
#
# create makes a topic that is confirmed at once and last in its queue:
# normal unless --queue names another. A live topic with the same name and
# goal is the same topic, so a repeat prints its id and leaves it where it is.
# Each --hashtag puts that hashtag on the topic, like hashtag below; when the
# board refuses one of them, it makes no topic.
#
# hashtag puts one hashtag on one live topic (+<name>) or takes it off
# (--remove <name>). Hashtags describe what a topic is about; they change no
# queue, order or dispatch and send nothing. A name is letters (Chinese too),
# digits and underscore, 1 to 32 characters; case and full-width forms do not
# make another hashtag, and the spelling first created is the one shown. The
# first use of a name opens the hashtag. The board refuses, and changes
# nothing, when the captain turned off the aggregator's tagging or opening of
# new hashtags on the page, when the hashtag is locked, when the topic already
# has the per-topic maximum (8 unless changed), when the board already has the
# board-wide maximum of hashtags (50) and the name is new, or past the hourly
# cap of the aggregator's hashtag changes (20); the captain changes these on
# the page. Renaming, merging and deleting a whole hashtag, the settings,
# locks, reverts and saved views are on the page only. Every change is
# recorded on the topic's updates with what it had before and after.
# list --hashtag <name> lists only the topics with that hashtag, read from
# data/myshape/hashtags.json with jq, so it works with the service down; it
# matches the stored spelling and its case and full-width variants. find also
# matches hashtags: a keyword that is a hashtag prints its topics.
#
# open prints the board's URL. status and stop never start the service, but
# the main home's next session start does.
#
# The service reaches its aggregator through the home's
# config/myshape-aggregator.json, which names it and the paths of its feed
# and deliver programs (myshape/spec/contracts.markdown section 7). Each time
# this command starts or replaces the service, it asks git which of those
# paths are relative paths under the code root's bin/ that git tracks and
# that equal HEAD, and hands that list to the service: only those run without
# a confirmation on the page. The code root is this command's own directory's
# parent, or MYSHAPE_ROOT_OVERRIDE; with an override whose physical path is
# not that directory's, every program needs a confirmation. A board running
# with another binding file than the one there now is replaced by the next
# command, like one running other code.
#
# The home is MYSHAPE_HOME, else MYSHAPE_ROOT_OVERRIDE, else the code root;
# MYSHAPE_DATA_OVERRIDE, MYSHAPE_CONFIG_OVERRIDE and MYSHAPE_STATE_OVERRIDE
# replace its data/, config/ and state/. An aggregator that starts the board
# hands its own home on under these names. A caller that still sets FM_HOME or
# FM_ROOT_OVERRIDE, the names this command read before, without the new name
# and pointing somewhere other than what this command resolved (or somewhere
# that cannot be entered), is refused with exit 2 and one line naming the new
# name; the old value is never used.
#
# summary stores a one-to-three sentence milestone summary read from stdin (at
# most 600 characters) and prints the line to start the chat reminder with:
# "<topic name>：", "未分類：" when the task has no topic, or "議題不明（<task-id>）："
# when the task's home could not be read. which prints the same line without
# storing anything. --home names the secondmate home the task lives in.
#
# split makes a new confirmed topic out of part of <topic-id>, right after it
# in the same queue. It moves no task; a split that names tasks is refused.
#
# find answers where a topic or task is now and how it got there, in a few
# lines: it matches the keyword against topic ids, names, and goals, including
# ids and names that were merged away or renamed, and prints each match under
# its current id with its history. A keyword that is a task id also prints the
# topics that task was tagged with, oldest first. Each history line says, when
# it was recorded, whether the change was made on the page or by a command and
# why: the --reason given with a merge or split, or the close proposal an
# archive followed. The answer is kept short; --all prints every matching
# topic and every history line with exact times, for working out what went
# wrong with a topic.
#
# todo keeps the things the captain has to do by hand (a sudo command, a
# login) on the board, which stores each item itself in data/myshape/todos.json.
# add puts <task-id> on the board under a live topic, or rewrites it; a
# rewrite of different text starts it over as still to do. --do says what to
# do, in one line; --note is optional guidance shown as plain text; each --cmd
# is one command, shown exactly as written in its own block with its own copy
# button. A command of several lines (a here-document, a line continuation) is
# one --cmd, for example --cmd "$(cat <<'EOF' ... EOF)". An item with no --cmd
# shows no command. add reads no stdin: the old "-" form is refused. --ref is
# opaque text of at most 128 characters that the board hands back in its
# notices about the item. The title is one line of at most 200 characters and
# --do one of at most 1000, neither with control or direction characters;
# there are at most 50 --cmd. The page offers 做完了 and 不做了. 做完了 does not close
# the item: the board tells the aggregator, who checks and then runs done
# (which closes it) or failed (which puts it back in front of the captain with
# the reason). obsolete takes an item the aggregator no longer needs off the
# page at once, with the reason in its topic's updates; an item added with
# --captain-closes waits instead for the captain's 好，撤下.
#
# Every step of an item (put on, rewritten, claimed, failed, marked no
# longer needed, closed) writes a record on its topic's updates saying who made
# it: the captain on the page, or the aggregator by its label.
#
# Repeating add, failed, or obsolete unchanged is safe; done on an item that
# is already closed changes nothing and says so.
#
# schedule keeps a topic coming up on a timetable, stored in
# data/myshape/schedules.json. A schedule is a daily or weekly HH:MM rule in
# an IANA time zone (--tz, else the captain's default, else this machine's),
# on one topic in 待辦: add refuses any other (move it there first, or create
# it with --queue later), and a topic has at most one schedule. --weekly takes
# weekdays as mon,tue,wed,thu,fri,sat,sun, comma-separated. Each occurrence
# has a key, <schedule-id>:<UTC time> such as weekly-sync:20261130T0200Z.
# --lead is how many minutes before it the first notice goes (0 sends none)
# and --duration how long an occurrence nobody takes stays open; left out,
# the captain's settings decide. --rt soft-rt|hard-rt orders the topics that
# are up at the same time and appears in their notices; it never changes
# when anything is sent. The board's clock that opens occurrences and sends
# their notices is not built yet.
#
# While a topic has a schedule it stays in 待辦: move refuses taking it out,
# reopen puts it back there, a merge of two scheduled topics is refused, and
# a single schedule follows its topic into the one it was merged into, which
# goes to 待辦. Archiving the topic pauses its schedule. Delete the schedule
# to make it an ordinary topic again.
#
# The aggregator may change only schedules that are not locked (the
# captain's are locked by default) and delete only those it made; rt has its
# own lock. It may make at most the captain's limit of active schedules and
# of changes an hour, and the occurrences of a schedule it makes or retimes
# do not ring within the captain's first-ring minutes (60 by default): the
# reply names the earliest one. take reports that the aggregator took an
# open occurrence; close reports that it ended, done or skipped. Both are
# allowed on a locked schedule. The settings, the locks, pausing everything,
# undoing a change and marking a schedule seen are only on the page. These
# are guard rails against a careless or misled aggregator, not a boundary:
# the socket does not check who is calling.
#
# list puts the topics with an open occurrence first, one line each:
# <topic-id>, now, the occurrence's state (upcoming, due or taken), its key,
# and the name, with its rt in brackets. An occurrence past its closes_by has
# ended, whatever the file still says. list --json keeps one row per topic
# and adds two fields to each: schedule (null, or its id, rule, tz, state,
# rt and locked) and occurrence (null, or the open one's key, at, state,
# closes_by, taken_at and note).
#
# retract takes the task's latest summary of that kind off the board when it
# turned out to be wrong; stdin is the reason. The line stays in the file.
#
# Exit codes: 0 success (including an identical repeat), 1 refused or failed
# with nothing written, 2 usage error, 3 outcome unknown (the request was sent
# but no answer came back; repeat it once), 69 the board service is unavailable.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The code root, decided once here: this command's directory's parent, or
# MYSHAPE_ROOT_OVERRIDE. ROOT_TRACKED_EXEMPT is 1 when a program git tracks
# unchanged under the root's bin/ may run without a confirmation: always
# without an override; with one, only when its physical path (pwd -P) is
# this command's own location's, and the code root is then that compared
# path. An override that differs, or that cannot be entered or resolved,
# keeps no such case.
OWN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CODE_ROOT=$OWN_ROOT
ROOT_TRACKED_EXEMPT=1
if [ -n "${MYSHAPE_ROOT_OVERRIDE:-}" ]; then
  CODE_ROOT=$MYSHAPE_ROOT_OVERRIDE
  ROOT_TRACKED_EXEMPT=0
  if OWN_PHYSICAL=$(CDPATH='' cd -- "$OWN_ROOT" 2>/dev/null && pwd -P) &&
    OVERRIDE_PHYSICAL=$(CDPATH='' cd -- "$MYSHAPE_ROOT_OVERRIDE" 2>/dev/null && pwd -P) &&
    [ -n "$OWN_PHYSICAL" ] && [ "$OWN_PHYSICAL" = "$OVERRIDE_PHYSICAL" ]; then
    CODE_ROOT=$OWN_PHYSICAL
    ROOT_TRACKED_EXEMPT=1
  fi
fi
BOARD_HOME="${MYSHAPE_HOME:-${MYSHAPE_ROOT_OVERRIDE:-$CODE_ROOT}}"
DATA="${MYSHAPE_DATA_OVERRIDE:-$BOARD_HOME/data}"
CONFIG="${MYSHAPE_CONFIG_OVERRIDE:-$BOARD_HOME/config}"
STATE="${MYSHAPE_STATE_OVERRIDE:-$BOARD_HOME/state}"
BOARD_DIST="$CODE_ROOT/myshape/dist"
DEFAULT_PORT=47819
EXIT_UNAVAILABLE=69
TOPICS_FILE="$DATA/topics.json"
ARCHIVE_FILE="$DATA/topics-archive.json"
HASHTAGS_FILE="$DATA/myshape/hashtags.json"
SCHEDULES_FILE="$DATA/myshape/schedules.json"

# shellcheck source=bin/myshape-lib.sh
. "$SCRIPT_DIR/myshape-lib.sh"

usage() {
  sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

usage_error() {
  printf '%s\n' "myshape.sh: $*（myshape.sh --help 看用法）" >&2
  exit 2
}

# The names this command read before it had its own (FM_HOME and
# FM_ROOT_OVERRIDE). A caller that still sets one, without its new name, while
# it points somewhere other than what this command resolved (or somewhere that
# cannot be entered) is refused, so that it is never sent to another home
# quietly. The old value is only compared, never used.
refuse_old_name() {  # <old name> <old value> <new value> <new name> <resolved path>
  local old_physical resolved_physical
  [ -n "$2" ] && [ -z "$3" ] || return 0
  old_physical=$(CDPATH='' cd -- "$2" 2>/dev/null && pwd -P) || old_physical=
  resolved_physical=$(CDPATH='' cd -- "$5" 2>/dev/null && pwd -P) || resolved_physical=
  [ -z "$old_physical" ] || [ "$old_physical" != "$resolved_physical" ] || return 0
  usage_error "不讀 ${1} 了：它指的 ${2} 和這次用的 ${5} 不同；要指定請改設 ${4}"
}

# Every subcommand but open needs a home whose board has run: the service
# writes state/myshape/token the first time it starts and never deletes it.
require_board() {
  [ -f "$STATE/myshape/token" ] ||
    tb_die 1 "這裡沒有看板（找不到 state/myshape/token）；要在這裡開看板先跑 myshape.sh open。"
}

require_jq() {
  command -v jq >/dev/null 2>&1 ||
    tb_die 1 "$1 需要 jq，但找不到。安裝：$(tb_jq_install_hint)"
}

cmd_list() {
  local all=0 json=0 archive hashtag='' tags=/dev/null filtered=false schedules
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --all) all=1 ;;
      --json) json=1 ;;
      --hashtag)
        [ "$#" -ge 2 ] && [ -n "$2" ] || usage_error "--hashtag 後面要有 hashtag 名稱"
        hashtag=$2 filtered=true
        shift
        ;;
      *) usage_error "list 不認得的參數：$1" ;;
    esac
    shift
  done
  require_jq list
  if [ ! -f "$TOPICS_FILE" ]; then
    if [ "$json" -eq 1 ]; then printf '[]\n'; else printf '%s\n' "還沒有議題。"; fi
    return 0
  fi
  archive=$ARCHIVE_FILE
  if [ "$all" -eq 0 ] || [ ! -f "$archive" ]; then
    archive=/dev/null
  fi
  [ ! -f "$HASHTAGS_FILE" ] || tags=$HASHTAGS_FILE
  schedules=$SCHEDULES_FILE
  [ -f "$schedules" ] || schedules=/dev/null
  jq -r -n --argjson json "$json" --slurpfile live "$TOPICS_FILE" --slurpfile gone "$archive" \
    --slurpfile tags "$tags" --arg hashtag "$hashtag" --argjson filtered "$filtered" \
    --slurpfile kept "$schedules" "$(tb_hashtag_fold_jq)
$(tb_hashtag_topics_jq)"'
    # A topic id with merges followed, as every reader of a schedule does.
    def follow($merged; $hops):
      if $hops > 64 or $merged[.] == null then . else $merged[.] | follow($merged; $hops + 1) end;
    def ended($now): (try (.closes_by | fromdateiso8601) catch 0) <= $now;
    def rank: {"hard-rt": 0, "soft-rt": 1} [.] // 2;
    $live[0] as $doc
    | ($kept[0] // {}) as $store
    | [ ($store.series // {}) | to_entries[]
        | {id: .key, topic: (.value.topic | follow($doc.merged // {}; 0)), rule: .value.rule,
           tz: .value.tz, state: .value.state, rt: .value.rt, locked: .value.locked} ] as $series
    | [ ($store.occurrences // {}) | to_entries[] | select(.value | ended(now) | not)
        | {key: .key, series: .value.series, at: .value.at, state: .value.state,
           closes_by: .value.closes_by, taken_at: (.value.taken_at // null),
           note: (.value.note // null)} ] as $open
    | def scheduled:
        . as $row
        | (first($series[] | select(.topic == $row.id)) // null) as $schedule
        | $row + {schedule: ($schedule | if . == null then null else del(.topic) end),
                  occurrence: (if $schedule == null then null
                               else first($open[] | select(.series == $schedule.id)) // null end
                               | if . == null then null else del(.series) end)};
      [ ("high", "normal", "later") as $queue
        | ($doc.queues[$queue] // []) | to_entries[]
        | {id: .value, status: "confirmed", queue: $queue, position: (.key + 1),
           name: ($doc.topics[.value].name // "")} ] as $queued
    | [ $queued[].id ] as $placed
    | [ $doc.topics | to_entries[] | .key as $id | select($placed | index([$id]) | not)
        | {id: .key, status: "confirmed", queue: null, position: null, name: .value.name} ] as $loose
    | [ ($gone[0].topics // {}) | to_entries[]
        | {id: .key, status: "archived", queue: null, position: null, name: .value.name} ] as $archived
    | [ ($queued + $loose + $archived)[] | scheduled ] as $all
    | (if $filtered then hashtag_topics($tags[0] // {}; $doc; $hashtag) else null end) as $tagged
    | (if $tagged == null then $all else [ $all[] | select(.id as $id | any($tagged[]; . == $id)) ] end) as $rows
    | [ $rows[] | select(.occurrence != null) ]
        | sort_by((.schedule.rt | rank), .occurrence.at) as $now_rows
    | if $json == 1 then $rows
      elif ($rows | length) == 0 and $filtered then "沒有議題貼著 #\($hashtag | ltrimstr("#"))。"
      elif ($rows | length) == 0 then "還沒有議題。"
      else
        ($now_rows[]
          | "\(.id)\tnow\t\(.occurrence.state)\t\(.occurrence.key)\t\(.name)"
            + (if .schedule.rt == "none" then "" else "（\(.schedule.rt)）" end)),
        ($rows[] | "\(.id)\t\(.status)\t\(.queue // "-")\t\(.position // "-")\t\(.name)")
      end
  ' 2>/dev/null || tb_die 1 "讀不懂 ${TOPICS_FILE}、${ARCHIVE_FILE}、${HASHTAGS_FILE} 或 ${SCHEDULES_FILE}。"
}

# todo_part <flag> <value>: <value> with carriage returns and trailing newlines
# removed. A value with nothing else in it is a usage error.
todo_part() {
  local value=${2//$'\r'/}
  while [ "${value%$'\n'}" != "$value" ]; do value=${value%$'\n'}; done
  [ -n "${value//[[:space:]]/}" ] || usage_error "$1 後面要有內容"
  printf '%s' "$value"
}

TODO_ADD_USAGE='todo add 的用法是 <task-id> <標題> --topic <議題 id> --do <要做什麼> [--note <說明>] [--cmd <指令>]…：每個要使用者跑的指令一個 --cmd（多行的指令整段放進同一個 --cmd），不是指令的說明放 --note'

# todo add <task-id> <title> --topic <topic-id> --do <action> [--note <text>]
# [--cmd <command>]... [--ref <text>] [--captain-closes]: put a
# hands-on item for the captain on the board. The board checks the topic.
todo_add() {
  local topic="" action="" note="" ref="" captain_closes=false item
  local -a words=() commands=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --topic | --do | --note | --cmd | --ref)
        [ "$#" -ge 2 ] || usage_error "$1 後面要有值。$TODO_ADD_USAGE"
        case "$1" in
          --topic) topic=$2 ;;
          --do)
            [ -z "$action" ] || usage_error "--do 只能有一個。$TODO_ADD_USAGE"
            action=$(todo_part --do "$2")
            ;;
          --note)
            [ -z "$note" ] || usage_error "--note 只能有一個；多行的說明放進同一個 --note。$TODO_ADD_USAGE"
            note=$(todo_part --note "$2")
            ;;
          --cmd) commands+=("$(todo_part --cmd "$2")") ;;
          --ref) ref=$2 ;;
        esac
        shift 2
        ;;
      --captain-closes) captain_closes=true && shift ;;
      -) usage_error "todo add 不再從 stdin 讀內容；要做什麼放 --do，說明放 --note，指令放 --cmd。$TODO_ADD_USAGE" ;;
      --*) usage_error "todo add 不認得 ${1}。$TODO_ADD_USAGE" ;;
      *)
        words+=("$1")
        shift
        ;;
    esac
  done
  if [ "${#words[@]}" -ne 2 ] || [ -z "$topic" ] || [ -z "$action" ]; then
    usage_error "$TODO_ADD_USAGE"
  fi
  case "$action" in
    *$'\n'*) usage_error "--do 只寫一行；其餘的說明放 --note，指令放 --cmd。$TODO_ADD_USAGE" ;;
  esac
  tb_valid_id "${words[0]}" || usage_error "task id 格式不對：${words[0]}"
  tb_valid_id "$topic" || usage_error "議題 id 格式不對：$topic"
  item=$(jq -cn --arg id "${words[0]}" --arg title "${words[1]}" --arg topic "$topic" \
    --arg action "$action" --arg guidance "$note" --arg ref "$ref" \
    --argjson captain_closes "$captain_closes" \
    '{id: $id, title: $title, topic: $topic, action: $action,
      guidance: $guidance, commands: $ARGS.positional, ref: $ref,
      captain_closes: $captain_closes}' \
    --args ${commands[@]+"${commands[@]}"}) || tb_die 1 "組不出項目的內容，沒有放上任何東西。"
  printf '%s' "$item" | cmd_service todo-add -
}

cmd_todo() {
  local sub=${1:-}
  [ "$#" -gt 0 ] || usage_error "todo 的用法是 add、done、failed、obsolete 其中之一"
  shift
  case "$sub" in
    add)
      require_jq "todo add"
      todo_add "$@"
      ;;
    done | failed | obsolete) cmd_service "todo-$sub" "$@" ;;
    *) usage_error "todo 不認得 ${sub}；可用的是 add、done、failed、obsolete" ;;
  esac
}

SCHEDULE_SUBS="add、edit、pause、resume、skip、rt、delete、take、close"

cmd_schedule() {
  local sub=${1:-}
  [ "$#" -gt 0 ] || usage_error "schedule 的用法是 ${SCHEDULE_SUBS} 其中之一"
  shift
  case "$sub" in
    add | edit | pause | resume | skip | rt | delete | take | close) cmd_service "schedule-$sub" "$@" ;;
    *) usage_error "schedule 不認得 ${sub}；可用的是 ${SCHEDULE_SUBS}" ;;
  esac
}

service_unavailable() {  # <reason> <fix>
  printf '%s\n' "看板服務無法啟動：$1。$2。這次的要求沒有寫入。" >&2
  exit "$EXIT_UNAVAILABLE"
}

# The port the board should listen on: config/myshape-port, or the default.
configured_port() {
  local port=$DEFAULT_PORT
  if [ -f "$CONFIG/myshape-port" ]; then
    IFS= read -r port < "$CONFIG/myshape-port" || true
    case "$port" in
      '' | *[!0-9]*) port=0 ;;
    esac
    if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
      service_unavailable "config/myshape-port 不是 1024 到 65535 的埠號" "改成合法的埠號，或刪掉那個檔用預設的 $DEFAULT_PORT"
    fi
  fi
  printf '%s\n' "$port"
}

# What status can still say when node is missing: only what the files show.
status_without_node() {
  local file
  printf '%s\n' "看板服務：不明（沒有 node，無法詢問服務）"
  for file in pid port; do
    if [ -f "$STATE/myshape/$file" ]; then
      printf '上次的 %s：%s\n' "$file" "$(< "$STATE/myshape/$file")"
    fi
  done
  for file in "$DATA/myshape/events.jsonl" "$DATA/myshape/summaries.jsonl" "$STATE/myshape/audit.jsonl"; do
    if [ -f "$file" ]; then
      printf '%s：%s 位元組\n' "${file##*/}" "$(wc -c < "$file" | tr -d ' ')"
    fi
  done
}

# binding_flags: the --binding and --exempt values for the service: the
# binding file's SHA-256 (or -) and the paths it names that git tracks under
# the code root's bin/ unchanged from HEAD (or -; always - when
# ROOT_TRACKED_EXEMPT is not 1). The node helper reads the file; git is asked
# here, so the service itself runs no git.
binding_flags() {
  local lines sha rest="" path exempt=""
  lines=$(node "$BOARD_DIST/binding-cli.js" "$CONFIG/myshape-aggregator.json") || lines=-
  sha=${lines%%$'\n'*}
  case "$sha" in
    - | *[!0-9a-f]* | '') printf '%s\n%s\n' - - && return 0 ;;
  esac
  [ "$ROOT_TRACKED_EXEMPT" = 1 ] || { printf '%s\n%s\n' "$sha" - && return 0; }
  case "$lines" in *$'\n'*) rest=${lines#*$'\n'} ;; esac
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if git --literal-pathspecs -C "$CODE_ROOT" ls-files --error-unmatch -- "$path" >/dev/null 2>&1 &&
      git --literal-pathspecs -C "$CODE_ROOT" diff --quiet HEAD -- "$path" >/dev/null 2>&1; then
      exempt=${exempt:+$exempt,}$path
    fi
  done <<< "$rest"
  printf '%s\n%s\n' "$sha" "${exempt:--}"
}

# Hand a socket subcommand to the node client, after the checks that must not
# need node themselves.
cmd_service() {
  local sub=$1 port commit major binding exempt flags
  if ! command -v node >/dev/null 2>&1; then
    if [ "$sub" = status ]; then
      status_without_node
      return 0
    fi
    service_unavailable "沒有 node" "安裝：brew install node  # or the platform's package manager"
  fi
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')
  case "$major" in '' | *[!0-9]*) major=0 ;; esac
  [ "$major" -ge 22 ] || service_unavailable "node 版本低於 22" "請升級到 22 以上"
  if [ ! -f "$BOARD_DIST/board-client.js" ] || [ ! -f "$BOARD_DIST/board-server.js" ] ||
    [ ! -f "$BOARD_DIST/binding-cli.js" ]; then
    service_unavailable "編譯結果不見了（${BOARD_DIST}）" "確認 checkout 完整"
  fi
  port=$(configured_port)
  commit=$(git -C "$CODE_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')
  flags=$(binding_flags)
  binding=${flags%%$'\n'*}
  exempt=${flags#*$'\n'}
  exec node "$BOARD_DIST/board-client.js" --home "$BOARD_HOME" --root "$CODE_ROOT" \
    --commit "$commit" --port "$port" --state "$STATE" --data "$DATA" --config "$CONFIG" \
    --binding "$binding" --exempt "$exempt" -- "$@"
}

# The forms this command no longer has: one line naming what to use now, exit
# 2, nothing written. None of them needs the board to exist.
refuse_old_form() {  # <subcommand>
  case "$1" in
    # The board confirms every topic it makes; rules from before that still name these.
    propose | confirm) usage_error "沒有 ${1} 了：議題一建立就已確認。新議題用 create <名稱> --goal <一行>" ;;
  esac
}

main() {
  [ "$#" -gt 0 ] || usage_error "少了子命令"
  local sub=$1
  shift
  refuse_old_form "$sub"
  case "$sub" in
    -h | --help)
      usage
      return 0
      ;;
    open | list | todo | schedule | split | create | merge | close-propose | move | rename | hashtag | \
      goal | archive | reopen | summary | retract | which | find | status | stop | restart | reset-token) ;;
    *) usage_error "不認得的子命令：$sub" ;;
  esac
  refuse_old_name FM_HOME "${FM_HOME:-}" "${MYSHAPE_HOME:-}" MYSHAPE_HOME "$BOARD_HOME"
  refuse_old_name FM_ROOT_OVERRIDE "${FM_ROOT_OVERRIDE:-}" "${MYSHAPE_ROOT_OVERRIDE:-}" \
    MYSHAPE_ROOT_OVERRIDE "$CODE_ROOT"
  [ "$sub" = open ] || require_board
  case "$sub" in
    list) cmd_list "$@" ;;
    todo) cmd_todo "$@" ;;
    schedule) cmd_schedule "$@" ;;
    *) cmd_service "$sub" "$@" ;;
  esac
}

main "$@"
