#!/usr/bin/env bash
# Firstmate's fixtures for the board tests on its side: fm-board/test and the
# suites that run the board with Firstmate's own adapter. Sourced after
# tests/lib.sh; it loads the board's test kit (myshape/test/kit/helpers.sh)
# first, so a suite sources only this file.
# shellcheck disable=SC2034 # the path globals are read by the sourcing tests.

# shellcheck source=myshape/test/kit/helpers.sh
. "$ROOT/myshape/test/kit/helpers.sh"

BOARD_READ="$ROOT/bin/fm-topic-board-read.sh"
BOARD="$ROOT/bin/fm-board.sh"

# tb_write_registry <main-home> <local-secondmate-home>: register one local
# secondmate (sm1) and one remote secondmate (far1).
tb_write_registry() {
  cat > "$1/data/secondmates.md" <<EOF
# Secondmates
- sm1 - Local helper (home: $2; scope: sample work; projects: alpha; added 2026-11-01)
- far1 - Remote helper (host: farbox; root: /srv/fm; home: /srv/fm-home; scope: remote work; projects: beta; added 2026-11-01)
EOF
}

# tb_seed_unstarted <code-root> <task>: make <code-root>'s snapshot report <task>
# the way upstream does for a harness that has not taken its first turn since
# spawn (the busy record is still fm-spawn's seed). A real one needs a live pane.
tb_seed_unstarted() {
  rm -f "$1/bin/fm-fleet-snapshot.sh"
  cat > "$1/bin/fm-fleet-snapshot.sh" <<SH
#!/usr/bin/env bash
set -euo pipefail
"$ROOT/bin/fm-fleet-snapshot.sh" "\$@" | jq -c --arg task "$2" '
  (.tasks[] | select(.id == \$task) | .current_state) =
    {state: "working", source: "pane", detail: "harness busy (fm-spawn)", freshness: "fresh"}'
SH
  chmod +x "$1/bin/fm-fleet-snapshot.sh"
}

