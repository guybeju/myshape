#!/usr/bin/env bash
# fm-board-vendor.sh - copy the board and its Firstmate adapter from one commit
# of guybeju/myshape into this Firstmate fork, or check that copy.
#
# Usage:
#   fm-board-vendor.sh vendor <commit>
#   fm-board-vendor.sh --check
#   fm-board-vendor.sh --source <dir> vendor <commit>    (tests only)
#   fm-board-vendor.sh --source <dir> --check             (tests only)
#
# The fork is the git checkout this script sits in: it must run as
# <toplevel>/bin/fm-board-vendor.sh. It sources nothing.
#
# What is vendored: every file the two lists name at <commit>. Lines of
# myshape/vendor-files map to the same path in the fork (empty lines are
# skipped); lines of adapters/firstmate/fm-board/vendor-files name
# adapters/firstmate/<line> in myshape and <line> in the fork. A line names a
# file or a whole directory. The script owns these areas of the fork:
#   myshape/, fm-board/, dispatch-plan/   whole directories
#   bin/<name>                            only the files the lists name
#   myshape.lock                          the lock
# and it never reads or writes anything else of the fork.
#
# The lock, myshape.lock at the toplevel, is exactly two lines:
#   repository https://github.com/guybeju/myshape
#   commit <40 lowercase hex>
# `vendor` writes it; nobody edits it by hand.
#
# The fetch: a bare scratch repository under mktemp, removed on exit, gets
# refs/heads/main of the repository above in full (no --depth, no tags). Every
# git command on that side runs under `env -i` with a fixed environment: PATH
# /usr/bin:/bin, HOME the scratch directory, LC_ALL=C, GIT_CONFIG_GLOBAL=/dev/null,
# GIT_CONFIG_NOSYSTEM=1, GIT_TERMINAL_PROMPT=0, plus https_proxy, HTTPS_PROXY,
# no_proxy, NO_PROXY and GIT_SSL_CAINFO when the caller sets them; and with
# -c protocol.allow=never -c protocol.https.allow=always
# -c transfer.fsckObjects=true. No token, credential helper, prompt, URL
# rewrite or ssh takes part. git older than 2.32 is refused, because it ignores
# GIT_CONFIG_GLOBAL. The commit must be on the first-parent chain of main: a
# commit that main itself pointed to, such as a pull request's merge commit,
# not one that only sits inside a merged pull request.
#
# vendor <commit> refuses, before it writes anything:
#   - unless HEAD is a branch whose name contains "board-sync" (so never on a
#     detached HEAD, main, or a home's code root);
#   - an uncommitted or untracked change in the owned areas;
#   - a list line that is absolute, holds whitespace or a character other than
#     A-Z a-z 0-9 . _ / -, has a "..", "." or .git part, or names nothing;
#   - an entry that is not a regular file (a symlink, a submodule) or has a mode
#     other than 100644 or 100755;
#   - two lines naming the same target, a target that is also a directory of
#     another, and a target outside the owned areas;
#   - a bin/ target the fork tracks but the current lock's commit did not
#     vendor (with no lock yet, a tracked bin/ target must already hold the
#     same bytes);
#   - a symlink or non-directory on the way from the toplevel to a target.
# It then writes each changed file through a temporary file and a rename,
# deletes one at a time each tracked file of a whole-directory area that the
# commit does not list and each bin/ file the current lock's commit vendored
# that the new one does not, writes myshape.lock, and stages exactly those
# paths. Committing is left to the caller.
#
# --check is read-only (it writes only its scratch repository) and runs on any
# checkout, a detached HEAD included. It compares the (path, mode, blob) of each
# listed file at the locked commit with HEAD's entries in the owned areas and
# prints one `not ok - <path>: ...` line per file that is missing, not listed,
# has other bytes or another mode, and per uncommitted or untracked change
# there. All equal prints `ok - <n> files match guybeju/myshape@<commit> (on main)`.
#
# --source <dir> is for the script's tests: it fetches main from that existing
# local directory instead (the file transport is allowed for that run only),
# runs every other step the same, and ends every output line with
# "(test source; provenance NOT checked)". The lock still names the
# repository above.
#
# Exit codes: 0 done or everything matches, 1 refused, a difference, or a
# failure (a fetch failure included), 2 usage error.
set -euo pipefail
export LC_ALL=C
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE

