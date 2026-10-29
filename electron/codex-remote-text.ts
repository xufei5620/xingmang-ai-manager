import { redactSecretPatterns } from './redaction-patterns'
import { redactHomeDirectory } from './startup-log'
import type { RemoteApprovalKind, RemoteApprovalRequest } from './codex-remote-channel'

// 手机遥控发到聊天里的字、从聊天里认的指令，飞书、微信共用。字都在这一张表里，改字只改这里。

export const remoteMessages = {
  paired: '配对成功。这台电脑上的 Codex 现在只听你的。直接发消息就能让它干活，发「帮助」看能用的指令。',
  received: '收到，Codex 开始处理。',
  busy: 'Codex 还在处理上一条。等它做完再发，或者发「停止」中断它。',
  emptyAnswer: '这一轮做完了，Codex 没有留下文字回复。',
  interrupted: '已停止。',
  nothingToStop: '现在没有在处理的任务。',
  newThread: '已开始新对话。',
  unsupported: '暂时只支持文字消息。',
  help: '直接发消息就能让 Codex 干活。\n能用的指令：新对话、停止、状态、帮助。\nCodex 要改文件、跑会改东西的命令时会先问你，回「同意」或「拒绝」；只是看文件不问。',
  idleClosed: '4 小时没有新消息，手机遥控已自动关闭。要再用，请在电脑上的星芒里重新打开。',
  closedOnComputer: '手机遥控已在电脑上关闭。',
  quitting: '电脑上的星芒关了，遥控已停。再打开星芒并打开遥控才能继续。',
  quitAborted: '电脑上的星芒没关成，遥控还开着，可以接着用。',
  stalled: '这件事 1 小时没有任何进展，已经停下。可以重新说一遍要做什么。',
  codexUnavailable: '电脑上的 Codex 没能启动，请在电脑上的星芒里看一下。',
  commandRefused: 'Codex 想运行的命令太长，手机上显示不全，已经替你拒绝了。确实需要的话，请在电脑上直接用 Codex 做这件事。',
  permissionsRefused: 'Codex 想多要一些权限，但要的范围手机上显示不全，已经替你拒绝了。确实需要的话，请在电脑上直接用 Codex 做这件事。',
  staleApprovalCard: '这张卡片已经失效了（处理过、超时了，或者电脑上的星芒重开过），刚才点的没有生效。有要你同意的事会另发新卡片。',
} as const

export function turnFailedMessage(reason: string): string {
  return reason ? `这一轮没做完：${reason}` : '这一轮没做完。'
}

export function approvalAcceptedMessage(id: string): string {
  return `已同意第 ${id} 条。`
}

export function approvalDeclinedMessage(id: string): string {
  return `已拒绝第 ${id} 条。`
}

export function approvalExpiredMessage(id: string, minutes: number): string {
  return `第 ${id} 条等了 ${minutes} 分钟没回，已自动拒绝。`
}

export function unknownApprovalMessage(id: string): string {
  return `没有第 ${id} 条等你同意的操作。`
}

export function whichApprovalMessage(ids: readonly string[]): string {
  return `现在有 ${ids.length} 条等你同意（${ids.join('、')}），请回「同意 编号」或「拒绝 编号」。`
}

export interface RemoteStatusSummary {
  workspace: string
  running: boolean
  pendingApprovals: number
}

export function statusMessage(status: RemoteStatusSummary): string {
  const now = status.pendingApprovals > 0
    ? `等你同意 ${status.pendingApprovals} 条`
    : status.running ? '正在处理' : '空闲'
  return `工作文件夹：${status.workspace}\n现在：${now}`
}

const approvalTitles: Record<RemoteApprovalKind, string> = {
  command: 'Codex 想运行命令',
  'terminal-input': 'Codex 想往正在运行的程序里输入',
  network: 'Codex 想连网站',
  'file-change': 'Codex 想改文件',
  other: 'Codex 想做一件需要你同意的事',
}

export function approvalTitle(kind: RemoteApprovalKind): string {
  return approvalTitles[kind]
}