# tb_make_fake_root <dir>: a private code root with this checkout's scripts and
# build, its own git history, stand-ins for the four scripts the board writes
# through (fm-inbox.sh, fm-send.sh, fm-captain-hold.sh, fm-on.sh), and the
# committed bin/fm-board.sh wrapper of tb_fake_aggregator. A home's board runs
# it once the home is bound (tb_bind_home).
#
# Each stand-in appends "cmd=<key>\targv=<a|b|...>\thome=<FM_HOME>\tstdin=<text>"
# to $TB_LOG, then follows the next step in $TB_PLAY/<key> when there is one. A
# step is "<exit code or sleepN>\t<stdout>". "Remote" home <id> is the local
# directory $TB_REMOTES/<id>.
tb_make_fake_root() {
  local fake=$1 name
  fm_git_init_commit "$fake"
  mkdir -p "$fake/bin" "$fake/myshape"
  ln -s "$ROOT"/bin/* "$fake/bin/"
  ln -s "$ROOT/myshape/dist" "$fake/myshape/dist"
  rm "$fake/bin/fm-on.sh" "$fake/bin/fm-inbox.sh" "$fake/bin/fm-send.sh" "$fake/bin/fm-captain-hold.sh"
  cat > "$fake/bin/tb-fake-lib.sh" <<'SH'
tb_fake() {  # <play key> <stdin> <argv...>
  local key=$1 input=$2 step code out play
  shift 2
  {
    printf 'cmd=%s\targv=' "$key"
    printf '%s|' "$@"
    printf '\thome=%s\tstdin=%s\n' "${FM_HOME:-}" "${input//$'\n'/\\n}"
  } >> "$TB_LOG"
  play="$TB_PLAY/$key"
  [ -s "$play" ] || return 0
  IFS= read -r step < "$play"
  tail -n +2 "$play" > "$play.next"
  mv "$play.next" "$play"
  code=${step%%$'\t'*}
  out=${step#*$'\t'}
  [ "$out" = "$step" ] || printf '%s\n' "$out"
  case "$code" in
    sleep*)
      printf 'start %s\n' "$key" >> "$TB_LOG"
      sleep "${code#sleep}"
      printf 'end %s\n' "$key" >> "$TB_LOG"
      code=0
      ;;
  esac
  exit "$code"
}
SH
  for name in fm-inbox.sh fm-send.sh; do
    cat > "$fake/bin/$name" <<'SH'
#!/usr/bin/env bash
set -u
. "$(dirname "$0")/tb-fake-lib.sh"
tb_fake "$(basename "$0")" "$(cat)" "$@"
exit 0
SH
  done
  cat > "$fake/bin/fm-captain-hold.sh" <<'SH'
#!/usr/bin/env bash
set -u
. "$(dirname "$0")/tb-fake-lib.sh"
input=$(cat)
tb_fake fm-captain-hold.sh "$input" "$@"
printf 'closed: %s\n' "${input%%$'\t'*}"
SH
  cat > "$fake/bin/fm-on.sh" <<'SH'
#!/usr/bin/env bash
set -u
. "$(dirname "$0")/tb-fake-lib.sh"
[ "$1" != --stdin ] || shift
id=$1
script=$2
shift 2
case "$script" in
  fm-remote-file.sh) exit 1 ;;
  fm-topic-board-read.sh) FM_HOME="$TB_REMOTES/$id" exec "$(dirname "$0")/$script" "$@" ;;
esac
input=$(cat)
tb_fake "fm-on.sh.$script" "$input" "$id" "$@"
case "$script" in
  fm-board.sh) FM_HOME="$TB_REMOTES/$id" exec "$(dirname "$0")/$script" "$@" ;;
  fm-captain-hold.sh) printf 'closed: %s\n' "${input%%$'\t'*}" ;;
esac
SH
  chmod +x "$fake"/bin/fm-on.sh "$fake"/bin/fm-inbox.sh "$fake"/bin/fm-send.sh "$fake"/bin/fm-captain-hold.sh
  tb_fake_aggregator "$fake"
}

# The settings the stand-ins and the reader take from the environment of the
# test that made the root. The board hands its programs a fixed, short
# environment (contracts section 7), so they reach bin/fm-board.sh through
# <root>/tb-fake.env instead.
TB_FAKE_ENV_NAMES="TB_LOG TB_PLAY TB_REMOTES FM_SNAPSHOT_NOW"

# tb_fake_aggregator <fake-root>: make that root's bin/fm-board.sh the program the
# board's binding names: a committed wrapper (git tracks it unchanged, so it
# runs without a confirmation) that loads <root>/tb-fake.env and runs this
# checkout's fm-board.sh from <root>/bin, beside the stand-ins. Run it after
# the test exported the settings of TB_FAKE_ENV_NAMES it needs.
tb_fake_aggregator() {
  local fake=$1 name value
  : > "$fake/tb-fake.env"
  for name in $TB_FAKE_ENV_NAMES; do
    if value=$(printenv "$name"); then
      printf 'export %s=%q\n' "$name" "$value" >> "$fake/tb-fake.env"
    fi
  done
  rm -f "$fake/bin/fm-board.sh"
  ln -s "$ROOT/bin/fm-board.sh" "$fake/bin/fm-board-real.sh"
  cat > "$fake/bin/fm-board.sh" <<'SH'
#!/usr/bin/env bash
# shellcheck source=/dev/null
. "$(dirname "$0")/../tb-fake.env"
exec "$(dirname "$0")/fm-board-real.sh" "$@"
SH
  chmod 755 "$fake/bin/fm-board.sh"
  git -C "$fake" add bin/fm-board.sh
  git -C "$fake" -c user.name='Firstmate Tests' -c user.email='tests@example.invalid' commit -qm "fake aggregator"
}
