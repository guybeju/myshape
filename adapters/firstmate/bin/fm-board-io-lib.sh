#!/usr/bin/env bash
# Firstmate's side of the board's two contracts (myshape/spec/contracts.markdown
# section 7): the feed, which prints one home's report, and the deliverer,
# which carries out one action record from the page. Sourced by
# bin/fm-board.sh only; defines functions and has no side effects on source.
#
# The caller must already have sourced fm-secondmate-registry-lib.sh and
# myshape-lib.sh, and set SCRIPT_DIR, SELF, DATA and FM_HOME (exported).
#
# feed <home> <offset> <prefix-sha256> [<closed-offset> <closed-sha256>] runs
# this home's reader for <home>:
#   main                      fm-topic-board-read.sh <offset> <sha>
#   a local secondmate        fm-topic-board-read.sh --in-home <id> <offset> <sha>
#   a remote secondmate       fm-on.sh <id> fm-topic-board-read.sh <offset> <sha>
# with "--closed-since <closed-offset> <closed-sha256>" before <offset> when the
# board passed that cursor, which it does only for a home whose last report
# carried closed_cursor, so a home on older code never gets the extra arguments.
# and adds what the board asks of an aggregator: the aggregator block (main
# only), a ledger_hint for a home whose ledger is off, and read hints of 60 s
# and 400 s for remote secondmates. Exit 0 prints the report; 4 says the home
# cannot report, with one line on stderr: the remote checkout has no reader, or
# the reader found the Firstmate it runs on missing a capability it needs (the
# reader's own exit 4 and line, passed on unchanged; for a remote home its own
# code root's); 2 an unknown home; any other code is the reader's own failure.
#
# deliver reads one action record on stdin and prints one outcome line,
# {"outcome":"delivered|handled_elsewhere|retry|failed"[,"error":…]}, always
# exiting 0 once it has an outcome. Each kind runs:
#   message, notice  fm-inbox.sh note --request-id tb-<id> -, except that a
#                    todo.closed the aggregator caused itself is delivered
#                    without a note.
#   direct           fm-send.sh <task> <text> (main) or
#                    fm-send.sh <id> --fire-and-forget <16 hex> 轉給 <task>：<text>
#   answer           fm-captain-hold.sh answers --source myshape (main),
#                    fm-board.sh --in-home <id> answers (local),
#                    fm-on.sh --stdin <id> fm-captain-hold.sh answers --source myshape
#                    (remote); then the note tb-<id>-note
#   tag              fm-board.sh tag, --in-home <id> tag, or fm-on.sh <id> fm-board.sh tag
#                    after fm-dispatch-plan.sh queues-push --to <id> (remote; its result is ignored)
# A repeat of the same id is safe for every kind but direct: notes are keyed
# by request id, an identical answer is answered "closed:" again, and a tag
# already in place is rewritten to the same topic.

FMB_NOT_ON_FORK=(
  "command is not tracked by the configured remote root"
  "command is not a genuine executable in the configured remote root"
)
FMB_NOT_ON_FORK_LINE="還沒換到 fork：在那台的 code root 加上 fork remote、寫 config/self-update-source 為「fork carry」，再回主 home 跑 /updatefirstmate。它的 agent 不會顯示。"
FMB_AGGREGATOR='{"name":"firstmate","label":"first mate","update_hint":"請在主 home 跑 /updatefirstmate。"}'
FMB_ERROR_MAX=600

# fmb_registry_remote <id>: prints 1 for a remote registered secondmate, 0 for
# a local one; returns 1 when <id> is not registered.
fmb_registry_remote() {
  tb_valid_id "$1" || return 1
  secondmate_registry_field "$DATA/secondmates.md" "$1" remote 2>/dev/null
}

# fmb_ledger_hint <home> <remote>: the line the board shows when the home's ledger is off.
fmb_ledger_hint() {
  local command="bin/fm-board.sh setup"
  if [ "$1" != main ]; then
    command="bin/fm-board.sh --in-home $1 setup"
    [ "$2" != 1 ] || command="bin/fm-on.sh $1 fm-board.sh setup"
  fi
  printf '%s\n' "home $1 的帳本未開，它的 task 不會有更新。在主 home 的終端機跑 $command"
}

