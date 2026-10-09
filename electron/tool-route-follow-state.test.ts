import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createToolRouteFollowStore,
  parseToolRouteFollowState,
  recordToolRouteRevert,
  toolRouteHintDue,
  toolRouteHintIntervalMs,
  toolRouteRetryAllowed,
  toolRouteRetryLimit,
  toolRouteRevertWindowMs,
} from './tool-route-follow-state'

const identity = 'a'.repeat(64)
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('tool-route-follow-state', () => {
  it('keeps only fields it understands and treats anything unknown as empty', () => {
    expect(parseToolRouteFollowState({ version: 1, providers: {
      codex: { revertIdentity: identity, reverts: [1, 'x', 2, 3], managedElsewhere: true, originalKept: true, hintAt: 5, extra: 'drop' },
      claude: { revertIdentity: 'not-a-fingerprint', baseUrl: 'https://example.com' },
      unknown: { managedElsewhere: true },
    } })).toEqual({ version: 1, providers: {
      codex: { revertIdentity: identity, reverts: [2, 3], managedElsewhere: true, originalKept: true, hintAt: 5 },
      claude: {},
    } })
    for (const raw of [null, [], { version: 2, providers: {} }, { version: 1, providers: [] }]) {
      expect(parseToolRouteFollowState(raw)).toEqual({ version: 1, providers: {} })
    }
  })

  it('marks a config managed elsewhere on the second revert within a day only', () => {
    const now = 10 * toolRouteRevertWindowMs
    const once = recordToolRouteRevert({}, now)
    expect(once).toEqual({ reverts: [now] })
    expect(recordToolRouteRevert(once, now + 1000).managedElsewhere).toBe(true)
    expect(recordToolRouteRevert(once, now + toolRouteRevertWindowMs).managedElsewhere).toBeUndefined()
  })

  it('allows one restart hint per tool per day', () => {
    const now = 10 * toolRouteHintIntervalMs
    expect(toolRouteHintDue(undefined, now)).toBe(true)
    expect(toolRouteHintDue({ hintAt: now - 1000 }, now)).toBe(false)
    expect(toolRouteHintDue({ hintAt: now - toolRouteHintIntervalMs }, now)).toBe(true)
    // 时钟往回拨过：不让一条未来时间的记录把提示压一整天。
    expect(toolRouteHintDue({ hintAt: now + 1000 }, now)).toBe(true)
  })

  it('stops retrying after twelve failures', () => {
    expect(toolRouteRetryLimit).toBe(12)
    expect(toolRouteRetryAllowed(11)).toBe(true)
    expect(toolRouteRetryAllowed(12)).toBe(false)
  })

  it('round-trips through its own file and reads a damaged one as empty', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-route-follow-state-'))
    temporaryDirectories.push(directory)
    const store = createToolRouteFollowStore(path.join(directory, 'state'))
    expect(store.read()).toEqual({ version: 1, providers: {} })
    await store.write({ version: 1, providers: { gemini: { originalKept: true, hintAt: 7 } } })
    expect(store.read()).toEqual({ version: 1, providers: { gemini: { originalKept: true, hintAt: 7 } } })
    fs.writeFileSync(path.join(directory, 'state', 'tool-route-follow.json'), '{broken')
    expect(store.read()).toEqual({ version: 1, providers: {} })
  })
})
