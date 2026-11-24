#!/usr/bin/env bash
# stage-8-vendor.sh: bin/fm-board-vendor.sh, offline. Each case copies a small
# source repository and a small fork made here, and runs the fork's own copy of
# the script with --source: vendor and --check succeed on the listed set, every
# refusal leaves the fork exactly as it was, --check names each kind of
# difference, and every output line carries the test-source mark. It sends no
# signal and starts no server.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-board-vendor)
VENDOR="$ROOT/bin/fm-board-vendor.sh"
TMPL=$TMP_ROOT/template
MARK='(test source; provenance NOT checked)'
LOCK_REPO='repository https://github.com/guybeju/myshape'
CASE=''
SRC=''
FORK=''
OUT=''
CODE=0
SRC_HEAD=''

g() {
  git -c user.name='Firstmate Tests' -c user.email='tests@example.invalid' "$@"
}

put() {  # <file> <content> [<mode>]
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" > "$1"
  chmod "${3:-644}" "$1"
}

commit_all() {  # <repo> <message>
  if ! g -C "$1" add -A || ! g -C "$1" commit -qm "$2"; then
    fail "cannot commit in $1: $2"
  fi
}

# The source: one commit on main, then a pull request of two commits merged
# with --no-ff, so its first commit is in main's history but off the
# first-parent chain. The fork: its own files, a bin/fm-board.sh with the
# source's bytes, and the placed script committed alone, as a first sync starts.
make_templates() {
  local src=$TMPL/src fork=$TMPL/fork
  mkdir -p "$src" "$fork"
  g init -q -b main "$src" || fail "git init of the template source failed"
  put "$src/myshape/vendor-files" "$(printf '%s\n' bin/myshape.sh myshape/dist '' \
    myshape/vendor-files myshape/test/kit)"
  put "$src/adapters/firstmate/fm-board/vendor-files" "$(printf '%s\n' bin/fm-board.sh \
    bin/fm-board-vendor.sh fm-board dispatch-plan)"
  put "$src/bin/myshape.sh" 'board' 755
  put "$src/myshape/dist/a.js" 'a'
  put "$src/myshape/dist/page/b.js" 'b'
  put "$src/myshape/test/kit/helpers.sh" 'kit'
  put "$src/myshape/src/x.ts" 'source'
  put "$src/README.md" 'readme'
  put "$src/adapters/firstmate/bin/fm-board.sh" 'adapter' 755
  put "$src/adapters/firstmate/bin/fm-other.sh" 'other' 755
  put "$src/adapters/firstmate/fm-board/test/a.sh" 'test'
  put "$src/adapters/firstmate/dispatch-plan/spec/p.markdown" 'plan'
  mkdir -p "$src/adapters/firstmate/bin"
  cp "$VENDOR" "$src/adapters/firstmate/bin/fm-board-vendor.sh"
  chmod 755 "$src/adapters/firstmate/bin/fm-board-vendor.sh"
  commit_all "$src" first
  g -C "$src" checkout -q -b pr
  put "$src/myshape/dist/a.js" 'a, first pull request commit'
  commit_all "$src" 'pull request, part 1'
  SRC_P1=$(git -C "$src" rev-parse HEAD)
  put "$src/myshape/dist/a.js" 'a, merged'
  commit_all "$src" 'pull request, part 2'
  g -C "$src" checkout -q main
  g -C "$src" merge -q --no-ff -m 'Merge pull request' pr || fail "template merge failed"
  SRC_M=$(git -C "$src" rev-parse HEAD)
  g -C "$src" checkout -q -b unmerged
  put "$src/myshape/dist/a.js" 'a, never merged'
  commit_all "$src" 'not on main'
  SRC_OFF=$(git -C "$src" rev-parse HEAD)
  g -C "$src" checkout -q main

  g init -q -b board-sync-test "$fork" || fail "git init of the template fork failed"
  put "$fork/README.md" 'fork'
  put "$fork/bin/fm-own.sh" 'own' 755
  put "$fork/bin/fm-board.sh" 'adapter' 755
  put "$fork/tests/own.sh" 'own test'
  commit_all "$fork" 'fork'
  cp "$VENDOR" "$fork/bin/fm-board-vendor.sh"
  chmod 755 "$fork/bin/fm-board-vendor.sh"
  commit_all "$fork" 'Place bin/fm-board-vendor.sh'
}