# fmb_decorate <home> <remote>: the reader's report on stdin, with this side's additions.
fmb_decorate() {
  jq -c --arg home "$1" --arg hint "$(fmb_ledger_hint "$1" "$2")" --argjson agg "$FMB_AGGREGATOR" '
    (if .ledger_enabled == false then . + {ledger_hint: $hint} else . end)
    | if $home == "main" then
        . + {aggregator: $agg}
        | .secondmates = [(.secondmates // [])[]
            | if .remote == true then . + {read_every_s: 60, read_timeout_s: 400} else . end]
      else . end'
}

cmd_feed() {
  local home=${1:-} offset=${2:-} sha=${3:-} remote out err rc=0
  local -a closed=()
  [ "$#" -eq 3 ] || [ "$#" -eq 5 ] ||
    usage_error "feed 的用法是 <home> <offset> <prefix-sha256> [<closed-offset> <closed-sha256>]"
  fmb_check_cursor "$offset" "$sha"
  if [ "$#" -eq 5 ]; then
    fmb_check_cursor "$4" "$5"
    closed=(--closed-since "$4" "$5")
  fi
  if [ "$home" = main ]; then
    out=$("$SCRIPT_DIR/fm-topic-board-read.sh" ${closed[@]+"${closed[@]}"} "$offset" "$sha") || exit $?
    printf '%s\n' "$out" | fmb_decorate main 0
    return
  fi
  remote=$(fmb_registry_remote "$home") || {
    printf '%s\n' "feed：$home 不是已註冊的 secondmate" >&2
    exit 2
  }
  if [ "$remote" = 0 ]; then
    out=$("$SCRIPT_DIR/fm-topic-board-read.sh" --in-home "$home" ${closed[@]+"${closed[@]}"} "$offset" "$sha") || exit $?
  else
    err=$(mktemp "${TMPDIR:-/tmp}/fm-board-feed.XXXXXX")
    out=$("$SCRIPT_DIR/fm-on.sh" "$home" fm-topic-board-read.sh ${closed[@]+"${closed[@]}"} "$offset" "$sha" 2>"$err") || rc=$?
    if [ "$rc" -ne 0 ]; then
      if grep -qF -e "${FMB_NOT_ON_FORK[0]}" -e "${FMB_NOT_ON_FORK[1]}" "$err"; then
        rm -f "$err"
        printf '%s\n' "$FMB_NOT_ON_FORK_LINE" >&2
        exit 4
      fi
      cat "$err" >&2
      rm -f "$err"
      exit "$rc"
    fi
    rm -f "$err"
  fi
  printf '%s\n' "$out" | fmb_decorate "$home" "$remote"
}

# fmb_check_cursor <offset> <sha>: refuses a cursor the reader would refuse.
fmb_check_cursor() {
  case "$1" in '' | *[!0-9]*) usage_error "offset 要是非負整數：$1" ;; esac
  [ "$2" = - ] || [[ "$2" =~ ^[0-9a-f]{64}$ ]] || usage_error "prefix-sha256 要是 64 位十六進位或 -"
}

# fmb_outcome <outcome> [error]: the one outcome line.
fmb_outcome() {
  jq -cn --arg outcome "$1" --arg error "${2:-}" \
    '{outcome: $outcome} + (if $error == "" then {} else {error: $error} end)'
}

# fmb_run <stdin-text> <command...>: runs the command with exactly <stdin-text>
# (no newline added) on stdin; leaves FMB_CODE, FMB_OUT and FMB_ERR.
fmb_run() {
  local input=$1 dir
  shift
  dir=$(mktemp -d "${TMPDIR:-/tmp}/fm-board-deliver.XXXXXX")
  printf '%s' "$input" > "$dir/in"
  FMB_CODE=0
  "$@" < "$dir/in" > "$dir/out" 2> "$dir/err" || FMB_CODE=$?
  FMB_OUT=$(cat "$dir/out")
  FMB_ERR=$(cat "$dir/err")
  rm -rf "$dir"
}

# fmb_error_text: the last run's stderr, else its stdout, else its exit code.
fmb_error_text() {
  local text=$FMB_ERR
  [ -n "${text//[[:space:]]/}" ] || text=$FMB_OUT
  [ -n "${text//[[:space:]]/}" ] || text="exit $FMB_CODE"
  printf '%s' "${text:0:$FMB_ERROR_MAX}"
}

# fmb_field <record> <jq path>: one string field of the record, "" when absent.
fmb_field() {
  jq -r "($2)? // \"\" | if type == \"string\" then . else tostring end" <<< "$1" 2>/dev/null || true
}

