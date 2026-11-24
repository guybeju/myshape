#!/usr/bin/env bash
# Firstmate's helpers for the topic board: reaching a local secondmate home on
# the board's behalf (bin/fm-board.sh, bin/fm-topic-board-read.sh), and running
# the board's own command (bin/fm-board.sh, bin/fm-topic-session-start.sh).
# Sourced only; defines functions and has no side effects on source.
#
# tb_local_secondmate_home needs fm-secondmate-registry-lib.sh and
# myshape-lib.sh sourced first; tb_board_env needs nothing.

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
