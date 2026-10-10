// Copyright 2026 Anthropic PBC
// Modifications copyright 2026 qarge
// SPDX-License-Identifier: Apache-2.0
//
// Changed by qarge (2026-10-10) from hooks/token-weather.mjs of Token Weather
// in anthropics/claude-code-playground: rewritten for live per-request
// context and the plan's usage limits. See ../NOTICE for the changes.
//
// Token Weather: a live forecast of the context window and the plan's usage
// limits, drawn above the prompt. Three rows (Context, 5-hour, Weekly), one
// scale of weather icons for all of them.
//
// Context, exact where the API says it: turn.step reads each model response's
// usage the moment it finishes (cached and uncached input), so the band moves
// with every request of a turn. Where no response has said it yet (a fresh
// session, after /compact or /clear) the row shows an estimate, marked `~`.
// The figures belong to one chat: /clear and /resume switch chats inside the
// process without a session.start, so they are kept with the session id they
// were measured in, and never drawn for another.
//
// Limits, exact: GET /api/oauth/usage, the endpoint /usage reads, sent with
// the session's credential handle ($.session.authorize: the token itself
// never reaches this module). Fetched at start, after each turn (the headers
// below are read as a request is answered, so they lag its own cost), and
// whenever no reading is fresher than REFRESH_MS. While Claude works, every
// response's rate-limit headers arrive through session.measure. The fetch
// takes about half a second, so a session starts on the last reading any
// session kept ($.store), and the fetch runs alongside the engine's start.
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions.

import type { ApiMessage, EngineInterface, Register, SessionContextUsage, Timer } from 'claude-code'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const COUNT_URL = 'https://api.anthropic.com/v1/messages/count_tokens'
const TICK_MS = 30_000 // countdowns redraw, and stale limits are refetched
const WATCH_MS = 500 // the session id and the engine's context figure are read this often
const MIN_FETCH_MS = 30_000 // at most one /usage read this often
const FETCH_GIVE_UP_MS = 60_000 // a /usage read unanswered this long is let go
const COUNT_GIVE_UP_MS = 20_000 // a compaction's count past this gives way to the engine's estimate
const REFRESH_MS = 5 * 60_000 // limits heard of longer ago than this are fetched again
const STALE_MS = 15 * 60_000 // past this a limit row says how old it is
const STORE_KEY = 'limits' // the last readings, across sessions
const KINDS = ['five_hour', 'seven_day'] // the windows the rows show
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// One scale for the context window and both limits, by percent used. Each
// icon carries U+FE0F, which asks for the emoji glyph: a coding font with its
// own one-cell ⚡ (JetBrains Mono, Nerd Fonts) otherwise draws that, left in
// the two cells the icon takes.
const SKY = [
  { below: 25, icon: '🌞', color: 'success' },
  { below: 50, icon: '⛅\uFE0F', color: 'success' },
  { below: 75, icon: '☔\uFE0F', color: 'warning' },
  { below: 90, icon: '⚡\uFE0F', color: 'warning' },
  { below: 100, icon: '🌀', color: 'error' },
  { below: Infinity, icon: '⛔\uFE0F', color: 'error' },
] as const
type Sky = { icon: string; color?: string }
const WAITING: Sky = { icon: '⏳\uFE0F' }
const UNKNOWN: Sky = { icon: '❔\uFE0F' }

type Limit = { used: number; resetsAt?: number; at: number }

