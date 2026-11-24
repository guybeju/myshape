#!/usr/bin/env bash
# Where a secondmate home reads the main home's topic list, shared by
# fm-dispatch-plan.sh order and fm-board.sh tag so the two never disagree about
# which topics exist. Sourced only; defines functions and two variables, and
# sources nothing until fmq_root_home runs. The caller must already have
# sourced fm-primary-scope-lib.sh and set SCRIPT_DIR. Written for bash 3.2 and
# BSD tools, since it runs on the far machine.
# shellcheck disable=SC2034 # FMQ_* are read by the sourcing scripts.

# The jq definition of a usable queue copy (fm-dispatch-queues.v1).
FMQ_COPY_VALID='def valid_copy:
  type == "object"
  and .schema == "fm-dispatch-queues.v1"
  and (.at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  and ((.at | try fromdateiso8601 catch null) != null)
  and (.queues | type == "object")
  and ([.queues.high, .queues.normal, .queues.later] | all(type == "array" and all(.[]; type == "string")))
  and (.topics | type == "object" and all(.[]; type == "object" and (.name | type == "string")))
  and (.merged | type == "object" and all(.[]; type == "string"))
  and (.archived | type == "object" and all(.[]; type == "object" and (.name | type == "string")));'

# A copy this many minutes old or more is stale: order still ranks by it with
# a warning, tag no longer checks against it.
FMQ_COPY_STALE_MINUTES=60

# fmq_usable_topic_file <file>: whether <file> is a topic file with queues and topics.
fmq_usable_topic_file() {
  jq -e '(.queues | type == "object") and (.topics | type == "object")' "$1" >/dev/null 2>&1
}

# fmq_root_home <home>: this machine's top home above <home>, through upstream's
# own walk, loaded in a subshell so none of its globals reach the caller.
fmq_root_home() {
  (
    # The library sets FM_HOME, STATE and more, but only inside this subshell;
    # not following it keeps ShellCheck from flagging every caller (SC2031).
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/fm-wake-lib.sh" >/dev/null 2>&1 && fm_firstmate_root_home "$1"
  ) 2>/dev/null
}

# fmq_mate_source <secondmate-home> <its-own-copy-file>: where that home reads
# the topic list. Sets FMQ_SOURCE to "root" when its top home on this machine
# is the main home (FMQ_PATH is that home, whose data/topics.json is read
# live), otherwise to "copy" (FMQ_PATH is the queue copy kept in the top home
# on this machine: <its-own-copy-file> when that is the home itself).
fmq_mate_source() {
  local own root
  own=$(cd "$1" && pwd -P)
  root=$(fmq_root_home "$1") || root=$own
  if [ "$root" != "$own" ] && ! fm_root_is_secondmate_home "$root"; then
    FMQ_SOURCE=root
    FMQ_PATH=$root
  else
    FMQ_SOURCE=copy
    FMQ_PATH=$2
    [ "$root" = "$own" ] || FMQ_PATH="$root/state/dispatch-plan/queues.json"
  fi
}

# fmq_copy_age <copy>: prints "<at>\t<whole minutes old, at least 0>" for a
# usable copy; returns 1 when <copy> is not one.
fmq_copy_age() {
  jq -r "$FMQ_COPY_VALID"' if valid_copy then "\(.at)\t\([((now - (.at | fromdateiso8601)) / 60 | floor), 0] | max)" else error("invalid") end' \
    "$1" 2>/dev/null
}
