# Token Weather

A Claude Code mod that draws a live forecast of your context window and your plan's usage limits in the band above the prompt. One hooks module, three rows, real figures only: nothing is estimated where an exact figure exists.

## What this shows

Three rows above the prompt, each with a weather icon, a bar, the percentage used and the details that matter:

- **Context**: tokens used of the window, how much is left before auto-compaction, how much the current turn has added and which model request it is on (`●` while Claude works), and a chart of the last 16 requests. It moves after every model request of a turn (each tool round), not only when the turn ends.
- **5-hour** and **Weekly**: your plan's usage limits as `/usage` reports them: percent used (rounded down, as `/usage` shows it), percent left, and a countdown to the reset with its local time.

One scale for all three rows, by percent used:

| Used      | Icon | Color |
|-----------|------|-------|
| under 25% | 🌞   | green |
| 25–49%    | ⛅   | green |
| 50–74%    | ☔   | amber |
| 75–89%    | ⚡   | amber |
| 90–99%    | 🌀   | red   |
| 100% up   | ⛔   | red   |

For the context row the icon counts toward the auto-compaction point, where the window effectively ends; the percentage is of the whole window, as the status line and `/context` show it.

Where each figure comes from:

| Figure | Source | Updated |
|--------|--------|---------|
| Context tokens | the usage of each main-loop model response, read in `turn.step`: input, cache-write and cache-read tokens (the status line's `total_input_tokens`) | as each response of a turn finishes |
| Window, auto-compaction point | `$.session.usage()`, with the summary breakdown, which is estimated locally and sends no request | at session start and when the model changes |
| 5-hour and weekly limits | `GET /api/oauth/usage`, the endpoint `/usage` reads, sent with the session's own credential through `$.session.authorize()` (the mod never sees the token) | at session start, within 30 seconds of each turn's end, every 5 minutes when idle, and as soon as a window has reset |
| | the rate-limit headers of each response, pushed by `session.measure` | during a turn, whenever a window moves a whole point |

| Hook | What it does |
|------|--------------|
| `session.start` | Reads the window and the auto-compaction point, starts a 30-second tick (countdowns, refreshes), and reads `/usage` off the startup path. |
| `turn.step` | Reads each main-loop response's usage as it finishes. Subagents' requests have their own windows and are skipped. |
| `turn.complete` | Marks the limits for a fresh `/usage` read on the next tick. |
| `session.measure` | Takes the engine's pushed figures: context after a turn, limits when a window moves a point. |
| `session.end` | Empties the context row on `/clear`. |
| `ui.render` with `{component: "AbovePrompt"}` | Draws the three rows; one line when the band has fewer than three rows or under 50 columns. |

## Demo

The band in a 160-column terminal while Claude reads a third file (example figures):

```text
 🌞 Context █▍░░░░░░░░░░░░░░░░░░   7%  73k / 1M · 894k to auto-compact · ● ▲ +73k this turn, step 4  ▅▆█
 ⛅ 5-hour  ██████▌░░░░░░░░░░░░░  33%  67% left · resets in 2h 41m (17:10)
 ☔ Weekly  █████████████▍░░░░░░  67%  33% left · resets in 1d 20h (Mon 09:00)
```

Before the first response the context row reads `⏳ … fills in after the first response`; the limit rows are filled from `/usage` at once. In a band with fewer than three rows:

```text
 🌞 ctx 7%  ⛅ 5h 33% ↻2h 41m  ☔ wk 67% ↻1d 20h
```

## How it was built

- **Model:** built with Claude in Claude Code. Version 0.1.0 was tested with Claude Haiku 4.5. Version 0.2.0 was built with Claude Opus 5.5 and tested live with Claude Haiku 5.5. The mod itself doesn't call a model.
- **Prompt(s):** the mod started as one of ten ideas Claude wrote for mods. This is the idea as written:

  > **Token Weather.** _A live forecast of your context window._ A band above the prompt draws a small chart of context use for each turn, as weather icons. It's clear when the window is mostly empty, and stormy when it's nearly full. It uses `ui.render` on the `AbovePrompt` component, with the `Svg` element, and it updates on `turn.complete`. I haven't confirmed which event or call gives the token counts, so that needs a check. Developers would share it because it looks good in a screenshot, and it answers "why did Claude forget that?" at a glance. The status line only shows text. _A weekend build._

  The build prompt for 0.1.0, which picked this idea and two others by number:

  > implement 1,2,7. give me zips for them. test them in claude code and get me screenshots of what they look like when used.

  Version 0.2.0 came from a request to update the band while Claude works, to show the 5-hour and weekly limits with the same data `/usage` has, to use emoji that change as usage grows, and to keep it compact.
- **Transcript:** not shared.
- **Iterations:**
  - 0.1.0 read `$.session.usage()` once per turn, in `turn.complete`. 0.2.0 reads each response's usage in `turn.step`, so a long turn of tool calls moves the band request by request.
  - `$.session.usage()` has no rate-limit readings until the session's first response, so the limit rows would have been empty at start. `/usage` reads `GET /api/oauth/usage`; `$.session.authorize()` and `$.http.fetch` send the same request with the session's credential, which the engine adds itself.
  - The rate-limit headers are read as a request is answered and lag its own cost: in testing the band read 16% while `/usage` read 17%. The band now reads `/usage` again after each turn.
  - The same reset comes back as `14:09:59.95` from one read and `14:10:00` from the next, so the shown time rounds to the nearest minute.
  - 0.1.0 avoided emoji because they weren't in its test terminal's font. 0.2.0 uses only emoji that are drawn as emoji by default (no variation selector), which emoji-capable terminals draw two cells wide.
  - 0.1.0 read `e.hasSurvey` and `e.bodyColumns`, which live under `e.props`: it never gave way to a survey and always laid out for 80 columns. Fixed.
  - Tested with `claude plugin test` (14 tests: the `/usage` read, header pushes, refresh timing, reset handling, every unavailable case, per-request context, `/clear`, and widths), `tsc`, and live in Claude Code 2.1.296 driven through a pseudo-terminal: across a three-file turn the context row moved at each request, and the band's figures matched `/context` and `/usage` in the same session.

## Run it

**Requirements:**

- Claude Code 2.1.296 or later (built and tested on 2.1.296).
- A terminal (or the desktop app's Code tab): `AbovePrompt` is drawn on the terminal and desktop surfaces.
- For the limit rows, a claude.ai subscription login (Pro, Max or Team). With an API key or a third-party provider the rows say they're unavailable; the context row works everywhere.

No environment variables or configuration.

**Install** for every session:

```bash
claude plugin marketplace add qarge/claude-mods
claude plugin install token-weather@qarge-mods --scope user
```

**Develop** from a clone of [qarge/claude-mods](https://github.com/qarge/claude-mods):

```bash
claude --plugin-dir mods/token-weather   # one session, reloads on save
scripts/check.sh token-weather           # validate, test, type-check
```

## Notes / limitations

- **Context moves per model request, not per streamed token.** The API reports a request's usage when its response ends; there is no exact figure in between, so the band doesn't guess one.
- **Limits move during a turn only when the engine reports a whole-point move** from the response headers. Use from other sessions, devices or claude.ai shows after the next `/usage` read: after each turn, and every 5 minutes when idle.
- **`/api/oauth/usage` is the endpoint Claude Code's own `/usage` reads, not a documented API**, and may change. If it does, the rows say they're unavailable and the header readings still fill them during turns.
- **Only the 5-hour and the all-models weekly limit are shown.** `/usage`'s other rows (a Sonnet-only week, per-model weeks, usage credits) are not.
- **A reading older than 15 minutes says how old it is**, for example when `/usage` can't be reached.
- **The context chart is relative** to the fullest request shown, so growth shows at any fill level. It resets when the session starts, on `/clear`, and when the plugin reloads.
- **One band per session.** Another plugin that draws `AbovePrompt` competes for the same band.

## Dependencies

| Name | Version | License (SPDX) | Source |
| --- | --- | --- | --- |
| None | | | |

## Origin and license

Derived from Token Weather by Anthropic's Claude Code DevRel team, in [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/token-weather) (copyright 2026 Anthropic PBC). The upstream repository describes it as not an official Anthropic product, shared as-is; this version is changed by qarge and not made or endorsed by Anthropic. This README is adapted from the original's.

Licensed under the Apache License, Version 2.0: see [LICENSE](LICENSE). [NOTICE](NOTICE) lists what was changed. Claude and Claude Code are trademarks of Anthropic, PBC.