# fmb_note <request-id> <body>: hands firstmate a note and prints the outcome.
fmb_note() {
  fmb_run "$2" "$SCRIPT_DIR/fm-inbox.sh" note --request-id "$1" -
  case "$FMB_CODE" in
    0) fmb_outcome delivered ;;
    # Saved but firstmate was not woken; replaying the same request id wakes it.
    3) fmb_outcome retry "$(fmb_error_text)" ;;
    *) fmb_outcome failed "$(fmb_error_text)" ;;
  esac
}

# fmb_request_id <record> [suffix]: the note's request id, tb-<write id>[suffix].
fmb_request_id() {
  printf 'tb-%s%s\n' "$(fmb_field "$1" .id)" "${2:-}"
}

fmb_deliver_message() {
  local body
  tb_valid_id "$(fmb_field "$1" .topic.id)" && [ -n "$(fmb_field "$1" .topic.name)" ] ||
    { fmb_outcome failed "訊息沒有議題"; return; }
  body="［議題：$(fmb_field "$1" .topic.name)（$(fmb_field "$1" .topic.id)）］"$'\n'"$(fmb_field "$1" .text)"
  fmb_note "$(fmb_request_id "$1")" "$body"
}

# fmb_hex16 <text>: the first 16 hex digits of the text's SHA-256.
fmb_hex16() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -c1-16
  else
    printf '%s' "$1" | shasum -a 256 | cut -c1-16
  fi
}

fmb_deliver_direct() {
  local home task text remote lead='^[[:space:]]*[/$!-]'
  home=$(fmb_field "$1" .home)
  task=$(fmb_field "$1" .task)
  text=$(fmb_field "$1" .text)
  tb_valid_id "$task" || { fmb_outcome failed "task id 格式不對：$task"; return; }
  [[ ! "$text" =~ $lead ]] && [ -n "${text//[[:space:]]/}" ] ||
    { fmb_outcome failed "訊息是空的，或以 /、\$、! 或 - 開頭"; return; }
  if [ "$home" = main ]; then
    fmb_run "" "$SCRIPT_DIR/fm-send.sh" "$task" "$text"
    [ "$FMB_CODE" -ne 0 ] || { fmb_outcome delivered; return; }
    case "$FMB_ERR$FMB_OUT" in
      *"is not resolvable"*) fmb_outcome failed "這個 worker 已經結束或找不到，訊息沒有送出。" ;;
      *) fmb_outcome failed "$(fmb_error_text)" ;;
    esac
    return
  fi
  remote=$(fmb_registry_remote "$home") || { fmb_outcome failed "不認得 home $home"; return; }
  fmb_run "" "$SCRIPT_DIR/fm-send.sh" "$home" --fire-and-forget \
    "$(fmb_hex16 "$(fmb_field "$1" .id)")" "轉給 $task：$text"
  if [ "$FMB_CODE" -eq 0 ]; then
    fmb_outcome delivered
  elif [ "$FMB_CODE" -eq 3 ] && [ "$remote" = 1 ]; then
    # fm-send.sh retried once and the remote delivery is still unconfirmed.
    fmb_outcome retry "$(fmb_error_text)"
  else
    fmb_outcome failed "$(fmb_error_text)"
  fi
}

# fmb_answer_verdict <task> <remote>: what the last answers run said about
# <task>: "closed", or an outcome line.
fmb_answer_verdict() {
  local task=$1 remote=$2 line verdict=""
  while IFS= read -r line; do
    line=$(printf '%s' "$line" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
    [ "$line" != "closed: $task" ] || { printf 'closed\n'; return; }
    case "$line" in "skipped: $task "* | "refused: $task "*) [ -n "$verdict" ] || verdict=$line ;; esac
  done <<< "$FMB_OUT"
  case "$verdict" in
    *"(already closed)"* | *"records a different captain decision"* | *"(not held for the captain)"*)
      fmb_outcome handled_elsewhere ;;
    ?*) fmb_outcome failed "$verdict" ;;
    *)
      if [ "$remote" = 1 ] && [ "$FMB_CODE" -eq 255 ]; then
        fmb_outcome retry "$(fmb_error_text)"
      else
        fmb_outcome failed "$(fmb_error_text)"
      fi
      ;;
  esac
}

