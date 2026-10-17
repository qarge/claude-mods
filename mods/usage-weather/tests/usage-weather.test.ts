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
  return { plugin: 'usage-weather', surface, component: 'AbovePrompt' as const, props: { ...PROPS, ...props } }
}

type World = {
  usage?: () => SessionUsage
  authorize?: () => { handle: string; kind: 'bearer' | 'api-key' } | null
  fetch?: () => HttpResponse | Promise<HttpResponse>
  id?: () => string
  store?: Record<string, unknown>
  count?: (body: string | undefined) => HttpResponse | Promise<HttpResponse>
  theme?: () => string
  messages?: () => unknown[]
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
  const store: Record<string, unknown> = { ...w.store }
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => ((store[e.key] = e.value), { value: undefined }))
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
  on('http.fetch', async (_$, e) => {
    fetches.push(e.url)
    if (e.url === COUNT_URL) {
      return { value: w.count ? await w.count(e.init?.body) : counter(e.init?.body) }
    }
    return { value: w.fetch ? await w.fetch() : ok(USAGE_BODY) }
  })
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.id', () => ({ value: w.id?.() ?? 'chat' }))
  on('session.messages', () => ({ value: (w.messages?.() ?? []) as never }))
  on('config.list', () => ({ value: [{ key: 'theme', value: w.theme?.() ?? 'dark' }] as never }))
  on('config.set', (_$, e) => ({ value: e.value }))
  return { clock, fetches, store }
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

  test('the last reading any session made shows from the first frame, until /usage answers', async ($, on) => {
    let answer: (r: HttpResponse) => void = () => {}
    const { clock, store } = world(on, {
      fetch: () => new Promise<HttpResponse>(resolve => (answer = resolve)),
      store: {
        limits: {
          five_hour: { used: 7, resetsAt: NOW + 2 * HOUR + 14 * MINUTE, at: NOW - 10 * MINUTE },
          seven_day: { used: 66, resetsAt: NOW + 44 * HOUR + 5 * MINUTE, at: NOW - 10 * MINUTE },
        },
      },
    })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount(band())
    let r = await rows(ui)
    expect(r.fiveHour).toContain('7%  93% left · resets in 2h 14m')
    expect(r.weekly).toContain('66%  34% left')
    expect(r.context).toContain('~40k / 200k estimated')
    answer(ok(USAGE_BODY))
    await clock.settle()
    r = await rows(ui)
    expect(r.fiveHour).toContain('8%  92% left · resets in 2h 13m')
    // What /usage said is kept for the next session.
    expect(JSON.parse(JSON.stringify(store.limits))).toMatchObject({ five_hour: { used: 8, at: NOW }, seven_day: { used: 66.4, at: NOW } })
  })

  test('a saved reading says how old it is, and one whose window has reset since is not shown', async ($, on) => {
    const { clock } = world(on, {
      fetch: () => new Promise<HttpResponse>(() => {}),
      store: {
        limits: {
          five_hour: { used: 97, resetsAt: NOW - MINUTE, at: NOW - 3 * HOUR },
          seven_day: { used: 66, resetsAt: NOW + 44 * HOUR, at: NOW - 3 * HOUR },
          junk: { used: 'x' },
        },
      },
    })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    void clock
    const r = await rows(await $.ui.mount(band()))
    expect(r.fiveHour).toContain('reading /usage…')
    expect(r.weekly).toContain('66%  34% left · resets in 1d 20h (')
    expect(r.weekly).toContain('as of 3h 0m ago')
  })

  test('a saved subscription reading is not shown under an API key', async ($, on) => {
    const { clock } = world(on, {
      authorize: () => ({ handle: 'key', kind: 'api-key' }),
      store: { limits: { seven_day: { used: 66, resetsAt: NOW + HOUR, at: NOW } } },
    })
    await start($, clock)
    const r = await rows(await $.ui.mount(band()))
    expect(r.weekly).toContain('unavailable: needs a claude.ai subscription login')
  })

  test('a rate-limit header never pulls back the /usage figure of the same window', async ($, on) => {
    const { clock } = world(on)
    await start($, clock)
    const ui = await $.ui.mount(band())
    const header = (percentUsed: number) =>
      $.session.measure({
        context: { window: 200_000 },
        // The same reset as /usage gave, spelled to the millisecond.
        rateLimits: [{ kind: 'seven_day', percentUsed, resetsAt: new Date(Date.parse(USAGE_BODY.seven_day.resets_at) + 158).toISOString() }],
        changed: ['rateLimits'],
      })
    await header(65)
    expect((await rows(ui)).weekly).toContain('66%  34% left')
    await header(67.5)
    expect((await rows(ui)).weekly).toContain('67%  33% left')
  })

  test('rate-limit headers pushed by session.measure replace the fetched figures', async ($, on) => {
    const { clock } = world(on)
    await start($, clock)
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 91.5, resetsAt: new Date(NOW + 2 * HOUR + 30 * MINUTE).toISOString() },
        { kind: 'seven_day', percentUsed: 100 },
      ],
      changed: ['rateLimits'],
    })
    const r = await rows(await $.ui.mount(band()))
    expect(r.fiveHour).toMatch(/^🌀 5-hour/)
    expect(r.fiveHour).toContain('91%')
    expect(r.fiveHour).toContain('9% left · resets in 2h 30m')
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

  test('refetches every minute while idle', async ($, on) => {
    let call = 0
    const { clock, fetches } = world(on, {
      fetch: () => {
        call += 1
        return call === 1 ? ok(USAGE_BODY) : ok({ ...USAGE_BODY, five_hour: { utilization: 2, resets_at: new Date(NOW + 7 * HOUR).toISOString() } })
      },
    })
    await start($, clock)
    await clock.advance(50_000)
    expect(fetches).toHaveLength(1)
    await clock.advance(10_000)
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
        return call === 1
          ? ok({ ...USAGE_BODY, five_hour: { utilization: 97, resets_at: new Date(NOW + 10_000).toISOString() } })
          : ok({ ...USAGE_BODY, five_hour: { utilization: 2, resets_at: new Date(NOW + 7 * HOUR).toISOString() } })
      },
    })
    await start($, clock)
    await clock.advance(20_000)
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).fiveHour).toContain('97%  3% left · reset due, refreshing')
    await clock.advance(10_000) // the next tick, half a minute before the refresh would be due
    expect(fetches).toHaveLength(2)
    expect((await rows(ui)).fiveHour).toContain('98% left')
  })

  test('/usage is believed when it lowers a figure within the same window', async ($, on) => {
    let call = 0
    const { clock } = world(on, {
      fetch: () => (++call === 1 ? ok({ ...USAGE_BODY, seven_day: { ...USAGE_BODY.seven_day, utilization: 80 } }) : ok({ ...USAGE_BODY, seven_day: { ...USAGE_BODY.seven_day, utilization: 20 } })),
    })
    await start($, clock)
    await clock.advance(6 * MINUTE)
    expect((await rows(await $.ui.mount(band()))).weekly).toContain('20%  80% left')
  })

  test('an old window’s headers never replace a newer reading', async ($, on) => {
    const { clock } = world(on)
    await start($, clock)
    const ui = await $.ui.mount(band())
    // The last response's headers of a window that has since reset.
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: new Date(NOW - 1000).toISOString() }],
      changed: ['context'],
    })
    expect((await rows(ui)).fiveHour).toContain('8%  92% left')
    // And headers of a window that reset before the one /usage reported.
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: new Date(NOW + 30 * MINUTE).toISOString() }],
      changed: ['rateLimits'],
    })
    expect((await rows(ui)).fiveHour).toContain('8%  92% left')
  })

  test('headers that only ride along with a measure don’t freshen an old reading', async ($, on) => {
    let call = 0
    const { clock } = world(on, {
      fetch: () => {
        if (++call === 1) return ok(USAGE_BODY)
        throw new Error('offline')
      },
    })
    await start($, clock)
    await clock.advance(16 * MINUTE)
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 8, resetsAt: USAGE_BODY.five_hour.resets_at }],
      changed: ['context'],
    })
    expect((await rows(await $.ui.mount(band()))).fiveHour).toMatch(/as of 1[56]m ago/)
  })

  test('a kept reading no window could have is not shown', async ($, on) => {
    world(on, {
      fetch: () => new Promise<HttpResponse>(() => {}),
      store: { limits: { five_hour: { used: 1e21, resetsAt: NOW + HOUR, at: NOW }, seven_day: { used: 50, resetsAt: NOW + HOUR, at: NOW + HOUR } } },
    })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const r = await rows(await $.ui.mount(band()))
    expect(r.fiveHour).toContain('reading /usage…')
    expect(r.weekly).toContain('reading /usage…')
  })

  test('a window /usage stops listing is dropped, and nothing refetches in a loop', async ($, on) => {
    let call = 0
    const { clock, fetches } = world(on, {
      fetch: () => (++call === 1 ? ok({ ...USAGE_BODY, five_hour: { utilization: 97, resets_at: new Date(NOW + 10_000).toISOString() } }) : ok({ ...USAGE_BODY, five_hour: null })),
    })
    await start($, clock)
    await clock.advance(2 * MINUTE)
    // Read at the start, at the reset (30 s), then a minute after that.
    expect(fetches).toHaveLength(3)
    const r = await rows(await $.ui.mount(band()))
    expect(r.fiveHour).toContain('none open now')
    expect(r.fiveHour).not.toContain('97%')
    expect(r.weekly).toContain('66%')
  })

  test('a /usage that keeps listing a passed reset is not asked every 30 seconds', async ($, on) => {
    const { clock, fetches } = world(on, {
      fetch: () => ok({ ...USAGE_BODY, five_hour: { utilization: 97, resets_at: new Date(NOW + 10_000).toISOString() } }),
    })
    await start($, clock)
    await clock.advance(MINUTE)
    // The start's read, and one at the reset (30 s); the next is the refresh, a minute after that.
    expect(fetches).toHaveLength(2)
  })

  test('a read given up on that answers late doesn’t overwrite a newer one', async ($, on) => {
    let call = 0
    let late: (r: HttpResponse) => void = () => {}
    const { clock } = world(on, {
      fetch: () => (++call === 1 ? new Promise<HttpResponse>(resolve => (late = resolve)) : ok(USAGE_BODY)),
    })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await clock.advance(6 * MINUTE)
    late(ok({ ...USAGE_BODY, five_hour: { ...USAGE_BODY.five_hour, utilization: 50 } }))
    await clock.settle()
    expect((await rows(await $.ui.mount(band()))).fiveHour).toContain('8%  92% left')
  })

  test('a /usage read that never answers is given up, and limits are read again', async ($, on) => {
    let call = 0
    const { clock, fetches } = world(on, {
      fetch: () => (++call === 1 ? new Promise<HttpResponse>(() => {}) : ok(USAGE_BODY)),
    })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await clock.advance(MINUTE)
    expect(fetches).toHaveLength(2)
    expect((await rows(await $.ui.mount(band()))).fiveHour).toContain('92% left')
  })

  test('a claude.ai login after the start is picked up', async ($, on) => {
    let isLoggedIn = false
    const { clock } = world(on, { authorize: () => (isLoggedIn ? { handle: 'handle', kind: 'bearer' } : null) })
    await start($, clock)
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).fiveHour).toContain('needs a claude.ai subscription login')
    isLoggedIn = true
    await clock.advance(6 * MINUTE)
    expect((await rows(ui)).fiveHour).toContain('92% left')
  })

  test('reads /usage again once a turn has ended, at most every 30 seconds', async ($, on) => {
    const { clock, fetches } = world(on)
    on('turn.complete', () => ({ text: 'done' }))
    await start($, clock)
    const turnEnd = { reason: 'answer', answer: 'done', durationMs: 1_000, turnId: 't1', isAborted: false } as const
    await $.turn.complete(turnEnd)
    await clock.advance(10_000)
    expect(fetches).toHaveLength(1) // the start's read is too recent
    await clock.advance(20_000)
    expect(fetches).toHaveLength(2)
    // A subagent's turn is not the session's, and none of its own has ended
    // since: the next tick, before the refresh is due, reads nothing.
    await $.turn.complete({ ...turnEnd, agentId: 'a1' })
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
    expect(fetches).toHaveLength(1) // a 5xx waits two minutes
    await clock.advance(MINUTE)
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

  test('what another session kept shows within half a second', async ($, on) => {
    const { clock, store, fetches } = world(on)
    await start($, clock)
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).fiveHour).toContain('8%  92% left')
    // Another session's response headers, kept a second later.
    await clock.advance(1_000)
    const at = NOW + 1_000
    store.limits = { five_hour: { used: 41, resetsAt: NOW + 2 * HOUR, at }, seven_day: { used: 70, resetsAt: NOW + 44 * HOUR, at }, at }
    await clock.advance(500)
    let r = await rows(ui)
    expect(r.fiveHour).toContain('41%  59% left')
    expect(r.weekly).toContain('70%  30% left')
    // An older record is not taken.
    store.limits = { five_hour: { used: 3, resetsAt: NOW + 2 * HOUR, at }, at: NOW }
    await clock.advance(500)
    r = await rows(ui)
    expect(r.fiveHour).toContain('41%  59% left')
    expect(fetches).toHaveLength(1)
  })

  test('a /usage read by another session spares this one its own', async ($, on) => {
    const { clock, store, fetches } = world(on)
    await start($, clock)
    await clock.advance(50_000)
    const at = NOW + 50_000
    store.limits = { five_hour: { used: 9, resetsAt: NOW + 2 * HOUR, at }, seven_day: { used: 67, resetsAt: NOW + 44 * HOUR, at }, at }
    await clock.advance(40_000)
    // The refresh is due a minute after the newest reading any session heard.
    expect(fetches).toHaveLength(1)
    await clock.advance(30_000)
    expect(fetches).toHaveLength(2)
  })

  test('what this session hears is kept on top of what another kept meanwhile', async ($, on) => {
    const { clock, store } = world(on)
    await start($, clock)
    await clock.advance(250) // between two syncs
    const at = NOW + 250
    store.limits = { five_hour: { used: 41, resetsAt: NOW + 2 * HOUR, at }, seven_day: { used: 66.4, resetsAt: Date.parse(USAGE_BODY.seven_day.resets_at), at }, at }
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 68, resetsAt: USAGE_BODY.seven_day.resets_at }],
      changed: ['rateLimits'],
    })
    const kept = JSON.parse(JSON.stringify(store.limits)) as { five_hour: { used: number }; seven_day: { used: number }; at: number }
    expect(kept.five_hour.used).toBe(41)
    expect(kept.seven_day.used).toBe(68)
    expect(kept.at).toBeGreaterThan(at)
  })

  test('a session with no subscription login takes no other session’s limits', async ($, on) => {
    const { clock, store } = world(on, { authorize: () => ({ handle: 'key', kind: 'api-key' }) })
    await start($, clock)
    await clock.advance(1_000)
    const at = NOW + 1_000
    store.limits = { five_hour: { used: 41, resetsAt: NOW + 2 * HOUR, at }, at }
    await clock.advance(500)
    expect((await rows(await $.ui.mount(band()))).fiveHour).toContain('unavailable: needs a claude.ai subscription login')
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

  test('a response the engine hasn’t caught up with yet stays exact', async ($, on) => {
    const { clock } = world(on)
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(18_000, 24_100) }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(18_000, 24_100) }
    })
    await start($, clock)
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 })
    await clock.advance(2_000)
    expect((await rows(await $.ui.mount(band()))).context).toContain('42.1k / 200k · 24.1k cached · 18k uncached')
  })

  test('the engine taking in the next request early leaves the split alone', async ($, on) => {
    let tokens: number | undefined
    const { clock } = world(on, {
      usage: () => ({ startedAt: NOW, context: { window: 200_000, tokens, breakdown: { autoCompactThreshold: 160_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(18_000, 24_100) }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(18_000, 24_100) }
    })
    await start($, clock)
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 })
    tokens = 42_100
    await clock.advance(500)
    // The next request's input, before its step ends.
    tokens = 60_000
    await clock.advance(500)
    expect((await rows(await $.ui.mount(band()))).context).toContain('42.1k / 200k · 24.1k cached · 18k uncached')
  })

  test('a rewind the engine reports without a measure moves the row', async ($, on) => {
    let tokens = 50_000
    const { clock } = world(on, {
      usage: () => ({ startedAt: NOW, context: { window: 200_000, tokens, breakdown: { autoCompactThreshold: 160_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    await start($, clock)
    await clock.advance(500)
    tokens = 30_000
    await clock.advance(500)
    expect((await rows(await $.ui.mount(band()))).context).toContain('30k / 200k')
  })

  test('/compact with no count of the messages: Claude Code’s own estimate once the engine lets go', async ($, on) => {
    let compacted = false
    let engineTokens: number | undefined
    const { clock } = world(on, {
      messages: () => {
        if (compacted) throw new Error('transcript unreadable')
        return [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(30_000) }] }]
      },
      usage: () =>
        ({ startedAt: NOW, context: { window: 200_000, tokens: engineTokens, breakdown: { autoCompactThreshold: 160_000, totalTokens: 31_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(500, 49_500) }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(500, 49_500) }
    })
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
    await start($, clock)
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 2 })
    engineTokens = 50_000
    await clock.advance(500)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'all of it', toolUses: [] }] })
    compacted = true
    await clock.advance(2_000)
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).context).toContain('estimating…')
    engineTokens = undefined
    await clock.advance(500)
    expect((await rows(ui)).context).toContain('~31k / 200k estimated')
  })

  test('/compact with the count still running when the engine lets go: no rough estimate in between', async ($, on) => {
    let compacted = false
    let engineTokens: number | undefined
    let release: () => void = () => {}
    const { clock } = world(on, {
      messages: () => [{ role: 'user', content: [{ type: 'text', text: compacted ? 'summary '.repeat(500) : 'x'.repeat(30_000) }] }],
      // The count of the messages after the compaction answers when released.
      count: body => (body?.includes('summary') ? new Promise<HttpResponse>(resolve => (release = () => resolve(counter(body)))) : counter(body)),
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
    await clock.advance(500)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'all of it', toolUses: [] }] })
    compacted = true
    await clock.advance(1_000)
    engineTokens = undefined
    await clock.advance(1_000)
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).context).toContain('estimating…')
    release()
    await clock.settle()
    expect((await rows(ui)).context).toContain('~24.5k / 200k estimated')
  })

  test('/compact: a transcript that fails while still being read back, after the engine let go', async ($, on) => {
    let compacted = false
    let reads = 0
    let engineTokens: number | undefined
    const before = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(30_000) }] }]
    const { clock } = world(on, {
      messages: () => {
        if (compacted && ++reads > 3) throw new Error('transcript unreadable')
        return before
      },
      usage: () =>
        ({ startedAt: NOW, context: { window: 200_000, tokens: engineTokens, breakdown: { autoCompactThreshold: 160_000, totalTokens: 31_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(500, 49_500) }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(500, 49_500) }
    })
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
    await start($, clock)
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 2 })
    engineTokens = 50_000
    await clock.advance(500)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'all of it', toolUses: [] }] })
    compacted = true
    await clock.advance(1_000)
    engineTokens = undefined
    await clock.advance(3_000)
    expect((await rows(await $.ui.mount(band()))).context).toContain('~31k / 200k estimated')
  })

  test('/compact: a failed count read back between the engine letting go and the next watch', async ($, on) => {
    let compacted = false
    let engineTokens: number | undefined = 50_000
    const { clock } = world(on, {
      messages: () => [{ role: 'user', content: [{ type: 'text', text: compacted ? 'short' : 'x'.repeat(30_000) }] }],
      count: () => ({ status: 500, ok: false, headers: {}, text: '' }),
      usage: () =>
        ({ startedAt: NOW, context: { window: 200_000, tokens: engineTokens, breakdown: { autoCompactThreshold: 160_000, totalTokens: 31_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(500, 49_500) }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(500, 49_500) }
    })
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
    await start($, clock)
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 2 })
    // The compaction's poll runs a quarter-second off the watch's beat.
    await clock.advance(250)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'all of it', toolUses: [] }] })
    compacted = true
    await clock.advance(350) // the watch at 500 still hears 50k
    engineTokens = undefined // let go at 600; the poll reads back at 750
    await clock.advance(1_000)
    expect((await rows(await $.ui.mount(band()))).context).toContain('~31k / 200k estimated')
  })

  test('/compact: a count that never answers gives way to Claude Code’s estimate', async ($, on) => {
    let compacted = false
    let engineTokens: number | undefined
    const { clock } = world(on, {
      messages: () => [{ role: 'user', content: [{ type: 'text', text: compacted ? 'summary '.repeat(500) : 'x'.repeat(30_000) }] }],
      count: body => (body?.includes('summary') ? new Promise<HttpResponse>(() => {}) : counter(body)),
      usage: () =>
        ({ startedAt: NOW, context: { window: 200_000, tokens: engineTokens, breakdown: { autoCompactThreshold: 160_000, totalTokens: 31_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(500, 49_500) }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(500, 49_500) }
    })
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
    await start($, clock)
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 2 })
    engineTokens = 50_000
    await clock.advance(500)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'all of it', toolUses: [] }] })
    compacted = true
    await clock.advance(1_000)
    engineTokens = undefined
    await clock.advance(30_000)
    expect((await rows(await $.ui.mount(band()))).context).toContain('~31k / 200k estimated')
  })

  test('a measure that says the context didn’t move doesn’t bring back an old size', async ($, on) => {
    let compacted = false
    let engineTokens: number | undefined
    const { clock } = world(on, {
      messages: () => [{ role: 'user', content: [{ type: 'text', text: compacted ? 'summary '.repeat(500) : 'x'.repeat(30_000) }] }],
      usage: () =>
        ({ startedAt: NOW, context: { window: 200_000, tokens: engineTokens, breakdown: { autoCompactThreshold: 160_000, totalTokens: 31_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(500, 49_500) }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(500, 49_500) }
    })
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
    await start($, clock)
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 2 })
    engineTokens = 50_000
    await clock.advance(500)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'all of it', toolUses: [] }] })
    compacted = true
    await clock.advance(1_000)
    engineTokens = undefined
    await clock.advance(1_000)
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).context).toContain('~24.5k / 200k estimated')
    // A late measure still carrying the size from before the compaction.
    await $.session.measure({ context: { window: 200_000, tokens: 50_000 }, rateLimits: [], changed: ['cost'] })
    await clock.advance(1_000)
    expect((await rows(ui)).context).toContain('~24.5k / 200k estimated')
  })

  test('a rewind or the end of a compaction: when the engine lets go of its figure, so does the row', async ($, on) => {
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

  test('another chat (/clear, /resume) never shows the last chat’s figures', async ($, on) => {
    let chat = 'A'
    const engine: Record<string, number | undefined> = { A: undefined, B: 61_000, C: undefined }
    const { clock } = world(on, {
      id: () => chat,
      usage: () =>
        ({ startedAt: NOW, context: { window: 200_000, tokens: engine[chat], breakdown: { autoCompactThreshold: 160_000, totalTokens: chat === 'C' ? 41_000 : 40_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    on('turn.step', async function* (_$, e) {
      const u = usage(18_000, 24_100)
      yield { kind: 'stop', stopReason: 'end_turn', usage: u }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: u }
    })
    await start($, clock)
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 })
    engine.A = 42_100
    const ui = await $.ui.mount(band())
    expect((await rows(ui)).context).toContain('42.1k / 200k · 24.1k cached · 18k uncached')

    // /resume B: A ends first, and the engine keeps A's id for a moment.
    const end = (reason: string) => $.session.end({ reason, sessionId: chat, resume: { id: chat } } as never)
    await end('resume')
    let r = (await rows(ui)).context
    expect(r).toContain('estimating…')
    expect(r).not.toMatch(/42\.1k|cached/)
    await clock.advance(500)
    expect((await rows(ui)).context).toContain('estimating…')
    chat = 'B'
    // Then B's own last figure, as the engine has it from its transcript. The
    // split comes with B's next response.
    await clock.advance(500)
    r = (await rows(ui)).context
    expect(r).toContain('61k / 200k · 99k to auto-compact')
    expect(r).not.toContain('cached')

    // /clear: a new, empty chat has only the estimate.
    await end('clear')
    expect((await rows(ui)).context).toContain('estimating…')
    chat = 'C'
    await clock.advance(500)
    r = (await rows(ui)).context
    expect(r).toContain('~41k / 200k estimated')
    expect(r).not.toContain('cached')
    // Its first response is its own.
    await step($, { turnId: 't2', index: 0, model: 'claude-test', messageCount: 1 })
    expect((await rows(ui)).context).toContain('42.1k / 200k · 24.1k cached · 18k uncached')
  })

  test('a compaction that ends after a switch leaves the new chat alone', async ($, on) => {
    let chat = 'A'
    let compacted = false
    const { clock, fetches } = world(on, {
      id: () => chat,
      messages: () => [{ role: 'user', content: [{ type: 'text', text: compacted ? 'short' : 'x'.repeat(30_000) }] }],
      usage: () =>
        ({ startedAt: NOW, context: { window: 200_000, breakdown: { autoCompactThreshold: 160_000, totalTokens: 41_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(500, 49_500) }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(500, 49_500) }
    })
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
    await start($, clock)
    await step($, { turnId: 't1', index: 0, model: 'claude-test', messageCount: 2 })
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'all of it', toolUses: [] }] })
    chat = 'B'
    compacted = true
    await clock.advance(2_000)
    expect((await rows(await $.ui.mount(band()))).context).toContain('~41k / 200k estimated')
    // The other chat's messages were never sent to be counted: only chat A's, before.
    expect(fetches.filter(url => url.endsWith('/count_tokens'))).toHaveLength(1)
  })
})

describe('colors', () => {
  // Each row's bar, in row order: the Text that holds its filled cells.
  async function barColors(ui: { findAll: (q: { type: string; text: RegExp }) => Promise<{ props: Record<string, unknown> }[]> }) {
    return (await ui.findAll({ type: 'Text', text: /^[█▏▎▍▌▋▊▉]+$/ })).map(t => t.props.color)
  }
  // Context 10%, 5-hour 80%, weekly 100%.
  function figures(on: On, theme: () => string) {
    return world(on, {
      theme,
      fetch: () =>
        ok({ five_hour: { ...USAGE_BODY.five_hour, utilization: 80 }, seven_day: { ...USAGE_BODY.seven_day, utilization: 100 } }),
      usage: () => ({ startedAt: NOW, context: { window: 200_000, tokens: 20_000, breakdown: { autoCompactThreshold: 160_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
  }

  test('under 25% a lighter green, 75–89% a darker orange, from 100% a darker red', async ($, on) => {
    const { clock } = figures(on, () => 'dark')
    await start($, clock)
    const ui = await $.ui.mount(band())
    expect(await barColors(ui)).toEqual(['rgb(134,224,151)', 'rgb(245,140,20)', 'rgb(200,45,65)'])
    // The percent takes its bar's color.
    expect((await ui.find({ key: 'Weekly' }))?.text).toContain('100%')
    expect((await ui.findAll({ type: 'Text', text: /^ *100%$/ }))[0]?.props.color).toBe('rgb(200,45,65)')
  })

  test('inside their levels, the theme’s own green, amber and red', async ($, on) => {
    const { clock } = world(on, {
      fetch: () => ok({ five_hour: { ...USAGE_BODY.five_hour, utilization: 62.5 }, seven_day: { ...USAGE_BODY.seven_day, utilization: 90 } }),
      usage: () => ({ startedAt: NOW, context: { window: 200_000, tokens: 60_000, breakdown: { autoCompactThreshold: 160_000 } }, rateLimits: [] }) as unknown as SessionUsage,
    })
    await start($, clock)
    expect(await barColors(await $.ui.mount(band()))).toEqual(['rgb(78,186,101)', 'rgb(255,193,7)', 'rgb(255,107,128)'])
  })

  test('the color glides from level to level, with no step to see', async ($, on) => {
    const { clock } = world(on, { fetch: () => ok({ ...USAGE_BODY, seven_day: { ...USAGE_BODY.seven_day, utilization: 1 } }) })
    await start($, clock)
    const ui = await $.ui.mount(band())
    const channels = async () => {
      return String((await barColors(ui))[2]).match(/\d+/g)!.map(Number)
    }
    let was = await channels()
    let largest = 0
    // Weekly from 1% (the first eighth of a cell) to 110%, a tenth of a point at a time.
    for (let tenths = 11; tenths <= 1100; tenths++) {
      await $.session.measure({
        context: { window: 200_000 },
        rateLimits: [{ kind: 'seven_day', percentUsed: tenths / 10, resetsAt: USAGE_BODY.seven_day.resets_at }],
        changed: ['rateLimits'],
      })
      const now = await channels()
      largest = Math.max(largest, ...now.map((c, k) => Math.abs(c - was[k]!)))
      was = now
    }
    // One level's color was 53 to 177 from the next's in some channel; a
    // tenth of a point now moves a channel by 3 at most.
    expect(largest).toBeGreaterThan(0)
    expect(largest).toBeLessThanOrEqual(3)
    expect(was).toEqual([200, 45, 65])
  })

  test('the light theme gets shades of its own, and any other theme keeps its colors', async ($, on) => {
    let theme = 'light'
    const { clock } = figures(on, () => theme)
    await start($, clock)
    const ui = await $.ui.mount(band())
    expect(await barColors(ui)).toEqual(['rgb(96,176,108)', 'rgb(115,72,10)', 'rgb(125,20,40)'])
    // Changed in /config, the band follows.
    theme = 'dark-daltonized'
    await $.config.set({ key: 'theme', value: 'dark-daltonized', previous: 'light', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
    expect(await barColors(ui)).toEqual(['success', 'warning', 'error'])
  })
})

describe('layout', () => {
  test('a figure that rounds to 1000k is shown as 1M', async ($, on) => {
    const { clock } = world(on, {
      usage: () => ({ startedAt: NOW, context: { window: 1_000_000, tokens: 999_960 }, rateLimits: [] }) as unknown as SessionUsage,
    })
    await start($, clock)
    expect((await rows(await $.ui.mount(band()))).context).toContain('1M / 1M')
  })

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
