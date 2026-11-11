import type {
  CodexRemoteBoundPeerSnapshot,
  CodexRemoteChannelSnapshot,
  CodexRemoteLastRequestSnapshot,
  CodexRemoteSnapshot,
  RemoteChannelStatus,
} from '../../../../../electron/ipc-contract'

// 「手机遥控 Codex」卡上几处说法的纯函数，卡片和测试共用。

/** 操作的返回值和状态事件都是整份快照、先后不定：只收比手上新的那份。 */
export function newerRemoteSnapshot(current: CodexRemoteSnapshot | null, next: CodexRemoteSnapshot): CodexRemoteSnapshot {
  return current && current.revision > next.revision ? current : next
}

export function remoteTaskLabel(snapshot: Pick<CodexRemoteSnapshot, 'task' | 'pendingApprovals'>): string {
  if (snapshot.task === 'waiting-approval') return `等你同意 ${snapshot.pendingApprovals} 条`
  if (snapshot.task === 'idle') return '空闲'
  return '正在处理'
}

export function remoteAnyEnabled(snapshot: Pick<CodexRemoteSnapshot, 'channels'>): boolean {
  return Object.values(snapshot.channels).some((channel) => channel.enabled)
}

/** 卡片标题右边那句：有渠道开着才说 Codex 在干什么；都没开时不写，各渠道的小标签已经说了「没打开」。 */
export function remoteCardMeta(snapshot: Pick<CodexRemoteSnapshot, 'task' | 'pendingApprovals' | 'channels'>): string | null {
  return remoteAnyEnabled(snapshot) ? `Codex ${remoteTaskLabel(snapshot)}` : null
}

/**
 * 「打开遥控」那一行的说明：还差哪一步就说哪一步，都齐了说开着时电脑睡不睡、什么时候会断开。
 * 开了「打开星芒时自动打开遥控」（YF-9）时不再说「下次打开星芒要再打开一次」：那时下次会自己连上，留着就说反了。
 * 「闲着几小时也会自动断开」跟着「多久没消息就自动关」选的时长走，选了「不自动关」（YF-10 的缺省）就不说。
 */
export function remoteSwitchHint(
  snapshot: Pick<CodexRemoteSnapshot, 'workspaceDirectory' | 'autoStart' | 'idleCloseHours'>,
  channel: Pick<CodexRemoteChannelSnapshot, 'hasCredential' | 'enabled'>,
  credentialHint: string,
): string {
  if (!channel.enabled && !channel.hasCredential) return credentialHint
  if (!channel.enabled && !snapshot.workspaceDirectory) return '先在上面选好干活的文件夹。'
  const reopen = snapshot.autoStart ? '' : '，下次打开星芒要再打开一次'
  const idle = snapshot.idleCloseHours ? `；闲着 ${snapshot.idleCloseHours} 小时也会自动断开` : ''
  return `开着时电脑不会自己睡着，合上笔记本盖子还是会睡。窗口缩到托盘也照样开着，退出星芒才断开${reopen}${idle}。`
}

export function remoteChannelStateLabel(status: RemoteChannelStatus): string {
  switch (status.state) {
    case 'stopped':
      return '没打开'
    case 'connecting':
      return '正在连接'
    case 'connected':
      return '已连上'
    case 'needs-login':
      return '要重新登录'
    case 'error':
      return '出错了'
  }
}

export function remoteChannelStateTone(status: RemoteChannelStatus): 'neutral' | 'ok' | 'warn' | 'bad' {
  if (status.state === 'connected') return 'ok'
  if (status.state === 'needs-login') return 'warn'
  if (status.state === 'error') return 'bad'
  return 'neutral'
}

/** 码挂了 1 分钟只收到群里的消息时，数字下面那句（YF-2）。两个渠道一样。 */
export const pairingGroupOnlyText = '收到的是群里的消息，不算。要点开机器人单独私聊它。'

/**
 * 配对那一行下面的小字（D66 / YKS-21）：手机上发来过错的码就说错了几次，错满作废了说要重新开始配对。
 * 挂了 1 分钟还没收到私聊时说可能是哪儿没配好（YF-2）：quietHint 是这个渠道「一条都没收到」那句。
 * 只在电脑卡片上说，手机那边照旧不回，计数规则也不动。
 */
export function pairingAttemptText(channel: Pick<CodexRemoteChannelSnapshot, 'pairing' | 'pairingLocked'>, quietHint: string): string | null {
  const pairing = channel.pairing
  if (!pairing) return channel.pairingLocked ? '这个码已经作废，请重新开始配对。' : null
  if (pairing.failures) return `配对码错了 ${pairing.failures} 次`
  if (pairing.quiet === 'group-only') return pairingGroupOnlyText
  if (pairing.quiet === 'nothing') return quietHint
  return null
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/** 「张三（尾号 a1b2），10 月 25 日 14:05 配对」。昵称只用来认人，平台编号的尾巴才对得上。 */
export function boundPeerText(peer: CodexRemoteBoundPeerSnapshot): string {
  const date = new Date(peer.boundAt)
  const when = `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
  const who = peer.displayName ? `${peer.displayName}（尾号 ${peer.userIdTail}）` : `尾号 ${peer.userIdTail} 的账号`
  return `${who}，${when} 配对`
}

/** 「14:05」；不是今天的带上日期，「11 月 10 日 23:50」（遥控开着过了半夜）。 */
export function remoteClockText(at: number, now: number): string {
  const date = new Date(at)
  const today = new Date(now)
  const clock = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return sameDay ? clock : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock}`
}

/** 「不到 1 分钟」「3 分钟」「1 小时 5 分钟」「2 小时」：按整分钟往下取。 */
export function remoteElapsedText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

/**
 * 卡片上「最近一次」那行的说明（YF-13）：只说几点发来的、做到哪儿了，手机上发来的原话不上卡片。
 * 没做完时原因用手机上收到的那句大白话（主进程给的 reason）。
 */
export function lastRequestText(request: CodexRemoteLastRequestSnapshot, now: number): string {
  const at = remoteClockText(request.receivedAt, now)
  switch (request.state) {
    case 'running':
      return `${at} 发来一条，正在处理，已经 ${remoteElapsedText(now - request.receivedAt)}`
    case 'done':
      return `${at} 那一条做完了`
    case 'stopped':
      return `${at} 那一条停下了`
    case 'failed':
      return request.reason ? `${at} 那一条没做完：${request.reason}` : `${at} 那一条没做完。`
  }
}

/** 「最近一次」下面那句：有等你同意的才说，同意要在手机上点（YF-13）。 */
export function pendingApprovalsText(count: number): string | null {
  return count > 0 ? `等你同意 ${count} 条，要在手机上回。` : null
}

/** 余额低于这个数（美元）、又没有能用的订阅时，开着遥控的卡片上提醒先充值（YF-12）。 */
export const remoteLowBalanceDollars = 1

/**
 * 没登录的渠道收成一行（YF-7）：没凭据、没开着，而且另一个渠道登录过了。两个都没登录时都摊开，
 * 刚来的人得看得见每个渠道怎么开。
 */
export function remoteChannelCollapsed(snapshot: Pick<CodexRemoteSnapshot, 'channels'>, channel: Pick<CodexRemoteChannelSnapshot, 'channel' | 'hasCredential' | 'enabled'>): boolean {
  if (channel.hasCredential || channel.enabled) return false
  return Object.values(snapshot.channels).some((other) => other.channel !== channel.channel && other.hasCredential)
}
