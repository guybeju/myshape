#!/usr/bin/env bash
# Checks the names FORK-SETUP.markdown cites against this checkout, so a board
# change that renames or drops something the setup guide tells people to use
# fails here instead of on a new machine. It checks names only, never prose:
#   - every relative Markdown link points at an existing file (anchors after
#     '#' are not checked);
#   - every bin/fm-*.sh and bin/myshape.sh it names exists and is executable;
#   - every "myshape.sh <sub>", "fm-board.sh <sub>" (also after
#     "--in-home <id>") and "fm-dispatch-plan.sh <sub>" names a subcommand
#     listed in that script's usage header;
#   - every config/<name> it names appears in some script under bin/;
#   - every `/<skill>` and every `<skill>` 技能 has .agents/skills/<skill>/SKILL.md;
#   - every version written after captain.md or captain-shared.md, such as
#     "（v11）", equals the version on the first line of its template in
#     fm-board/rules/.
# Prints one "not ok" line per problem and exits 1, or one "ok" line and 0.
#
# Usage: fm-board/test/check-guide.sh [<guide> [<link-base-dir>]]
#   <guide> defaults to FORK-SETUP.markdown at the checkout root; relative
#   links resolve against <link-base-dir>, which defaults to the guide's
#   directory.
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUIDE=${1:-$ROOT/FORK-SETUP.markdown}
[ -f "$GUIDE" ] || {
  echo "check-guide.sh: no such guide: $GUIDE" >&2
  exit 2
}
BASE=${2:-$(cd "$(dirname "$GUIDE")" && pwd)}
problems=0

problem() {
  echo "not ok - check-guide: $1" >&2
  problems=$((problems + 1))
}

# cited <extended-regex>: every distinct match in the guide, one per line.
cited() {
  grep -oE "$1" "$GUIDE" | sort -u || true
}

check_links() {
  local link path
  while IFS= read -r link; do
    [ -n "$link" ] || continue
    path=${link#](}
    path=${path%)}
    case "$path" in
      http:* | https:* | mailto:* | '#'*) continue ;;
    esac
    path=${path%%#*}
    [ -e "$BASE/$path" ] || problem "link target does not exist: $path"
  done <<< "$(cited '\]\([^)]+\)')"
}

check_scripts() {
  local script
  while IFS= read -r script; do
    [ -n "$script" ] || continue
    [ -x "$ROOT/$script" ] || problem "script does not exist or is not executable: $script"
  done <<< "$(cited 'bin/(fm-[A-Za-z0-9_-]+|myshape)\.sh')"
}

# usage_subcommands <script>: the subcommands bin/<script>'s usage header
# lists, one per line.
usage_subcommands() {
  sed -n "s/^#   ${1//./\\.} //p" "$ROOT/bin/$1" | tr '|' '\n' |
    awk '{ if ($1 == "--in-home") print $3; else print $1 }' | sort -u
}

# check_subcommands <script>: every "<script> [--in-home <id>] <sub>" the
# guide cites names a subcommand of that script.
check_subcommands() {
  local script=$1 known use sub
  known=$(usage_subcommands "$script")
  while IFS= read -r use; do
    [ -n "$use" ] || continue
    sub=${use##* }
    printf '%s\n' "$known" | grep -qxF "$sub" || problem "$script has no subcommand '$sub' (cited as: $use)"
  done <<< "$(cited "${script//./\\.}( --in-home <[^>]*>)? [a-z][a-z-]*")"
}

check_config_files() {
  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    grep -rqF "$file" "$ROOT/bin" || problem "no script under bin/ mentions $file"
  done <<< "$(cited 'config/[a-z][a-z0-9-]*')"
}

check_skills() {
  local use name
  # shellcheck disable=SC2016 # the backticks are Markdown code spans, not command substitution.
  while IFS= read -r use; do
    [ -n "$use" ] || continue
    name=${use#\`}
    name=${name#/}
    name=${name%%\`*}
    [ -f "$ROOT/.agents/skills/$name/SKILL.md" ] || problem "no skill named $name"
  done <<< "$(cited '`/[a-z][a-z-]*`'; cited '`[a-z][a-z-]*` 技能')"
}

# check_version <preference-file> <its regex> <template>
check_version() {
  local file=$1 pattern=$2 template=$3 expected use found
  expected=$(sed -n '1s/^.*myshape:begin \(v[0-9]*\).*$/\1/p' "$ROOT/fm-board/rules/$template")
  [ -n "$expected" ] || {
    problem "cannot read the version of fm-board/rules/$template"
    return 0
  }
  while IFS= read -r use; do
    [ -n "$use" ] || continue
    found=${use##*（}
    found=${found%）}
    [ "$found" = "$expected" ] || problem "$file is cited at $found but fm-board/rules/$template is $expected"
  done <<< "$(cited "${pattern}[^v\`]*（v[0-9]+）")"
}

check_links
check_scripts
check_subcommands myshape.sh
check_subcommands fm-board.sh
check_subcommands fm-dispatch-plan.sh
check_config_files
check_skills
check_version captain.md 'captain\.md' captain.block.md.tmpl
check_version captain-shared.md 'captain-shared\.md' captain-shared.block.md.tmpl

if [ "$problems" -gt 0 ]; then
  echo "check-guide.sh: $problems problem(s) in $GUIDE" >&2
  exit 1
fi
echo "ok - $(basename "$GUIDE") cites only names that exist in this checkout"
