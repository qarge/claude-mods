// Copyright __YEAR__ qarge
// SPDX-License-Identifier: MIT

import { expect, test } from 'claude-code/testing'

// The test's own hooks sit beneath the mod and stand for the engine: each
// event or $ call the mod reaches needs one (a $ call answers { value }).

test('/__NAME__ answers', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const { text } = await $.command.run({
    command: '__NAME__',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(text).toBe('__NAME__ is loaded.')
})
