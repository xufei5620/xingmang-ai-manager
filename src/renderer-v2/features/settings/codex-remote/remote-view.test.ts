import { describe, expect, it } from 'vitest'
import type { CodexRemoteChannelSnapshot, CodexRemoteSnapshot } from '../../../../../electron/ipc-contract'
import {
  boundPeerText,
  newerRemoteSnapshot,
  remoteCardMeta,
  remoteChannelStateLabel,
  remoteChannelStateTone,
  remoteSwitchHint,
  remoteTaskLabel,
} from './remote-view'

function channel(patch: Partial<CodexRemoteChannelSnapshot> = {}): CodexRemoteChannelSnapshot {
  return { channel: 'feishu', hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: false, status: { state: 'stopped' }, boundPeer: null, pairing: null, ...patch }
}

function snapshot(patch: Partial<CodexRemoteSnapshot> = {}): CodexRemoteSnapshot {
  return {
    revision: 1,
    available: true,
    credentialPersistence: 'durable',
    workspaceDirectory: '~/projects/demo',
    task: 'idle',
    pendingApprovals: 0,
    channels: { feishu: channel(), weixin: channel({ channel: 'weixin', hasCredential: false, accountLabel: null }) },
    ...patch,
  }
}

describe('codex remote view', () => {
  it('keeps the newer snapshot whichever of the reply and the push arrives last', () => {
    const older = snapshot({ revision: 4 })
    const newer = snapshot({ revision: 5, task: 'running' })
    expect(newerRemoteSnapshot(null, older)).toBe(older)
    expect(newerRemoteSnapshot(older, newer)).toBe(newer)
    expect(newerRemoteSnapshot(newer, older)).toBe(newer)
  })

  it('says what Codex is doing only while a channel is on', () => {
    expect(remoteTaskLabel({ task: 'waiting-approval', pendingApprovals: 2 })).toBe('等你同意 2 条')
    expect(remoteTaskLabel({ task: 'starting', pendingApprovals: 0 })).toBe('正在处理')
    expect(remoteCardMeta(snapshot())).toBeNull()
    expect(remoteCardMeta(snapshot({ task: 'running', channels: { ...snapshot().channels, feishu: channel({ enabled: true }) } }))).toBe('Codex 正在处理')
  })

  it('labels every channel state and only colours the ones that need attention', () => {
    expect(remoteChannelStateLabel({ state: 'needs-login' })).toBe('要重新登录')
    expect(remoteChannelStateTone({ state: 'connected' })).toBe('ok')
    expect(remoteChannelStateTone({ state: 'needs-login' })).toBe('warn')
    expect(remoteChannelStateTone({ state: 'error' })).toBe('bad')
    expect(remoteChannelStateTone({ state: 'connecting' })).toBe('neutral')
  })

  it('names the missing step before the switch can be turned on', () => {
    expect(remoteSwitchHint(snapshot(), channel({ hasCredential: false }), '先在上面填好飞书应用。')).toBe('先在上面填好飞书应用。')
    expect(remoteSwitchHint(snapshot({ workspaceDirectory: null }), channel(), '先在上面填好飞书应用。')).toBe('先在上面选好干活的文件夹。')
    expect(remoteSwitchHint(snapshot(), channel(), '先在上面填好飞书应用。')).toContain('关掉星芒就断开')
    // 开着的时候不再说「先填」：关掉的说法要一直看得到。
    expect(remoteSwitchHint(snapshot({ workspaceDirectory: null }), channel({ enabled: true }), '先在上面填好飞书应用。')).toContain('关掉星芒就断开')
  })

  it('names the bound person by nickname and id tail, or by the tail alone', () => {
    const boundAt = new Date(2026, 9, 25, 14, 5).getTime()
    expect(boundPeerText({ displayName: '小明', userIdTail: 'a1b2', boundAt })).toBe('小明（尾号 a1b2），10 月 25 日 14:05 配对')
    expect(boundPeerText({ userIdTail: 'a1b2', boundAt })).toBe('尾号 a1b2 的账号，10 月 25 日 14:05 配对')
  })
})
