import { describe, expect, it } from 'vitest'
import type { CodexRemoteChannelSnapshot, CodexRemoteSnapshot } from '../../../../../electron/ipc-contract'
import {
  boundPeerText,
  lastRequestText,
  newerRemoteSnapshot,
  pairingAttemptText,
  pendingApprovalsText,
  remoteCardMeta,
  remoteChannelCollapsed,
  remoteClockText,
  remoteElapsedText,
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

const quiet = '机器人还没收到任何消息。'

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
    // 缺省「不自动关」（YF-10）：不说闲着几小时断开。
    expect(remoteSwitchHint(snapshot(), channel(), '先在上面填好飞书应用。')).toBe('开着时电脑不会自己睡着，合上笔记本盖子还是会睡。窗口缩到托盘也照样开着，退出星芒才断开，下次打开星芒要再打开一次。')
    expect(remoteSwitchHint(snapshot({ idleCloseHours: 4 }), channel(), '先在上面填好飞书应用。')).toBe('开着时电脑不会自己睡着，合上笔记本盖子还是会睡。窗口缩到托盘也照样开着，退出星芒才断开，下次打开星芒要再打开一次；闲着 4 小时也会自动断开。')
    expect(remoteSwitchHint(snapshot({ idleCloseHours: 12 }), channel(), '先在上面填好飞书应用。')).toBe('开着时电脑不会自己睡着，合上笔记本盖子还是会睡。窗口缩到托盘也照样开着，退出星芒才断开，下次打开星芒要再打开一次；闲着 12 小时也会自动断开。')
    expect(remoteSwitchHint(snapshot({ autoStart: true, idleCloseHours: 4 }), channel(), '先在上面填好飞书应用。')).toBe('开着时电脑不会自己睡着，合上笔记本盖子还是会睡。窗口缩到托盘也照样开着，退出星芒才断开；闲着 4 小时也会自动断开。')
    expect(remoteSwitchHint(snapshot({ autoStart: true }), channel(), '先在上面填好飞书应用。')).toBe('开着时电脑不会自己睡着，合上笔记本盖子还是会睡。窗口缩到托盘也照样开着，退出星芒才断开。')
    // 开着的时候不再说「先填」：关掉的说法要一直看得到。
    expect(remoteSwitchHint(snapshot({ workspaceDirectory: null }), channel({ enabled: true }), '先在上面填好飞书应用。')).toContain('退出星芒才断开')
  })

  // Mac 上没有托盘（「菜单栏改」）：只换中间那截，前后跟着设置走的照旧。
  it('says the menu bar instead of the tray on a Mac', () => {
    expect(remoteSwitchHint(snapshot(), channel(), '先在上面填好飞书应用。', true)).toBe('开着时电脑不会自己睡着，合上笔记本盖子还是会睡。窗口收到菜单栏也照样开着，退出星芒才断开，下次打开星芒要再打开一次。')
    expect(remoteSwitchHint(snapshot({ autoStart: true, idleCloseHours: 4 }), channel(), '先在上面填好飞书应用。', true)).toBe('开着时电脑不会自己睡着，合上笔记本盖子还是会睡。窗口收到菜单栏也照样开着，退出星芒才断开；闲着 4 小时也会自动断开。')
    expect(remoteSwitchHint(snapshot(), channel({ hasCredential: false }), '先在上面填好飞书应用。', true)).toBe('先在上面填好飞书应用。')
    expect(remoteSwitchHint(snapshot(), channel(), '先在上面填好飞书应用。', false)).toContain('窗口缩到托盘也照样开着')
  })

  it('names the bound person by nickname and id tail, or by the tail alone', () => {
    const boundAt = new Date(2026, 9, 25, 14, 5).getTime()
    expect(boundPeerText({ displayName: '小明', userIdTail: 'a1b2', boundAt })).toBe('小明（尾号 a1b2），10 月 25 日 14:05 配对')
    expect(boundPeerText({ userIdTail: 'a1b2', boundAt })).toBe('尾号 a1b2 的账号，10 月 25 日 14:05 配对')
  })

  it('says how many wrong pairing codes came in, and that the code was voided once they ran out', () => {
    expect(pairingAttemptText(channel(), quiet)).toBeNull()
    expect(pairingAttemptText(channel({ pairing: { code: '000042', expiresAt: 1 } }), quiet)).toBeNull()
    expect(pairingAttemptText(channel({ pairing: { code: '000042', expiresAt: 1, failures: 1 } }), quiet)).toBe('配对码错了 1 次')
    expect(pairingAttemptText(channel({ pairingLocked: true }), quiet)).toBe('这个码已经作废，请重新开始配对。')
    // A new code replaces the voided one.
    expect(pairingAttemptText(channel({ pairing: { code: '000043', expiresAt: 1 }, pairingLocked: true }), quiet)).toBeNull()
  })

  // YF-2：码挂了 1 分钟还没收到私聊，说可能是哪儿没配好；错码那句优先。
  it('says why a pairing code got no answer: nothing arrived at all, or only group messages did', () => {
    expect(pairingAttemptText(channel({ pairing: { code: '000042', expiresAt: 1, quiet: 'nothing' } }), quiet)).toBe(quiet)
    expect(pairingAttemptText(channel({ pairing: { code: '000042', expiresAt: 1, quiet: 'group-only' } }), quiet)).toBe('收到的是群里的消息，不算。要点开机器人单独私聊它。')
    expect(pairingAttemptText(channel({ pairing: { code: '000042', expiresAt: 1, quiet: 'nothing', failures: 2 } }), quiet)).toBe('配对码错了 2 次')
  })
})

