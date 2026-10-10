# claude-mods

Mods for [Claude Code](https://code.claude.com): plugins that change what Claude Code does or draw their own UI, such as a band above the prompt or a pane. Each mod lives in its own folder under [`mods/`](mods/) and installs on its own from this repository's plugin marketplace.

## Mods

| Mod | What it does | License |
| --- | --- | --- |
| [`token-weather`](mods/token-weather/) | A live forecast above the prompt: context window fill (cached and uncached) updated on every model request, and the 5-hour and weekly usage limits as `/usage` reports them. | Apache-2.0, derived from Anthropic's [claude-code-playground](https://github.com/anthropics/claude-code-playground) |

## Install

From a shell:

```bash
claude plugin marketplace add qarge/claude-mods
claude plugin install token-weather@qarge-mods --scope user
```

Or inside Claude Code: `/plugin marketplace add qarge/claude-mods`, then `/plugin install token-weather@qarge-mods`. The user scope loads a mod in every session from then on. To update an installed mod: `claude plugin marketplace update qarge-mods`, then `claude plugin update token-weather@qarge-mods`.

The mods use Claude Code's mod API, which is early access and changes between releases. Each mod's README names the Claude Code version it was built and tested on.

## Layout

```text
.claude-plugin/marketplace.json  the marketplace "qarge-mods": one entry per mod
mods/<name>/                     one complete plugin per mod
  .claude-plugin/plugin.json     name, version, description, author, license
  hooks/hooks.json               names the hooks module
  hooks/<name>.tsx               the hooks module: register(on)
  tests/<name>.test.ts           tests that `claude plugin test` runs
  README.md                      what it does, install, how it works, limits
  LICENSE                        the mod's license text (and NOTICE if it has one)
  tsconfig.json                  type-checks against the API types Claude Code lays
templates/mod/                   the skeleton new mods start from
scripts/new-mod.sh               creates a mod from the template and lists it
scripts/check.sh                 validates, tests and type-checks every mod
```

## Develop

Work on a mod from its folder, in a session that loads it:

```bash
claude --plugin-dir mods/<name>
```

The session reloads the mod each time a file in it is saved, and lays the API's type declarations in `mods/<name>/.claude-plugin/types/` (ignored by git), which `tsconfig.json` uses. Those declarations are the API reference: every event, every call on `$`, and every UI element with its props. In Claude Code, the `plugin-authoring` skill covers writing mods.

To run your working copy in every session instead of the published one, add the clone as the marketplace (in place of the GitHub one; both are named `qarge-mods`):

```bash
claude plugin marketplace add ~/projects/claude-mods
claude plugin install <name>@qarge-mods --scope user
```

A marketplace added from a folder is read from that folder: after an edit, run `/reload-plugins` in a session.

## Add a mod

1. Create it:

   ```bash
   scripts/new-mod.sh my-mod "One line saying what it does"
   ```

   This copies [`templates/mod/`](templates/mod/) to `mods/my-mod/`, fills in the name, description and year, and adds the mod to `.claude-plugin/marketplace.json`. The new mod already loads, registers a `/my-mod` command and has a passing test.
2. Write its hooks in `mods/my-mod/hooks/my-mod.tsx`, and tests for the behavior in `mods/my-mod/tests/`. Load it with `claude --plugin-dir mods/my-mod` while you work.
3. Fill in its README and add a row to the Mods table above.
4. Check everything:

   ```bash
   scripts/check.sh            # every mod
   scripts/check.sh my-mod     # one mod
   ```

   For each mod it checks that the marketplace lists it, that `claude plugin validate` passes, that its tests pass, that it type-checks (once its API types are laid), and that every code file has an `SPDX-License-Identifier` line.
5. Commit and push. Installed copies update by version, so bump `version` in the mod's `plugin.json` whenever its behavior changes.

## Maintain

- **After a Claude Code update**, run `claude --plugin-dir mods/<name>` once per mod to lay the new API types, then `scripts/check.sh`, and fix what no longer type-checks or passes.
- **Versions** follow semver, per mod, in its `plugin.json`.
- **Requirements:** Claude Code, `jq` and `perl` for the scripts, and Node.js (`npx`) for type-checking.

## License

Everything in this repository is under the [MIT License](LICENSE), copyright qarge, except where a mod's folder says otherwise. A mod derived from someone else's work keeps that work's license, copyright and notices in its folder, and its NOTICE file says what was changed:

- [`mods/token-weather`](mods/token-weather/) is under the Apache License 2.0. It is derived from Token Weather by Anthropic's Claude Code DevRel team (copyright 2026 Anthropic PBC). See its [NOTICE](mods/token-weather/NOTICE) and [LICENSE](mods/token-weather/LICENSE).

This project is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC; they are named here only to say what the mods work with.