REPOSITORY=https://github.com/guybeju/myshape
LOCK=myshape.lock
BOARD_LIST=myshape/vendor-files
ADAPTER_LIST=adapters/firstmate/fm-board/vendor-files
ADAPTER_PREFIX=adapters/firstmate/
WHOLE_AREAS=(myshape fm-board dispatch-plan)
SYNC_BRANCH_WORD=board-sync
FETCH_PATH=/usr/bin:/bin
PASSED_NAMES="https_proxy HTTPS_PROXY no_proxy NO_PROXY GIT_SSL_CAINFO"
TEST_MARK=" (test source; provenance NOT checked)"

MARK=''
SOURCE_DIR=''
SCRATCH=''
PENDING_TMP=''
GIT_BIN=''
FETCH_URL=$REPOSITORY
PROTOCOL=https
TOP=''
LOCKED=''
PROBLEM=''
FETCH_ENV=()
NEW_BIN=()
OLD_BIN=()

usage() {
  printf '%s\n' "usage: fm-board-vendor.sh vendor <commit> | --check$MARK" \
    "       (tests only: fm-board-vendor.sh --source <dir> vendor <commit> | --check)$MARK"
}

emit_ok() {
  printf 'ok - %s%s\n' "$1" "$MARK"
}

emit_not_ok() {
  printf 'not ok - %s%s\n' "$1" "$MARK" >&2
}

emit_note() {
  printf '# %s%s\n' "$1" "$MARK" >&2
}

refuse() {
  emit_not_ok "$1"
  exit 1
}

usage_error() {
  printf 'fm-board-vendor.sh: %s%s\n' "$1" "$MARK" >&2
  usage >&2
  exit 2
}

# git_failed <what>: report <what> with git's captured stderr, then exit 1.
git_failed() {
  local line
  emit_not_ok "$1"
  while IFS= read -r line || [ -n "$line" ]; do
    emit_note "git: $line"
  done < "$SCRATCH/git.err"
  exit 1
}

cleanup() {
  [ -z "$PENDING_TMP" ] || rm -f -- "$PENDING_TMP"
  [ -z "$SCRATCH" ] || rm -rf -- "$SCRATCH"
}

is_commit_id() {
  [ "${#1}" -eq 40 ] || return 1
  case $1 in
    *[!0123456789abcdef]*) return 1 ;;
  esac
}

# path_problem <path>: set PROBLEM to why <path> is not a clean relative path
# this script may write, or to '' when it is one.
path_problem() {
  local rest=$1/ part
  PROBLEM=''
  case $1 in
    '') PROBLEM='is empty' ;;
    /*) PROBLEM='is absolute' ;;
    *[[:space:]]*) PROBLEM='contains whitespace' ;;
    *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-]*)
      PROBLEM='contains a character other than A-Z a-z 0-9 . _ / -' ;;
  esac
  [ -z "$PROBLEM" ] || return 0
  while [ -n "$rest" ]; do
    part=${rest%%/*}
    rest=${rest#*/}
    case $part in
      '' | .) PROBLEM='is not a clean relative path' ;;
      ..) PROBLEM="contains a '..' part" ;;
      [.][Gg][Ii][Tt]) PROBLEM='contains a .git part' ;;
    esac
    [ -z "$PROBLEM" ] || return 0
  done
}