new_case() {  # <name>
  CASE=$TMP_ROOT/$1
  mkdir -p "$CASE/tmp"
  if ! cp -Rp "$TMPL/src" "$CASE/src" || ! cp -Rp "$TMPL/fork" "$CASE/fork"; then
    fail "$1: cannot copy the templates"
  fi
  SRC=$CASE/src
  FORK=$CASE/fork
}

# run_vendor <args...>: the fork's script with --source; sets OUT and CODE, and
# checks the mark on every line and that the scratch directory is gone.
run_vendor() {
  local line
  CODE=0
  OUT=$(TMPDIR="$CASE/tmp" "$FORK/bin/fm-board-vendor.sh" --source "$SRC" "$@" 2>&1) || CODE=$?
  [ -n "$OUT" ] || fail "fm-board-vendor.sh $* printed nothing"
  while IFS= read -r line; do
    assert_contains "$line" "$MARK" "every line of a --source run must carry the mark"
  done <<< "$OUT"
  [ -z "$(ls -A "$CASE/tmp")" ] || fail "fm-board-vendor.sh $* left its scratch directory behind"
}

# snapshot: everything about the fork that a write could change.
snapshot() {
  git -C "$FORK" symbolic-ref -q HEAD || echo detached
  git -C "$FORK" rev-parse HEAD
  git -C "$FORK" ls-files -s
  git -C "$FORK" status --porcelain --untracked-files=all --ignored
  (cd "$FORK" && find . -path ./.git -prune -o -type f -exec cksum {} + | LC_ALL=C sort)
  (cd "$FORK" && find . -path ./.git -prune -o ! -type f -print | LC_ALL=C sort)
  (cd "$FORK" && find . -path ./.git -prune -o -type f -perm -u+x -print | LC_ALL=C sort)
}

# expect_refused <label> <needle> <args...>: exit 1, <needle> in the output,
# and the fork unchanged.
expect_refused() {
  local label=$1 needle=$2 before after
  shift 2
  before=$(snapshot)
  run_vendor "$@"
  expect_code 1 "$CODE" "$label"
  assert_contains "$OUT" "$needle" "$label: the refusal must say why"
  assert_contains "$OUT" "not ok - " "$label: a refusal is a not ok line"
  after=$(snapshot)
  assert_equals "$before" "$after" "$label: a refusal must write nothing"
}

# expect_check_fails <label> <needle>: --check exits 1, names <needle>, writes nothing.
expect_check_fails() {
  expect_refused "$1" "$2" --check
}

# synced_case <name>: a case whose fork has vendored $SRC_M and committed it.
synced_case() {
  new_case "$1"
  run_vendor vendor "$SRC_M"
  expect_code 0 "$CODE" "$1: the first sync"
  commit_all "$FORK" "Vendor $SRC_M"
}

src_list() {  # <board list lines> <adapter list lines>: rewrite both lists and commit on main
  put "$SRC/myshape/vendor-files" "$1"
  put "$SRC/adapters/firstmate/fm-board/vendor-files" "$2"
  commit_all "$SRC" 'Change the lists'
  SRC_HEAD=$(git -C "$SRC" rev-parse HEAD)
}

BOARD_LINES=$(printf '%s\n' bin/myshape.sh myshape/dist '' myshape/vendor-files myshape/test/kit)
ADAPTER_LINES=$(printf '%s\n' bin/fm-board.sh bin/fm-board-vendor.sh fm-board dispatch-plan)