/** 没有按钮的渠道发这一段；有按钮的渠道也把它当卡片正文。 */
export function formatApprovalText(request: RemoteApprovalRequest): string {
  const lines = [`${approvalTitle(request.kind)}（第 ${request.approvalId} 条）：`]
  if (request.summary) lines.push(request.summary)
  if (request.cwd) lines.push(`在：${request.cwd}`)
  if (request.reason) lines.push(`原因：${request.reason}`)
  lines.push(`回「同意 ${request.approvalId}」或「拒绝 ${request.approvalId}」。`)
  return lines.join('\n')
}

export type RemoteCommand =
  | { kind: 'prompt'; text: string }
  | { kind: 'new-thread' }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'approval'; decision: 'accept' | 'decline'; approvalId?: string }

const plainCommands: Record<string, RemoteCommand['kind']> = {
  新对话: 'new-thread',
  停止: 'stop',
  状态: 'status',
  帮助: 'help',
}

/**
 * 只认整条消息就是指令的（前面可以带 / 或全角／）。「同意」「拒绝」只在有等你同意的操作时才算指令，
 * 别的时候照常交给 Codex：「拒绝」两个字本身也可能是客户想说的话。
 */
export function parseRemoteCommand(text: string, hasPendingApprovals: boolean): RemoteCommand {
  const trimmed = text.trim()
  const bare = trimmed.replace(/^[/／]\s*/, '')
  const plain = plainCommands[bare]
  if (plain === 'new-thread' || plain === 'stop' || plain === 'status' || plain === 'help') return { kind: plain }
  if (hasPendingApprovals) {
    const match = /^(同意|拒绝)(?:\s*(?:第\s*)?(\d{1,4})\s*条?)?$/.exec(bare)
    if (match) {
      return {
        kind: 'approval',
        decision: match[1] === '同意' ? 'accept' : 'decline',
        ...(match[2] ? { approvalId: String(Number(match[2])) } : {}),
      }
    }
  }
  return { kind: 'prompt', text: trimmed }
}

/** 配对码只认整条消息就是这 6 位数字（中间、两边的空格不算）。 */
export function normalizePairingAttempt(text: string): string | null {
  const compact = text.replace(/\s+/g, '')
  return /^\d{6}$/.test(compact) ? compact : null
}

export interface RemoteRedactionOptions {
  /** 一定要遮住的原值：当前 Codex 用的密钥、渠道自己的密钥。 */
  secrets: readonly string[]
  homeDirectory: string
  platform?: NodeJS.Platform
}

/**
 * 主目录换成 ~。redactHomeDirectory 在 Windows、Mac 上写 %USERPROFILE%，那是给客服看日志的；
 * 手机上给客户自己看，统一写 ~ 好认。
 */
export function remoteDisplayPath(text: string, homeDirectory: string, platform?: NodeJS.Platform): string {
  return redactHomeDirectory(text, homeDirectory, platform).split('%USERPROFILE%').join('~')
}

/** 发出电脑的每一段字都过这里（I13）：认得出形状的密钥、点名的原值、主目录路径。 */
export function redactRemoteText(text: string, options: RemoteRedactionOptions): string {
  let result = text
  const secrets = [...new Set(options.secrets.filter((secret) => secret.length >= 6))]
    .sort((left, right) => right.length - left.length)
  for (const secret of secrets) result = result.split(secret).join('[已隐去]')
  result = redactSecretPatterns(result).split('[REDACTED]').join('[已隐去]')
  return remoteDisplayPath(result, options.homeDirectory, options.platform)
}

export function truncateRemoteText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

/**
 * 按渠道的长度上限切成几条，尽量在换行处断开；超过条数上限的部分不发，最后一条末尾说明。
 * 一次回答最多发这么几条，免得一个超长输出刷屏、吃光飞书免费版的调用次数。
 */
export function splitRemoteText(text: string, maxLength: number, maxChunks: number): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  const notice = '\n…（后面太长，没有发完，请到电脑上看）'
  while (rest && chunks.length < maxChunks) {
    if (rest.length <= maxLength) {
      chunks.push(rest)
      rest = ''
      break
    }
    const window = rest.slice(0, maxLength)
    const breakAt = window.lastIndexOf('\n')
    const cut = breakAt > maxLength / 2 ? breakAt : maxLength
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest && chunks.length) {
    const last = chunks[chunks.length - 1]
    chunks[chunks.length - 1] = `${last.slice(0, Math.max(0, maxLength - notice.length))}${notice}`
  }
  return chunks
}