owned_target() {
  case $1 in
    myshape/?* | fm-board/?* | dispatch-plan/?*) return 0 ;;
    bin/?*)
      case ${1#bin/} in
        */*) return 1 ;;
      esac
      return 0
      ;;
  esac
  return 1
}

# The fork's own git, in the caller's environment, never taking optional locks.
fork_git() {
  GIT_OPTIONAL_LOCKS=0 git -C "$TOP" --literal-pathspecs "$@" < /dev/null 2> "$SCRATCH/git.err"
}

# The fetch side's git: the fixed environment and settings of the header, run
# in the scratch directory.
fetch_git() {
  /usr/bin/env -i "${FETCH_ENV[@]}" "$GIT_BIN" -C "$SCRATCH" -c protocol.allow=never \
    -c "protocol.$PROTOCOL.allow=always" -c transfer.fsckObjects=true --literal-pathspecs \
    "$@" < /dev/null 2> "$SCRATCH/git.err"
}

src_git() {
  fetch_git --git-dir="$SCRATCH/src.git" "$@"
}

resolve_top() {
  local dir top
  dir=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) ||
    refuse "cannot resolve the directory of ${BASH_SOURCE[0]}"
  TOP=$(cd -P -- "$dir/.." && pwd -P) || refuse "cannot resolve the parent of $dir"
  top=$(fork_git rev-parse --show-toplevel) || git_failed "$TOP is not a git checkout"
  top=$(cd -P -- "$top" && pwd -P) || refuse "cannot resolve the toplevel $top"
  [ "$top" = "$TOP" ] && [ "$dir" = "$TOP/bin" ] ||
    refuse "this script runs only as <toplevel>/bin/fm-board-vendor.sh of a fork; it is in $dir"
}

set_fetch_env() {
  local name value
  FETCH_ENV=("PATH=$FETCH_PATH" "HOME=$SCRATCH" LC_ALL=C GIT_CONFIG_GLOBAL=/dev/null
    GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0)
  for name in $PASSED_NAMES; do
    if value=$(printenv "$name"); then
      FETCH_ENV+=("$name=$value")
    fi
  done
}

check_git_version() {
  local dir version major rest minor
  for dir in /usr/bin /bin; do
    if [ -x "$dir/git" ]; then
      GIT_BIN=$dir/git
      break
    fi
  done
  [ -n "$GIT_BIN" ] || refuse "no git in $FETCH_PATH; the fetch runs git from that fixed PATH only"
  version=$(fetch_git version) || git_failed "$GIT_BIN version failed"
  version=${version#git version }
  major=${version%%.*}
  rest=${version#*.}
  minor=${rest%%.*}
  case "$major.$minor" in
    .* | *. | *[!0-9.]*) refuse "cannot read the version of $GIT_BIN from '$version'" ;;
  esac
  if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 32 ]; }; then
    refuse "$GIT_BIN is git $version; keeping the user's git config out needs 2.32 or newer"
  fi
}

# read_lock: set LOCKED from myshape.lock; return 1 when there is no lock and
# refuse a lock that is not exactly the two lines of the header.
read_lock() {
  local file=$TOP/$LOCK content rest commit
  if [ ! -e "$file" ] && [ ! -L "$file" ]; then
    return 1
  fi
  [ -f "$file" ] && [ ! -L "$file" ] || refuse "$LOCK is not a regular file"
  content=$(cat -- "$file" && printf x) || refuse "cannot read $LOCK"
  content=${content%x}
  case $content in
    "repository $REPOSITORY"$'\n'*) ;;
    *) refuse "$LOCK: the first line must be 'repository $REPOSITORY'" ;;
  esac
  rest=${content#"repository $REPOSITORY"$'\n'}
  commit=${rest#commit }
  commit=${commit%$'\n'}
  if [ "$rest" != "commit $commit"$'\n' ] || ! is_commit_id "$commit"; then
    refuse "$LOCK: the second and last line must be 'commit <40 lowercase hex>'"
  fi
  LOCKED=$commit
}

fetch_main() {
  fetch_git init -q --bare --initial-branch=fetched "$SCRATCH/src.git" ||
    git_failed "cannot create the scratch repository"
  src_git fetch --no-tags --quiet "$FETCH_URL" refs/heads/main:refs/heads/main ||
    git_failed "fetch of main from $FETCH_URL failed"
}

# require_on_main <commit>: refuse unless <commit> is on main's first-parent chain.
require_on_main() {
  local commit=$1
  src_git cat-file -e "$commit^{commit}" || refuse "$commit is not a commit on main of $FETCH_URL"
  src_git rev-list --first-parent refs/heads/main > "$SCRATCH/first-parent" ||
    git_failed "cannot list main's first-parent chain"
  grep -Fxq -- "$commit" "$SCRATCH/first-parent" && return 0
  refuse "$commit is not on the first-parent chain of main at $FETCH_URL (a merge commit is)"
}

# expand_line <commit> <list> <line> <source> <raw-out>: append each file
# <source> holds at <commit> to <raw-out> as "<target> <mode> <blob>".
expand_line() {
  local commit=$1 list=$2 line=$3 src=$4 raw=$5 tree=$SCRATCH/tree.z rec meta path
  local mode rest type obj target found=0
  src_git ls-tree -r -z "$commit" -- "$src" > "$tree" || git_failed "cannot list $src at $commit"
  while IFS= read -r -d '' rec; do
    meta=${rec%%$'\t'*}
    path=${rec#*$'\t'}
    case $path in
      "$src" | "$src"/*) ;;
      *) continue ;;
    esac
    found=1
    mode=${meta%% *}
    rest=${meta#* }
    type=${rest%% *}
    obj=${rest#* }
    [ "$type" = blob ] || refuse "$path at $commit is a $type, not a regular file"
    case $mode in
      100644 | 100755) ;;
      120000) refuse "$path at $commit is a symlink; only regular files are vendored" ;;
      *) refuse "$path at $commit has mode $mode; only 100644 and 100755 are vendored" ;;
    esac
    target=${path#"$ADAPTER_PREFIX"}
    [ "$list" = "$ADAPTER_LIST" ] || target=$path
    path_problem "$target"
    [ -z "$PROBLEM" ] || refuse "$path at $commit $PROBLEM"
    owned_target "$target" ||
      refuse "$list at $commit: '$line' maps to $target, outside the areas this script owns"
    printf '%s %s %s\n' "$target" "$mode" "$obj" >> "$raw"
  done < "$tree"
  [ "$found" -eq 1 ] || refuse "$list at $commit: '$line' names nothing at that commit"
}

# expand_list <commit> <list> <source-prefix> <raw-out>
expand_list() {
  local commit=$1 list=$2 prefix=$3 raw=$4 text=$SCRATCH/list.txt line shown
  src_git cat-file blob "$commit:$list" > "$text" || git_failed "$list is missing at $commit"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    path_problem "$line"
    if [ -n "$PROBLEM" ]; then
      shown=$(printf '%q' "$line")
      refuse "$list at $commit: line $shown $PROBLEM"
    fi
    expand_line "$commit" "$list" "$line" "$prefix$line" "$raw"
  done < "$text"
}

# expected_set <commit> <out>: the files both lists name at <commit>, as sorted
# "<target> <mode> <blob>" lines.
expected_set() {
  local commit=$1 out=$2 raw=$SCRATCH/expected.raw clash
  : > "$raw"
  expand_list "$commit" "$BOARD_LIST" '' "$raw"
  expand_list "$commit" "$ADAPTER_LIST" "$ADAPTER_PREFIX" "$raw"
  [ -s "$raw" ] || refuse "the lists at $commit name no file"
  sort "$raw" > "$out"
  clash=$(awk 'seen[$1]++ { print $1; exit }' "$out")
  [ -z "$clash" ] || refuse "the lists at $commit name $clash more than once"
  clash=$(awk '{ seen[$1] = 1 }
    END {
      for (p in seen) {
        n = split(p, part, "/"); dir = part[1]
        for (i = 1; i < n; i++) { if (dir in seen) { print dir; exit } dir = dir "/" part[i + 1] }
      }
    }' "$out")
  [ -z "$clash" ] || refuse "the lists at $commit name $clash both as a file and as a directory"
}

# bin_targets <set-file> <out>: the bin/ targets of a set, one per line.
bin_targets() {
  awk '$1 ~ /^bin\// { print $1 }' "$1" > "$2"
}

# current_set <out> <bin targets...>: HEAD's entries in the owned areas as
# sorted "<path> <mode> <object>" lines; a tracked path this script could not
# write goes to $SCRATCH/current.bad instead, shown with printf %q.
current_set() {
  local out=$1 tree=$SCRATCH/current.z rec meta path mode rest obj
  shift
  : > "$SCRATCH/current.bad"
  fork_git rev-parse -q --verify "HEAD^{commit}" > /dev/null ||
    refuse "this checkout has no commit yet"
  fork_git ls-tree -r -z HEAD -- "${WHOLE_AREAS[@]}" "$@" > "$tree" || git_failed "cannot list HEAD"
  while IFS= read -r -d '' rec; do
    meta=${rec%%$'\t'*}
    path=${rec#*$'\t'}
    mode=${meta%% *}
    rest=${meta#* }
    obj=${rest#* }
    path_problem "$path"
    if [ -n "$PROBLEM" ]; then
      printf '%q %s\n' "$path" "$PROBLEM" >> "$SCRATCH/current.bad"
      continue
    fi
    printf '%s %s %s\n' "$path" "$mode" "$obj"
  done < "$tree" | sort > "$out"
}

# compare_sets <want> <have>: one "<kind> <path> [<have-mode> <want-mode>]" line
# per difference: missing, extra, bytes, mode.
compare_sets() {
  awk 'FILENAME == ARGV[1] { mode[$1] = $2; obj[$1] = $3; next }
    { have[$1] = 1
      if (!($1 in mode)) { print "extra", $1; next }
      if ($3 != obj[$1]) print "bytes", $1
      if ($2 != mode[$1]) print "mode", $1, $2, mode[$1] }
    END { for (p in mode) if (!(p in have)) print "missing", p }' "$1" "$2" | sort -k 2
}

# report_differences <want> <have> <label>: print each difference; return 1 if any.
report_differences() {
  local kind path have want found=0
  while read -r kind path have want; do
    found=1
    case $kind in
      missing) emit_not_ok "$path: missing (listed at $3)" ;;
      extra) emit_not_ok "$path: not listed at $3 (a leftover, or a file nobody lists)" ;;
      bytes) emit_not_ok "$path: bytes differ from $3" ;;
      mode) emit_not_ok "$path: mode $have, expected $want" ;;
    esac
  done < <(compare_sets "$1" "$2")
  [ "$found" -eq 0 ]
}

# dirty_lines <bin targets...>: git status lines for the owned areas, into
# $SCRATCH/status.
dirty_lines() {
  fork_git status --porcelain --untracked-files=all -- "${WHOLE_AREAS[@]}" "$LOCK" "$@" \
    > "$SCRATCH/status" || git_failed "git status failed"
}

source_label() {  # <commit>
  if [ -n "$SOURCE_DIR" ]; then
    printf '%s@%s' "$SOURCE_DIR" "$1"
  else
    printf '%s@%s (on main)' "${REPOSITORY#https://github.com/}" "$1"
  fi
}

# safe_parent <target>: refuse unless every directory from the toplevel down
# to <target> that exists is a real directory, and the deepest one resolves
# (pwd -P) to the same place inside the toplevel.
safe_parent() {
  local rest at=$TOP part deepest=$TOP
  case $1 in
    */*) rest=${1%/*}/ ;;
    *) return 0 ;;
  esac
  while [ -n "$rest" ]; do
    part=${rest%%/*}
    rest=${rest#*/}
    at=$at/$part
    [ ! -L "$at" ] || refuse "${at#"$TOP"/} is a symlink; nothing is written through one"
    [ -e "$at" ] || break
    [ -d "$at" ] || refuse "${at#"$TOP"/} is not a directory"
    deepest=$at
  done
  [ "$(cd -P -- "$deepest" && pwd -P)" = "$deepest" ] ||
    refuse "${deepest#"$TOP"/} does not resolve to itself inside $TOP"
}

