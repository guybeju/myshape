#!/usr/bin/env bash
# The hardened environment every stage-7 script runs the board in (AT0 of the
# board-interface test plan). Sourced after the test library
# (myshape/test/lib.sh; Firstmate's tests/lib.sh for
# fm-board/test/stage-7-upgrade.sh) and kit/helpers.sh, once TMP_ROOT is set.
# It runs the board from a board-only root (tb_make_board_root) with:
#   - a clean environment: env -i with only HOME, PATH, LANG, TMPDIR, the home
#     (as MYSHAPE_HOME, and as FM_HOME for board code from before the board
#     had its own names, which fm-board/test/stage-7-upgrade.sh runs) and the
#     test's own timing variables, so no override and no real home the caller
#     has can steer the board;
#   - a system-only PATH: a tripwire directory, /usr/bin, /bin, and the
#     directories of node, jq and git when they live elsewhere;
#   - tripwires named after every Firstmate script and library, from
#     myshape/test/firstmate-names and this checkout's bin/, which log to
#     $SA_TRIP_LOG when run or sourced;
#   - decoy Firstmate files in every scratch home, checked byte for byte at
#     the end.
# shellcheck disable=SC2034 # the globals are read by the sourcing scripts.

# The Firstmate names absent from a board-only root instead of tripwired. Since
# the board reaches its aggregator through the home's binding file, it names
# no Firstmate program at all, so every name is tripwired.
SA_NO_TRIPWIRE=""
LIVE_BOARD_PORT=47819

# sa_init: build the PATH, the tripwire directory, and the trip log. Stops the
# script when TMP_ROOT is unset or a PATH directory holds a Firstmate script.
sa_init() {
  local dir tool
  local -a dirs
  case "${TMP_ROOT:-}" in
    /*) ;;
    *) fail "TMP_ROOT must be an absolute scratch directory before sa_init" ;;
  esac
  SA_TRIP_LOG=$TMP_ROOT/tripwire.log
  : > "$SA_TRIP_LOG"
  SA_PATHTRIP=$TMP_ROOT/pathtrip
  mkdir -p "$SA_PATHTRIP" "$TMP_ROOT/h" "$TMP_ROOT/tmp"
  SA_TMPDIR=$TMP_ROOT/tmp
  SA_PATH="$SA_PATHTRIP:/usr/bin:/bin"
  for tool in node jq git; do
    dir=$(dirname "$(command -v "$tool")")
    case ":$SA_PATH:" in *":$dir:"*) ;; *) SA_PATH="$SA_PATH:$dir" ;; esac
  done
  IFS=: read -r -a dirs <<< "${SA_PATH#"$SA_PATHTRIP":}"
  for dir in "${dirs[@]}"; do
    if compgen -G "$dir/fm-*" >/dev/null; then
      fail "PATH directory $dir holds a file named fm-*; the board could find a Firstmate script there"
    fi
  done
  sa_tripwires "$SA_PATHTRIP"
}

# sa_firstmate_names: every Firstmate script name to put a tripwire under, one
# per line: the names in myshape/test/firstmate-names (Firstmate's bin/fm-*.sh
# when that list was made, so a copy of the board without Firstmate still has
# them) and every bin/fm-*.sh of this checkout (so a newer Firstmate script is
# never missed).
sa_firstmate_names() {
  local path
  {
    cat "$ROOT/myshape/test/firstmate-names"
    for path in "$ROOT"/bin/fm-*.sh; do
      [ ! -e "$path" ] || printf '%s\n' "${path##*/}"
    done
  } | LC_ALL=C sort -u
}