test_vendor_then_check() {
  local before
  new_case success
  run_vendor vendor "$SRC_M"
  expect_code 0 "$CODE" "vendor on a sync branch"
  assert_contains "$OUT" "ok - 10 files from $SRC@$SRC_M" "vendor must report the files it vendored"
  assert_equals "$LOCK_REPO"$'\n'"commit $SRC_M" "$(cat "$FORK/myshape.lock")" \
    "the lock's two lines"
  assert_equals "$(printf '%s\n' bin/fm-board-vendor.sh bin/fm-board.sh bin/myshape.sh \
    dispatch-plan/spec/p.markdown fm-board/test/a.sh fm-board/vendor-files myshape/dist/a.js \
    myshape/dist/page/b.js myshape/test/kit/helpers.sh myshape/vendor-files)" \
    "$(git -C "$FORK" ls-files -- bin/fm-board-vendor.sh bin/fm-board.sh bin/myshape.sh \
      dispatch-plan fm-board myshape)" "the fork must hold exactly the listed files"
  assert_equals 'a, merged' "$(cat "$FORK/myshape/dist/a.js")" "the bytes are the merge commit's"
  assert_contains "$(git -C "$FORK" ls-files -s bin/myshape.sh)" 100755 "an executable keeps 755"
  assert_equals "$(printf '%s\n' 'A  bin/myshape.sh' 'A  dispatch-plan/spec/p.markdown' \
    'A  fm-board/test/a.sh' 'A  fm-board/vendor-files' 'A  myshape.lock' 'A  myshape/dist/a.js' \
    'A  myshape/dist/page/b.js' 'A  myshape/test/kit/helpers.sh' 'A  myshape/vendor-files')" \
    "$(git -C "$FORK" status --porcelain --untracked-files=all)" \
    "vendor must stage exactly what it wrote"
  assert_equals own "$(cat "$FORK/bin/fm-own.sh")" "a fork-owned bin/ file stays"
  commit_all "$FORK" "Vendor $SRC_M"
  before=$(snapshot)
  run_vendor --check
  expect_code 0 "$CODE" "--check after the sync"
  assert_equals "ok - 10 files match $SRC@$SRC_M $MARK" "$OUT" "--check's one line"
  assert_equals "$before" "$(snapshot)" "--check must write nothing"
  pass "vendor writes and stages the listed set and the lock, and --check then matches"
}

test_next_sync_deletes_and_rewrites_itself() {
  synced_case next-sync
  g -C "$SRC" checkout -q -b pr2
  g -C "$SRC" rm -q myshape/dist/page/b.js
  put "$SRC/adapters/firstmate/fm-board/vendor-files" "$(printf '%s\n' bin/fm-board-vendor.sh \
    fm-board dispatch-plan)"
  chmod 755 "$SRC/myshape/dist/a.js"
  printf '# a later version\n' >> "$SRC/adapters/firstmate/bin/fm-board-vendor.sh"
  commit_all "$SRC" 'Drop two files'
  g -C "$SRC" checkout -q main
  g -C "$SRC" merge -q --no-ff -m 'Merge pull request 2' pr2 || fail "merge of pr2 failed"
  SRC_HEAD=$(git -C "$SRC" rev-parse HEAD)
  run_vendor vendor "$SRC_HEAD"
  expect_code 0 "$CODE" "the next sync"
  assert_contains "$OUT" "3 written, 2 deleted" "the next sync writes changes, deletes drops"
  assert_absent "$FORK/myshape/dist/page/b.js" "a file the commit no longer has is deleted"
  assert_absent "$FORK/bin/fm-board.sh" "a bin/ file the new lists drop is deleted"
  assert_equals own "$(cat "$FORK/bin/fm-own.sh")" "a fork-owned bin/ file stays"
  assert_equals "$(git -C "$SRC" rev-parse "$SRC_HEAD:adapters/firstmate/bin/fm-board-vendor.sh")" \
    "$(git -C "$FORK" rev-parse :bin/fm-board-vendor.sh)" \
    "the running script is replaced by the new one"
  commit_all "$FORK" "Vendor $SRC_HEAD"
  run_vendor --check
  expect_code 0 "$CODE" "--check after the next sync"
  assert_contains "$OUT" "ok - 8 files match $SRC@$SRC_HEAD" "--check must match the next sync"
  pass "the next sync deletes what the commit dropped, keeps fork files and replaces itself"
}