describe('last phone request (YF-13)', () => {
  const now = new Date(2026, 10, 11, 14, 8, 30).getTime()
  const at = new Date(2026, 10, 11, 14, 5, 0).getTime()

  it('writes the clock for today and adds the date for an earlier day', () => {
    expect(remoteClockText(at, now)).toBe('14:05')
    expect(remoteClockText(new Date(2026, 10, 10, 23, 50).getTime(), now)).toBe('11 月 10 日 23:50')
  })

  it('rounds the elapsed time down to whole minutes', () => {
    expect(remoteElapsedText(59_000)).toBe('不到 1 分钟')
    expect(remoteElapsedText(3 * 60_000 + 59_000)).toBe('3 分钟')
    expect(remoteElapsedText(65 * 60_000)).toBe('1 小时 5 分钟')
    expect(remoteElapsedText(120 * 60_000)).toBe('2 小时')
    expect(remoteElapsedText(-5)).toBe('不到 1 分钟')
  })

  it('says when it came in and how far it got, never what was asked', () => {
    expect(lastRequestText({ receivedAt: at, state: 'running' }, now)).toBe('14:05 发来一条，正在处理，已经 3 分钟')
    expect(lastRequestText({ receivedAt: at, state: 'done' }, now)).toBe('14:05 那一条做完了')
    expect(lastRequestText({ receivedAt: at, state: 'stopped' }, now)).toBe('14:05 那一条停下了')
    expect(lastRequestText({ receivedAt: at, state: 'failed', reason: '余额不够了，充值后再发一次。' }, now)).toBe('14:05 那一条没做完：余额不够了，充值后再发一次。')
    expect(lastRequestText({ receivedAt: at, state: 'failed' }, now)).toBe('14:05 那一条没做完。')
  })

  it('mentions waiting approvals only when there are some', () => {
    expect(pendingApprovalsText(0)).toBeNull()
    expect(pendingApprovalsText(2)).toBe('等你同意 2 条，要在手机上回。')
  })
})

describe('folding a channel that is not logged in (YF-7)', () => {
  it('folds it only while the other channel is logged in, and never once it is logged in or on', () => {
    const feishuIn = snapshot({ channels: { feishu: channel(), weixin: channel({ channel: 'weixin', hasCredential: false, accountLabel: null }) } })
    expect(remoteChannelCollapsed(feishuIn, feishuIn.channels.weixin)).toBe(true)
    expect(remoteChannelCollapsed(feishuIn, feishuIn.channels.feishu)).toBe(false)
    const neither = snapshot({ channels: { feishu: channel({ hasCredential: false, accountLabel: null }), weixin: channel({ channel: 'weixin', hasCredential: false, accountLabel: null }) } })
    expect(remoteChannelCollapsed(neither, neither.channels.weixin)).toBe(false)
    expect(remoteChannelCollapsed(neither, neither.channels.feishu)).toBe(false)
    const weixinOn = snapshot({ channels: { feishu: channel(), weixin: channel({ channel: 'weixin', hasCredential: false, accountLabel: null, enabled: true }) } })
    expect(remoteChannelCollapsed(weixinOn, weixinOn.channels.weixin)).toBe(false)
  })
})
