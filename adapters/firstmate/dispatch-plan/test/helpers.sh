#!/usr/bin/env bash
# Shared fixtures for the dispatch-plan tests. Sourced after tests/lib.sh and
# the board's test kit (myshape/test/kit/helpers.sh), and after TMP_ROOT is set.
# shellcheck disable=SC2034 # PLAN is read by the sourcing tests.

# section <output> <header>: the task ids listed under one section header.
section() {
  printf '%s\n' "$1" | awk -v header="$2" '
    /^[^ ]/ { active = ($0 == header) ; next }
    active { sub(/^  /, ""); split($0, cols, "\t"); printf "%s ", cols[1] }
  '
}

# dp_make_local_mate <name> <id> <parent-home>: a secondmate home on this
# machine whose parent record names <parent-home>, the way upstream seeds one.
dp_make_local_mate() {
  local home
  home=$(tb_make_home "$1")
  printf 'schema=fm-secondmate-parent.v1\nroute=local\nparent_home=%s\n' "$3" > "$home/.fm-secondmate-parent"
  printf '%s\n' "$2" > "$home/.fm-secondmate-home"
  printf '%s\n' "$home"
}

# dp_make_remote_mate <name> <id>: a secondmate home seeded from another
# machine; its parent record names no local home.
dp_make_remote_mate() {
  local home
  home=$(tb_make_home "$1")
  printf 'schema=fm-secondmate-parent.v1\nroute=remote\nparent_host=farbox\n' > "$home/.fm-secondmate-parent"
  printf '%s\n' "$2" > "$home/.fm-secondmate-home"
  printf '%s\n' "$home"
}

# dp_minutes_ago <n>: the UTC time <n> minutes ago, in the copy's format.
dp_minutes_ago() {
  jq -nr --argjson n "$1" '(now - $n * 60) | strftime("%Y-%m-%dT%H:%M:%SZ")'
}

# dp_copy_json <at>: a queue copy with tb_write_topics' queues, topics, merged
# alias and archived topic, made at <at>.
dp_copy_json() {
  jq -nc --arg at "$1" '{
    schema: "fm-dispatch-queues.v1", at: $at,
    queues: {high: ["billing"], normal: ["t2"], later: ["parked"]},
    topics: {billing: {name: "帳務重構"}, t2: {name: "登入頁"}, parked: {name: "之後再說"}, idea: {name: "新點子"}},
    merged: {"old-billing": "billing"},
    archived: {gone: {name: "已結束"}}
  }'
}

# dp_write_copy <home> <at>: place that copy where queues-in keeps it.
dp_write_copy() {
  mkdir -p "$1/state/dispatch-plan"
  dp_copy_json "$2" > "$1/state/dispatch-plan/queues.json"
}

# The host every order and machine call in these tests reads, so no assertion
# depends on the runner's real load: upstream's probes read
# FM_PROC_ROOT_OVERRIDE in place of /proc on Linux, and the getconf and df on
# DP_HOST/bin answer the core count and the free disk from DP_HOST's files;
# every other getconf or df call goes to the real one. Only the planner's
# calls get them (PLAN and dp_on_host), since other upstream /proc readers
# have no fallback for a fixture /proc. macOS reads sysctl instead, so there
# these tests read the real host.
DP_HOST="$TMP_ROOT/host"

# dp_host <load1> <load5> <mem_free_pct|-> <disk_free_mb> <cores>: make that
# the host; a - memory leaves /proc/meminfo empty, so memory cannot be read.
dp_host() {
  mkdir -p "$DP_HOST/proc"
  printf '%s %s 1.00 1/100 1\n' "$1" "$2" > "$DP_HOST/proc/loadavg"
  if [ "$3" = - ]; then
    : > "$DP_HOST/proc/meminfo"
  else
    printf 'MemTotal:       10000000 kB\nMemAvailable:   %s kB\n' "$(($3 * 100000))" > "$DP_HOST/proc/meminfo"
  fi
  printf '%s\n' "$4" > "$DP_HOST/disk_mb"
  printf '%s\n' "$5" > "$DP_HOST/cores"
}

# dp_calm_host: an idle 4-core machine with half its memory and 100 GB free.
dp_calm_host() {
  dp_host 0.10 0.10 50 102400 4
}

# dp_on_host <command...>: run <command> on the pinned host.
dp_on_host() {
  FM_PROC_ROOT_OVERRIDE="$DP_HOST/proc" PATH="$DP_HOST/bin:$PATH" "$@"
}

mkdir -p "$DP_HOST/bin"
cat > "$DP_HOST/bin/getconf" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = _NPROCESSORS_ONLN ]; then cat "$DP_HOST/cores"; else exec "$(command -v getconf)" "\$@"; fi
EOF
cat > "$DP_HOST/bin/df" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = -Pk ]; then
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 1 1 %s 1%% /\n' "\$((\$(cat "$DP_HOST/disk_mb") * 1024))"
else
  exec "$(command -v df)" "\$@"
