// Copyright 2026 qarge
// SPDX-License-Identifier: Apache-2.0

import type { HttpResponse, On, RenderPropsOf, SessionUsage, TurnStepInput, TurnUsage } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

// Beneath the plugin, the test's hooks stand for the engine: the session's
// figures, the credential handle, the network and the clock.

const NOW = Date.parse('2026-10-10T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const USAGE_BODY = {
  five_hour: { utilization: 8.0, resets_at: new Date(NOW + 2 * HOUR + 13 * MINUTE + 30_000).toISOString() },
  seven_day: { utilization: 66.4, resets_at: new Date(NOW + 44 * HOUR + 5 * MINUTE).toISOString() },
  seven_day_opus: null,
}

const PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 150,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

function band(props: Partial<RenderPropsOf['AbovePrompt']> = {}, surface: 'terminal' | 'desktop' = 'terminal') {
  return { plugin: 'token-weather', surface, component: 'AbovePrompt' as const, props: { ...PROPS, ...props } }
}

type World = {
  usage?: () => SessionUsage
  authorize?: () => { handle: string; kind: 'bearer' | 'api-key' } | null
  fetch?: () => HttpResponse
  draft?: () => string
  clipboard?: () => string
  messages?: () => unknown[]
  canCount?: boolean
}

const COUNT_URL = 'https://api.anthropic.com/v1/messages/count_tokens'

// The test's token counter: 8 around the request, one per character.
function counter(body: string | undefined): HttpResponse {
  const { messages } = JSON.parse(body ?? '{}') as { messages: { content: { text?: string }[] }[] }
  const chars = messages.flatMap(m => m.content).reduce((n, b) => n + (b.text?.length ?? 0), 0)
  return ok({ input_tokens: 8 + chars })
}

function ok(body: unknown): HttpResponse {
  return { status: 200, ok: true, headers: {}, text: JSON.stringify(body) }
}

