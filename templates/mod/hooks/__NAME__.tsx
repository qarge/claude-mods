// Copyright __YEAR__ qarge
// SPDX-License-Identifier: MIT
//
// __NAME__: __DESCRIPTION__
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions.

import type { Register } from 'claude-code'

export const register: Register = on => {
  // A first hook to build from: /__NAME__ answers, so the mod is visibly loaded.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: '__NAME__', description: 'Says that __NAME__ is loaded.' })
    return result
  })

  on('command.run', { command: '__NAME__' }, () => ({ text: '__NAME__ is loaded.' }))
}
