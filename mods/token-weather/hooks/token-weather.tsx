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
// Context, live: turn.step reads each model response's usage the moment it
// finishes, so the band moves with every request of a turn (each tool round),
// not once at its end. session.measure is the engine's own push of the same
// figures the status line shows.
//
// Limits, exact: GET /api/oauth/usage, the endpoint /usage reads, sent with
// the session's credential handle ($.session.authorize: the token itself
// never reaches this module). Fetched at start, after each turn (the headers
// below are read as a request is answered, so they lag its own cost), and
// whenever no reading is fresher than REFRESH_MS. While Claude works, every
// response's rate-limit headers arrive through session.measure.
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions.

import type { EngineInterface, ModelUsage, Register, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TICK_MS = 30_000 // countdowns redraw, and stale limits are refetched
const MIN_FETCH_MS = 30_000 // at most one /usage read this often
const REFRESH_MS = 5 * 60_000 // limits heard of longer ago than this are fetched again
const STALE_MS = 15 * 60_000 // past this a limit row says how old it is
const HISTORY = 16
const SPARK = '▁▂▃▄▅▆▇█'
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// One scale for the context window and both limits, by percent used. Every
// icon has emoji presentation by default, so each is two cells in any font.
const SKY = [
  { below: 25, icon: '🌞', color: 'success' },
  { below: 50, icon: '⛅', color: 'success' },
  { below: 75, icon: '☔', color: 'warning' },
  { below: 90, icon: '⚡', color: 'warning' },
  { below: 100, icon: '🌀', color: 'error' },
  { below: Infinity, icon: '⛔', color: 'error' },
] as const
type Sky = { icon: string; color?: string }
const WAITING: Sky = { icon: '⏳' }
const UNKNOWN: Sky = { icon: '❔' }

type Limit = { used: number; resetsAt?: number; at: number }

// The session's readings. Module state: a reload runs session.start again,
// which reads everything afresh.
let ctx: { tokens?: number; window?: number; compactAt?: number } = {}
let history: number[] = []
let turn: { id: string; step: number; from: number; added?: number } | undefined
let limits: Record<string, Limit> = {}
let limitsNote: string | undefined // why a limit row is empty, when it is
let fetchedAt = -Infinity
let retryAt = 0
let isFetching = false
let hasTurnEnded = false
let ticker: Timer | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    ctx = {}
    history = []
    turn = undefined
    limits = {}
    limitsNote = undefined
    fetchedAt = -Infinity
    retryAt = 0
    hasTurnEnded = false
    await readUsage($)
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($))
    // The first /usage read, off the startup path.
    $.clock.after(0, () => void fetchLimits($))
    return result
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') {
      ctx = { window: ctx.window, compactAt: ctx.compactAt }
      history = []
      turn = undefined
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const isNewWindow = e.context.window !== ctx.window
    applyContext(e.context)
    applyLimits(e.rateLimits, await $.clock.now())
    if (isNewWindow) {
      await readUsage($) // another model: its own compaction point
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      return yield* next(e) // a subagent's window is its own
    }
    if (turn?.id !== e.turnId) {
      turn = { id: e.turnId, step: 0, from: ctx.tokens ?? 0 }
    }
    const current = turn
    current.step = e.index + 1
    $.ui.invalidate('ui.render')
    const response = yield* next(e)
    const tokens = contextTokens(response.usage)
    if (tokens !== undefined) {
      ctx.tokens = tokens
      current.added = tokens - current.from
      history = [...history, tokens].slice(-HISTORY)
      $.ui.invalidate('ui.render')
    }
    return response
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
      contextRow(columns, e.props.isWorking),
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
// breakdown (a local estimate of the categories; it sends no request).
async function readUsage($: EngineInterface) {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    applyContext(usage.context)
    ctx.compactAt = usage.context.breakdown?.autoCompactThreshold
    applyLimits(usage.rateLimits, await $.clock.now())
  } catch {
    // The band keeps what it had.
  }
}

async function tick($: EngineInterface) {
  $.ui.invalidate('ui.render')
  const now = await $.clock.now()
  if (now < retryAt || now - fetchedAt < MIN_FETCH_MS) {
    return
  }
  const readings = Object.values(limits)
  const lastHeard = Math.max(fetchedAt, ...readings.map(l => l.at))
  const hasReset = readings.some(l => l.resetsAt !== undefined && l.resetsAt <= now)
  if (hasTurnEnded || hasReset || now - lastHeard >= REFRESH_MS) {
    hasTurnEnded = false
    await fetchLimits($)
  }
}

