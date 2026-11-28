#!/usr/bin/env bash
# dispatch-plan/common-tools.tsv agrees with what it is drawn from: section 1
# of the fork's FORK-SETUP.markdown names every tool on it with the same lowest
# version, except ShellCheck, whose lowest version is bin/fm-lint.sh's pin
# (the guide does not repeat it); and every "`<tool>` <version> 以上" in that
# section is on the list with that version. So the list the machines view
# measures cannot drift from the setup guide.
set -u

# shellcheck source=tests/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/lib.sh"

LIST="$ROOT/dispatch-plan/common-tools.tsv"
GUIDE="$ROOT/FORK-SETUP.markdown"

# guide_section_1: the lines of FORK-SETUP's section 1, without its heading.
guide_section_1() {
  awk '/^## 1\./ { on = 1; next } /^## / { on = 0 } on' "$GUIDE"
}

test_every_listed_tool_is_in_the_guide() {
  local part name floor pin
  assert_present "$LIST" "the common list must exist"
  assert_present "$GUIDE" "the setup guide must exist in the fork"
  part=$(guide_section_1)
  [ -n "$part" ] || fail "FORK-SETUP.markdown has no section 1 (## 1.)"
  pin=$("$ROOT/bin/fm-lint.sh" --required-version) || fail "bin/fm-lint.sh --required-version failed"
  while IFS=$'\t' read -r name floor || [ -n "$name" ]; do
    case "$name" in '' | '#'*) continue ;; esac
    if [ "$name" = shellcheck ]; then
      assert_equals "$pin" "$floor" "the list's ShellCheck floor must be bin/fm-lint.sh's pin"
      continue
    fi
    assert_contains "$part" "\`$name\`" "FORK-SETUP section 1 must name $name, which the common list has"
    [ "$floor" = - ] || assert_contains "$part" "\`$name\` $floor 以上" \
      "FORK-SETUP section 1 must give $name the list's lowest version $floor"
  done < "$LIST"
  pass "every tool on the common list is in FORK-SETUP section 1 (ShellCheck at bin/fm-lint.sh's pin)"
}

test_every_guide_floor_is_on_the_list() {
  local name floor found=0
  # shellcheck disable=SC2016 # the backticks are Markdown in the pattern, not a command.
  while read -r name floor; do
    found=$((found + 1))
    assert_equals "$name	$floor" "$(grep "^$name	" "$LIST")" \
      "FORK-SETUP section 1 says $name $floor or later, so the common list must say the same"
  done < <(guide_section_1 | grep -o '`[A-Za-z0-9._-]*` [0-9][0-9.]* 以上' | sed 's/`//g; s/ 以上$//')
  [ "$found" -gt 0 ] || fail "FORK-SETUP section 1 gives no tool a lowest version; the check would prove nothing"
  pass "every lowest version FORK-SETUP section 1 gives is on the common list"
}

fm_test_run test_every_listed_tool_is_in_the_guide test_every_guide_floor_is_on_the_list
