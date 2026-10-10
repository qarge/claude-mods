#!/bin/sh
# Copyright 2026 qarge
# SPDX-License-Identifier: MIT
#
# Creates mods/<name> from templates/mod and lists it in the marketplace.
#
# usage: scripts/new-mod.sh <name> "<one-line description>"
#   <name>  kebab-case: what /plugin install <name>@qarge-mods will take

set -eu
export LC_ALL=C # so [a-z] below is a to z, not every letter of the user's locale

root=$(cd "$(dirname "$0")/.." && pwd)
name=${1:-}
description=${2:-}

case $name in
  '' | *[!a-z0-9-]* | -* | *- | *--*)
    echo "usage: $0 <kebab-case-name> \"<one-line description>\"" >&2
    exit 2
    ;;
esac
case $description in
  '' | *'
'*)
    echo "a one-line description is required" >&2
    exit 2
    ;;
esac
dir="$root/mods/$name"
if [ -e "$dir" ]; then
  echo "mods/$name already exists" >&2
  exit 1
fi

# A run that stops part-way leaves nothing behind.
tmp=
trap 'rm -rf "$dir" ${tmp:+"$tmp"}' EXIT
cp -R "$root/templates/mod" "$dir"
mv "$dir/hooks/__NAME__.tsx" "$dir/hooks/$name.tsx"
mv "$dir/tests/__NAME__.test.ts" "$dir/tests/$name.test.ts"

# The description goes in through the environment, so no character in it
# needs escaping; JSON files get it through jq.
export NAME="$name" DESCRIPTION="$description" YEAR="$(date +%Y)"
find "$dir" -type f ! -name plugin.json -exec perl -pi -e \
  's/__NAME__/$ENV{NAME}/g; s/__DESCRIPTION__/$ENV{DESCRIPTION}/g; s/__YEAR__/$ENV{YEAR}/g' {} +

manifest="$dir/.claude-plugin/plugin.json"
marketplace="$root/.claude-plugin/marketplace.json"
tmp=$(mktemp)
# Each jq on a line of its own, so set -e stops on its failure; cat keeps the
# files' modes.
jq --arg name "$name" --arg description "$description" \
  '.name = $name | .description = $description | .homepage |= sub("__NAME__"; $name)' \
  "$manifest" > "$tmp"
cat "$tmp" > "$manifest"
jq --arg name "$name" --arg description "$description" \
  '.plugins = ([.plugins[] | select(.name != $name)] + [{ name: $name, source: ("./mods/" + $name), description: $description }] | sort_by(.name))' \
  "$marketplace" > "$tmp"
cat "$tmp" > "$marketplace"
rm -f "$tmp"
trap - EXIT

echo "Created mods/$name and listed it in .claude-plugin/marketplace.json."
echo "Next: write mods/$name/hooks/$name.tsx, then run scripts/check.sh $name"
