import { redactSecretPatterns } from './redaction-patterns'
import { redactHomeDirectory } from './startup-log'
import { isRecord } from './input-guards'
import { isServiceUnavailableResponse } from './network-failure'
import { classifyRelayQuotaFailure, relayQuotaFailureMessages } from './relay-quota-failure'
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
  clockAhead: '电脑上的时间和手机差得太多，这条消息没有执行。请把电脑时间调准后再发。',
  // 以下四句是 0.2.24 深查 D66（手机遥控.md YKS-3、16、18、19），yoyo 11-10「决定单照推荐」。
  codexStarting: '电脑正在准备 Codex，稍等一下；想取消就发「停止」。',
  threadReset: '这是新对话，前面的记不得了。',
  unbound: '电脑上已经把你解绑了，之后发的消息不会再执行。',
  idleClosingSoon: '手机遥控 10 分钟后自动关闭，还要用的话随便回一句就行。',
} as const

/** 超过 10 分钟、或者遥控打开以前发的消息照旧不执行，只给绑定的人回这一句（D66 / YKS-9）。 */
export function staleMessageNotice(minutes: number): string {
  return `这条是 ${minutes} 分钟前发的，那会儿电脑没连上，没有执行。还要做的话请再发一次。`
}

export function turnFailedMessage(reason: string): string {
  return reason ? `这一轮没做完：${reason}` : '这一轮没做完。'
}

/**
 * 这一轮没做完的原因里，客户自己能处理的那几种（D66 / YKS-8）。以前把 Codex 和中转的原话（英文、JSON）
 * 原样发到手机，余额不够也看不出来；认得出的换成下面的大白话，原话只进日志。认不出的照旧发原话，
 * 硬说成「连不上」会让人在跟网络无关的故障上一直等。
 */
export type RemoteTurnFailure = 'balance' | 'keyLimit' | 'login' | 'context' | 'connection'

export const remoteTurnFailureMessages: Readonly<Record<RemoteTurnFailure, string>> = {
  balance: '余额不够了，充值后再发一次。',
  // 单子上的四句里没有这一种（密钥自己设的上限用完了，充值也没用），用软件里已有的那句。
  keyLimit: turnFailedMessage(relayQuotaFailureMessages.keyLimit),
  login: '电脑上的登录失效了，请在电脑上的星芒里重新登录。',
  context: '这段对话太长了，发「新对话」重新开始。',
  connection: '电脑这会儿连不上星芒的线路，过一会儿再发。',
}

interface CodexErrorInfoSummary {
  kind: string
  httpStatusCode: number | null
}

/**
 * Codex's `codexErrorInfo` (checked against rust-v0.167.0,
 * app-server-protocol v2 `CodexErrorInfo`): unit variants arrive as a bare
 * camelCase string ("contextWindowExceeded"), the HTTP ones as a one-key
 * object ({ httpConnectionFailed: { httpStatusCode: 403 } }). Anything else
 * is unknown and yields null.
 */
function readCodexErrorInfo(value: unknown): CodexErrorInfoSummary | null {
  if (typeof value === 'string' && value) return { kind: value, httpStatusCode: null }
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length !== 1) return null
  const [kind, detail] = entries[0]
  const status = isRecord(detail) ? detail.httpStatusCode : null
  return { kind, httpStatusCode: typeof status === 'number' && Number.isInteger(status) ? status : null }
}

/**
 * A relay answer Codex did not expect becomes `unexpected status 403 Forbidden: <body>`
 * (UnexpectedResponseError's Display); the body is where new-api and Sub2API
 * say whose money ran out, so the classifier reads the status from there when
 * codexErrorInfo carries none.
 */
function statusInMessage(message: string): number | null {
  const match = /unexpected status (\d{3})(?!\d)/.exec(message)
  return match ? Number(match[1]) : null
}

// Codex's transport-level failures. With no HTTP status the request never got
// an answer; with one, only a gateway-class answer counts as "cannot reach".
const connectionErrorKinds: ReadonlySet<string> = new Set([
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
])

export function classifyRemoteTurnFailure(message: string, codexErrorInfo: unknown): RemoteTurnFailure | null {
  const info = readCodexErrorInfo(codexErrorInfo)
  const status = info?.httpStatusCode ?? statusInMessage(message)
  // 余额、密钥那几句以服务端写死的原话为准（relay-quota-failure.ts），排在笼统的「连不上」前面。
  const quota = status === null ? null : classifyRelayQuotaFailure(status, message)
  if (quota === 'balance' || quota === 'keyLimit') return quota
  if (quota === 'keyInvalid' || info?.kind === 'unauthorized') return 'login'
  if (info?.kind === 'contextWindowExceeded') return 'context'
  if (info?.kind === 'serverOverloaded') return 'connection'
  if (info && connectionErrorKinds.has(info.kind)) {
    if (info.httpStatusCode === null || isServiceUnavailableResponse({ status: info.httpStatusCode, json: false })) return 'connection'
  }
  return null
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

/** 改文件审批卡上一行说的那个文件，路径已经换成手机上显示的样子。 */
export interface RemoteFileChangeLine {
  /** Codex 的 PatchChangeKind；老版本 Codex 不给时是 null，只列路径。 */
  kind: 'add' | 'delete' | 'update' | null
  path: string
  /** 改完挪到的位置（Update 带 move_path 时）。 */
  movePath?: string
  /** 加了、删了多少行；Codex 没给改动内容时不填，这一行就不带行数。 */
  added?: number
  removed?: number
}

/**
 * 改文件卡片上的一行（D66 / YKS-10）：前面写新建、删除、改、挪到，后面带「+12 -3 行」。
 * 删文件和改一行以前在手机上长得一样，客户没法判断该不该同意。
 */
export function formatFileChangeLine(change: RemoteFileChangeLine): string {
  let line = change.path
  if (change.kind === 'add') line = `新建 ${change.path}`
  else if (change.kind === 'delete') line = `删除 ${change.path}`
  else if (change.kind === 'update') line = change.movePath ? `${change.path} 挪到 ${change.movePath}` : `改 ${change.path}`
  return change.added === undefined || change.removed === undefined ? line : `${line} +${change.added} -${change.removed} 行`
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
