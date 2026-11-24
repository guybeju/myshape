#!/usr/bin/env bash
# check-guide.sh: the setup guide at the checkout root cites only names that
# exist, and each kind of check really catches a wrong name.
# shellcheck disable=SC2016 # the backticks in the planted lines are Markdown code spans.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-board-guide)
CHECK="$ROOT/fm-board/test/check-guide.sh"
GUIDE="$ROOT/FORK-SETUP.markdown"

# check_copy <name> <line>: run the check on a copy of the guide with <line>
# appended, resolving links against the checkout root; prints the output.
check_copy() {
  local copy=$TMP_ROOT/$1.markdown
  { cat "$GUIDE"; printf '\n%s\n' "$2"; } > "$copy"
  "$CHECK" "$copy" "$ROOT" 2>&1
}

# expect_caught <name> <line> <needle>: the appended line alone makes the check fail.
expect_caught() {
  local out code=0
  out=$(check_copy "$1" "$2") || code=$?
  expect_code 1 "$code" "$1: the check must fail"
  assert_contains "$out" "$3" "$1: the check must name the problem"
}

test_real_guide_passes() {
  local out
  out=$("$CHECK" 2>&1) || fail "the guide fails its own check: $out"
  assert_contains "$out" "ok - FORK-SETUP.markdown" "the check must report the guide it read"
  out=$(check_copy unchanged "") || fail "an unchanged copy must pass when links resolve against the root: $out"
  pass "the setup guide cites only names that exist in this checkout"
}

test_catches_wrong_names() {
  expect_caught link '[壞](docs/no-such-file.md#x)' "link target does not exist: docs/no-such-file.md"
  expect_caught script '`bin/fm-no-such-script.sh`' "bin/fm-no-such-script.sh"
  expect_caught subcommand '`bin/myshape.sh frobnicate`' "myshape.sh has no subcommand 'frobnicate'"
  expect_caught moved-subcommand '`bin/myshape.sh setup`' "myshape.sh has no subcommand 'setup'"
  expect_caught board-subcommand '`bin/fm-board.sh frobnicate`' "fm-board.sh has no subcommand 'frobnicate'"
  expect_caught in-home '`bin/fm-board.sh --in-home <id> frob`' "fm-board.sh has no subcommand 'frob'"
  expect_caught plan-subcommand '`bin/fm-dispatch-plan.sh frobnicate`' "fm-dispatch-plan.sh has no subcommand 'frobnicate'"
  expect_caught config '`config/no-such-flag`' "no script under bin/ mentions config/no-such-flag"
  expect_caught slash-skill '`/no-such-skill`' "no skill named no-such-skill"
  expect_caught named-skill '`no-such-skill` 技能' "no skill named no-such-skill"
  pass "a wrong link, script, subcommand, config file, or skill fails the check"
}

test_catches_wrong_template_versions() {
  expect_caught main-version '`captain.md：新增（v99）`' "captain.md is cited at v99"
  expect_caught shared-version '`規則：captain.md 和範本相同（v6）；captain-shared.md 和範本相同（v98）`' \
    "captain-shared.md is cited at v98"
  pass "a template version that differs from fm-board/rules fails the check"
}

test_missing_guide() {
  local out code=0
  out=$("$CHECK" "$TMP_ROOT/absent.markdown" 2>&1) || code=$?
  expect_code 2 "$code" "a missing guide"
  assert_contains "$out" "no such guide" "a missing guide must be named"
  pass "a missing guide is a usage error, not a pass"
}

fm_test_run test_real_guide_passes test_catches_wrong_names test_catches_wrong_template_versions test_missing_guide