async function fetchLimits($: EngineInterface) {
  if (isFetching) {
    return
  }
  isFetching = true
  const now = await $.clock.now()
  fetchedAt = now
  try {
    const auth = await $.session.authorize()
    if (auth?.kind !== 'bearer') {
      // An API key, a gateway or a third-party provider: no plan limits.
      limitsNote = 'needs a claude.ai subscription login'
      retryAt = Infinity
      return
    }
    const response = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!response.ok) {
      const seconds = Number(response.headers['retry-after'])
      retryAt = now + (seconds > 0 ? seconds * 1000 : response.status >= 500 ? 2 * 60_000 : REFRESH_MS)
      limitsNote = `/usage answered HTTP ${response.status}`
      return
    }
    const data: unknown = JSON.parse(response.text)
    let hasAny = false
    for (const kind of ['five_hour', 'seven_day']) {
      const window = (data as Record<string, { utilization?: unknown; resets_at?: unknown } | null>)?.[kind]
      if (typeof window?.utilization === 'number') {
        limits[kind] = { used: window.utilization, resetsAt: timeOf(window.resets_at), at: now }
        hasAny = true
      }
    }
    limitsNote = hasAny ? undefined : 'no 5-hour or weekly limit on this plan'
    retryAt = 0
  } catch {
    retryAt = now + 2 * 60_000
    limitsNote = '/usage could not be read'
  } finally {
    isFetching = false
    $.ui.invalidate('ui.render')
  }
}

function applyContext(context: SessionContextUsage) {
  ctx.window = context.window
  ctx.tokens = context.tokens
}

function applyLimits(list: readonly SessionRateLimit[], now: number) {
  for (const limit of list) {
    limits[limit.kind] = { used: limit.percentUsed, resetsAt: timeOf(limit.resetsAt), at: now }
  }
}

// The input side of one response: what the next request is answered over,
// the figure the status line and $.session.usage() report.
function contextTokens(usage: ModelUsage | null | undefined) {
  if (!usage) {
    return undefined
  }
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
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

function contextRow(columns: number, isWorking: boolean): Row {
  const window = ctx.window ?? 0
  const tokens = ctx.tokens
  if (tokens === undefined) {
    return {
      label: 'Context',
      short: 'ctx',
      sky: WAITING,
      ratio: 0,
      percent: '—',
      detail: `of ${short(window)} · fills in after the first response`,
    }
  }
  // The weather counts toward auto-compaction, where the window really ends;
  // the percentage is of the whole window, as the status line has it.
  const limit = ctx.compactAt ?? window
  const parts = [`${short(tokens)} / ${short(window)}`]
  parts.push(ctx.compactAt ? `${short(Math.max(0, ctx.compactAt - tokens))} to auto-compact` : `${short(Math.max(0, window - tokens))} free`)
  if (turn?.added !== undefined) {
    const sign = turn.added >= 0 ? `▲ +${short(turn.added)}` : `▼ ${short(-turn.added)}`
    parts.push(isWorking ? `● ${sign} this turn, step ${turn.step}` : `${sign} last turn`)
  }
  let detail = parts.join(' · ')
  if (columns >= 120 && history.length > 1) {
    detail += `  ${spark()}`
  }
  return {
    label: 'Context',
    short: 'ctx',
    sky: skyFor((tokens / limit) * 100),
    ratio: tokens / window,
    percent: `${Math.round((tokens / window) * 100)}%`,
    detail,
  }
}

function limitRow(label: string, limit: Limit | undefined, now: number, columns: number, isWeekly: boolean): Row {
  const shortLabel = isWeekly ? 'wk' : '5h'
  if (!limit) {
    return {
      label,
      short: shortLabel,
      sky: limitsNote ? UNKNOWN : WAITING,
      ratio: 0,
      percent: '—',
      detail: limitsNote ? `unavailable: ${limitsNote}` : 'reading /usage…',
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

// Bars scale to the fullest reading shown, so growth shows at any fill level.
function spark() {
  const top = Math.max(...history, 1)
  return history.map(t => SPARK[Math.min(SPARK.length - 1, Math.floor((t / top) * (SPARK.length - 1)))]).join('')
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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}
