# __NAME__

__DESCRIPTION__

## What it does

What the mod changes or draws, and when. A short example of what it looks like (a text capture of the terminal works well).

## Install

```bash
claude plugin marketplace add qarge/claude-mods
claude plugin install __NAME__@qarge-mods --scope user
```

**Requirements:** Claude Code 2.1.296 or later.

## How it works

| Hook | What it does |
|------|--------------|
| `session.start` | Registers `/__NAME__`. |
| `command.run` | Answers `/__NAME__`. |

## Develop

```bash
claude --plugin-dir mods/__NAME__   # hot-reloads on save, lays the API types for tsc
scripts/check.sh __NAME__           # validate, test, type-check
```

## Notes / limitations

Known rough edges and anything not to rely on.

## License

MIT. See [LICENSE](LICENSE).
