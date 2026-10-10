#!/bin/sh
# Copyright 2026 qarge
# SPDX-License-Identifier: MIT
#
# Creates mods/<name> from templates/mod and lists it in the marketplace.
#
# usage: scripts/new-mod.sh <name> "<one-line description>"
#   <name>  kebab-case: what /plugin install <name>@qarge-mods will take

set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
name=${1:-}
description=${2:-}

case $name in
  '' | *[!a-z0-9-]* | -* | *- | *--*)
    echo "usage: $0 <kebab-case-name> \"<one-line description>\"" >&2
    exit 2
    ;;
esac
if [ -z "$description" ]; then
  echo "a one-line description is required" >&2
  exit 2
fi
dir="$root/mods/$name"
if [ -e "$dir" ]; then
  echo "mods/$name already exists" >&2
  exit 1
fi

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
jq --arg name "$name" --arg description "$description" \
  '.name = $name | .description = $description | .homepage |= sub("__NAME__"; $name)' \
  "$manifest" > "$tmp" && mv "$tmp" "$manifest"
jq --arg name "$name" --arg description "$description" \
  '.plugins = (.plugins + [{ name: $name, source: ("./mods/" + $name), description: $description }] | sort_by(.name))' \
  "$marketplace" > "$tmp" && mv "$tmp" "$marketplace"

echo "Created mods/$name and listed it in .claude-plugin/marketplace.json."
echo "Next: write mods/$name/hooks/$name.tsx, then run scripts/check.sh $name"
