import { describe, expect, it } from 'vitest'
import type { SleepBlocker } from './cli-keep-awake'
import type { CodexRemoteSnapshot, RemoteChannelId, RemoteChannelState } from './codex-remote-channel'
import { createCodexRemoteKeepAwake, resolveCodexRemoteKeepAwakeChannels } from './codex-remote-keep-awake'

type ChannelState = [enabled: boolean, state: RemoteChannelState]

function snapshot(revision: number, states: Partial<Record<RemoteChannelId, ChannelState>> = {}): CodexRemoteSnapshot {
  function channel(id: RemoteChannelId) {
    const [enabled, state] = states[id] ?? [false, 'stopped']
    return { channel: id, hasCredential: true, accountLabel: null, enabled, status: { state }, boundPeer: null, pairing: null }
  }
  return {
    revision,
    available: true,
    credentialPersistence: 'durable',
    workspaceDirectory: '~/projects/demo',
    task: 'idle',
    pendingApprovals: 0,
    channels: { feishu: channel('feishu'), weixin: channel('weixin') },
  }
}

function fakeBlocker() {
  let next = 1
  const running = new Set<number>()
  const calls: string[] = []
  const blocker: SleepBlocker = {
    start(type) {
      calls.push(`start:${type}`)
      running.add(next)
      return next++
    },
    stop(id) {
      calls.push(`stop:${id}`)
      running.delete(id)
    },
  }
  return { blocker, running, calls }
}

describe('resolveCodexRemoteKeepAwakeChannels', () => {
  it('counts channels that are on and can still hear the phone', () => {
    expect(resolveCodexRemoteKeepAwakeChannels(snapshot(1))).toEqual([])
    expect(resolveCodexRemoteKeepAwakeChannels(snapshot(1, { feishu: [true, 'connected'] }))).toEqual(['feishu'])
    expect(resolveCodexRemoteKeepAwakeChannels(snapshot(1, { feishu: [true, 'connecting'], weixin: [true, 'error'] }))).toEqual(['feishu', 'weixin'])
  })

  it('leaves out channels that wait for a new login on the computer or are switched off', () => {
    expect(resolveCodexRemoteKeepAwakeChannels(snapshot(1, { feishu: [true, 'needs-login'] }))).toEqual([])
    expect(resolveCodexRemoteKeepAwakeChannels(snapshot(1, { weixin: [false, 'error'] }))).toEqual([])
    expect(resolveCodexRemoteKeepAwakeChannels(snapshot(1, { feishu: [true, 'stopped'] }))).toEqual([])
  })
})

