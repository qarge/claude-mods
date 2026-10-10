#!/bin/sh
# Copyright 2026 qarge
# SPDX-License-Identifier: MIT
#
# Checks the marketplace and every mod (or the mods named): each mod is
# listed, validates, passes its tests, type-checks, and every code file
# carries a license header. Exits non-zero if anything fails.
#
# usage: scripts/check.sh [mod-name...]
#
# Type-checking needs the API types Claude Code lays in
# mods/<name>/.claude-plugin/types/ when it loads the mod from its folder:
# run `claude --plugin-dir mods/<name>` once (and again after a Claude Code
# update). A mod without them is reported and skipped.

set -u

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 1
failed=0

fail() {
  echo "  FAIL: $*"
  failed=1
}

echo "== marketplace"
if ! out=$(claude plugin validate . 2>&1); then
  echo "$out"
  fail "marketplace does not validate"
fi
for source in $(jq -r '.plugins[].source' .claude-plugin/marketplace.json); do
  [ -d "$source" ] || fail "marketplace lists $source, which does not exist"
done

if [ $# -gt 0 ]; then
  mods=$(printf 'mods/%s\n' "$@")
else
  mods=$(find mods -mindepth 1 -maxdepth 1 -type d | sort)
fi

for dir in $mods; do
  echo "== ${dir#mods/}"
  if [ ! -d "$dir" ]; then
    fail "$dir does not exist"
    continue
  fi
  jq -e --arg source "./$dir" '.plugins | any(.source == $source)' .claude-plugin/marketplace.json >/dev/null ||
    fail "not listed in .claude-plugin/marketplace.json"

  if out=$(claude plugin validate "$dir" 2>&1); then
    echo "  validate: ok"
  else
    echo "$out"
    fail "does not validate"
  fi

  if ls "$dir"/tests/*.test.ts* >/dev/null 2>&1; then
    if out=$(claude plugin test "$dir" 2>&1); then
      echo "  tests: $(echo "$out" | grep -E '^ *[0-9]+ pass' | tr -s ' ')"
    else
      echo "$out"
      fail "tests fail"
    fi
  else
    fail "no tests (add $dir/tests/*.test.ts)"
  fi

  if [ -f "$dir/.claude-plugin/types/tsconfig.json" ]; then
    if out=$(npx --yes -p typescript@5.6.3 tsc -p "$dir" 2>&1); then
      echo "  tsc: ok"
    else
      echo "$out"
      fail "does not type-check"
    fi
  else
    echo "  tsc: skipped, no API types yet (run: claude --plugin-dir $dir)"
  fi

  for file in $(find "$dir" -path '*/.claude-plugin/types' -prune -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.sh' \) -print); do
    grep -q 'SPDX-License-Identifier' "$file" || fail "$file has no SPDX-License-Identifier line"
  done
  [ -f "$dir/LICENSE" ] || fail "no LICENSE file in $dir"
done

if [ $failed -ne 0 ]; then
  echo "== FAILED"
  exit 1
fi
echo "== all checks passed"