# sa_tripwires <dir>: one tripwire per Firstmate script name (sa_firstmate_names)
# in <dir>, every name but the no-tripwire ones. The board's own two files are
# not named fm-*, so none of them is ever replaced. A *-lib.sh tripwire logs
# when sourced; any other logs when run and exits 97.
sa_tripwires() {
  local dir=$1 name
  mkdir -p "$dir"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case " $SA_NO_TRIPWIRE " in *" $name "*) continue ;; esac
    case "$name" in
      *-lib.sh) printf 'printf "sourced %%s\\n" %q >> %q\n' "$name" "$SA_TRIP_LOG" > "$dir/$name" ;;
      *) printf '#!/bin/sh\nprintf "ran %%s %%s\\n" %q "$*" >> %q\nexit 97\n' "$name" "$SA_TRIP_LOG" > "$dir/$name" ;;
    esac
    chmod +x "$dir/$name"
  done <<EOF
$(sa_firstmate_names)
EOF
}

# sa_trip_root <broot>: tripwires in the root's bin/ and in a bin/ beside the
# root, for every Firstmate name.
sa_trip_root() {
  sa_tripwires "$1/bin"
  sa_tripwires "$(dirname "$1")/bin"
}

# sa_home <name>: a scratch home under TMP_ROOT with its own free port. Stops
# the script if the home is outside the scratch root or the port is the live
# board's.
sa_home() {
  local home=$TMP_ROOT/$1 port
  mkdir -p "$home/state" "$home/data" "$home/config"
  port=$(tb_free_port)
  printf '%s\n' "$port" > "$home/config/myshape-port"
  sa_assert_scratch "$home"
  printf '%s\n' "$home"
}