// The session's readings. Module state: a reload runs session.start again,
// which reads everything afresh.
let session: string | undefined // the chat the context figures below belong to
let ended: string | undefined // a chat /clear or /resume has left, until the next one is in
let ctx: {
  window?: number
  compactAt?: number
  tokens?: number // exact: the last main-loop response's input
  cached?: number // of which read from the prompt cache
  uncached?: number // of which not: plain input and cache writes
  output?: number // that response's own output, which the next request carries too
  estimate?: number // when no response has measured the context yet
  stale?: number // the engine's figure from before a compaction, until it lets go of it
} = {}
let limits: Record<string, Limit> = {}
let limitsNote: string | undefined // why a limit row is empty, when it is
let hasRead = false // /usage has answered: a window it leaves out has none open
let fetchedAt = -Infinity
let retryAt = 0
let isFetching = false
let fetchGen = 0 // the /usage read whose answer counts: a newer one, once an older is given up
let hasTurnEnded = false
let ticker: Timer | undefined
let watcher: Timer | undefined
let isWatching = false
let isCounting = false // a compaction's messages are being counted
let heard: number | undefined // the engine's context figure, as last read

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    limits = saved(await $.store.get(STORE_KEY).catch(() => undefined), await $.clock.now())
    limitsNote = undefined
    hasRead = false
    fetchedAt = -Infinity
    retryAt = 0
    hasTurnEnded = false
    fetchLimits($).catch(() => {}) // not awaited: the engine starts meanwhile
    const result = await next(e)
    session = await $.session.id()
    ctx = {}
    await readUsage($)
    $.ui.invalidate('ui.render') // the band can draw now that the window is known
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($).catch(() => {}))
    watcher?.cancel()
    watcher = $.clock.every(WATCH_MS, () => void watch($))
    return result
  })

  // /clear and /resume end the chat before the next one takes its id: from
  // here nothing of this one is drawn, and the watch waits for the new id.
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      ended = e.sessionId
      session = undefined
      ctx = { window: ctx.window, compactAt: ctx.compactAt }
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const isNewWindow = e.context.window !== ctx.window
    // Like the rate limits, the context figure rides along with every
    // measure; it is news only when it moved.
    if (e.changed.includes('context')) {
      applyContext(e.context)
    } else {
      ctx.window = e.context.window
    }
    // The rate limits ride along with every measure, as the last response
    // left them; they are news only when they moved.
    if (e.changed.includes('rateLimits')) {
      const now = await $.clock.now()
      for (const limit of e.rateLimits) {
        if (KINDS.includes(limit.kind)) {
          setLimit(limit.kind, limit.percentUsed, timeOf(limit.resetsAt), now, true)
        }
      }
      keepLimits($)
    }
    if (isNewWindow) {
      await readUsage($) // another model: its own compaction point
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const usage = response.usage
    if (!e.agentId && usage) {
      // A subagent's window is its own; this is the main conversation's.
      const cached = usage.cache_read_input_tokens ?? 0
      const uncached = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      session = await $.session.id()
      ctx = { window: ctx.window, compactAt: ctx.compactAt, tokens: cached + uncached, cached, uncached, output: usage.output_tokens ?? 0 }
      $.ui.invalidate('ui.render')
    }
    return response
  })

  // No measurement follows a compaction, and the engine's own figure keeps
  // the old size for a while, so the row is put right here: the last exact
  // size, less the messages compacted, plus the messages that replace them,
  // both counted with the API's token counter.
  on('session.compact', async ($, e, next) => {
    if (e.agentId || e.trigger === 'precompute') {
      return next(e)
    }
    const exact = ctx.tokens === undefined ? undefined : ctx.tokens + (ctx.output ?? 0)
    const before = await $.session.messages({ as: 'api' })
    const beforeTokens = exact === undefined ? undefined : countTokens($, before) // alongside the compaction
    const result = await next(e)
    if (result.skip === undefined) {
      ctx = { window: ctx.window, compactAt: ctx.compactAt, stale: ctx.tokens }
      $.ui.invalidate('ui.render')
      isCounting = true
      Promise.race([
        estimateCompacted($, session, before, exact, beforeTokens),
        new Promise<never>((_, reject) => $.clock.after(COUNT_GIVE_UP_MS, () => reject(new Error('count timed out')))),
      ])
        .catch(() => readUsage($).then(() => $.ui.invalidate('ui.render')))
        .finally(() => (isCounting = false))
    }
    return result
  })

  on('turn.complete', ($, e, next) => {
    if (!e.agentId) {
      hasTurnEnded = true // the next tick reads /usage as the turn settled it
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || ctx.window === undefined) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const columns = e.props.bodyColumns
    const rows = [
      // Until the watch has read the chat on screen, nothing of another shows.
      contextRow((await $.session.id()) === session),
      limitRow('5-hour', limits.five_hour, now, columns, false),
      limitRow('Weekly', limits.seven_day, now, columns, true),
    ]

    if (e.props.maxRows < rows.length || columns < 50) {
      const line = rows.map(r => `${r.sky.icon} ${r.short} ${r.percent}${r.shortDetail ?? ''}`).join('  ')
      return (
        <Box paddingX={1}>
          <Text wrap="truncate-end">{line}</Text>
        </Box>
      )
    }

    const barWidth = columns >= 100 ? 20 : columns >= 70 ? 14 : 8
    // icon 2 + space, label 8, bar, percent 5, gap 2, and the box's padding 2.
    const room = columns - (3 + 8 + barWidth + 5 + 2 + 2)
    return (
      <Box flexDirection="column" paddingX={1}>
        {rows.map(r => {
          const bar = filled(r.ratio, barWidth)
          return (
            <Box key={r.label}>
              <Text>{r.sky.icon} </Text>
              <Text bold>{r.label.padEnd(8)}</Text>
              <Text color={r.sky.color}>{bar}</Text>
              <Text dimColor>{'░'.repeat(barWidth - bar.length)}</Text>
              <Text color={r.sky.color} bold>{r.percent.padStart(5)}</Text>
              <Text dimColor wrap="truncate-end">{'  ' + fit(r.detail, room)}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}

// The status line's figures, and the auto-compaction point from the summary
// breakdown (a local estimate of the categories; it sends no request), whose
// total stands in for the context until a response measures it.
async function readUsage($: EngineInterface) {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    heard = usage.context.tokens
    if (heard === undefined) {
      ctx.stale = undefined // the engine has let go of the size before a compaction
    }
    applyContext(usage.context)
    ctx.compactAt = usage.context.breakdown?.autoCompactThreshold
    if (ctx.tokens === undefined && ctx.stale === undefined) {
      ctx.estimate = usage.context.breakdown?.totalTokens
    }
  } catch {
    // The band keeps what it had.
  }
}

// Every WATCH_MS: whether another chat is on screen (/clear, /resume), and
// whether the engine's context figure moved with no measure (a rewind) or
// was let go (a compaction settled, a rewind). Another chat, or a figure let
// go, is read afresh: the engine's exact one for a resumed chat, else its
// estimate. A response the engine hasn't taken in yet is no change.
async function watch($: EngineInterface) {
  if (isWatching) {
    return
  }
  isWatching = true
  try {
    const id = await $.session.id()
    if (id === ended) {
      return // the chat that ended is still the engine's for a moment
    }
    const { context } = await $.session.usage()
    const was = heard
    heard = context.tokens
    if (id !== session) {
      session = id
      ended = undefined
    } else if (context.tokens === was) {
      return
    } else if (context.tokens !== undefined) {
      // Down with no measure is a rewind; up is the next request taken in
      // early, which its step measures with the split.
      if (ctx.tokens === undefined || context.tokens < ctx.tokens) {
        applyContext(context)
        $.ui.invalidate('ui.render')
      }
      return
    } else if (ctx.stale !== undefined) {
      ctx.stale = undefined // the compaction has settled
      if (ctx.estimate !== undefined || isCounting) {
        return // its messages are counted, or being counted
      }
    }
    ctx = { window: ctx.window, compactAt: ctx.compactAt }
    await readUsage($)
    $.ui.invalidate('ui.render')
  } catch {
    // Read again on the next round.
  } finally {
    isWatching = false
  }
}

async function estimateCompacted($: EngineInterface, chat: string | undefined, before: readonly ApiMessage[], exact: number | undefined, beforeTokens: Promise<number | undefined> | undefined) {
  // The conversation the engine reads back changes a moment after the hook.
  let after = before
  for (let i = 0; i < 20 && sameStart(after, before); i++) {
    await new Promise<void>(resolve => $.clock.after(WATCH_MS, resolve))
    if (session !== chat) {
      return // another chat is on screen: its messages are not counted
    }
    after = await $.session.messages({ as: 'api' })
  }
  const was = exact === undefined ? undefined : await beforeTokens
  const now = was === undefined ? undefined : await countTokens($, after)
  if (ctx.tokens !== undefined || session !== chat) {
    return // a response has measured it meanwhile, or another chat is on screen
  }
  if (exact !== undefined && was !== undefined && now !== undefined) {
    ctx.estimate = Math.max(0, exact - was + now)
  } else {
    await readUsage($)
  }
  $.ui.invalidate('ui.render')
}

function sameStart(a: readonly ApiMessage[], b: readonly ApiMessage[]) {
  return a.length === b.length && JSON.stringify(a[0]) === JSON.stringify(b[0])
}

// The API's token counter (POST /v1/messages/count_tokens), for the session's
// model, with the session's credential handle; undefined when it can't answer.
async function countTokens($: EngineInterface, messages: readonly ApiMessage[]) {
  try {
    const auth = await $.session.authorize()
    if (!auth || messages.length === 0) {
      return undefined
    }
    const response = await $.http.fetch(COUNT_URL, {
      method: 'POST',
      auth: auth.handle,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(auth.kind === 'bearer' ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}),
      },
      body: JSON.stringify({ model: await $.session.model(), messages }),
    })
    const n = response.ok ? (JSON.parse(response.text) as { input_tokens?: unknown }).input_tokens : undefined
    return typeof n === 'number' ? n : undefined
  } catch {
    return undefined
  }
}

async function tick($: EngineInterface) {
  $.ui.invalidate('ui.render')
  const now = await $.clock.now()
  if (now < retryAt || now - fetchedAt < MIN_FETCH_MS) {
    return
  }
  const readings = KINDS.flatMap(kind => limits[kind] ?? [])
  const lastHeard = Math.max(fetchedAt, ...readings.map(l => l.at))
  // Once: a reading taken after its own reset waits for the usual refresh.
  const hasReset = readings.some(l => l.resetsAt !== undefined && l.resetsAt <= now && l.at < l.resetsAt)
  if (hasTurnEnded || hasReset || now - lastHeard >= REFRESH_MS) {
    hasTurnEnded = false
    await fetchLimits($)
  }
}

async function fetchLimits($: EngineInterface) {
  const now = await $.clock.now()
  if (isFetching && now - fetchedAt < FETCH_GIVE_UP_MS) {
    return
  }
  isFetching = true
  fetchedAt = now
  const gen = ++fetchGen
  try {
    const auth = await $.session.authorize()
    if (gen !== fetchGen) {
      return
    }
    if (auth?.kind !== 'bearer') {
      // An API key, a gateway or a third-party provider: no plan limits, until
      // a /login (asked again with each refresh).
      limits = {}
      limitsNote = 'needs a claude.ai subscription login'
      retryAt = now + REFRESH_MS
      return
    }
    const response = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (gen !== fetchGen) {
      return // given up on, and a newer read has started
    }
    if (!response.ok) {
      const seconds = Number(response.headers['retry-after'])
      retryAt = now + (seconds > 0 ? seconds * 1000 : response.status >= 500 ? 2 * 60_000 : REFRESH_MS)
      limitsNote = `/usage answered HTTP ${response.status}`
      return
    }
    const data: unknown = JSON.parse(response.text)
    let hasAny = false
    for (const kind of KINDS) {
      const window = (data as Record<string, { utilization?: unknown; resets_at?: unknown } | null>)?.[kind]
      if (typeof window?.utilization === 'number') {
        setLimit(kind, window.utilization, timeOf(window.resets_at), now, false)
        hasAny = true
      } else {
        delete limits[kind] // /usage lists no such window now, and shows none
      }
    }
    limitsNote = hasAny ? undefined : 'no 5-hour or weekly limit on this plan'
    hasRead = true
    retryAt = 0
    keepLimits($)
  } catch {
    if (gen === fetchGen) {
      retryAt = now + 2 * 60_000
      limitsNote = '/usage could not be read'
    }
  } finally {
    if (gen === fetchGen) {
      isFetching = false
    }
    $.ui.invalidate('ui.render')
  }
}

// The engine's figure is the last response's input as a whole; the cached
// split stays only while it still describes that figure.
function applyContext(context: SessionContextUsage) {
  ctx.window = context.window
  if (context.tokens === undefined || context.tokens === ctx.stale || context.tokens === ctx.tokens) {
    return
  }
  ctx = { window: ctx.window, compactAt: ctx.compactAt, tokens: context.tokens }
}

// /usage's figure stands as read. A window's use only grows until it resets,
// and the headers' figure runs a point under /usage's (78 to 79), so within
// one window a header never lowers it; a header of a window that reset before
// the one on hand is an old one.
function setLimit(kind: string, used: number, resetsAt: number | undefined, now: number, isHeader: boolean) {
  const had = limits[kind]
  if (isHeader && had?.resetsAt !== undefined && resetsAt !== undefined) {
    if (resetsAt < had.resetsAt - 60_000) {
      return
    }
    if (resetsAt - had.resetsAt < 60_000) {
      used = Math.max(had.used, used)
    }
  }
  limits[kind] = { used, resetsAt, at: now }
}

// The readings for the next session's first frame, whichever session made them last.
function keepLimits($: EngineInterface) {
  $.store.set(STORE_KEY, limits).catch(() => {})
}

// A kept reading, less what can't stand: a window that has reset since, or a
// value no reading has.
function saved(value: unknown, now: number) {
  const kept: Record<string, Limit> = {}
  for (const kind of KINDS) {
    const l = (value as Record<string, Partial<Limit> | null> | undefined)?.[kind]
    if (typeof l?.used === 'number' && l.used >= 0 && l.used < 1000 && typeof l.at === 'number' && l.at <= now && typeof l.resetsAt === 'number' && l.resetsAt > now) {
      kept[kind] = { used: l.used, resetsAt: l.resetsAt, at: l.at }
    }
  }
  return kept
}

type Row = {
  label: string
  short: string
  sky: Sky
  ratio: number
  percent: string
  detail: string
  shortDetail?: string
}

function contextRow(isOwn: boolean): Row {
  const window = ctx.window ?? 0
  const isExact = isOwn && ctx.tokens !== undefined
  const tokens = isOwn ? (ctx.tokens ?? ctx.estimate) : undefined
  if (tokens === undefined) {
    return { label: 'Context', short: 'ctx', sky: WAITING, ratio: 0, percent: '—', detail: `of ${short(window)} · estimating…` }
  }
  const mark = isExact ? '' : '~'
  const parts = [`${mark}${short(tokens)} / ${short(window)}${isExact ? '' : ' estimated'}`]
  if (ctx.cached !== undefined && ctx.uncached !== undefined) {
    parts.push(`${short(ctx.cached)} cached · ${short(ctx.uncached)} uncached`)
  }
  parts.push(ctx.compactAt ? `${mark}${short(Math.max(0, ctx.compactAt - tokens))} to auto-compact` : `${mark}${short(Math.max(0, window - tokens))} free`)
  // The weather counts toward auto-compaction, where the window really ends;
  // the percentage is of the whole window, as the status line has it.
  return {
    label: 'Context',
    short: 'ctx',
    sky: skyFor((tokens / (ctx.compactAt ?? window)) * 100),
    ratio: tokens / window,
    percent: `${mark}${Math.round((tokens / window) * 100)}%`,
    detail: parts.join(' · '),
  }
}

function limitRow(label: string, limit: Limit | undefined, now: number, columns: number, isWeekly: boolean): Row {
  const shortLabel = isWeekly ? 'wk' : '5h'
  if (!limit) {
    return {
      label,
      short: shortLabel,
      sky: limitsNote || hasRead ? UNKNOWN : WAITING,
      ratio: 0,
      percent: '—',
      detail: limitsNote ? `unavailable: ${limitsNote}` : hasRead ? 'none open now (/usage lists none)' : 'reading /usage…',
    }
  }
  // Whole percents rounded down, as /usage shows them.
  const used = Math.floor(limit.used)
  const parts = [`${Math.max(0, 100 - used)}% left`]
  let shortDetail: string | undefined
  if (limit.resetsAt !== undefined) {
    const left = limit.resetsAt - now
    if (left > 0) {
      const at = columns >= 90 ? clockOf(limit.resetsAt, isWeekly) : ''
      parts.push(`resets in ${until(left)}${at ? ` (${at})` : ''}`)
      shortDetail = ` ↻${until(left)}`
    } else {
      parts.push('reset due, refreshing')
    }
  }
  if (now - limit.at >= STALE_MS) {
    parts.push(`as of ${until(now - limit.at)} ago`)
  }
  return {
    label,
    short: shortLabel,
    sky: skyFor(limit.used),
    ratio: limit.used / 100,
    percent: `${used}%`,
    detail: parts.join(' · '),
    shortDetail,
  }
}

function skyFor(percent: number): Sky {
  return SKY.find(s => percent < s.below) ?? SKY[SKY.length - 1]!
}

// The filled part of a bar `width` cells wide, to an eighth of a cell.
function filled(ratio: number, width: number) {
  const cells = Math.max(0, Math.min(1, ratio)) * width
  const whole = Math.floor(cells)
  const part = whole < width ? EIGHTHS[Math.floor((cells - whole) * 8)] ?? '' : ''
  return '█'.repeat(whole) + part
}

function fit(text: string, room: number) {
  if (room <= 1) {
    return ''
  }
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`
}

function until(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

// To the nearest minute: the same reset comes as 14:09:59.95 from one read
// and 14:10:00 from the next.
function clockOf(time: number, withDay: boolean) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(withDay ? { weekday: 'short' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(Math.round(time / 60_000) * 60_000)
  } catch {
    return ''
  }
}

function timeOf(iso: unknown) {
  const time = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isNaN(time) ? undefined : time
}

function short(n: number) {
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}