function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  const fetches: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  // The engine's own drawing, where the plugin passes.
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
  // A call on $ is answered with { value }.
  on('session.usage', () => ({
    value: w.usage
      ? w.usage()
      : ({
          startedAt: NOW,
          context: { window: 200_000, breakdown: { autoCompactThreshold: 160_000, totalTokens: 40_000 } },
          rateLimits: [],
        } as unknown as SessionUsage),
  }))
  on('session.authorize', () => ({ value: w.authorize ? w.authorize() : { handle: 'handle', kind: 'bearer' } }))
  on('http.fetch', (_$, e) => {
    fetches.push(e.url)
    if (e.url === COUNT_URL) {
      if (w.canCount === false) throw new Error('offline')
      return { value: counter(e.init?.body) }
    }
    return { value: w.fetch ? w.fetch() : ok(USAGE_BODY) }
  })
  on('session.model', () => ({ value: 'claude-test' }))
  on('prompt.read', () => ({ value: { text: w.draft?.() ?? '', cursor: 0 } }))
  on('session.messages', () => ({ value: (w.messages?.() ?? []) as never }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: w.clipboard?.() ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return { clock, fetches, counts: () => fetches.filter(u => u === COUNT_URL).length }
}

async function start($: Engine, clock: MockClock) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

// The text of each row, by its key.
async function rows(ui: { find: (q: { key: string }) => Promise<{ text: string } | undefined> }) {
  return {
    context: (await ui.find({ key: 'Context' }))?.text ?? '',
    fiveHour: (await ui.find({ key: '5-hour' }))?.text ?? '',
    weekly: (await ui.find({ key: 'Weekly' }))?.text ?? '',
  }
}

function usage(input: number, cacheRead: number): TurnUsage {
  return { input_tokens: input, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, model: 'claude-test' }
}

async function step($: Engine, e: TurnStepInput) {
  const stream = $.turn.step(e)
  for await (const _ of stream) {
    // drained
  }
  return stream.result
}

describe('limits', () => {
  test('reads /usage at start and shows the figures as /usage does', async ($, on) => {
    const { clock, fetches } = world(on)
    await start($, clock)
    expect(fetches).toEqual(['https://api.anthropic.com/api/oauth/usage'])

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(band({}, surface))
      const r = await rows(ui)
      expect(r.fiveHour).toMatch(/^🌞 5-hour/)
      expect(r.fiveHour).toContain('8%')
      expect(r.fiveHour).toContain('92% left · resets in 2h 13m')
      // 66.4 is shown as 66, rounded down as /usage rounds it.
      expect(r.weekly).toMatch(/^☔\uFE0F Weekly/)
      expect(r.weekly).toContain('66%')
      expect(r.weekly).toContain('34% left · resets in 1d 20h')
      expect(r.context).toContain('~40k / 200k estimated')
      await ui.unmount()
    }
  })

  test('rate-limit headers pushed by session.measure replace the fetched figures', async ($, on) => {
    const { clock } = world(on)
    await start($, clock)
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 91.5, resetsAt: new Date(NOW + 30 * MINUTE).toISOString() },
        { kind: 'seven_day', percentUsed: 100 },
      ],
      changed: ['rateLimits'],
    })
    const r = await rows(await $.ui.mount(band()))
    expect(r.fiveHour).toMatch(/^🌀 5-hour/)
    expect(r.fiveHour).toContain('91%')
    expect(r.fiveHour).toContain('9% left · resets in 30m')
    expect(r.weekly).toMatch(/^⛔\uFE0F Weekly/)
    expect(r.weekly).toContain('0% left')
  })

  test('a reset read as 14:09:59.95 or as 14:10:00 shows the same clock time', async ($, on) => {
    const boundary = NOW + 2 * HOUR + 14 * MINUTE
    const { clock } = world(on, {
      fetch: () => ok({ ...USAGE_BODY, five_hour: { utilization: 9, resets_at: new Date(boundary - 50).toISOString() } }),
    })
    await start($, clock)
    const shown = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(boundary)
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).fiveHour).toContain(`(${shown})`)
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 9.3, resetsAt: new Date(boundary).toISOString() }],
      changed: ['rateLimits'],
    })
    expect((await rows(ui)).fiveHour).toContain(`(${shown})`)
  })

  test('refetches every few minutes while idle', async ($, on) => {
    let call = 0
    const { clock, fetches } = world(on, {
      fetch: () => {
        call += 1
        return call === 1 ? ok(USAGE_BODY) : ok({ ...USAGE_BODY, five_hour: { utilization: 2, resets_at: new Date(NOW + 7 * HOUR).toISOString() } })
      },
    })
    await start($, clock)
    await clock.advance(4 * MINUTE)
    expect(fetches).toHaveLength(1)
    await clock.advance(2 * MINUTE)
    expect(fetches).toHaveLength(2)
    const r = await rows(await $.ui.mount(band()))
    expect(r.fiveHour).toContain('2%')
    expect(r.fiveHour).toContain('98% left')
  })

  test('refetches as soon as a window has reset, however fresh its reading', async ($, on) => {
    let call = 0
    const { clock, fetches } = world(on, {
      fetch: () => {
        call += 1
        return call === 1 ? ok(USAGE_BODY) : ok({ ...USAGE_BODY, five_hour: { utilization: 2, resets_at: new Date(NOW + 7 * HOUR).toISOString() } })
      },
    })
    await start($, clock)
    // A reading just heard, of a window that has already reset.
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: new Date(NOW - 1000).toISOString() }],
      changed: ['rateLimits'],
    })
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).fiveHour).toContain('97%  3% left · reset due, refreshing')
    await clock.advance(30_000)
    expect(fetches).toHaveLength(2)
    expect((await rows(ui)).fiveHour).toContain('98% left')
  })

  test('reads /usage again once a turn has ended, at most every 30 seconds', async ($, on) => {
    const { clock, fetches } = world(on)
    on('turn.complete', () => ({ text: 'done' }))
    await start($, clock)
    const turnEnd = { reason: 'answer', text: 'done', turnId: 't1', isAborted: false } as never
    await $.turn.complete(turnEnd)
    await clock.advance(10_000)
    expect(fetches).toHaveLength(1) // the start's read is too recent
    await clock.advance(20_000)
    expect(fetches).toHaveLength(2)
    await clock.advance(60_000)
    expect(fetches).toHaveLength(2) // no turn ended since: nothing to read
    // A subagent's turn is not the session's.
    await $.turn.complete({ ...(turnEnd as object), agentId: 'a1' } as never)
    await clock.advance(30_000)
    expect(fetches).toHaveLength(2)
  })

  test('says why limits are missing instead of guessing', async ($, on) => {
    const { clock, fetches } = world(on, { authorize: () => null })
    await start($, clock)
    const r = await rows(await $.ui.mount(band()))
    expect(fetches).toHaveLength(0)
    expect(r.fiveHour).toMatch(/^❔\uFE0F 5-hour/)
    expect(r.fiveHour).toContain('unavailable: needs a claude.ai subscription login')
  })

  test('backs off after an HTTP error, then recovers', async ($, on) => {
    let call = 0
    const { clock, fetches } = world(on, {
      fetch: () => {
        call += 1
        return call === 1 ? { status: 503, ok: false, headers: {}, text: '' } : ok(USAGE_BODY)
      },
    })
    await start($, clock)
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).fiveHour).toContain('unavailable: /usage answered HTTP 503')
    await clock.advance(MINUTE)
    expect(fetches).toHaveLength(1)
    await clock.advance(5 * MINUTE)
    expect(fetches).toHaveLength(2)
    expect((await rows(ui)).fiveHour).toContain('92% left')
  })

  test('a body that is not JSON, or a network failure, leaves the rows unavailable', async ($, on) => {
    let call = 0
    const { clock } = world(on, {
      fetch: () => {
        call += 1
        if (call === 1) return { status: 200, ok: true, headers: {}, text: '<html>' }
        throw new Error('offline')
      },
    })
    await start($, clock)
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).weekly).toContain('unavailable: /usage could not be read')
    await clock.advance(6 * MINUTE)
    expect((await rows(ui)).weekly).toContain('unavailable: /usage could not be read')
  })

  test('an old reading says how old it is', async ($, on) => {
    let call = 0
    const { clock } = world(on, {
      fetch: () => {
        call += 1
        if (call === 1) return ok(USAGE_BODY)
        throw new Error('offline')
      },
    })
    await start($, clock)
    await clock.advance(16 * MINUTE)
    const r = await rows(await $.ui.mount(band()))
    expect(r.fiveHour).toContain('8%')
    expect(r.fiveHour).toMatch(/as of 1[56]m ago/)
  })
})