sa_assert_scratch() {  # <home>
  local port
  case "$1/" in
    "$TMP_ROOT"/*) ;;
    *) fail "home $1 is outside the scratch root $TMP_ROOT" ;;
  esac
  port=$(cat "$1/config/myshape-port" 2>/dev/null || true)
  case "$port" in
    '' | "$LIVE_BOARD_PORT") fail "home $1 must have its own port, never $LIVE_BOARD_PORT" ;;
  esac
}

# The decoys of AT0.4, relative to a home.
SA_DECOYS="data/captain.md data/captain-shared.md data/secondmates.md config/fleet-ledger state/fleet-ledger.jsonl .fm-secondmate-home data/backlog.md"

# sa_decoys <home>: Firstmate's files, as a Firstmate home would hold them,
# with their checksums recorded beside the home.
sa_decoys() {
  local home=$1
  printf '%s\n' '<!-- myshape:begin v10（裝好的規則） -->' '- 規則' '<!-- myshape:end -->' > "$home/data/captain.md"
  printf '%s\n' '# Shared captain preferences' '<!-- myshape:begin v4（裝好的規則） -->' '- 共用' \
    '<!-- myshape:end -->' > "$home/data/captain-shared.md"
  cat > "$home/data/secondmates.md" <<EOF
# Secondmates
- sm1 - Local helper (home: $TMP_ROOT/sm1; scope: sample work; projects: alpha; added 2026-11-01)
- far1 - Remote helper (host: farbox; root: /srv/fm; home: /srv/fm-home; scope: remote work; projects: beta; added 2026-11-01)
EOF
  : > "$home/config/fleet-ledger"
  printf '%s\n' '{"v":1,"ts":1782864100,"event":"task.dispatched","task":"ship-a","kind":"ship"}' \
    '{"v":1,"ts":1782864200,"event":"task.status","task":"ship-a","state":"working","text":"halfway"}' \
    > "$home/state/fleet-ledger.jsonl"
  printf 'sm9\n' > "$home/.fm-secondmate-home"
  cat > "$home/data/backlog.md" <<'EOF'
## In flight

## Queued
- [ ] vpn-login - Log in to the VPN (repo: sample) (kind: captain) (hold: 動手：登入 VPN) (hold-kind: captain)
  Captain hold set: 2026-07-24T00:00:00Z
- [ ] call-1 - A call (repo: sample) (kind: captain) (hold: 要合併嗎？ 選項：合併 | 先不要) (hold-kind: captain)
  Captain hold set: 2026-07-24T00:00:00Z

## Done
EOF
  mkdir -p "$home/state/inbox"
  # shellcheck disable=SC2086 # the decoy list is a list of words.
  (cd "$home" && sha256sum $SA_DECOYS) > "$home.decoys"
}

# sa_check_decoys <home>: every decoy is byte-identical and state/inbox/ is empty.
sa_check_decoys() {
  (cd "$1" && sha256sum -c --quiet "$1.decoys") >/dev/null 2>&1 ||
    fail "a decoy Firstmate file in $1 changed: $(cd "$1" && sha256sum -c "$1.decoys" 2>&1 | grep -v ': OK$')"
  [ -z "$(ls -A "$1/state/inbox")" ] || fail "the board wrote into $1/state/inbox"
}

# Extra NAME=value words for the clean environment, set by each script.
SA_ENV=()

# sa <home> <myshape.sh arguments...>: run the board-only root's command in a
# clean environment. SA_ROOT is the root; SA_CMD_PATH, when set, replaces PATH.
# The home goes under the board's own name and under FM_HOME too: the board's
# command at an older commit read only that, and stage-7-upgrade.sh runs it
# here; this one does not read it.
sa() {
  local home=$1
  shift
  sa_assert_scratch "$home"
  case "${1:-}" in
    open | stop | restart) ! declare -F sig_product_target >/dev/null || sig_product_target "$home" "$1" ;;
  esac
  env -i HOME="$TMP_ROOT/h" PATH="${SA_CMD_PATH:-$SA_PATH}" LANG=C.UTF-8 TMPDIR="$SA_TMPDIR" \
    MYSHAPE_HOME="$home" FM_HOME="$home" ${SA_ENV[@]+"${SA_ENV[@]}"} "$SA_ROOT/bin/myshape.sh" "$@"
}

# sa_code <home> <arguments...>: run like sa, discard output, print the exit code.
sa_code() {
  local rc=0
  sa "$@" >/dev/null 2>&1 || rc=$?
  printf '%s\n' "$rc"
}

# sa_assert_no_trips: nothing in the board tree ran or sourced a tripwire.
sa_assert_no_trips() {
  [ ! -s "$SA_TRIP_LOG" ] || fail "the board reached Firstmate files: $(cat "$SA_TRIP_LOG")"
}

# sa_assert_no_boards: no board started under the scratch root is left.
sa_assert_no_boards() {
  tb_stop_boards
  ! pgrep -f "board-server.js.*--state $TMP_ROOT/" >/dev/null || fail "a board under $TMP_ROOT is still running"
}

# sa_agg_dir <agg-dir>: the data and logs of a stub aggregator, empty
# (myshape/test/stub-aggregator/stub-lib.sh).
sa_agg_dir() {
  mkdir -p "$1/fm" "$1/plain" "$1/control"
  : > "$1/calls.log"
  : > "$1/received.jsonl"
  : > "$1/play"
}

# sa_stub_files <stub> <bin-dir> <agg-dir>: copy the stubs into <bin-dir> with
# modes set here (this PC's umask would leave them group-writable), and
# tb-stub.conf naming <stub> and <agg-dir>.
sa_stub_files() {
  local stub=$1 dir=$2 agg=$3 name
  mkdir -p "$dir"
  for name in stub-fm stub-plain stub-lib.sh; do
    cp "$ROOT/myshape/test/stub-aggregator/$name" "$dir/$name"
  done
  chmod 755 "$dir/stub-fm" "$dir/stub-plain"
  chmod 644 "$dir/stub-lib.sh"
  printf 'TB_STUB=%q\nTB_AGG=%q\n' "$stub" "$agg" > "$dir/tb-stub.conf"
  chmod 644 "$dir/tb-stub.conf"
}

# sa_install_stub <stub> <agg-dir>: put a stub aggregator (fm or plain) outside
# the board-only root, in <agg-dir>/bin, under its own name, with its data and
# logs in <agg-dir>; print the program's path. A home reaches it once
# sa_bind names it and the page confirms it (sa_confirm).
sa_install_stub() {
  sa_agg_dir "$2"
  sa_stub_files "$1" "$2/bin" "$2"
  printf '%s\n' "$2/bin/stub-$1"
}

# sa_install_old_stub <stub> <agg-dir>: for a board from before the binding
# file, which runs only <root>/bin/fm-board.sh: the stub dispatcher committed
# there, with the stubs beside it.
sa_install_old_stub() {
  sa_agg_dir "$2"
  sa_stub_files "$1" "$SA_ROOT/bin" "$2"
  cp "$ROOT/myshape/test/stub-aggregator/dispatch" "$SA_ROOT/bin/fm-board.sh"
  chmod 755 "$SA_ROOT/bin/fm-board.sh"
  ROOT_COMMIT=$(tb_commit_root "$SA_ROOT" "stub aggregator")
}

# sa_bind <home> <program> [<name>]: the home's binding naming <program> as both
# its feed and its deliverer, under <name> (the program's file name by default).
sa_bind() {
  local name=${3:-${2##*/}}
  jq -cn --arg name "$name" --arg program "$2" '{v: 1, name: $name, feed: $program, deliver: $program}' \
    > "$1/config/myshape-aggregator.json"
  chmod 644 "$1/config/myshape-aggregator.json"
}

