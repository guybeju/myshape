#!/usr/bin/env bash
# Firstmate's helpers for the topic board: reaching a local secondmate home on
# the board's behalf (bin/fm-board.sh, bin/fm-topic-board-read.sh), checking
# that the Firstmate scripts the reader runs can give a true report
# (bin/fm-topic-board-read.sh), and running the board's own command
# (bin/fm-board.sh, bin/fm-topic-session-start.sh).
# Sourced only; defines functions and has no side effects on source.
#
# tb_local_secondmate_home needs fm-secondmate-registry-lib.sh and
# myshape-lib.sh sourced first; tb_tag_files_json needs jq; tb_capability_gap,
# tb_snapshot_mode and tb_board_env need nothing.

# tb_local_secondmate_home <registry-file> <secondmate-id>: print the home of a
# LOCAL registered secondmate. Returns 1 after printing the reason to stderr
# when the id is malformed, unregistered, or remote.
tb_local_secondmate_home() {
  local reg=$1 id=$2 remote home
  tb_valid_id "$id" || {
    printf '%s\n' "--in-home：secondmate id 格式不對：$id" >&2
    return 1
  }
  remote=$(secondmate_registry_field "$reg" "$id" remote) || {
    printf '%s\n' "--in-home：data/secondmates.md 裡沒有 $id" >&2
    return 1
  }
  [ "$remote" = 0 ] || {
    printf '%s\n' "--in-home：$id 是遠端的 secondmate，請改用 bin/fm-on.sh $id" >&2
    return 1
  }
  home=$(secondmate_registry_field "$reg" "$id" home) || return 1
  [ -d "$home" ] || {
    printf '%s\n' "--in-home：$id 的 home 不存在：$home" >&2
    return 1
  }
  printf '%s\n' "$home"
}

# tb_exec_in_home <home> <command...>: replace this process with <command> run
# against <home>. Path overrides that pointed at the calling home are dropped
# so the command resolves state/, data/, and config/ from <home>.
tb_exec_in_home() {
  local home=$1
  shift
  exec env -u FM_STATE_OVERRIDE -u FM_DATA_OVERRIDE -u FM_CONFIG_OVERRIDE \
    -u FM_PROJECTS_OVERRIDE FM_HOME="$home" "$@"
}

# tb_capability_gap <bin-dir>: whether the Firstmate scripts in <bin-dir> have
# what fm-topic-board-read.sh needs beyond upstream's main for its report to be
# true. Prints one line naming the missing capability and returns 1 when one is
# missing; returns 0 otherwise. It reads the scripts' text and nothing else, so
# it runs no Firstmate command and writes nothing.
#
# The one capability checked is the fork's archived-blocker fix in
# fm-fleet-snapshot.sh, marked by its call of fm_backlog_archived_done_ids
# (bin/fm-backlog-archive-lib.sh): without it a blocker that Done retention
# moved to the markdown archive counts as unresolved, so holds and queued items
# are reported blocked by finished work. A snapshot script that is missing or
# unreadable is no gap here: the read fails on its own, as before.
tb_capability_gap() {
  local snapshot="$1/fm-fleet-snapshot.sh" rc=0
  grep -qF fm_backlog_archived_done_ids "$snapshot" 2>/dev/null || rc=$?
  [ "$rc" -eq 1 ] || return 0
  printf '%s%s%s%s\n' "這個 home 的 first mate 缺少封存 blocker 的修正：${snapshot} " \
    "會把已搬進 Done 封存的 blocker 當成沒完成，項目會看起來卡住，所以先不回報。" \
    "把 fork 的這個修正（bin/fm-fleet-snapshot.sh 呼叫 bin/fm-backlog-archive-lib.sh 的 " \
    "fm_backlog_archived_done_ids）移植到那個 code root，再更新。"
  return 1
}

# tb_snapshot_mode <bin-dir>: print the fm-fleet-snapshot.sh option that gives
# the board's readers what they use: --board-input when the script in <bin-dir>
# offers it (its text names the option), --json otherwise. Like
# tb_capability_gap it reads the script's text and runs nothing.
tb_snapshot_mode() {
  if grep -qF -e --board-input "$1/fm-fleet-snapshot.sh" 2>/dev/null; then
    printf '%s\n' --board-input
  else
    printf '%s\n' --json
  fi
}

# tb_tag_files_json <topic-file>...: print {"<task-id>": "<tag file content>"}
# for each named data/<task-id>/topic that is a file, its content without the
# trailing newlines; a path that is not a file is left out.
tb_tag_files_json() {
  local file task
  for file in "$@"; do
    [ -f "$file" ] || continue
    task=${file%/topic}
    task=${task##*/}
    # A tab can never start a tag line, so it marks where the next task begins.
    printf '\t%s\n%s\n' "$task" "$(< "$file")"
  done | jq -R -n '
    reduce inputs as $line ({tags: {}, task: null};
      if ($line | startswith("\t")) then .task = $line[1:] | .tags[.task] = []
      elif .task != null then .tags[.task] += [$line]
      else . end)
    | .tags | map_values(join("\n"))
  '
}

# tb_board_env: set TB_BOARD_ENV to the env(1) arguments that run
# bin/myshape.sh for this home (FM_HOME): the board reads only its own names,
# so this home and Firstmate's overrides go to it under those, each override
# only when it is set and not empty here, and any board name already in the
# environment is dropped first. Firstmate runs the board's command only as
# env "${TB_BOARD_ENV[@]}" <code root>/bin/myshape.sh; a name the board starts
# to read joins the -u list here.
# shellcheck disable=SC2034 # TB_BOARD_ENV is read by the scripts that source this file.
tb_board_env() {
  TB_BOARD_ENV=(-u MYSHAPE_ROOT_OVERRIDE -u MYSHAPE_DATA_OVERRIDE -u MYSHAPE_CONFIG_OVERRIDE
    -u MYSHAPE_STATE_OVERRIDE "MYSHAPE_HOME=$FM_HOME")
  [ -z "${FM_ROOT_OVERRIDE:-}" ] || TB_BOARD_ENV+=("MYSHAPE_ROOT_OVERRIDE=$FM_ROOT_OVERRIDE")
  [ -z "${FM_DATA_OVERRIDE:-}" ] || TB_BOARD_ENV+=("MYSHAPE_DATA_OVERRIDE=$FM_DATA_OVERRIDE")
  [ -z "${FM_CONFIG_OVERRIDE:-}" ] || TB_BOARD_ENV+=("MYSHAPE_CONFIG_OVERRIDE=$FM_CONFIG_OVERRIDE")
  [ -z "${FM_STATE_OVERRIDE:-}" ] || TB_BOARD_ENV+=("MYSHAPE_STATE_OVERRIDE=$FM_STATE_OVERRIDE")
}
