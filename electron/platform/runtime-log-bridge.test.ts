import { describe, expect, it } from 'vitest'
import { createPlatformLogBridge } from './runtime-log-bridge'

interface Recorded {
  level: string
  source: string
  event: string
  message: string
  detail: Record<string, unknown>
}

function sink() {
  const entries: Recorded[] = []
  return {
    entries,
    write: (
      level: Recorded['level'],
      source: Recorded['source'],
      event: string,
      message: string,
      detail: Record<string, unknown>,
    ) => {
      entries.push({ level, source, event, message, detail })
    },
  }
}

describe('platform runtime log bridge', () => {
  it('replays entries made before the runtime log exists, in order', () => {
    const bridge = createPlatformLogBridge()
    const target = sink()
    bridge.logger('info', 'ipc', 'first', '第一条', { durationMs: 1 })
    bridge.logger('warn', 'security', 'second', '第二条', { channel: 'x' })
    expect(target.entries).toHaveLength(0)
    bridge.attach(target.write as never)
    expect(target.entries.map((entry) => entry.event)).toEqual([
      'first',
      'second',
    ])
    expect(target.entries[1]!.detail).toEqual({ channel: 'x' })
  })

  it('forwards later entries straight through', () => {
    const bridge = createPlatformLogBridge()
    const target = sink()
    bridge.attach(target.write as never)
    bridge.logger('debug', 'ipc', 'later', '之后', {})
    expect(target.entries.map((entry) => entry.event)).toEqual(['later'])
  })

  it('keeps the newest entries and reports how many the buffer lost', () => {
    const bridge = createPlatformLogBridge(2)
    const target = sink()
    for (const event of ['a', 'b', 'c', 'd'])
      bridge.logger('info', 'ipc', event, event, {})
    bridge.attach(target.write as never)
    expect(target.entries.map((entry) => entry.event)).toEqual([
      'platform.log.overflow',
      'c',
      'd',
    ])
    expect(target.entries[0]!.detail).toEqual({ droppedEntries: 2 })
  })
})