# sa_confirm <home> [<role>]: confirm on the page, in its two steps, the
# program the home's binding names for <role> (feed by default; one
# confirmation covers both roles of one program). The board must be running.
sa_confirm() {
  local home=$1 role=${2:-feed} base token code
  base="http://127.0.0.1:$(cat "$home/config/myshape-port")"
  token=$(cat "$home/state/myshape/token")
  code=$(curl -s -m 20 -H "Authorization: Bearer $token" -H "Origin: $base" -H 'Content-Type: application/json' \
    -d "{\"role\":\"$role\"}" "$base/api/programs/confirm" | jq -r '.confirm // empty')
  [ -n "$code" ] || fail "the page offered no confirmation for the $role program of $home"
  curl -s -m 20 -H "Authorization: Bearer $token" -H "Origin: $base" -H 'Content-Type: application/json' \
    -d "{\"role\":\"$role\",\"confirm\":\"$code\"}" "$base/api/programs/confirm" | jq -e '.ok == true' >/dev/null ||
    fail "the page did not confirm the $role program of $home"
}

# sa_child_board <home>: start the home's board service the way myshape.sh
# would, but as this script's own background child, so a test may end it with
# kill_own_child. Leaves its pid in SA_CHILD once the service answers.
sa_child_board() {
  local home=$1 i=0
  sa_assert_scratch "$home"
  mkdir -p "$home/state/myshape"
  env -i HOME="$TMP_ROOT/h" PATH="$SA_PATH" LANG=C.UTF-8 TMPDIR="$SA_TMPDIR" MYSHAPE_HOME="$home" \
    ${SA_ENV[@]+"${SA_ENV[@]}"} node "$SA_ROOT/myshape/dist/board-server.js" --home "$home" --root "$SA_ROOT" \
    --commit "$(git -C "$SA_ROOT" rev-parse HEAD)" --state "$home/state" --data "$home/data" \
    --config "$home/config" --binding "$(node "$SA_ROOT/myshape/dist/binding-cli.js" "$home/config/myshape-aggregator.json" | head -n 1)" \
    --exempt - --port "$(cat "$home/config/myshape-port")" >> "$home/state/myshape/service.log" 2>&1 &
  SA_CHILD=$!
  while [ "$(tb_board_pid "$home")" != "$SA_CHILD" ] || [ ! -S "$home/state/myshape/board.sock" ]; do
    [ "$i" -lt 100 ] || fail "the board started as this script's child did not come up in $home"
    sleep 0.1
    i=$((i + 1))
  done
}

# sa_crash_child <home>: end the board sa_child_board started, at once, the way
# a crash would. In a signal dry run nothing is sent: the board is stopped
# through its socket instead, and the caller's crash-only checks are skipped.
sa_crash_child() {
  kill_own_child "$SA_CHILD"
  signal_dry_run && tb_socket_stop "$1/state/myshape/board.sock"
  wait "$SA_CHILD" 2>/dev/null || true
}