fmb_deliver_answer() {
  local home task answer label mode name remote=0 line verdict
  home=$(fmb_field "$1" .home)
  task=$(fmb_field "$1" .task)
  answer=$(fmb_field "$1" .answer)
  label=$(fmb_field "$1" .label)
  mode=$(fmb_field "$1" .mode)
  tb_valid_id "$task" && [ -n "$answer" ] || { fmb_outcome failed "作答紀錄不完整"; return; }
  case "$mode" in done | release) ;; *) fmb_outcome failed "mode 只能是 done 或 release"; return ;; esac
  case "$answer$label" in *$'\t'* | *$'\n'*) fmb_outcome failed "答案與選項只能有一行，不能有 tab"; return ;; esac
  line="$task"$'\t'"$answer"$'\t'"$label"$'\t'"$mode"$'\n'
  if [ "$home" = main ]; then
    fmb_run "$line" "$SCRIPT_DIR/fm-captain-hold.sh" answers --source myshape
  else
    remote=$(fmb_registry_remote "$home") || { fmb_outcome failed "不認得 home $home"; return; }
    if [ "$remote" = 0 ]; then
      fmb_run "$line" "$SELF" --in-home "$home" answers
    else
      fmb_run "$line" "$SCRIPT_DIR/fm-on.sh" --stdin "$home" fm-captain-hold.sh answers --source myshape
    fi
  fi
  verdict=$(fmb_answer_verdict "$task" "$remote")
  [ "$verdict" = closed ] || { printf '%s\n' "$verdict"; return; }
  name=$(fmb_field "$1" .topic.name)
  fmb_note "$(fmb_request_id "$1" -note)" "［議題：${name:-未分類}］已在看板回答 $home/$task：$answer"
}

# fmb_deliver_notice <record>: a notice is a note, except that an item the
# aggregator closed itself needs no note.
fmb_deliver_notice() {
  local id
  if [ "$(fmb_field "$1" .event)" = todo.closed ]; then
    id=$(fmb_field "$1" .item.id)
    tb_valid_id "$id" || { fmb_outcome failed "項目 id 格式不對：$id"; return; }
    [ "$(fmb_field "$1" .by)" = captain ] || { fmb_outcome delivered; return; }
  fi
  fmb_note "$(fmb_request_id "$1")" "$(fmb_field "$1" .text)"
}

fmb_deliver_tag() {
  local home task topic remote=0
  home=$(fmb_field "$1" .home)
  task=$(fmb_field "$1" .task)
  topic=$(fmb_field "$1" .topic)
  if ! tb_valid_id "$task" || ! tb_valid_id "$topic"; then
    fmb_outcome failed "task 或議題 id 格式不對"
    return
  fi
  if [ "$home" = main ]; then
    fmb_run "" "$SELF" tag "$task" "$topic"
  else
    remote=$(fmb_registry_remote "$home") || { fmb_outcome failed "不認得 home $home"; return; }
    if [ "$remote" = 0 ]; then
      fmb_run "" "$SELF" --in-home "$home" tag "$task" "$topic"
    else
      # The mate checks the topic against its queue copy, so send it the board's current one first.
      "$SCRIPT_DIR/fm-dispatch-plan.sh" queues-push --to "$home" </dev/null >/dev/null 2>&1 || true
      fmb_run "" "$SCRIPT_DIR/fm-on.sh" "$home" fm-board.sh tag "$task" "$topic"
    fi
  fi
  if [ "$FMB_CODE" -eq 0 ]; then
    fmb_outcome delivered
  elif [ "$remote" = 1 ] && [ "$FMB_CODE" -eq 255 ]; then
    fmb_outcome retry "$(fmb_error_text)"
  else
    fmb_outcome failed "$(fmb_error_text)"
  fi
}

cmd_deliver() {
  local record kind
  [ "$#" -eq 0 ] || usage_error "deliver 不收參數，動作紀錄從 stdin 讀"
  IFS= read -r record || [ -n "$record" ] || { fmb_outcome failed "沒有收到動作紀錄"; return; }
  jq -e 'type == "object" and .v == 1 and (.id | type == "string") and (.kind | type == "string")' \
    <<< "$record" >/dev/null 2>&1 || { fmb_outcome failed "動作紀錄不是合法的 JSON 物件"; return; }
  kind=$(fmb_field "$record" .kind)
  case "$kind" in
    message) fmb_deliver_message "$record" ;;
    notice) fmb_deliver_notice "$record" ;;
    direct) fmb_deliver_direct "$record" ;;
    answer) fmb_deliver_answer "$record" ;;
    tag) fmb_deliver_tag "$record" ;;
    *) fmb_outcome failed "不認得的動作：$kind" ;;
  esac
}