describe('createCodexRemoteKeepAwake', () => {
  it('blocks automatic sleep only while a channel is on and lets the screen turn off', () => {
    const { blocker, running, calls } = fakeBlocker()
    const keepAwake = createCodexRemoteKeepAwake({ blocker })
    keepAwake.observe(snapshot(1, { feishu: [true, 'connecting'] }))
    expect(keepAwake.holding()).toBe(true)
    expect(calls).toEqual(['start:prevent-app-suspension'])
    keepAwake.observe(snapshot(2, { feishu: [true, 'connected'] }))
    keepAwake.observe(snapshot(3))
    expect(keepAwake.holding()).toBe(false)
    expect(running.size).toBe(0)
    expect(calls).toEqual(['start:prevent-app-suspension', 'stop:1'])
    keepAwake.dispose()
  })

  it('holds one blocker for both channels and releases after the last one closes', () => {
    const { blocker, calls } = fakeBlocker()
    const keepAwake = createCodexRemoteKeepAwake({ blocker })
    keepAwake.observe(snapshot(1, { feishu: [true, 'connected'] }))
    keepAwake.observe(snapshot(2, { feishu: [true, 'connected'], weixin: [true, 'connected'] }))
    keepAwake.observe(snapshot(3, { weixin: [true, 'connected'] }))
    expect(keepAwake.holding()).toBe(true)
    keepAwake.observe(snapshot(4))
    expect(calls).toEqual(['start:prevent-app-suspension', 'stop:1'])
    keepAwake.dispose()
  })

  it('keeps holding while a channel retries after a network error', () => {
    const { blocker, calls } = fakeBlocker()
    const keepAwake = createCodexRemoteKeepAwake({ blocker })
    keepAwake.observe(snapshot(1, { weixin: [true, 'connected'] }))
    keepAwake.observe(snapshot(2, { weixin: [true, 'error'] }))
    keepAwake.observe(snapshot(3, { weixin: [true, 'connecting'] }))
    expect(keepAwake.holding()).toBe(true)
    expect(calls).toEqual(['start:prevent-app-suspension'])
    keepAwake.dispose()
  })

  it('lets the computer sleep once the only channel needs a new login, and holds again after it', () => {
    const { blocker, calls } = fakeBlocker()
    const keepAwake = createCodexRemoteKeepAwake({ blocker })
    keepAwake.observe(snapshot(1, { weixin: [true, 'connected'] }))
    keepAwake.observe(snapshot(2, { weixin: [true, 'needs-login'] }))
    expect(keepAwake.holding()).toBe(false)
    keepAwake.observe(snapshot(3, { weixin: [true, 'connected'] }))
    expect(keepAwake.holding()).toBe(true)
    expect(calls).toEqual(['start:prevent-app-suspension', 'stop:1', 'start:prevent-app-suspension'])
    keepAwake.dispose()
  })

  it('ignores a snapshot that arrives after a newer one', () => {
    const { blocker } = fakeBlocker()
    const keepAwake = createCodexRemoteKeepAwake({ blocker })
    keepAwake.observe(snapshot(5, { feishu: [true, 'connected'] }))
    keepAwake.observe(snapshot(4))
    keepAwake.observe(snapshot(5))
    expect(keepAwake.holding()).toBe(true)
    keepAwake.dispose()
  })

  it('carries on when the system refuses the blocker and tries again with the next snapshot', () => {
    let refuse = true
    const logs: string[] = []
    const blocker: SleepBlocker = {
      start() {
        if (refuse) throw new Error('denied')
        return 7
      },
      stop() {},
    }
    const keepAwake = createCodexRemoteKeepAwake({ blocker, log: (_level, event) => { logs.push(event) } })
    keepAwake.observe(snapshot(1, { feishu: [true, 'connected'] }))
    expect(keepAwake.holding()).toBe(false)
    expect(logs).toEqual(['codex-remote.keep-awake.start-failed'])
    refuse = false
    keepAwake.observe(snapshot(2, { feishu: [true, 'connected'] }))
    expect(keepAwake.holding()).toBe(true)
    keepAwake.dispose()
  })

  it('logs and forgets the blocker when releasing it fails', () => {
    const logs: string[] = []
    const blocker: SleepBlocker = {
      start: () => 3,
      stop() {
        throw new Error('gone')
      },
    }
    const keepAwake = createCodexRemoteKeepAwake({ blocker, log: (_level, event) => { logs.push(event) } })
    keepAwake.observe(snapshot(1, { feishu: [true, 'connected'] }))
    keepAwake.observe(snapshot(2))
    expect(keepAwake.holding()).toBe(false)
    expect(logs).toEqual(['codex-remote.keep-awake.held', 'codex-remote.keep-awake.stop-failed', 'codex-remote.keep-awake.released'])
  })

  it('tells the tray only when it starts or stops holding', () => {
    const { blocker } = fakeBlocker()
    let changes = 0
    const keepAwake = createCodexRemoteKeepAwake({ blocker, onChange: () => { changes += 1 } })
    keepAwake.observe(snapshot(1, { feishu: [true, 'connecting'] }))
    keepAwake.observe(snapshot(2, { feishu: [true, 'connected'], weixin: [true, 'connected'] }))
    expect(changes).toBe(1)
    keepAwake.observe(snapshot(3))
    expect(changes).toBe(2)
    keepAwake.observe(snapshot(4))
    expect(changes).toBe(2)
    keepAwake.dispose()
  })

  it('keeps going when the tray listener throws', () => {
    const { blocker } = fakeBlocker()
    const logs: string[] = []
    const keepAwake = createCodexRemoteKeepAwake({
      blocker,
      log: (_level, event) => { logs.push(event) },
      onChange: () => {
        throw new Error('tray gone')
      },
    })
    keepAwake.observe(snapshot(1, { feishu: [true, 'connected'] }))
    expect(keepAwake.holding()).toBe(true)
    expect(logs).toContain('codex-remote.keep-awake.notify-failed')
    keepAwake.dispose()
  })

  it('releases on dispose and stays released for later snapshots', () => {
    const { blocker, running } = fakeBlocker()
    const keepAwake = createCodexRemoteKeepAwake({ blocker })
    keepAwake.observe(snapshot(1, { feishu: [true, 'connected'] }))
    keepAwake.dispose()
    keepAwake.observe(snapshot(2, { feishu: [true, 'connected'] }))
    expect(keepAwake.holding()).toBe(false)
    expect(running.size).toBe(0)
  })
})