test_refuses_where_it_must_not_write() {
  new_case detached
  g -C "$FORK" checkout -q --detach
  expect_refused "a detached HEAD" "HEAD is detached" vendor "$SRC_M"
  new_case on-main
  g -C "$FORK" checkout -q -b main
  expect_refused "the branch main" "'main' is not a sync branch" vendor "$SRC_M"
  new_case on-carry
  g -C "$FORK" checkout -q -b carry
  expect_refused "the branch carry" "'carry' is not a sync branch" vendor "$SRC_M"
  pass "vendor writes only on a branch whose name contains board-sync"
}

test_refuses_a_dirty_owned_area() {
  synced_case dirty-tracked
  put "$FORK/myshape/dist/a.js" 'edited by hand'
  expect_refused "an edited vendored file" "uncommitted or untracked change" vendor "$SRC_M"
  synced_case dirty-untracked
  put "$FORK/fm-board/stray.sh" 'stray'
  expect_refused "an untracked file in fm-board/" "?? fm-board/stray.sh" vendor "$SRC_M"
  synced_case dirty-lock
  printf '\n' >> "$FORK/myshape.lock"
  expect_refused "an edited lock" "myshape.lock" vendor "$SRC_M"
  new_case untracked-bin
  put "$FORK/bin/myshape.sh" 'untracked' 755
  expect_refused "an untracked listed bin/ file" "?? bin/myshape.sh" vendor "$SRC_M"
  pass "vendor refuses any uncommitted or untracked change in the areas it owns"
}

test_refuses_bad_list_lines() {
  new_case list-absolute
  src_list "/bin/myshape.sh" "$ADAPTER_LINES"
  expect_refused "an absolute line" "is absolute" vendor "$SRC_HEAD"
  new_case list-dotdot
  src_list "$BOARD_LINES" "fm-board/../README.md"
  expect_refused "a '..' line" "contains a '..' part" vendor "$SRC_HEAD"
  new_case list-dotgit
  src_list "myshape/.git/config" "$ADAPTER_LINES"
  expect_refused "a .git line" "contains a .git part" vendor "$SRC_HEAD"
  new_case list-space
  src_list "$(printf '%s\n' "$BOARD_LINES" 'myshape/a b')" "$ADAPTER_LINES"
  expect_refused "a line with a space" "contains whitespace" vendor "$SRC_HEAD"
  new_case list-nothing
  src_list "$(printf '%s\n' "$BOARD_LINES" myshape/no-such-file)" "$ADAPTER_LINES"
  expect_refused "a line naming nothing" "'myshape/no-such-file' names nothing" vendor "$SRC_HEAD"
  new_case list-missing
  g -C "$SRC" rm -q adapters/firstmate/fm-board/vendor-files
  commit_all "$SRC" 'Remove the adapter list'
  expect_refused "a missing list" "adapters/firstmate/fm-board/vendor-files is missing" \
    vendor "$(git -C "$SRC" rev-parse HEAD)"
  pass "vendor refuses absolute, '..', .git, whitespace and empty lines, and a missing list"
}

test_refuses_entries_that_are_not_files() {
  local sub
  new_case entry-symlink
  ln -s a.js "$SRC/myshape/dist/link.js"
  commit_all "$SRC" 'Add a symlink'
  expect_refused "a symlink entry" "myshape/dist/link.js at" \
    vendor "$(git -C "$SRC" rev-parse HEAD)"
  assert_contains "$OUT" "is a symlink" "a symlink entry must be named as one"
  new_case entry-gitlink
  sub=$(git -C "$SRC" rev-parse HEAD)
  g -C "$SRC" update-index --add --cacheinfo "160000,$sub,myshape/dist/module" ||
    fail "cannot stage a gitlink"
  g -C "$SRC" commit -qm 'Add a gitlink' || fail "cannot commit a gitlink"
  expect_refused "a gitlink entry" "myshape/dist/module at" vendor "$(git -C "$SRC" rev-parse HEAD)"
  assert_contains "$OUT" "is a commit, not a regular file" "a gitlink must be named as one"
  pass "vendor refuses symlinks and submodules in the listed set"
}