fi
EOF
# PLAN runs the planner of this checkout on the pinned host.
cat > "$DP_HOST/plan" <<EOF
#!/usr/bin/env bash
FM_PROC_ROOT_OVERRIDE="$DP_HOST/proc" PATH="$DP_HOST/bin:\$PATH" exec "$ROOT/bin/fm-dispatch-plan.sh" "\$@"
EOF
chmod +x "$DP_HOST/bin/getconf" "$DP_HOST/bin/df" "$DP_HOST/plan"
PLAN="$DP_HOST/plan"
dp_calm_host

# dp_code_root <dir>: a scratch code root whose every file links to the real
# one, except bin/fm-on.sh, which is the far-machine stub below, and a copy of
# dispatch-plan/ that a test may change. The stub reads $STUB/<id>.mode: ok
# (the default: the real command in the scratch far home $STUB/far/<id>), down
# (exit 255), old (exit 2, no such subcommand), garbage (exit 0, not JSON), or
# record (exit 0, prints $STUB/<id>.json). It logs each call in $STUB/calls.
# Sets CODE and STUB.
dp_code_root() {
  local entry
  CODE=$1
  STUB="$1-stub"
  mkdir -p "$CODE/bin" "$STUB/far"
  for entry in "$ROOT"/* "$ROOT"/.[!.]*; do
    case "${entry##*/}" in bin | dispatch-plan | '.[!.]*') continue ;; esac
    [ -e "$entry" ] && ln -s "$entry" "$CODE/${entry##*/}"
  done
  cp -R "$ROOT/dispatch-plan" "$CODE/dispatch-plan"
  for entry in "$ROOT"/bin/*; do
    [ "${entry##*/}" = fm-on.sh ] || ln -s "$entry" "$CODE/bin/${entry##*/}"
  done
  cat > "$CODE/bin/fm-on.sh" <<EOF
#!/usr/bin/env bash
set -u
mate=\$1
shift
printf '%s %s\n' "\$mate" "\$*" >> "$STUB/calls"
case "\$(cat "$STUB/\$mate.mode" 2>/dev/null || echo ok)" in
  ok) exec env -u FM_ROOT_OVERRIDE -u FM_STATE_OVERRIDE -u FM_DATA_OVERRIDE FM_HOME="$STUB/far/\$mate" "$CODE/bin/\$1" "\${@:2}" ;;
  down) echo "ssh: connect to host farbox port 22: No route to host" >&2; exit 255 ;;
  old) echo "fm-dispatch-plan.sh: 不認得的子命令：machine" >&2; exit 2 ;;
  garbage) echo "not a record"; exit 0 ;;
  record) cat "$STUB/\$mate.json"; exit 0 ;;
esac
exit 91
EOF
  chmod +x "$CODE/bin/fm-on.sh"
}

# dp_far_mate <main-home> <id>: register <id> as a secondmate on another
# machine in <main-home>, with a scratch far home behind the stub; prints it.
dp_far_mate() {
  local far="$STUB/far/$2"
  mkdir -p "$far/state" "$far/data" "$far/config" "$far/projects"
  printf '%s\n' "$2" > "$far/.fm-secondmate-home"
  printf 'schema=fm-secondmate-parent.v1\nroute=remote\nparent_host=farbox\n' > "$far/.fm-secondmate-parent"
  printf -- '- %s - Remote helper (host: farbox; root: /srv/fm; home: /srv/fm-home; scope: remote work; projects: %s; added 2026-11-01)\n' \
    "$2" "$2" >> "$1/data/secondmates.md"
  printf '%s\n' "$far"
}

# dp_meta <home> <id> <key=value>...: a task record in <home>/state.
dp_meta() {
  local home=$1 id=$2
  shift 2
  printf '%s\n' "$@" > "$home/state/$id.meta"
}

# dp_summary <home> <age-seconds> <id:state>...: <home>'s home summary,
# generated <age-seconds> ago, listing those endpoints.
dp_summary() {
  local home=$1 age=$2 pair endpoints='[]'
  shift 2
  for pair in "$@"; do
    endpoints=$(jq -c --arg id "${pair%%:*}" --arg state "${pair#*:}" '. + [{id: $id, state: $state}]' <<< "$endpoints")
  done
  jq -n --argjson at "$(($(date +%s) - age))" --argjson endpoints "$endpoints" \
    '{schema: "fm-secondmate-home-summary.v1", generated_epoch: $at, endpoints: $endpoints}' > "$home/state/home-summary.json"
}

# dp_git_dir <dir> [message]: <dir> as a git repository with one empty commit.
# Two such commits made in the same second are the same commit unless their
# messages differ.
dp_git_dir() {
  mkdir -p "$1"
  git -C "$1" init -q
  git -C "$1" -c user.name=test -c user.email=test@example.invalid commit -q --allow-empty -m "${2:-init}"
}
