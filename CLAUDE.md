# Working in claude-mods

- One mod per folder under `mods/`, each a complete plugin, each listed in `.claude-plugin/marketplace.json`. Start new ones with `scripts/new-mod.sh <name> "<description>"`, which does both.
- Load the `plugin-authoring` skill before writing or changing a mod. The API types in `mods/<name>/.claude-plugin/types/` are the reference; `claude --plugin-dir mods/<name>` lays them.
- Run `scripts/check.sh` (or `scripts/check.sh <name>`) before every commit; it must pass.
- Bump the mod's `version` in its `plugin.json` when its behavior changes, and keep the Mods table in `README.md` current.
- Licensing:
  - New code is MIT. Each code file starts with `Copyright <year> qarge` and `SPDX-License-Identifier: MIT`, and the mod folder has the MIT `LICENSE`. The exception is a mod derived from someone else's work: new files there take the mod's license (its `plugin.json` `license`), which `scripts/check.sh` enforces.
  - Code taken from someone else keeps its license, copyright lines and notices. Add `Modifications copyright <year> qarge` under the original copyright, mark the file as changed, and record the changes in the mod's `NOTICE`. Never relabel it MIT or as qarge's.
  - `mods/usage-weather` is Apache-2.0, derived from Anthropic's claude-code-playground.