describe('context', () => {
  test('moves with every model request of a turn, split into cached and uncached', async ($, on) => {
    const { clock } = world(on)
    const perStep = [usage(2_000, 118_000), usage(1_000, 149_000)]
    on('turn.step', async function* (_$, e) {
      const u = e.agentId ? usage(0, 5_000) : perStep[e.index]!
      yield { kind: 'stop', stopReason: 'tool_use', usage: u }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: u }
    })
    await start($, clock)
    const ui = await $.ui.mount(band({ isWorking: true }))

    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 })
    let r = await rows(ui)
    expect(r.context).toMatch(/^⚡️ Context/) // 120k of a 160k compaction point
    expect(r.context).toContain('60%')
    expect(r.context).toContain('120k / 200k · 118k cached · 2k uncached · 40k to auto-compact')
    expect(r.context).not.toMatch(/turn|step|[▁▂▃▄▅▆▇]/)

    // A subagent's request is its own window: the band does not move.
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 1, agentId: 'a1' })
    expect((await rows(ui)).context).toContain('120k / 200k')

    await step($, { turnId: 't1', index: 1, model: 'claude-test', messageCount: 3 })
    r = await rows(ui)
    expect(r.context).toMatch(/^🌀 Context/)
    expect(r.context).toContain('75%')
    expect(r.context).toContain('150k / 200k · 149k cached · 1k uncached · 10k to auto-compact')

    // The engine's push of the same figure keeps the split.
    await $.session.measure({ context: { window: 200_000, tokens: 150_000, percent: 75 }, rateLimits: [], changed: ['context'] })
    expect((await rows(ui)).context).toContain('149k cached')
  })

  test('/compact: the row is estimated from the messages compacted and their replacement', async ($, on) => {
    let compacted = false
    let engineTokens: number | undefined
    const before = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(30_000) }] }]
    const after = [{ role: 'user', content: [{ type: 'text', text: 'summary '.repeat(500) }] }]
    const { clock } = world(on, {
      messages: () => (compacted ? after : before),
      usage: () =>
        ({ startedAt: NOW, context: { window: 200_000, tokens: engineTokens, breakdown: { autoCompactThreshold: 160_000, totalTokens: 99_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(500, 49_500) }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(500, 49_500) }
    })
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
    await start($, clock)
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 2 })
    engineTokens = 50_000
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).context).toContain('50k / 200k')

    const done = $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'all of it', toolUses: [] }] })
    await done
    // The engine still says 50k for a while; the row doesn't.
    expect((await rows(ui)).context).toContain('estimating…')
    compacted = true
    await clock.advance(1_000)
    // 50k + the 500-token reply, less 30k compacted, plus the 4k summary.
    expect((await rows(ui)).context).toContain('~24.5k / 200k estimated')
    engineTokens = undefined
    await clock.advance(1_000)
    expect((await rows(ui)).context).toContain('~24.5k / 200k estimated')

    // The next response measures it exactly.
    await step($, { turnId: 't2', index: 0, model: 'claude-test', messageCount: 2 })
    expect((await rows(ui)).context).toContain('50k / 200k · 49.5k cached')
  })

  test('when the engine lets go of its figure (/clear), the row falls back to the estimate', async ($, on) => {
    let tokens: number | undefined = 30_000
    const { clock } = world(on, {
      usage: () =>
        ({ startedAt: NOW, context: { window: 200_000, tokens, breakdown: { autoCompactThreshold: 160_000, totalTokens: 12_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    await start($, clock)
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).context).toMatch(/^🌞 Context.*15%/)
    tokens = undefined
    await clock.advance(500)
    expect((await rows(ui)).context).toContain('~12k / 200k estimated')
  })

  test('counts the draft as it is typed, pastes included, and adds it to the next request', async ($, on) => {
    let draft = ''
    let clipboard = ''
    const { clock, counts } = world(on, { draft: () => draft, clipboard: () => clipboard })
    await start($, clock)
    const ui = await $.ui.mount(band())
    draft = 'hello world'
    await clock.advance(500)
    // 11 characters, 11 tokens in the test's counter; 40k context.
    expect((await rows(ui)).context).toContain('~40k / 200k estimated · draft 11 → next ~40k')

    // A paste Claude Code shows as a placeholder: the clipboard holds it.
    clipboard = 'p'.repeat(2_000) + '\n' + 'q'.repeat(999)
    draft = 'look: [Pasted text #1 +1 lines]'
    await clock.advance(500)
    const shown = (await rows(ui)).context
    expect(shown).toContain('draft 3k → next ~43k') // 'look: ' and the 3,000 pasted
    const used = counts()
    draft = 'look at this: [Pasted text #1 +1 lines]'
    await clock.advance(500)
    expect(counts() - used).toBe(1) // only the typed text again; the paste was counted once

    // A clipboard that no longer matches the placeholder is not guessed at.
    clipboard = 'something else'
    draft = 'and [Pasted text #1 +1 lines] [Pasted text #2 +40 lines] [Image #1]'
    await clock.advance(500)
    expect((await rows(ui)).context).toContain('draft ≥3k (2 uncounted)') // #1 as read when it was pasted

    // Commands are not sent as typed.
    draft = '/compact'
    await clock.advance(500)
    expect((await rows(ui)).context).not.toContain('draft')
  })

  test('without the token counter the draft is estimated, and says so', async ($, on) => {
    const { clock } = world(on, { draft: () => 'x'.repeat(400), canCount: false })
    await start($, clock)
    await clock.advance(500)
    expect((await rows(await $.ui.mount(band()))).context).toContain('draft ~100')
  })
})

describe('layout', () => {
  test('folds into one line where the band has fewer than three rows', async ($, on) => {
    const { clock } = world(on)
    await start($, clock)
    const ui = await $.ui.mount(band({ maxRows: 2 }))
    const line = await ui.find({ type: 'Text', text: /5h/ })
    expect(line?.text).toBe('⛅\uFE0F ctx ~20%  🌞 5h 8% ↻2h 13m  ☔\uFE0F wk 66% ↻1d 20h')
  })

  test('no row is wider than the band', async ($, on) => {
    const { clock } = world(on)
    await start($, clock)
    for (const bodyColumns of [50, 72, 100, 150]) {
      const r = await rows(await $.ui.mount(band({ bodyColumns })))
      for (const text of Object.values(r)) {
        // Each icon is drawn two cells wide (U+FE0F takes none); padding is 2.
        expect([...text.replace(/\uFE0F/g, '')].length + 1 + 2).toBeLessThanOrEqual(bodyColumns)
      }
    }
  })
})