test_refuses_clashing_or_foreign_targets() {
  new_case duplicate
  src_list "$(printf '%s\n' "$BOARD_LINES" myshape/dist/a.js)" "$ADAPTER_LINES"
  expect_refused "two lines naming one file" "name myshape/dist/a.js more than once" \
    vendor "$SRC_HEAD"
  new_case outside
  src_list "$(printf '%s\n' "$BOARD_LINES" README.md)" "$ADAPTER_LINES"
  expect_refused "a board line outside the owned areas" "maps to README.md, outside the areas" \
    vendor "$SRC_HEAD"
  new_case outside-adapter
  put "$SRC/adapters/firstmate/tests/x.sh" 'x'
  src_list "$BOARD_LINES" "$(printf '%s\n' "$ADAPTER_LINES" tests/x.sh)"
  expect_refused "an adapter line outside the owned areas" "maps to tests/x.sh, outside the areas" \
    vendor "$SRC_HEAD"
  new_case bin-subdirectory
  put "$SRC/adapters/firstmate/bin/sub/x.sh" 'x'
  src_list "$BOARD_LINES" "$(printf '%s\n' "$ADAPTER_LINES" bin/sub)"
  expect_refused "a directory under bin/" "maps to bin/sub/x.sh, outside the areas" \
    vendor "$SRC_HEAD"
  pass "vendor refuses duplicate targets and targets outside the areas it owns"
}

test_refuses_to_take_over_fork_files() {
  new_case first-sync-other-bytes
  put "$FORK/bin/fm-board.sh" 'the fork changed this' 755
  commit_all "$FORK" 'Change bin/fm-board.sh'
  expect_refused "a first sync over other bytes" "bin/fm-board.sh is tracked here with other" \
    vendor "$SRC_M"
  synced_case fork-owned-bin
  put "$SRC/adapters/firstmate/bin/fm-own.sh" 'the adapter wants this name' 755
  src_list "$BOARD_LINES" "$(printf '%s\n' "$ADAPTER_LINES" bin/fm-own.sh)"
  expect_refused "a fork-owned bin/ file" "bin/fm-own.sh is the fork's own file" vendor "$SRC_HEAD"
  pass "vendor never overwrites a bin/ file the fork owns"
}

test_refuses_writing_through_symlinks() {
  new_case symlink-outside
  mkdir -p "$CASE/outside"
  ln -s "$CASE/outside" "$FORK/fm-board"
  commit_all "$FORK" 'fm-board is a symlink out of the checkout'
  expect_refused "a directory symlink out of the checkout" "fm-board is a symlink" vendor "$SRC_M"
  [ -z "$(ls -A "$CASE/outside")" ] || fail "nothing may be written through the symlink"
  new_case symlink-inside
  mkdir -p "$FORK/docs"
  put "$FORK/docs/keep.markdown" 'keep'
  ln -s docs "$FORK/dispatch-plan"
  commit_all "$FORK" 'dispatch-plan is a symlink inside the checkout'
  expect_refused "a directory symlink inside the checkout" "dispatch-plan is a symlink" \
    vendor "$SRC_M"
  new_case symlink-target
  mkdir -p "$FORK/myshape"
  ln -s ../README.md "$FORK/myshape/vendor-files"
  commit_all "$FORK" 'A listed file is a symlink here'
  expect_refused "a target that is a symlink" "myshape/vendor-files is a symlink or a directory" \
    vendor "$SRC_M"
  pass "vendor writes through no symlink between the toplevel and a target"
}

test_refuses_commits_off_the_first_parent_chain() {
  new_case pull-request-commit
  expect_refused "a commit inside a merged pull request" "not on the first-parent chain" \
    vendor "$SRC_P1"
  new_case unmerged-commit
  expect_refused "a commit on no branch of main" "is not a commit on main" vendor "$SRC_OFF"
  synced_case check-pull-request-commit
  printf '%s\ncommit %s\n' "$LOCK_REPO" "$SRC_P1" > "$FORK/myshape.lock"
  commit_all "$FORK" 'Lock a pull request commit'
  expect_check_fails "--check of a locked pull request commit" "not on the first-parent chain"
  pass "only a commit on main's first-parent chain is vendored or checked"
}