# guard_fork_bin <new-set> <current-set> <old-bin-file or ''>: refuse to take
# over a tracked bin/ file the fork owns.
guard_fork_bin() {
  local target mode obj have
  while read -r target mode obj; do
    have=$(awk -v p="$target" '$1 == p { print $3 }' "$2")
    [ -n "$have" ] || continue
    if [ -n "$3" ]; then
      grep -Fxq -- "$target" "$3" ||
        refuse "$target is the fork's own file: tracked, and not vendored by the locked $LOCKED"
    elif [ "$have" != "$obj" ]; then
      refuse "$target is tracked here with other bytes; with no lock, only identical ones are taken"
    fi
  done < <(awk '$1 ~ /^bin\//' "$1")
}

write_file() {  # <target> <mode> <blob>
  local dir=${1%/*}
  mkdir -p -- "$TOP/$dir" || refuse "cannot create $dir (files may be partly written)"
  [ "$(cd -P -- "$TOP/$dir" && pwd -P)" = "$TOP/$dir" ] ||
    refuse "$dir moved during the run (some files may already be written; see git status)"
  PENDING_TMP=$(mktemp "$TOP/$dir/.fm-board-vendor.XXXXXX") ||
    refuse "cannot create a temporary file in $dir"
  src_git cat-file blob "$3" > "$PENDING_TMP" || git_failed "cannot read $1 from the scratch copy"
  chmod "${2#100}" "$PENDING_TMP"
  mv -f -- "$PENDING_TMP" "$TOP/$1"
  PENDING_TMP=''
}

write_lock() {  # <commit>
  PENDING_TMP=$(mktemp "$TOP/.fm-board-vendor.XXXXXX") ||
    refuse "cannot create a temporary file in $TOP"
  printf 'repository %s\ncommit %s\n' "$REPOSITORY" "$1" > "$PENDING_TMP"
  chmod 644 "$PENDING_TMP"
  mv -f -- "$PENDING_TMP" "$TOP/$LOCK"
  PENDING_TMP=''
}

# plan_vendor <new> <current> <old-bin or ''>: write $SCRATCH/write (entries to
# write) and $SCRATCH/delete (tracked paths to delete), then check every path.
plan_vendor() {
  local new=$1 current=$2 old_bin=$3 target mode obj
  awk 'FILENAME == ARGV[1] { have[$1] = $2 " " $3; next }
    have[$1] != $2 " " $3' "$current" "$new" > "$SCRATCH/write"
  awk 'FILENAME == ARGV[1] { want[$1] = 1; next }
    $1 !~ /^bin\// && !($1 in want) { print $1 }' "$new" "$current" > "$SCRATCH/delete"
  if [ -n "$old_bin" ]; then
    awk 'FILENAME == ARGV[1] { want[$1] = 1; next }
      FILENAME == ARGV[2] { tracked[$1] = 1; next }
      !($1 in want) && ($1 in tracked) { print $1 }' \
      "$new" "$current" "$old_bin" >> "$SCRATCH/delete"
  fi
  while read -r target mode obj; do
    safe_parent "$target"
    if [ -L "$TOP/$target" ] || [ -d "$TOP/$target" ]; then
      refuse "$target is a symlink or a directory here; vendor writes only regular files"
    fi
  done < "$SCRATCH/write"
  while read -r target; do
    safe_parent "$target"
  done < "$SCRATCH/delete"
}

# verify_index <new> <label>: the index must now hold exactly the new set.
verify_index() {
  local rec meta path rest
  fork_git ls-files -s -z -- "${WHOLE_AREAS[@]}" ${NEW_BIN[@]+"${NEW_BIN[@]}"} \
    > "$SCRATCH/index.z" ||
    git_failed "cannot list the index"
  while IFS= read -r -d '' rec; do
    meta=${rec%%$'\t'*}
    path=${rec#*$'\t'}
    rest=${meta#* }
    printf '%s %s %s\n' "$path" "${meta%% *}" "${rest%% *}"
  done < "$SCRATCH/index.z" | sort > "$SCRATCH/index"
  report_differences "$1" "$SCRATCH/index" "$2" ||
    refuse "the staged files differ from $2 (see the lines above and git status)"
}

apply_vendor() {  # <commit> <label>
  local target mode obj written=() wrote=0 deleted=0 count
  while read -r target mode obj; do
    write_file "$target" "$mode" "$obj"
    written+=("$target")
    wrote=$((wrote + 1))
  done < "$SCRATCH/write"
  while read -r target; do
    fork_git rm -q -- "$target" || git_failed "cannot delete $target"
    deleted=$((deleted + 1))
  done < "$SCRATCH/delete"
  write_lock "$1"
  # -f: a listed file is vendored even where the fork's .gitignore matches it.
  fork_git add -f -- "$LOCK" ${written[@]+"${written[@]}"} || git_failed "git add failed"
  verify_index "$SCRATCH/new" "$2"
  count=$(wc -l < "$SCRATCH/new" | tr -d ' ')
  emit_ok "$count files from $2: $wrote written, $deleted deleted, $LOCK staged"
}

do_vendor() {  # <commit>
  local commit=$1 branch old_bin='' label line
  branch=$(fork_git symbolic-ref -q --short HEAD) ||
    refuse "HEAD is detached; vendor writes only on a branch named with '$SYNC_BRANCH_WORD'"
  case $branch in
    *"$SYNC_BRANCH_WORD"*) ;;
    *) refuse "'$branch' is not a sync branch: its name lacks '$SYNC_BRANCH_WORD'" ;;
  esac
  read_lock || LOCKED=''
  fetch_main
  require_on_main "$commit"
  label=$(source_label "$commit")
  expected_set "$commit" "$SCRATCH/new"
  bin_targets "$SCRATCH/new" "$SCRATCH/new.bin"
  while IFS= read -r line; do NEW_BIN+=("$line"); done < "$SCRATCH/new.bin"
  if [ -n "$LOCKED" ]; then
    src_git cat-file -e "$LOCKED^{commit}" ||
      refuse "the locked $LOCKED is not on main of $FETCH_URL; its bin/ files are unknown"
    expected_set "$LOCKED" "$SCRATCH/old"
    old_bin=$SCRATCH/old.bin
    bin_targets "$SCRATCH/old" "$old_bin"
    while IFS= read -r line; do OLD_BIN+=("$line"); done < "$old_bin"
  fi
  current_set "$SCRATCH/current" ${NEW_BIN[@]+"${NEW_BIN[@]}"} ${OLD_BIN[@]+"${OLD_BIN[@]}"}
  [ ! -s "$SCRATCH/current.bad" ] ||
    refuse "a tracked path here is not one this script writes: $(head -n 1 "$SCRATCH/current.bad")"
  dirty_lines ${NEW_BIN[@]+"${NEW_BIN[@]}"} ${OLD_BIN[@]+"${OLD_BIN[@]}"}
  [ ! -s "$SCRATCH/status" ] ||
    refuse "uncommitted or untracked change in the vendored areas: $(head -n 1 "$SCRATCH/status")"
  guard_fork_bin "$SCRATCH/new" "$SCRATCH/current" "$old_bin"
  plan_vendor "$SCRATCH/new" "$SCRATCH/current" "$old_bin"
  apply_vendor "$commit" "$label"
}

do_check() {
  local label line problems=0
  read_lock || refuse "no $LOCK at $TOP; nothing records which commit this fork vendors"
  fetch_main
  require_on_main "$LOCKED"
  label=$(source_label "$LOCKED")
  expected_set "$LOCKED" "$SCRATCH/new"
  bin_targets "$SCRATCH/new" "$SCRATCH/new.bin"
  while IFS= read -r line; do NEW_BIN+=("$line"); done < "$SCRATCH/new.bin"
  current_set "$SCRATCH/current" ${NEW_BIN[@]+"${NEW_BIN[@]}"}
  while IFS= read -r line; do
    emit_not_ok "tracked path not listed at $label and not one this script writes: $line"
    problems=1
  done < "$SCRATCH/current.bad"
  report_differences "$SCRATCH/new" "$SCRATCH/current" "$label" || problems=1
  dirty_lines ${NEW_BIN[@]+"${NEW_BIN[@]}"}
  while IFS= read -r line; do
    emit_not_ok "uncommitted or untracked: $line"
    problems=1
  done < "$SCRATCH/status"
  [ "$problems" -eq 0 ] || exit 1
  emit_ok "$(wc -l < "$SCRATCH/new" | tr -d ' ') files match $label"
}

main() {
  local mode commit=''
  if [ "${1:-}" = --source ]; then
    MARK=$TEST_MARK
    [ "$#" -ge 2 ] || usage_error "--source needs a directory"
    [ -d "$2" ] || usage_error "--source takes an existing local directory, not '$2'"
    SOURCE_DIR=$(cd -P -- "$2" && pwd -P) || usage_error "cannot resolve '$2'"
    FETCH_URL=$SOURCE_DIR
    PROTOCOL='file'
    shift 2
  fi
  case "${1:-}" in
    vendor)
      [ "$#" -eq 2 ] || usage_error "vendor takes one commit"
      is_commit_id "$2" || usage_error "vendor takes a 40-character lowercase commit id, not '$2'"
      mode=vendor
      commit=$2
      ;;
    --check)
      [ "$#" -eq 1 ] || usage_error "--check takes no argument"
      mode=check
      ;;
    -h | --help)
      [ "$#" -eq 1 ] && [ -z "$SOURCE_DIR" ] || usage_error "--help takes no argument"
      usage
      exit 0
      ;;
    *) usage_error "unknown or missing command '${1:-}'" ;;
  esac
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/fm-board-vendor.XXXXXX") ||
    refuse "cannot create a scratch directory"
  set_fetch_env
  resolve_top
  check_git_version
  if [ "$mode" = vendor ]; then
    do_vendor "$commit"
  else
    do_check
  fi
}

main "$@"
