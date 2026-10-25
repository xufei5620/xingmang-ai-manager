import type {
  CodexRemoteBoundPeerSnapshot,
  CodexRemoteChannelSnapshot,
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

/** 「打开遥控」那一行的说明：还差哪一步就说哪一步，都齐了说什么时候会断开。 */
export function remoteSwitchHint(
  snapshot: Pick<CodexRemoteSnapshot, 'workspaceDirectory'>,
  channel: Pick<CodexRemoteChannelSnapshot, 'hasCredential' | 'enabled'>,
  credentialHint: string,
): string {
  if (!channel.enabled && !channel.hasCredential) return credentialHint
  if (!channel.enabled && !snapshot.workspaceDirectory) return '先在上面选好干活的文件夹。'
  return '关掉星芒就断开，下次打开星芒要再打开一次；闲着 4 小时也会自动断开。'
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