test_refuses_bad_lock_lines() {
  local label content
  while IFS='|' read -r label content; do
    synced_case "lock-$label"
    printf '%b' "$content" > "$FORK/myshape.lock"
    commit_all "$FORK" "A $label lock"
    expect_refused "vendor with a $label lock" "myshape.lock: the" vendor "$SRC_M"
    expect_check_fails "--check with a $label lock" "myshape.lock: the"
  done <<EOF
uppercase|$LOCK_REPO\ncommit $(printf '%s' "$SRC_M" | tr 'a-f' 'A-F')\n
short|$LOCK_REPO\ncommit ${SRC_M:0:12}\n
third-line|$LOCK_REPO\ncommit $SRC_M\nnote\n
other-repository|repository https://github.com/someone/myshape\ncommit $SRC_M\n
unterminated|$LOCK_REPO\ncommit $SRC_M
EOF
  new_case no-lock
  expect_check_fails "--check with no lock" "no myshape.lock"
  pass "a lock that is not exactly the two lines is refused by vendor and --check"
}

test_check_names_each_difference() {
  synced_case check-bytes
  put "$FORK/fm-board/test/a.sh" 'edited and committed'
  commit_all "$FORK" 'Edit a vendored file'
  expect_check_fails "--check of changed bytes" \
    "not ok - fm-board/test/a.sh: bytes differ from $SRC@$SRC_M"
  synced_case check-mode
  chmod 644 "$FORK/bin/myshape.sh"
  commit_all "$FORK" 'Change a mode'
  expect_check_fails "--check of a changed mode" \
    "not ok - bin/myshape.sh: mode 100644, expected 100755"
  synced_case check-missing
  g -C "$FORK" rm -q dispatch-plan/spec/p.markdown
  commit_all "$FORK" 'Delete a vendored file'
  expect_check_fails "--check of a missing file" "not ok - dispatch-plan/spec/p.markdown: missing"
  synced_case check-extra
  put "$FORK/myshape/src/x.ts" 'a file nobody lists'
  commit_all "$FORK" 'Add an unlisted file'
  expect_check_fails "--check of an unlisted file" "not ok - myshape/src/x.ts: not listed"
  synced_case check-uncommitted
  put "$FORK/myshape/dist/a.js" 'not committed'
  expect_check_fails "--check of an uncommitted edit" \
    "not ok - uncommitted or untracked:  M myshape/dist/a.js"
  synced_case check-untracked
  put "$FORK/dispatch-plan/stray" 'untracked'
  expect_check_fails "--check of an untracked file" \
    "not ok - uncommitted or untracked: ?? dispatch-plan/stray"
  pass "--check names a changed, re-moded, missing, unlisted, uncommitted and untracked file"
}

test_usage_errors() {
  new_case usage
  run_vendor vendor "${SRC_M:0:12}"
  expect_code 2 "$CODE" "a short commit id"
  run_vendor vendor "$(printf '%s' "$SRC_M" | tr 'a-f' 'A-F')"
  expect_code 2 "$CODE" "an uppercase commit id"
  run_vendor --check extra
  expect_code 2 "$CODE" "--check with an argument"
  run_vendor frobnicate
  expect_code 2 "$CODE" "an unknown command"
  CODE=0
  OUT=$(TMPDIR="$CASE/tmp" "$FORK/bin/fm-board-vendor.sh" \
    --source https://github.com/guybeju/myshape --check 2>&1) || CODE=$?
  expect_code 2 "$CODE" "--source with a URL"
  assert_contains "$OUT" "--source takes an existing local directory" "--source must refuse a URL"
  assert_contains "$OUT" "$MARK" "a --source usage error carries the mark too"
  pass "a bad commit id, a stray argument, an unknown command and a --source URL are usage errors"
}

make_templates
fm_test_run test_vendor_then_check test_next_sync_deletes_and_rewrites_itself \
  test_refuses_where_it_must_not_write test_refuses_a_dirty_owned_area test_refuses_bad_list_lines \
  test_refuses_entries_that_are_not_files test_refuses_clashing_or_foreign_targets \
  test_refuses_to_take_over_fork_files test_refuses_writing_through_symlinks \
  test_refuses_commits_off_the_first_parent_chain test_refuses_bad_lock_lines \
  test_check_names_each_difference test_usage_errors
