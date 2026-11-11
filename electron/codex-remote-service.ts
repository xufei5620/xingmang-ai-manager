import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomInt as cryptoRandomInt } from 'node:crypto'
import {
  AppServerMethodError,
  CodexAppServerClient,
  type AppServerProcess,
} from './codex-remote-app-server'
import {
  remoteChannelIds,
  type CodexRemoteChannelSnapshot,
  type CodexRemoteSnapshot,
  type CodexRemoteTaskState,
  type RemoteApprovalDecision,
  type RemoteApprovalKind,
  type RemoteApprovalRequest,
  type RemoteChannelAdapter,
  type RemoteChannelDependencies,
  type RemoteChannelId,
  type RemoteChannelLogDetail,
  type RemoteChannelLogLevel,
  type RemoteChannelStatus,
  type RemoteInbound,
  type RemoteInboundApproval,
  type RemoteInboundText,
  type RemoteInboundUnsupported,
  type RemoteOutbound,
  type RemoteIdleCloseHours,
  type RemotePeer,
} from './codex-remote-channel'
import { emptyChannelSettings, type CodexRemoteStore } from './codex-remote-store'
import {
  approvalAcceptedMessage,
  approvalDeclinedMessage,
  approvalExpiredMessage,
  approvalExpiringMessage,
  classifyRemoteTurnFailure,
  formatApprovalText,
  formatFileChangeLine,
  idleClosedMessage,
  normalizePairingAttempt,
  parseRemoteCommand,
  redactRemoteText,
  remoteDisplayPath,
  remoteMessages,
  remoteOpenedMessage,
  remoteTurnFailureMessages,
  retryMessage,
  splitRemoteText,
  staleMessageNotice,
  statusMessage,
  truncateRemoteText,
  turnFailedMessage,
  turnSummaryLine,
  unknownApprovalMessage,
  whichApprovalMessage,
  type RemoteFileChangeLine,
} from './codex-remote-text'
import { classifyWorkspace, sensitiveWorkspaceLabel } from './workspace-guard'
import { isRecord } from './input-guards'

// 手机遥控的底座：谁能指挥（配对、只认绑定的那一个人）、Codex 每次要动手前问谁（审批）、
// 发出电脑的字遮掉什么（脱敏），都只在这里决定。渠道（飞书、微信）只管收发。
//
// Security model, in one place:
// - Whoever controls the bound chat account can make Codex act on this
//   computer, so binding needs a fresh 6-digit code shown only on this screen,
//   attempts are capped, and messages from anyone else are dropped silently.
// - Codex runs with approvalPolicy "untrusted", sandbox "workspace-write" and
//   approvals routed to the user (never to an auto reviewer). Every request is
//   answered with plain accept or decline; there is no "accept for session",
//   no full-access mode and no way to run a shell command directly.
// - Threads started from the phone get no MCP servers, plugins or apps: their
//   tool calls do not all go through an approval, so nothing the phone cannot
//   see or stop is handed to the model. Codex on the computer keeps them.
// - Unanswered approvals decline themselves; nothing ever approves by default.
// - A permission request is only put to the user when every part of it fits on
//   the card, and "accept" grants exactly the paths the card listed. A command
//   (or terminal input, or website) is only put to the user when the card shows
//   it whole; one that would be cut short is declined without asking. A file
//   change card lists only whole paths and always keeps its write scope line;
//   one whose write scope alone would not fit is declined without asking.
// - Approval numbers keep counting across restarts, and every button carries a
//   per-request random nonce: a card left in the chat history from an earlier
//   request or an earlier run can never answer a newer one.
// - Only the turn running now may ask: a late request from a stopped or
//   finished turn is declined, and nothing reaches Codex once the turn it was
//   meant for has been switched off.
// - Text that leaves the machine is redacted (I13) and capped.

const pairingTtlMs = 10 * 60_000
/** 配对码挂了这么久还没收到私聊，电脑卡片上说可能是哪儿没配好（YF-2）。 */
const pairingQuietMs = 60_000
const maxPairingFailures = 20
const approvalTimeoutMinutes = 10
const approvalTimeoutMs = approvalTimeoutMinutes * 60_000
/** 等你同意的还剩这么久就提醒一次（YF-20）：人在路上没看到，到点自动拒绝，这一轮多半就做不下去了。 */
const approvalReminderMinutesLeft = 3
const approvalReminderMs = approvalTimeoutMs - approvalReminderMinutesLeft * 60_000
const hourMs = 60 * 60_000
const idleRecheckMs = 30 * 60_000
/** 闲着自动关之前这么久先提醒手机一次（D66 / YKS-19），回什么都会重新起算。 */
const idleWarningMs = 10 * 60_000
/** 起 Codex、开对话超过这么久还没交给 Codex，先跟手机说一声在准备（D66 / YKS-3）。 */
const codexStartingNoticeMs = 15_000
const staleBeforeStartMs = 60_000
const maxMessageAgeMs = 10 * 60_000
/** 回过一句「这条是 N 分钟前发的」以后，这么久里再来的旧消息算同一批，不再回（noticeStale）。 */
const staleNoticeQuietMs = 60_000
/**
 * 电脑上的时间至少快这么多才算「不准」：快不到 1 分钟，开启以后发的消息不会被当成旧的；平台回应里的时间
 * 只到秒，再加上路上的来回，几秒的差也不该算到电脑头上。
 */
const clockAheadToleranceMs = staleBeforeStartMs
const maxReplyChunks = 5
const maxSummaryLength = 1500
const maxReasonLength = 500
const maxFileLines = 20
const seenMessageLimit = 512
const secretsTtlMs = 60_000
const shutdownSendTimeoutMs = 1500
/**
 * 星芒退出前跟手机道别最多等这么久（打磨 B8）：退出不能被一条消息拖住。要比主窗口 prepareToQuit 那 2 秒的
 * 清理预算（window-lifecycle 的 quitCleanupBudgetMs）短，不然道别还没放手，退出那边先记一条「清理超时」。
 */
const farewellTimeoutMs = shutdownSendTimeoutMs
/** 一轮多久没任何动静就当它卡死（打磨 C2，yoyo 10-27「停改」）：Codex 不出声这一轮永远不结束，手机上发什么都是「上一件还没做完」。 */
const turnStallMs = 60 * 60_000
/** 审批编号最多 4 位：手机上回「同意 12」要好打，飞书按钮和文字指令也只认 4 位以内。 */
const maxApprovalNumber = 9999
/** 每个渠道记住最近结束的这么多轮的编号，它们迟到的审批和通知都不认（belongsToOtherTurn）。 */
const maxRetiredTurns = 16
/** Codex 起不来、半路退出时，stderr 最后这么多字进日志。 */
const maxStderrLogLength = 1000
const quittingMessage = '星芒正在退出。'
/**
 * 装、卸 Codex 前停掉遥控那份 Codex，最多等它这么久真退出（releaseCodex）。Windows 上它和它起的命令由
 * taskkill /T /F 一起收掉，平常一两秒；client.stop() 5 秒后还会再补一刀，这里比那个多留一点。
 */
const codexReleaseTimeoutMs = 10_000

/** 电脑上要更新还是卸载 Codex：遥控里的 Codex 正在干活时，挡下来的那句按这个说。 */
export type CodexRemoteReleaseAction = 'update' | 'uninstall'

/** 遥控里的 Codex 正在干活，不替客户停它（#1407 P3-3，yoyo 10-29「按推荐」）。 */
export const codexRemoteBusyMessages: Readonly<Record<CodexRemoteReleaseAction, string>> = {
  update: '手机遥控里的 Codex 正在干活，等它做完再更新，或者先在设置里关掉手机遥控。',
  uninstall: '手机遥控里的 Codex 正在干活，等它做完再卸载，或者先在设置里关掉手机遥控。',
}

const developerInstructions = [
  'You are being driven remotely from a phone chat through the Xingmang desktop app.',
  'The person cannot see this computer\'s screen: reply in plain text, briefly, in the language they write in.',
  'Never print, copy or summarise API keys, tokens, passwords, cookies or the contents of credential files',
  '(for example auth.json, .env, id_rsa, browser profiles), even if asked to; say that this must be done on the computer.',
  'Stay inside the current working directory unless the person explicitly asks otherwise.',
].join(' ')

export interface CodexRemoteServiceOptions {
  store: CodexRemoteStore
  createChannel(channel: RemoteChannelId, deps: RemoteChannelDependencies): RemoteChannelAdapter
  fetch: typeof fetch
  appVersion: string
  homeDirectory: string
  platform?: NodeJS.Platform
  log(level: RemoteChannelLogLevel, event: string, detail?: RemoteChannelLogDetail): void
  now?(): number
  /** 生成配对码用的随机数，缺省 crypto.randomInt。 */
  randomInt?(maxExclusive: number): number
  /** 按 argv 数组起 `codex app-server`（I1）。起不来就抛能上屏的中文。 */
  spawnCodex(): Promise<AppServerProcess>
  /** 发出电脑的字里一定要遮住的原值：Codex 正在用的密钥等。 */
  readCodexSecrets(): Promise<readonly string[]>
  /** 这台电脑现在能不能开遥控；不能就给上屏的原因（比如星芒以管理员身份运行）。 */
  inspectAvailability(): string | null
  /** 打开渠道前看一眼 Codex 命令行工具在不在；不在就给上屏的原因。缺省 = 不看，等真用到时再报。 */
  checkCodexReady?(): Promise<string | null>
  /**
   * 手机上发「状态」时报的余额（美元，YF-18）；没登录、读不到回 null。缺省 = 不报。
   * 读得慢也只等 statusBalanceTimeoutMs，过了就不带这一行，「状态」不能因为余额卡住。
   */
  readBalanceUsd?(): Promise<number | null>
  onStateChanged?(snapshot: CodexRemoteSnapshot): void
}

/** 「状态」等余额最多等这么久（YF-18）。 */
const statusBalanceTimeoutMs = 3_000

export function generatePairingCode(randomInt: (maxExclusive: number) => number): string {
  return String(randomInt(1_000_000)).padStart(6, '0')
}

/** 上一条是 last，这一条用几号：往下数，过了 9999（或读回来的值不对）回到 1。 */
export function nextApprovalNumber(last: number): number {
  return Number.isSafeInteger(last) && last >= 0 && last < maxApprovalNumber ? last + 1 : 1
}

/** 只对这一条审批有效的随机串，放进有按钮渠道的按钮里（16 个字符，飞书按钮值里放得下）。 */
export function generateApprovalNonce(): string {
  return randomBytes(12).toString('base64url')
}

/**
 * 这次审批、这条通知是不是别的那一轮的（#1407 P3-2）。手机上「停止」以后上一轮的审批和结束通知可能晚到，
 * 这时下一轮的编号可能还没从 Codex 回来：只按对话对得上，就会挂到新一轮头上，手机上点一下「同意」，
 * 批的是已经停掉的那一轮的命令。不带编号的（老版本 Codex）照旧只按对话认。
 */
export function belongsToOtherTurn(currentTurnId: string | null, retiredTurnIds: readonly string[], turnId: unknown): boolean {
  if (typeof turnId !== 'string' || !turnId) return false
  return currentTurnId ? turnId !== currentTurnId : retiredTurnIds.includes(turnId)
}

/** 渠道开启前 1 分钟以上、或 10 分钟以前发的消息不算：星芒关着时发的指令不该在下次打开时突然执行。 */
export function isStaleInbound(sentAt: number, channelStartedAt: number, now: number): boolean {
  return sentAt < channelStartedAt - staleBeforeStartMs || sentAt < now - maxMessageAgeMs
}

/**
 * 这条旧消息是不是遥控开着的时候发的，只是电脑合盖、断网没及时收到（D66 / YKS-9）。遥控打开以前的不算：
 * 微信每次打开都从头拉，可能把上次开着时已经执行过的话再送一遍，跟它说「没有执行」就说错了。
 */
export function sentWhileOpen(sentAt: number, channelStartedAt: number): boolean {
  return sentAt >= channelStartedAt - staleBeforeStartMs
}

/**
 * 这条被当成旧消息，是不是只因为电脑上的时间快了（#1407 P3-5）：换成平台的钟再看一遍就不旧了。
 * 只用来决定给手机回不回一句提醒，消息照样不执行，时间校验本身不放宽。
 */
export function isStaleOnlyByClock(sentAt: number, channelStartedAt: number, now: number, clockAheadMs: number | undefined): boolean {
  if (clockAheadMs === undefined || !Number.isFinite(clockAheadMs) || clockAheadMs < clockAheadToleranceMs) return false
  return isStaleInbound(sentAt, channelStartedAt, now) && !isStaleInbound(sentAt, channelStartedAt - clockAheadMs, now - clockAheadMs)
}

/**
 * 遥控开的对话不给客户自己接的外部工具（#1407 P2-4，yoyo 10-29「按推荐」）：MCP 服务、插件、ChatGPT 应用的工具
 * 调用不一定先问人，手机上看不到也拦不住。只关这一份对话，电脑上直接用 Codex 照旧，联网搜索也不动。
 * mcpServers 是 buildRemoteMcpServerOverrides 算出来的那份。
 */
export function buildThreadStartParams(workspace: string, mcpServers: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    cwd: workspace,
    approvalPolicy: 'untrusted',
    // auto_review / guardian 会让另一个模型替人点同意；遥控只许人自己点。
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    developerInstructions,
    config: {
      'features.apps': false,
      'features.plugins': false,
      ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
    },
  }
}

function mcpServerTable(config: unknown): Record<string, unknown> | null {
  return isRecord(config) && isRecord(config.mcp_servers) ? config.mcp_servers : null
}

function mcpServerTransport(server: unknown): Record<string, string> | null {
  if (!isRecord(server)) return null
  if (typeof server.command === 'string') return { command: server.command }
  if (typeof server.url === 'string') return { url: server.url }
  return null
}

/**
 * Turns Codex's `config/read` answer for the workspace (`includeLayers: true`)
 * into a `mcp_servers` override that switches every configured server off.
 *
 * Codex only knows servers by name, and merges an override into the layers
 * instead of replacing the table, so each name has to be listed. Disabled
 * layers count too: a project `.codex/config.toml` in a folder Codex has not
 * trusted yet is a disabled layer here, and thread/start with workspace-write
 * trusts that folder on the spot and loads it. Codex refuses the whole config
 * when an override names a server that has no command or url, so a server that
 * only such a layer defines carries its own command or url along: valid before
 * the folder is trusted, unchanged after. Without layers (an older Codex), the
 * effective config's servers are used.
 */
export function buildRemoteMcpServerOverrides(configRead: unknown): Record<string, Record<string, unknown>> {
  const response = isRecord(configRead) ? configRead : {}
  const layers: unknown[] = Array.isArray(response.layers) ? response.layers : [{ config: response.config, disabledReason: null }]
  const active = new Set<string>()
  const inactive = new Map<string, Record<string, string>>()
  // Codex lists layers from the highest precedence down; the first command or url seen wins, as it does in Codex.
  for (const layer of layers) {
    if (!isRecord(layer)) continue
    const servers = mcpServerTable(layer.config)
    if (!servers) continue
    const disabled = layer.disabledReason !== null && layer.disabledReason !== undefined
    for (const [name, server] of Object.entries(servers)) {
      if (!disabled) active.add(name)
      else if (!inactive.has(name)) {
        const transport = mcpServerTransport(server)
        if (transport) inactive.set(name, transport)
      }
    }
  }
  const entries: Array<[string, Record<string, unknown>]> = [...active].map((name) => [name, { enabled: false }])
  for (const [name, transport] of inactive) {
    if (!active.has(name)) entries.push([name, { ...transport, enabled: false }])
  }
  // fromEntries, not assignment: a server called "__proto__" must stay an own key and be switched off like the rest.
  return Object.fromEntries(entries)
}

/** 渠道凭据（JSON）里的字符串值都当要遮住的原值：App Secret、机器人令牌。 */
export function collectCredentialSecrets(credential: string | null): string[] {
  if (!credential) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(credential)
  } catch {
    return [credential]
  }
  const secrets: string[] = []
  function visit(value: unknown, depth: number): void {
    if (depth > 4) return
    if (typeof value === 'string' && value.length >= 8) secrets.push(value)
    else if (Array.isArray(value)) for (const entry of value) visit(entry, depth + 1)
    else if (isRecord(value)) for (const entry of Object.values(value)) visit(entry, depth + 1)
  }
  visit(parsed, 0)
  return secrets
}

/** 选给遥控用的文件夹：要是存在的目录，不能是主目录、盘根、桌面这类「一份配置管全电脑」的地方。 */
export function validateRemoteWorkspace(directory: unknown, homeDirectory: string, platform: NodeJS.Platform): string {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 4096) {
    throw new Error('请选一个文件夹。')
  }
  const kind = classifyWorkspace(directory, { platform, home: homeDirectory })
  if (kind) throw new Error(`这个文件夹是${sensitiveWorkspaceLabel(kind)}，手机遥控不能在这里用，请选一个具体的项目文件夹。`)
  let info: fs.Stats
  try {
    info = fs.statSync(directory)
  } catch {
    throw new Error('这个文件夹不存在了，请重新选。')
  }
  if (!info.isDirectory()) throw new Error('请选一个文件夹。')
  return path.resolve(directory)
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export interface ApprovalDisplayOptions {
  homeDirectory: string
  platform: NodeJS.Platform
  secrets: readonly string[]
}

function displayPath(value: string, options: ApprovalDisplayOptions): string {
  return remoteDisplayPath(value, options.homeDirectory, options.platform)
}

/** 一份权限申请里手机上逐条显示、同意后也只授予的那几样。 */
export interface RequestedPermissions {
  network: boolean
  read: string[]
  write: string[]
}

/** null 和缺省都算没要；其余的只认非空字符串数组。 */
function readPathList(value: unknown): string[] | null {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) return null
  return value.every((entry): entry is string => typeof entry === 'string' && entry.length > 0) ? value : null
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.entries(record).every(([key, value]) => allowed.includes(key) || value === null || value === undefined)
}

/**
 * Codex (checked against 0.164.0) also spells the legacy read/write roots as
 * `entries`, and the protocol prefers `entries` when both are present. An
 * `entries` list is only accepted when it is exactly those same plain paths
 * with the same access, so nothing the phone does not show (the whole disk, a
 * glob, a deny rule) can ride along on one "同意".
 */
function entriesMirrorPaths(entries: unknown, read: readonly string[], write: readonly string[]): boolean {
  if (entries === null || entries === undefined) return true
  if (!Array.isArray(entries)) return false
  const listed = { read: new Set<string>(), write: new Set<string>() }
  for (const entry of entries) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ['path', 'access']) || !isRecord(entry.path)) return false
    const target = entry.path
    if (target.type !== 'path' || !hasOnlyKeys(target, ['type', 'path']) || typeof target.path !== 'string') return false
    if (entry.access === 'read' && read.includes(target.path)) listed.read.add(target.path)
    else if (entry.access === 'write' && write.includes(target.path)) listed.write.add(target.path)
    else return false
  }
  return read.every((entry) => listed.read.has(entry)) && write.every((entry) => listed.write.has(entry))
}

/**
 * 权限申请拆成手机上能一条条显示的样子（严重-2 / #1407 P2-3）。显示不全的申请整份不认，返回 null，
 * 由调用方直接拒：带着显示不出来的字段（整个硬盘、通配、扫描深度、以后协议新加的项）、路径超过一屏能列的条数，
 * 或者什么都没要（手机上会是一张空白卡片）。
 */
export function readRequestedPermissions(permissions: unknown): RequestedPermissions | null {
  if (!isRecord(permissions) || !hasOnlyKeys(permissions, ['network', 'fileSystem'])) return null
  let network = false
  if (permissions.network !== null && permissions.network !== undefined) {
    if (!isRecord(permissions.network) || !hasOnlyKeys(permissions.network, ['enabled'])) return null
    network = permissions.network.enabled === true
  }
  let read: string[] = []
  let write: string[] = []
  const fileSystem = permissions.fileSystem
  if (fileSystem !== null && fileSystem !== undefined) {
    if (!isRecord(fileSystem) || !hasOnlyKeys(fileSystem, ['read', 'write', 'entries'])) return null
    const readList = readPathList(fileSystem.read)
    const writeList = readPathList(fileSystem.write)
    if (!readList || !writeList || readList.length + writeList.length > maxFileLines) return null
    if (!entriesMirrorPaths(fileSystem.entries, readList, writeList)) return null
    read = [...readList]
    write = [...writeList]
  }
  if (!network && read.length === 0 && write.length === 0) return null
  return { network, read, write }
}

function describePermissions(requested: RequestedPermissions, options: ApprovalDisplayOptions): string {
  const lines: string[] = []
  if (requested.network) lines.push('联网')
  for (const entry of requested.write) lines.push(`写：${displayPath(entry, options)}`)
  for (const entry of requested.read) lines.push(`读：${displayPath(entry, options)}`)
  return lines.join('\n')
}

/** 这份权限申请能不能在手机上一字不落地显示出来：不能就不问人，直接拒，截断了再问等于让人签看不全的字。 */
export function permissionsShowInFull(permissions: unknown, options: ApprovalDisplayOptions): boolean {
  const requested = readRequestedPermissions(permissions)
  return requested !== null && redactRemoteText(describePermissions(requested, options), options).length <= maxSummaryLength
}

export type CommandApprovalKind = Extract<RemoteApprovalKind, 'command' | 'terminal-input' | 'network'>

/**
 * Codex 的 commandExecution 审批分三种（对过 0.164.0）：跑命令；往已经开着的程序里输入（kind 是 writeStdin，
 * command 是 write_stdin 加要输入的内容）；连网站（带 networkApprovalContext，这时 command、cwd 都是空的）。
 */
export function commandApprovalKind(params: Record<string, unknown>): CommandApprovalKind {
  if (networkApprovalHost(params)) return 'network'
  return params.kind === 'writeStdin' ? 'terminal-input' : 'command'
}

function networkApprovalHost(params: Record<string, unknown>): string | null {
  return isRecord(params.networkApprovalContext) ? stringField(params.networkApprovalContext.host) : null
}

function isCommandApprovalKind(kind: RemoteApprovalKind): kind is CommandApprovalKind {
  return kind === 'command' || kind === 'terminal-input' || kind === 'network'
}

/** 命令那三种审批卡片上的正文：命令原文、Codex 给的 write_stdin 原样、要连的网址。 */
function commandApprovalSummary(kind: CommandApprovalKind, params: Record<string, unknown>): string {
  return (kind === 'network' ? networkApprovalHost(params) : stringField(params.command)) ?? ''
}

export type CommandDisplay = 'full' | 'too-long' | 'blank'

/**
 * 命令那三种审批能不能在手机上一字不落地显示出来（#1407 P3-2）。跟权限申请一样，显示不全就不问人：
 * 截掉的尾巴可能正是要命的那一截，点「同意」的人根本没看到它。什么都显示不出来的也不问。
 */
export function inspectCommandDisplay(kind: CommandApprovalKind, params: Record<string, unknown>, options: ApprovalDisplayOptions): CommandDisplay {
  const summary = redactRemoteText(commandApprovalSummary(kind, params), options)
  if (!summary.trim()) return 'blank'
  return summary.length <= maxSummaryLength ? 'full' : 'too-long'
}

/**
 * 改动内容里加了、删了多少行。对过 Codex rust-v0.167.0 的 item_builders.rs：新建、删除给的是整份内容，
 * 改给的是不带文件头的统一 diff（挪位置的后面另接一行「Moved to: …」），只数 @@ 之后以 + / - 开头的行。
 */
export function countChangedLines(kind: 'add' | 'delete' | 'update', diff: string): { added: number; removed: number } {
  if (kind !== 'update') {
    const lines = diff ? diff.split('\n').length - (diff.endsWith('\n') ? 1 : 0) : 0
    return kind === 'add' ? { added: lines, removed: 0 } : { added: 0, removed: lines }
  }
  let added = 0
  let removed = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) added += 1
    else if (inHunk && line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

/**
 * Codex fileChange 条目里的一个文件（FileUpdateChange：path、kind、diff）翻成改文件卡片要列的样子，
 * 路径还是原样，显示时再换 ~。kind 认不出（老版本 Codex）只留路径，diff 不是字符串就不带行数。
 */
export function readFileChange(change: unknown): RemoteFileChangeLine | null {
  if (!isRecord(change) || typeof change.path !== 'string' || !change.path) return null
  const kind = isRecord(change.kind) ? change.kind : null
  const type = kind?.type === 'add' || kind?.type === 'delete' || kind?.type === 'update' ? kind.type : null
  const movePath = type === 'update' ? stringField(kind?.move_path) : null
  const counts = type && typeof change.diff === 'string' ? countChangedLines(type, change.diff) : null
  return { path: change.path, kind: type, ...(movePath ? { movePath } : {}), ...(counts ?? {}) }
}

/**
 * Codex 计划里正在做的那一步（YF-18）。turn/plan/updated 每次送整张计划（rust-v0.167.0 v2
 * TurnPlanUpdatedNotification：plan 是 { step, status } 的数组，status 是 pending / inProgress / completed），
 * 取第一条 inProgress 的；一条都没有（还没开始、都做完了、送来的不认得）是 null，「状态」里就不写「做到…」。
 */
export function currentPlanStep(plan: unknown): string | null {
  if (!Array.isArray(plan)) return null
  for (const entry of plan) {
    if (isRecord(entry) && entry.status === 'inProgress' && typeof entry.step === 'string' && entry.step.trim()) return entry.step.trim()
  }
  return null
}

/** 记下这一轮真改成了的文件（YF-16）：同一个文件改几次只算一个。 */
export function noteChangedFiles(turn: { changedFiles: string[] }, files: readonly RemoteFileChangeLine[]): void {
  for (const file of files) {
    const path = file.movePath ?? file.path
    if (!turn.changedFiles.includes(path)) turn.changedFiles.push(path)
  }
}

/** 做完小结只写文件名（YF-16）：Codex 给的路径 Windows、Mac 两种分隔符都可能有。 */
export function remoteFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * 改文件卡片的正文（#1407）。以前整段拼好再截到上限，路径一长，截掉的正是最后的「另外还有」和「可写范围」，
 * 客户看到半截路径，以为要改的就这些。现在只列整条放得下的文件，其余都算进「另外还有」，「可写范围」整行留在最后。
 * 「可写范围」那一行自己都放不下就返回 null，由调用方不问直接拒，跟显示不全的权限申请一样。
 */
export function buildFileChangeSummary(params: Record<string, unknown>, changedFiles: readonly RemoteFileChangeLine[], options: ApprovalDisplayOptions): string | null {
  const grantRoot = stringField(params.grantRoot)
  const tail = grantRoot ? [`可写范围：${displayPath(grantRoot, options)}`] : []
  for (let shown = Math.min(changedFiles.length, maxFileLines); shown >= 0; shown -= 1) {
    const lines = changedFiles.slice(0, shown).map((change) => formatFileChangeLine({
      ...change,
      path: displayPath(change.path, options),
      ...(change.movePath ? { movePath: displayPath(change.movePath, options) } : {}),
    }))
    if (changedFiles.length > shown) lines.push(`另外还有 ${changedFiles.length - shown} 个文件`)
    const summary = [...lines, ...tail].join('\n')
    // 量的是脱敏以后的长度：手机上显示的就是那个。
    if (redactRemoteText(summary, options).length <= maxSummaryLength) return summary
  }
  return null
}

/** Codex 发来的审批请求翻成渠道无关、已脱敏截断的样子。 */
export function buildApprovalRequest(
  approvalId: string,
  nonce: string,
  kind: RemoteApprovalKind,
  params: Record<string, unknown>,
  changedFiles: readonly RemoteFileChangeLine[],
  options: ApprovalDisplayOptions,
): RemoteApprovalRequest {
  const redact = (text: string) => redactRemoteText(text, {
    secrets: options.secrets,
    homeDirectory: options.homeDirectory,
    platform: options.platform,
  })
  let summary = ''
  if (isCommandApprovalKind(kind)) summary = commandApprovalSummary(kind, params)
  else if (kind === 'file-change') summary = buildFileChangeSummary(params, changedFiles, options) ?? ''
  else {
    const requested = readRequestedPermissions(params.permissions)
    summary = requested ? describePermissions(requested, options) : ''
  }
  const cwd = stringField(params.cwd)
  const reason = stringField(params.reason)
  return {
    approvalId,
    nonce,
    kind,
    summary: truncateRemoteText(redact(summary), maxSummaryLength),
    ...(cwd ? { cwd: truncateRemoteText(redact(displayPath(cwd, options)), 300) } : {}),
    ...(reason ? { reason: truncateRemoteText(redact(reason), maxReasonLength) } : {}),
  }
}

/**
 * 同意以后只授予手机上显示过的那几样，形状照 GrantedPermissionProfile。只给旧的 read / write 两张表、
 * 不带 entries：协议在没有 entries 时才看这两张表，给出去的就是显示过的那几条路径。
 */
export function grantRequestedPermissions(requested: RequestedPermissions): Record<string, unknown> {
  const granted: Record<string, unknown> = {}
  if (requested.network) granted.network = { enabled: true }
  if (requested.read.length > 0 || requested.write.length > 0) {
    granted.fileSystem = {
      read: requested.read.length > 0 ? [...requested.read] : null,
      write: requested.write.length > 0 ? [...requested.write] : null,
    }
  }
  return granted
}

/** Codex 报的这一轮出了什么错（TurnError 里分类要用的那几样）。 */
interface TurnFailure {
  message: string | null
  additionalDetails: string | null
  codexErrorInfo: unknown
}

function readTurnFailure(error: unknown): TurnFailure | null {
  if (!isRecord(error)) return null
  const message = stringField(error.message)
  const additionalDetails = stringField(error.additionalDetails)
  if (!message && !additionalDetails && error.codexErrorInfo === undefined) return null
  return { message, additionalDetails, codexErrorInfo: error.codexErrorInfo }
}

interface TurnState {
  id: string | null
  /** 收到这一句的时间：「状态」里的「已经多久」、做完小结里的「用时」都从这里算（YF-18、YF-16）。 */
  startedAt: number
  /** Codex 计划里正在做的那一步（turn/plan/updated 里 inProgress 的那条），没报过计划是 null。 */
  step: string | null
  /** 这一轮真改成了的文件（fileChange 条目 completed），原样路径、去重、按先后。 */
  changedFiles: string[]
  finalAnswer: string | null
  lastMessage: string | null
  error: TurnFailure | null
  stoppedByUser: boolean
  /** 上一次有动静起算的「卡死」计时；每条通知、每次问审批都重新起算（noteTurnProgress）。 */
  stallTimer: NodeJS.Timeout | null
}

interface ChannelRuntime {
  id: RemoteChannelId
  adapter: RemoteChannelAdapter | null
  status: RemoteChannelStatus
  enabled: boolean
  startedAt: number
  pairing: {
    code: string
    startedAt: number
    expiresAt: number
    failures: number
    timer: NodeJS.Timeout
    /** 挂满 pairingQuietMs 时推一份快照，卡片上那句「还没收到消息」才出得来。 */
    quietTimer: NodeJS.Timeout
  } | null
  /** 上一个配对码错满次数作废了，电脑卡片上要说一声，直到重新开始配对、取消或关掉渠道（D66 / YKS-21）。 */
  pairingLocked: boolean
  /**
   * 这次打开以后平台送来过什么（YF-2）：一条都没有、只有群里的、有过私聊。只记有没有，不记谁发的、发了什么；
   * 只用来在电脑卡片上说配对码为什么没反应，手机那边照旧不回陌生人。
   */
  inboundSeen: RemoteInboundSeen
  peer: RemotePeer | null
  replyContext?: string
  seen: Set<string>
  idleTimer: NodeJS.Timeout | null
  inbox: Promise<void>
  /**
   * 把话交给 Codex 的那几步（startTurn），一个渠道一次一份。不在收件队列里排（D66 / YKS-3），但前一轮刚被「停止」、
   * 回执还在路上时，后一轮要等它补完那次打断再交，同一个对话里不会两轮叠在一起。
   */
  handoff: Promise<void>
  outbox: Promise<void>
  threadId: string | null
  /** 原来的对话不是手机上发「新对话」丢的（dropThread）：下次开新对话时先说一声（D66 / YKS-16）。 */
  threadLost: boolean
  /** 上一次回「这条是 N 分钟前发的」的时间（noticeStale），0 = 还没回过；收到一条照常处理的消息就清零。 */
  staleNoticeAt: number
  turn: TurnState | null
  /** 最近结束的几轮的编号（retireTurn）。 */
  retiredTurnIds: string[]
  /**
   * 这次打开以后最后一句交给 Codex 的话，手机上发「重试」时再发一次（YF-22）。只在内存里，关了遥控、换了人就不要了：
   * 下次打开时发「重试」，不该把上次开着时的话翻出来执行。
   */
  lastPrompt: string | null
}

export type RemoteInboundSeen = 'none' | 'group' | 'direct'

interface PendingApproval {
  id: string
  nonce: string
  channel: RemoteChannelId
  threadId: string
  timer: NodeJS.Timeout
  settle(decision: RemoteApprovalDecision): void
}

function emptyRuntime(id: RemoteChannelId): ChannelRuntime {
  return {
    id,
    adapter: null,
    status: { state: 'stopped' },
    enabled: false,
    startedAt: 0,
    pairing: null,
    pairingLocked: false,
    inboundSeen: 'none',
    peer: null,
    seen: new Set(),
    idleTimer: null,
    inbox: Promise.resolve(),
    handoff: Promise.resolve(),
    outbox: Promise.resolve(),
    threadId: null,
    threadLost: false,
    staleNoticeAt: 0,
    turn: null,
    retiredTurnIds: [],
    lastPrompt: null,
  }
}

/**
 * 配对码挂满 pairingQuietMs 还没收到过私聊时，快照里带上 quiet（YF-2）：一条都没收到多半是平台后台没配好，
 * 只收到群里的是发错了地方。收到过私聊（哪怕不是配对码）就不说，错码另有「错了 N 次」。
 */
export function pairingQuietField(pairingStartedAt: number, inboundSeen: RemoteInboundSeen, now: number): { quiet?: 'nothing' | 'group-only' } {
  if (inboundSeen === 'direct' || now - pairingStartedAt < pairingQuietMs) return {}
  return { quiet: inboundSeen === 'group' ? 'group-only' : 'nothing' }
}

/**
 * 托盘「打开手机遥控」能直接打开的渠道（YF-8）：选好了文件夹，渠道有凭据、配对过人，还没开着。
 * 没配对过的不算：打开以后还得回电脑上点「开始配对」，从托盘开它没用。
 */
export function remoteChannelsReadyToEnable(snapshot: Pick<CodexRemoteSnapshot, 'workspaceDirectory' | 'channels'>): RemoteChannelId[] {
  if (!snapshot.workspaceDirectory) return []
  return remoteChannelIds.filter((id) => {
    const channel = snapshot.channels[id]
    return channel.hasCredential && channel.boundPeer !== null && !channel.enabled
  })
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export class CodexRemoteService {
  private readonly runtimes: Record<RemoteChannelId, ChannelRuntime>
  private readonly pending = new Map<string, PendingApproval>()
  private readonly fileChanges = new Map<string, RemoteFileChangeLine[]>()
  /** 上一条审批的编号；null = 这次打开星芒还没从设置里读过。 */
  private lastApprovalNumber: number | null = null
  private revision = 0
  private codex: CodexAppServerClient | null = null
  private codexStarting: Promise<CodexAppServerClient> | null = null
  /**
   * 手机上最近一条因为电脑上的 Codex 起不来没做（YK-5）：手机上收到那句，电脑卡片上也要看得见。
   * 下次 Codex 起来了、或者遥控全关了就清掉。
   */
  private codexStartFailed = false
  /**
   * 「多久没消息就自动关」（YF-10）：null = 不自动关，也是缺省。设置在盘上，这里留一份给同步的 touch 用：
   * 头一回连渠道前从盘上读，之后只有 setIdleClose 改它（盘上那份也只有它写），免得读到一半被改、拿旧值盖掉新值。
   */
  private idleCloseHours: RemoteIdleCloseHours | null = null
  private idleCloseLoaded = false
  /** 已经叫停、还没真退出的几份 Codex（retireClient）：装、卸 Codex 前也要等它们放开文件。 */
  private readonly retiringClients = new Set<CodexAppServerClient>()
  private secrets: readonly string[] = []
  private secretsReadAt = 0
  /** farewell() 已经说过「星芒关了」的渠道：退出没退成时要补一句（quitAborted）。 */
  private readonly farewellSaid = new Set<RemoteChannelId>()
  private disposed = false

  constructor(private readonly options: CodexRemoteServiceOptions) {
    const runtimes: Partial<Record<RemoteChannelId, ChannelRuntime>> = {}
    for (const id of remoteChannelIds) runtimes[id] = emptyRuntime(id)
    this.runtimes = runtimes as Record<RemoteChannelId, ChannelRuntime>
  }

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** 渠道拿到的依赖；微信扫码登录在渠道外面，也用这同一份。 */
  channelDependencies(channel: RemoteChannelId): RemoteChannelDependencies {
    return {
      fetch: this.options.fetch,
      readCredential: () => this.options.store.readCredential(channel),
      writeCredential: (value) => this.options.store.writeCredential(channel, value),
      log: (level, event, detail) => this.options.log(level, `${channel}.${event}`, detail),
      now: () => this.now(),
      appVersion: this.options.appVersion,
    }
  }

  /** 有渠道开着。闲时自动装更新要看：一重启遥控就停了，开着它的人又多半不在电脑前。 */
  hasEnabledChannel(): boolean {
    return remoteChannelIds.some((id) => this.runtimes[id].enabled)
  }

  /**
   * Windows 上在星芒里更新、卸载 Codex 之前调（#1407 P3-3）。手机用过一次以后遥控那份 Codex 一直开着，锁着自己的
   * 程序文件，换版本、卸载都会撞上「文件被占用」，提示里还看不出是遥控占着。它闲着就停掉、等它真退出再放行，
   * 手机下次来消息再起（起 Codex 也排在安装队列里，装完才起）；正在干活就不动它，抛那句话给电脑上的人。
   *
   * 要在安装队列里调：查完到 npm 动手之间不会再起一份。还在起的那一份（codexStarting）也算干活：它可能已经
   * 起来、正在握手，也可能排在这次安装后面，两种都不能在这里等它（后一种等它就互相等死）。
   */
  async releaseCodex(action: CodexRemoteReleaseAction): Promise<void> {
    const working = remoteChannelIds.some((id) => this.runtimes[id].turn !== null) || this.pending.size > 0
    if (this.codexStarting || (this.codex?.running && working)) {
      this.options.log('info', 'remote.codex-release-refused', { action })
      throw new Error(codexRemoteBusyMessages[action])
    }
    const client = this.codex
    if (client) {
      this.codex = null
      this.fileChanges.clear()
      // 对话开在这一份 Codex 里，它停了就接不上：下一条从新对话开始，同 Codex 意外退出以后。
      for (const id of remoteChannelIds) this.dropThread(this.runtimes[id])
      this.options.log('info', 'remote.codex-released', { action })
      await this.retireClient(client)
    }
    const exiting = [...this.retiringClients]
    if (!exiting.length) return
    let timer: NodeJS.Timeout | undefined
    const exited = await Promise.race([
      Promise.all(exiting.map((entry) => entry.whenExited())).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), codexReleaseTimeoutMs)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    // 等不到就照常往下装：真撞上占用时，安装那边会数进程、说成「文件被占用」。
    if (!exited) this.options.log('warn', 'remote.codex-release-timeout', { action })
  }

  async snapshot(): Promise<CodexRemoteSnapshot> {
    const settings = await this.options.store.readSettings()
    const unavailableReason = this.options.inspectAvailability()
    const channels: Partial<Record<RemoteChannelId, CodexRemoteChannelSnapshot>> = {}
    let pendingApprovals = 0
    let task: CodexRemoteTaskState = 'idle'
    for (const id of remoteChannelIds) {
      const runtime = this.runtimes[id]
      const stored = settings.channels[id]
      const now = this.now()
      if (runtime.pairing && runtime.pairing.expiresAt <= now) this.clearPairing(runtime)
      channels[id] = {
        channel: id,
        hasCredential: (await this.options.store.readCredential(id)) !== null,
        accountLabel: stored?.accountLabel ?? null,
        enabled: runtime.enabled,
        status: runtime.status,
        boundPeer: stored?.boundPeer
          ? {
              userIdTail: stored.boundPeer.userId.slice(-4),
              boundAt: stored.boundPeer.boundAt,
              ...(stored.boundPeer.displayName ? { displayName: stored.boundPeer.displayName } : {}),
            }
          : null,
        pairing: runtime.pairing
          ? {
              code: runtime.pairing.code,
              expiresAt: runtime.pairing.expiresAt,
              ...(runtime.pairing.failures > 0 ? { failures: runtime.pairing.failures } : {}),
              ...pairingQuietField(runtime.pairing.startedAt, runtime.inboundSeen, now),
            }
          : null,
        ...(runtime.pairingLocked ? { pairingLocked: true } : {}),
      }
      const waiting = this.pendingFor(id).length
      pendingApprovals += waiting
      if (waiting > 0) task = 'waiting-approval'
      else if (runtime.turn && task !== 'waiting-approval') task = runtime.turn.id ? 'running' : 'starting'
    }
    this.revision += 1
    return {
      revision: this.revision,
      available: unavailableReason === null,
      ...(unavailableReason ? { unavailableReason } : {}),
      credentialPersistence: this.options.store.credentialPersistence(),
      workspaceDirectory: settings.workspaceDirectory
        ? remoteDisplayPath(settings.workspaceDirectory, this.options.homeDirectory, this.platform)
        : null,
      task,
      pendingApprovals,
      ...(settings.autoStart ? { autoStart: true } : {}),
      ...(settings.idleCloseHours ? { idleCloseHours: settings.idleCloseHours } : {}),
      ...(this.codexStartFailed ? { codexStartFailed: true } : {}),
      channels: channels as Record<RemoteChannelId, CodexRemoteChannelSnapshot>,
    }
  }

  async setWorkspace(directory: string): Promise<CodexRemoteSnapshot> {
    const workspace = validateRemoteWorkspace(directory, this.options.homeDirectory, this.platform)
    if (remoteChannelIds.some((id) => this.runtimes[id].turn)) {
      throw new Error('Codex 正在处理手机上发来的任务，等它做完再换文件夹。')
    }
    await this.options.store.updateSettings((settings) => {
      settings.workspaceDirectory = workspace
    })
    // 新文件夹从新对话开始：旧对话的工作目录还是原来那个。
    for (const id of remoteChannelIds) this.dropThread(this.runtimes[id])
    return this.emit()
  }

  async setChannelEnabled(channel: RemoteChannelId, enabled: boolean): Promise<CodexRemoteSnapshot> {
    const runtime = this.runtimes[channel]
    if (!enabled) {
      await this.disableChannel(runtime, remoteMessages.closedOnComputer)
      return this.emit()
    }
    if (runtime.enabled) return this.emit()
    if (this.disposed) throw new Error(quittingMessage)
    const reason = this.options.inspectAvailability()
    if (reason) throw new Error(reason)
    const settings = await this.options.store.readSettings()
    if (!settings.workspaceDirectory) throw new Error('先选好 Codex 在哪个文件夹里干活。')
    validateRemoteWorkspace(settings.workspaceDirectory, this.options.homeDirectory, this.platform)
    if ((await this.options.store.readCredential(channel)) === null) throw new Error('先完成这个渠道的登录。')
    const codexProblem = await this.options.checkCodexReady?.()
    if (codexProblem) throw new Error(codexProblem)
    const blocked = await this.startChannel(runtime)
    if (blocked) throw new Error(blocked)
    return this.emit()
  }

  /**
   * 卡片上的「重新连接」（0.2.24 D23）：开着、停在出错上的渠道断开重连一次。凭据、绑定的人、配对码都不动，
   * 手机上也不收「电脑上关了」那句，跟换凭据以后重启渠道是同一条路。没开着就不连：按钮只在开着时才有，
   * 点下去这一会儿被关掉了就算了。
   */
  async reconnectChannel(channel: RemoteChannelId): Promise<CodexRemoteSnapshot> {
    const runtime = this.runtimes[channel]
    if (!runtime.enabled) return this.emit()
    await this.stopAdapter(runtime)
    const blocked = await this.startChannel(runtime)
    if (blocked) throw new Error(blocked)
    return this.emit()
  }

  /**
   * 微信重新扫码，服务端认出是本机原来那份登录、回「这个微信已经连着这台电脑了」（YKS-6）：凭据没换，
   * saveChannelCredential 那条重启渠道的路不会走。渠道开着、还停在「需要重新登录」时断开重连一次，跟卡片上点
   * 「重新连接」是同一条路；别的状态不动，扫一次码不把好好的连接断一下。这一下手机遥控被关掉了就不连，也不报错，
   * 跟换凭据那条一样。
   */
  async reconnectIfLoggedOut(channel: RemoteChannelId): Promise<void> {
    const runtime = this.runtimes[channel]
    if (this.disposed || !runtime.enabled || runtime.status.state !== 'needs-login') return
    this.options.log('info', 'remote.channel-relogin-reconnect', { channel })
    await this.stopAdapter(runtime)
    await this.startChannel(runtime)
    await this.emit()
  }

  /**
   * 能不能开变了（状态文件关掉或放开了手机遥控，remote-features.ts）：现在不能开了，开着的渠道当场停掉，
   * 手机上收到的跟在电脑上点关一样；又能开了不替他打开，只让界面跟上。
   */
  async applyAvailability(): Promise<CodexRemoteSnapshot | null> {
    if (this.disposed) return null
    if (this.options.inspectAvailability()) {
      for (const id of remoteChannelIds) {
        const runtime = this.runtimes[id]
        if (!runtime.enabled) continue
        await this.disableChannel(runtime, remoteMessages.closedOnComputer)
        this.options.log('info', 'remote.channel-suspended', { channel: id })
      }
    }
    return this.emit()
  }

  /**
   * 托盘里点「打开手机遥控」（YF-8）：齐了的渠道（remoteChannelsReadyToEnable）都打开，跟在设置里一个个点开过同样的检查。
   * 一个都没打开时 failure 是第一个打不开的原因原句（比如还没装 Codex），托盘那边拿它弹系统通知；
   * 齐了的一个都没有（刚在设置里解了绑）时什么都不做，只推一份快照让托盘收起这一项。
   */
  async enableReadyChannels(): Promise<{ opened: RemoteChannelId[]; failure: string | null }> {
    if (this.disposed) return { opened: [], failure: null }
    const ready = remoteChannelsReadyToEnable(await this.snapshot())
    const opened: RemoteChannelId[] = []
    let failure: string | null = null
    for (const id of ready) {
      try {
        await this.setChannelEnabled(id, true)
        opened.push(id)
      } catch (error) {
        failure ??= errorMessage(error, '手机遥控没能打开。')
        this.options.log('warn', 'remote.tray-enable-failed', { channel: id })
      }
    }
    if (!opened.length) await this.emit()
    return { opened, failure: opened.length ? null : failure }
  }

  /**
   * 设置里「打开星芒时自动打开遥控」那个开关（YF-9）。只记下来，不当场开关渠道：开着的照旧开着，关着的等下次打开星芒。
   */
  async setAutoStart(enabled: boolean): Promise<CodexRemoteSnapshot> {
    await this.options.store.updateSettings((settings) => {
      if (enabled) settings.autoStart = true
      else delete settings.autoStart
    })
    this.options.log('info', 'remote.auto-start-set', { enabled })
    return this.emit()
  }

  /**
   * 设置里「多久没消息就自动关」（YF-10）：null = 不自动关。开着的渠道当场按新的时长从现在重新起算，
   * 换成不自动关就把计时和「10 分钟后自动关闭」那句提醒一起撤掉。
   */
  async setIdleClose(hours: RemoteIdleCloseHours | null): Promise<CodexRemoteSnapshot> {
    await this.options.store.updateSettings((settings) => {
      if (hours === null) delete settings.idleCloseHours
      else settings.idleCloseHours = hours
    })
    this.idleCloseHours = hours
    this.idleCloseLoaded = true
    for (const runtime of Object.values(this.runtimes)) {
      if (runtime.enabled) this.touch(runtime)
    }
    this.options.log('info', 'remote.idle-close-set', { hours: hours ?? 0 })
    return this.emit()
  }

  /**
   * 打开星芒时（YF-9）：客户自己打开了「打开星芒时自动打开遥控」才替他连，连的跟托盘「打开手机遥控」一样只是
   * 配对过人的渠道（enableReadyChannels），检查也跟设置里那个开关一样；只认配对的那一个人、改东西要手机上同意都不变。
   * 打不开（比如还没装 Codex）只记日志：这时没人在看，卡片上开关照旧是关的。
   */
  async startOnLaunch(): Promise<void> {
    if (this.disposed || !(await this.options.store.readSettings()).autoStart) return
    const { opened, failure } = await this.enableReadyChannels()
    this.options.log(failure ? 'warn' : 'info', 'remote.auto-started', { opened: opened.length, failed: failure !== null })
  }

  /** 托盘里点「关掉手机遥控」：开着的渠道全关，手机上收到的跟在设置里点关一样。 */
  async disableAllChannels(): Promise<CodexRemoteSnapshot | null> {
    if (this.disposed) return null
    for (const id of remoteChannelIds) {
      const runtime = this.runtimes[id]
      if (runtime.enabled) await this.disableChannel(runtime, remoteMessages.closedOnComputer)
    }
    return this.emit()
  }

  async startPairing(channel: RemoteChannelId): Promise<CodexRemoteSnapshot> {
    const runtime = this.runtimes[channel]
    if (!runtime.enabled) throw new Error('先打开这个渠道，再开始配对。')
    this.clearPairing(runtime)
    runtime.pairingLocked = false
    // 到点自己收掉，界面上的配对码跟着消失，不用界面自己掐表。
    const timer = setTimeout(() => {
      if (runtime.pairing?.timer !== timer) return
      runtime.pairing = null
      this.emitSoon()
    }, pairingTtlMs)
    timer.unref?.()
    const quietTimer = setTimeout(() => {
      if (runtime.pairing?.quietTimer === quietTimer) this.emitSoon()
    }, pairingQuietMs)
    quietTimer.unref?.()
    const now = this.now()
    runtime.pairing = {
      code: generatePairingCode(this.options.randomInt ?? cryptoRandomInt),
      startedAt: now,
      expiresAt: now + pairingTtlMs,
      failures: 0,
      timer,
      quietTimer,
    }
    this.options.log('info', 'remote.pairing-started', { channel })
    return this.emit()
  }

  async cancelPairing(channel: RemoteChannelId): Promise<CodexRemoteSnapshot> {
    this.clearPairing(this.runtimes[channel])
    this.runtimes[channel].pairingLocked = false
    return this.emit()
  }

  private clearPairing(runtime: ChannelRuntime): void {
    if (runtime.pairing) {
      clearTimeout(runtime.pairing.timer)
      clearTimeout(runtime.pairing.quietTimer)
    }
    runtime.pairing = null
  }

  async unbind(channel: RemoteChannelId): Promise<CodexRemoteSnapshot> {
    const runtime = this.runtimes[channel]
    await this.tellUnbound(runtime)
    await this.forgetPeer(runtime)
    await this.options.store.updateSettings((settings) => {
      const stored = settings.channels[channel]
      if (stored) stored.boundPeer = null
    })
    this.options.log('info', 'remote.unbound', { channel })
    return this.emit()
  }

  /**
   * 保存（或清掉）渠道凭据。换了账号（accountLabel 变了）或清掉凭据时一并解绑：飞书的 open_id
   * 按应用分，换个应用同一个人编号也不一样。渠道开着就重启一次，让它用新凭据。
   *
   * verifiedPeerUserId：微信扫码时微信要过手机上那串数字并且输对了，扫码的人直接记成绑定的人，不用再发配对码
   * （YF-5，yoyo 2026-11-11 亲手打字「微信免配对码，加条件做」）。没过数字的登录不带它，照旧要配对。原来绑着别人时
   * 跟换人一样先跟他说一声。
   */
  async saveChannelCredential(
    channel: RemoteChannelId,
    value: string | null,
    accountLabel: string | null,
    options: { verifiedPeerUserId?: string } = {},
  ): Promise<CodexRemoteSnapshot> {
    const runtime = this.runtimes[channel]
    const before = (await this.options.store.readSettings()).channels[channel]
    const sameAccount = value !== null && accountLabel !== null && before?.accountLabel === accountLabel
    const verifiedPeer = value !== null ? options.verifiedPeerUserId ?? null : null
    const keepsPeer = sameAccount && (verifiedPeer === null || !before?.boundPeer || before.boundPeer.userId === verifiedPeer)
    if (!keepsPeer) {
      // 换凭据以前说：凭据一换（退出登录是清掉），就发不出去了。
      await this.tellUnbound(runtime)
      await this.forgetPeer(runtime)
    }
    // 退出登录时凭据删不掉（#1407 P3-6）：解绑、停渠道照做，客户点退出就是不想再让手机指挥这台电脑；
    // 账号字样留着，因为凭据还在，卡上照旧有「退出登录」能再点。最后把那句报出去。
    let removeFailure: unknown = null
    try {
      await this.options.store.writeCredential(channel, value)
    } catch (error) {
      if (value !== null) throw error
      removeFailure = error
      this.options.log('warn', 'remote.credential-remove-failed', { channel })
    }
    await this.options.store.updateSettings((settings) => {
      const stored = settings.channels[channel] ?? emptyChannelSettings()
      if (!removeFailure) stored.accountLabel = value === null ? null : accountLabel
      if (!keepsPeer) stored.boundPeer = null
      if (verifiedPeer && stored.boundPeer?.userId !== verifiedPeer) stored.boundPeer = { userId: verifiedPeer, boundAt: this.now() }
      settings.channels[channel] = stored
    })
    if (verifiedPeer) {
      // 已经绑好了人：电脑上挂着的配对码作废，免得别人再拿它换掉。
      this.clearPairing(runtime)
      this.options.log('info', 'remote.paired-by-scan', { channel })
    }
    this.secretsReadAt = 0
    if (runtime.enabled) {
      if (value === null) await this.disableChannel(runtime, null)
      else {
        await this.stopAdapter(runtime)
        // 这时手机遥控被关掉了就不连，也不报错：凭据已经存好（微信扫码登录也认这一步算成功），设置页上那句停用的话就是交代。
        await this.startChannel(runtime)
      }
    }
    if (removeFailure) {
      // 报错的调用拿不到返回的快照，界面靠 state-changed 跟上已经解绑、停掉的样子。
      await this.emit()
      throw removeFailure
    }
    return this.emit()
  }

  /**
   * 星芒要退出了（主窗口的 prepareToQuit，排在 dispose 前面）：开着遥控、绑着人的渠道各发一句「星芒关了」，
   * 最多等 1.5 秒（打磨 B8）。dispose 在 will-quit 里同步调、来不及等网络，所以道别只能放在这一步；发不出去就算了，
   * 退出不等它。Windows 关机那条路不经过这里，关机不为一条消息推迟。
   */
  async farewell(): Promise<void> {
    if (this.disposed) return
    const sends = remoteChannelIds.map((id) => this.runtimes[id]).filter((runtime) => runtime.enabled && runtime.adapter).map(async (runtime) => {
      const peer = runtime.peer ?? (await this.boundPeer(runtime.id))
      if (!peer) return
      await this.sendText(runtime, remoteMessages.quitting, peer)
      this.farewellSaid.add(runtime.id)
    })
    if (!sends.length) return
    await Promise.race([Promise.all(sends), new Promise((resolve) => setTimeout(resolve, farewellTimeoutMs).unref?.())])
  }

  /**
   * 退出没退成（装更新的安装器没启动起来——Windows 上在系统提权框点了「否」、Mac 卸载移不进废纸篓）：
   * farewell() 已经跟手机说过「星芒关了」，可星芒还开着、遥控照常收消息，得补一句，不然手机那头
   * 以为遥控停了。只补给说过「关了」的渠道，退出真走掉了这里不会被调。
   */
  async quitAborted(): Promise<void> {
    if (this.disposed) return
    const ids = [...this.farewellSaid]
    this.farewellSaid.clear()
    await Promise.all(ids.map(async (id) => {
      const runtime = this.runtimes[id]
      if (!runtime.enabled || !runtime.adapter) return
      const peer = runtime.peer ?? (await this.boundPeer(id))
      if (peer) await this.sendText(runtime, remoteMessages.quitAborted, peer)
    }))
  }

  /**
   * 星芒退出（will-quit 里同步调）：等你同意的一律拒绝，停掉定时器、渠道连接和 Codex 进程。
   * 这里来不及等网络，道别那句在 farewell() 里已经发过；下次手机上发消息不会有人理，直到在电脑上重新打开。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.pending.values()) entry.settle('decline')
    for (const id of remoteChannelIds) {
      const runtime = this.runtimes[id]
      runtime.enabled = false
      this.clearPairing(runtime)
      this.clearTurn(runtime)
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer)
      runtime.idleTimer = null
      const adapter = runtime.adapter
      runtime.adapter = null
      void adapter?.stop().catch(() => undefined)
    }
    const client = this.codex
    this.codex = null
    void client?.stop()
  }

  private async emit(): Promise<CodexRemoteSnapshot> {
    const snapshot = await this.snapshot()
    try {
      this.options.onStateChanged?.(snapshot)
    } catch {
      this.options.log('warn', 'remote.state-listener-failed')
    }
    return snapshot
  }

  private emitSoon(): void {
    void this.emit().catch(() => undefined)
  }

  /** 按问出来的先后排（Map 记得放进去的顺序）；编号过了 9999 会回到 1，不能按编号大小排。 */
  private pendingFor(channel: RemoteChannelId): PendingApproval[] {
    return [...this.pending.values()].filter((entry) => entry.channel === channel)
  }

  /**
   * 连上渠道。开不了就返回原因（上屏用），渠道这时停着；返回 null 时渠道开着，或者半路被别处关掉、那边已经交代过。
   *
   * 调用方开头都问过能不能开，可那之后还要等：读设置、读凭据、查 Codex 装没装，换凭据重启要先等旧连接停下。
   * 这几秒里状态文件关掉了手机遥控（applyAvailability），那一刻渠道还不算开着、停不到它，不在这里再问一次
   * 就照常连上了，急刹车刹不住（R29-06）。星芒开始退出也是同一个窗口。
   */
  private async startChannel(runtime: ChannelRuntime): Promise<string | null> {
    const blocked = this.disposed ? quittingMessage : this.options.inspectAvailability()
    if (blocked) {
      // 换凭据重启那条路上它还算开着：照远程关那样收干净。旧连接已经停了，手机上收不到道别。
      if (runtime.enabled) {
        await this.disableChannel(runtime, null)
        this.options.log('info', 'remote.channel-suspended', { channel: runtime.id })
      }
      return blocked
    }
    runtime.enabled = true
    runtime.startedAt = this.now()
    runtime.seen.clear()
    runtime.staleNoticeAt = 0
    runtime.lastPrompt = null
    runtime.inboundSeen = 'none'
    runtime.status = { state: 'connecting' }
    const adapter = this.options.createChannel(runtime.id, this.channelDependencies(runtime.id))
    runtime.adapter = adapter
    await this.loadIdleClose()
    await this.refreshSecrets(true)
    // 读设置、读密钥这一下里渠道被关掉了（或者又开了一次、换上了新的一份）：这一份还没连，就别连了，连上就没人停它。
    if (runtime.adapter !== adapter) return null
    this.touch(runtime)
    this.options.log('info', 'remote.channel-started', { channel: runtime.id })
    // 这一份连接第一次连上时给手机说一声（YF-11）；断线重连还是这一份，不再说。
    let announced = false
    try {
      await adapter.start({
        onInbound: (message) => this.onInbound(runtime, adapter, message),
        onStatus: (status) => {
          if (runtime.adapter !== adapter) return
          runtime.status = status
          if (status.state === 'connected' && !announced) {
            announced = true
            void this.announceOpened(runtime, adapter)
          }
          this.emitSoon()
        },
      })
    } catch (error) {
      if (runtime.adapter === adapter) {
        runtime.status = { state: 'error', message: errorMessage(error, '渠道没能连上。') }
      }
      this.options.log('warn', 'remote.channel-start-failed', { channel: runtime.id })
    }
    return null
  }

  private async stopAdapter(runtime: ChannelRuntime): Promise<void> {
    const adapter = runtime.adapter
    runtime.adapter = null
    runtime.status = { state: 'stopped' }
    if (!adapter) return
    try {
      await adapter.stop()
    } catch {
      this.options.log('warn', 'remote.channel-stop-failed', { channel: runtime.id })
    }
  }

  private async disableChannel(runtime: ChannelRuntime, farewell: string | null): Promise<void> {
    const wasEnabled = runtime.enabled
    runtime.enabled = false
    this.clearPairing(runtime)
    runtime.pairingLocked = false
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer)
    runtime.idleTimer = null
    await this.abandonTurn(runtime)
    if (wasEnabled && farewell && runtime.adapter) {
      const peer = runtime.peer ?? (await this.boundPeer(runtime.id))
      if (peer) {
        const sent = this.sendText(runtime, farewell, peer)
        await Promise.race([sent, new Promise((resolve) => setTimeout(resolve, shutdownSendTimeoutMs).unref?.())])
      }
    }
    await this.stopAdapter(runtime)
    runtime.peer = null
    runtime.replyContext = undefined
    this.dropThread(runtime)
    if (wasEnabled) this.options.log('info', 'remote.channel-stopped', { channel: runtime.id })
    if (!remoteChannelIds.some((id) => this.runtimes[id].enabled)) {
      this.codexStartFailed = false
      await this.stopCodex()
    }
  }

  /**
   * 电脑上打开遥控、连上了（YF-11）：给配对过的人说一声，手机上不用自己发一句试通没通；也顺带是个提醒，
   * 不是自己开的，手机上看得到。还没配对过的没人可说，等配对成功那句。
   */
  private async announceOpened(runtime: ChannelRuntime, adapter: RemoteChannelAdapter): Promise<void> {
    const [peer, settings] = await Promise.all([this.boundPeer(runtime.id), this.options.store.readSettings()])
    const workspace = settings.workspaceDirectory
    if (!peer || !workspace || runtime.adapter !== adapter) return
    this.options.log('info', 'remote.opened-announced', { channel: runtime.id })
    await this.sendText(runtime, remoteOpenedMessage(remoteDisplayPath(workspace, this.options.homeDirectory, this.platform)), peer)
  }

  private async boundPeer(channel: RemoteChannelId): Promise<RemotePeer | null> {
    const stored = (await this.options.store.readSettings()).channels[channel]?.boundPeer
    return stored ? { channel, userId: stored.userId, ...(stored.displayName ? { displayName: stored.displayName } : {}) } : null
  }

  /** 换了人、解绑：这个渠道的对话、等你同意的操作、最近的回复句柄都不要了。 */
  private async forgetPeer(runtime: ChannelRuntime): Promise<void> {
    await this.abandonTurn(runtime)
    runtime.peer = null
    runtime.replyContext = undefined
    runtime.threadId = null
    runtime.lastPrompt = null
    // 换了人就是新的人，没有「前面的」可言。
    runtime.threadLost = false
  }

  /**
   * 原来的对话接不上了，又不是手机上发「新对话」丢的（关遥控、换文件夹、Codex 停了或出错）：记下来，
   * 下次开新对话时先跟手机说一声（D66 / YKS-16）。不然客户接着说「再改一下」，Codex 已经不记得前面了。
   */
  private dropThread(runtime: ChannelRuntime): void {
    if (runtime.threadId) runtime.threadLost = true
    runtime.threadId = null
  }

  /**
   * 解绑、换人、退出登录以前，给原来那个人发一句（D66 / YKS-18）：之后他发的话一律不回，不说他会一直等。
   * 渠道没开着就发不了，算了；最多等 1.5 秒，电脑上的操作不为一条消息卡住。
   */
  private async tellUnbound(runtime: ChannelRuntime): Promise<void> {
    if (!runtime.enabled || !runtime.adapter) return
    const peer = await this.boundPeer(runtime.id)
    if (!peer) return
    const replyContext = runtime.peer?.userId === peer.userId ? runtime.replyContext : null
    const sent = this.sendText(runtime, remoteMessages.unbound, peer, replyContext)
    await Promise.race([sent, new Promise((resolve) => setTimeout(resolve, shutdownSendTimeoutMs).unref?.())])
  }

  /** 正在跑的这一轮：等你同意的一律拒绝，再请 Codex 停下。 */
  private async abandonTurn(runtime: ChannelRuntime): Promise<void> {
    for (const entry of this.pendingFor(runtime.id)) entry.settle('decline')
    const turn = runtime.turn
    if (!turn) return
    turn.stoppedByUser = true
    this.clearTurn(runtime)
    if (turn.id) this.retireTurn(runtime, turn.id)
    if (turn.id && runtime.threadId && this.codex?.running) {
      await this.codex.request('turn/interrupt', { threadId: runtime.threadId, turnId: turn.id }, 10_000).catch(() => {
        this.options.log('warn', 'remote.interrupt-failed', { channel: runtime.id })
      })
    }
  }

  /** 停掉、做完的这一轮记下编号：它迟到的审批、通知都不认（belongsToOtherTurn）。 */
  private retireTurn(runtime: ChannelRuntime, turnId: string): void {
    if (runtime.retiredTurnIds.includes(turnId)) return
    runtime.retiredTurnIds.push(turnId)
    if (runtime.retiredTurnIds.length > maxRetiredTurns) runtime.retiredTurnIds.shift()
  }

  /** 起 Codex、开对话都要等一会儿；等完了这一轮还要不要接着交给 Codex。 */
  private turnStillWanted(runtime: ChannelRuntime, turn: TurnState): boolean {
    return !this.disposed && runtime.enabled && runtime.turn === turn && !turn.stoppedByUser
  }

  /** 这一轮结束了（做完、停掉、Codex 没了、星芒退出）：连它的「卡死」计时一起收掉。 */
  private clearTurn(runtime: ChannelRuntime): void {
    const turn = runtime.turn
    if (turn?.stallTimer) clearTimeout(turn.stallTimer)
    if (turn) turn.stallTimer = null
    runtime.turn = null
  }

  /**
   * 这一轮刚有动静（开始、Codex 发来通知、问审批）：「卡死」计时重新起算。一小时没再动，就当 Codex 卡死了：
   * 等你同意的一律拒绝、请 Codex 停下，告诉手机一句，之后再发消息就能开新的一轮（打磨 C2）。
   */
  private noteTurnProgress(runtime: ChannelRuntime): void {
    const turn = runtime.turn
    if (!turn) return
    if (turn.stallTimer) clearTimeout(turn.stallTimer)
    turn.stallTimer = setTimeout(() => {
      turn.stallTimer = null
      if (runtime.turn !== turn || this.disposed) return
      this.options.log('warn', 'remote.turn-stalled', { channel: runtime.id })
      void this.abandonTurn(runtime)
        .then(() => this.sendText(runtime, remoteMessages.stalled))
        .then(() => { this.touch(runtime); this.emitSoon() })
        .catch(() => undefined)
    }, turnStallMs)
    turn.stallTimer.unref?.()
  }

  private async loadIdleClose(): Promise<void> {
    if (this.idleCloseLoaded) return
    const hours = (await this.options.store.readSettings()).idleCloseHours ?? null
    if (this.idleCloseLoaded) return
    this.idleCloseHours = hours
    this.idleCloseLoaded = true
  }

  /**
   * 从现在起再闲 delayMs（缺省是设置里选的时长）就自动关；关之前 10 分钟先提醒手机一次（D66 / YKS-19），
   * 手机上回什么都会走到这里重新起算。选了「不自动关」（YF-10）就只撤掉手上的计时。
   */
  private touch(runtime: ChannelRuntime, delayMs?: number): void {
    if (this.idleCloseHours === null) {
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer)
      runtime.idleTimer = null
      return
    }
    delayMs ??= this.idleCloseHours * hourMs
    if (delayMs > idleWarningMs) this.scheduleIdle(runtime, delayMs - idleWarningMs, () => this.warnIdleClose(runtime))
    else this.scheduleIdle(runtime, delayMs, () => this.closeIdle(runtime))
  }

  private scheduleIdle(runtime: ChannelRuntime, delayMs: number, fire: () => void): void {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer)
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = null
      if (!runtime.enabled) return
      // 还在干活或者还在等你同意，就再等等，不在半截断开。
      if (runtime.turn || this.pendingFor(runtime.id).length > 0) {
        this.touch(runtime, idleRecheckMs)
        return
      }
      fire()
    }, delayMs)
    runtime.idleTimer.unref?.()
  }

  private warnIdleClose(runtime: ChannelRuntime): void {
    this.scheduleIdle(runtime, idleWarningMs, () => this.closeIdle(runtime))
    this.options.log('info', 'remote.idle-closing-soon', { channel: runtime.id })
    void (async () => {
      const peer = runtime.peer ?? (await this.boundPeer(runtime.id))
      if (peer) await this.sendText(runtime, remoteMessages.idleClosingSoon, peer)
    })().catch(() => undefined)
  }

  private closeIdle(runtime: ChannelRuntime): void {
    const hours = this.idleCloseHours
    if (hours === null) return
    this.options.log('info', 'remote.idle-closed', { channel: runtime.id, hours })
    void this.disableChannel(runtime, idleClosedMessage(hours)).then(() => this.emit()).catch(() => undefined)
  }

  private async refreshSecrets(force = false): Promise<void> {
    if (!force && this.now() - this.secretsReadAt < secretsTtlMs) return
    const collected: string[] = []
    try {
      collected.push(...(await this.options.readCodexSecrets()))
    } catch {
      this.options.log('warn', 'remote.secrets-unreadable')
    }
    for (const id of remoteChannelIds) {
      collected.push(...collectCredentialSecrets(await this.options.store.readCredential(id).catch(() => null)))
    }
    this.secrets = collected
    this.secretsReadAt = this.now()
  }

  private redaction() {
    return { secrets: this.secrets, homeDirectory: this.options.homeDirectory, platform: this.platform }
  }

  /** replyContext 传 null 是不带平台句柄：回的不是绑定的人时，不能把他的句柄拿给别人用。 */
  private deliver(
    runtime: ChannelRuntime,
    peer: RemotePeer,
    message: RemoteOutbound,
    replyContext: string | null | undefined = runtime.replyContext,
  ): Promise<void> {
    const adapter = runtime.adapter
    if (!adapter) return Promise.resolve()
    const next = runtime.outbox.then(() => adapter.send(peer, message, replyContext ?? undefined))
    runtime.outbox = next.catch(() => undefined)
    return next.catch(() => {
      this.options.log('warn', 'remote.send-failed', { channel: runtime.id, kind: message.kind })
      throw new Error('send failed')
    })
  }

  private async sendText(
    runtime: ChannelRuntime,
    text: string,
    peer = runtime.peer,
    replyContext: string | null | undefined = runtime.replyContext,
  ): Promise<void> {
    const adapter = runtime.adapter
    if (!peer || !adapter) return
    await this.refreshSecrets()
    const chunks = splitRemoteText(redactRemoteText(text, this.redaction()), adapter.capabilities.maxTextLength, maxReplyChunks)
    for (const chunk of chunks) {
      try {
        await this.deliver(runtime, peer, { kind: 'text', text: chunk }, replyContext)
      } catch {
        return
      }
    }
  }

  private onInbound(runtime: ChannelRuntime, adapter: RemoteChannelAdapter, message: RemoteInbound): void {
    // 一个渠道的消息按到达顺序一条条处理，配对、指令、审批不会互相插队。
    runtime.inbox = runtime.inbox
      .then(() => (runtime.adapter === adapter ? this.handleInbound(runtime, message) : undefined))
      .catch(() => {
        this.options.log('error', 'remote.inbound-failed', { channel: runtime.id })
      })
  }

  private async handleInbound(runtime: ChannelRuntime, message: RemoteInbound): Promise<void> {
    if (!runtime.enabled || message.peer.channel !== runtime.id) return
    this.noteInboundSeen(runtime, message.direct)
    if (!message.direct) {
      this.options.log('info', 'remote.dropped', { channel: runtime.id, reason: 'not-direct' })
      return
    }
    const now = this.now()
    // 电脑时间往回调过（比如照着提醒调准了），开启时间按调好的钟改记成现在（#1407 P3-5）：不然调准以后，
    // 原来快了多久，就有多久发的话还被当成开启前的。现在不会早于真正的开启时间，所以比起时间一直准的电脑，
    // 不会多放进一条旧消息。
    if (now < runtime.startedAt) runtime.startedAt = now
    if (message.sentAt !== undefined && isStaleInbound(message.sentAt, runtime.startedAt, now)) {
      this.options.log('info', 'remote.dropped', { channel: runtime.id, reason: 'stale' })
      if (message.kind !== 'approval') {
        if (isStaleOnlyByClock(message.sentAt, runtime.startedAt, now, message.clockAheadMs)) await this.warnClockAhead(runtime, message)
        else if (sentWhileOpen(message.sentAt, runtime.startedAt)) await this.noticeStale(runtime, message, now - message.sentAt)
      }
      return
    }
    if (message.kind !== 'approval' && !this.markSeen(runtime, message.messageId)) return
    const bound = (await this.options.store.readSettings()).channels[runtime.id]?.boundPeer
    if (!bound || bound.userId !== message.peer.userId) {
      await this.tryPair(runtime, message)
      return
    }
    runtime.peer = message.peer
    if (message.replyContext) runtime.replyContext = message.replyContext
    runtime.staleNoticeAt = 0
    this.touch(runtime)
    if (message.kind === 'unsupported') {
      await this.sendText(runtime, remoteMessages.unsupported)
      return
    }
    if (message.kind === 'approval') {
      await this.answerApprovalCard(runtime, message)
      return
    }
    const command = parseRemoteCommand(message.text, this.pendingFor(runtime.id).length > 0)
    switch (command.kind) {
      case 'help':
        await this.sendText(runtime, remoteMessages.help)
        return
      case 'status':
        await this.sendText(runtime, await this.statusReply(runtime))
        return
      case 'retry':
        if (!runtime.lastPrompt) {
          await this.sendText(runtime, remoteMessages.nothingToRetry)
          return
        }
        await this.runPrompt(runtime, runtime.lastPrompt, retryMessage(runtime.lastPrompt))
        return
      case 'stop':
        if (!runtime.turn) {
          await this.sendText(runtime, remoteMessages.nothingToStop)
          return
        }
        await this.abandonTurn(runtime)
        await this.sendText(runtime, remoteMessages.interrupted)
        this.emitSoon()
        return
      case 'new-thread':
        await this.abandonTurn(runtime)
        runtime.threadId = null
        // 是他自己要的新对话，下次不用再提醒「前面的记不得了」。
        runtime.threadLost = false
        await this.sendText(runtime, remoteMessages.newThread)
        this.emitSoon()
        return
      case 'close':
        await this.closeFromPhone(runtime)
        return
      case 'approval':
        await this.answerApproval(runtime, command.decision, command.approvalId)
        return
      case 'prompt':
        await this.runPrompt(runtime, command.text)
    }
  }

  /**
   * 手机上发「关闭遥控」（YF-17）：手机丢了、发现不对劲，换台设备登录同一个账号就能当场关。跟托盘「关掉手机遥控」一样
   * 开着的渠道全关（同一个人两个渠道都开着时，只关一个等于没关），只是每个配对过的人收到的是「已关闭」那句。
   * 只认配对过的人（走到这里之前已经核过），要再开只能回电脑上。
   */
  private async closeFromPhone(from: ChannelRuntime): Promise<void> {
    this.options.log('info', 'remote.closed-from-phone', { channel: from.id })
    for (const id of remoteChannelIds) {
      const runtime = this.runtimes[id]
      if (runtime.enabled) await this.disableChannel(runtime, remoteMessages.closedFromPhone)
    }
    await this.emit()
  }

  private staleNoticedRecently(runtime: ChannelRuntime): boolean {
    return runtime.staleNoticeAt > 0 && Math.abs(this.now() - runtime.staleNoticeAt) < staleNoticeQuietMs
  }

  /** 第一次见到这条消息返回 true；见过的（长轮询重连、飞书重投会送重）返回 false。 */
  private markSeen(runtime: ChannelRuntime, messageId: string): boolean {
    if (runtime.seen.has(messageId)) return false
    runtime.seen.add(messageId)
    if (runtime.seen.size > seenMessageLimit) {
      const oldest = runtime.seen.values().next().value
      if (oldest !== undefined) runtime.seen.delete(oldest)
    }
    return true
  }

  /**
   * 电脑上的时间快了，手机刚发的话被当成旧的丢掉（#1407 P3-5）：照样不执行，只跟发的人说一声，免得手机上
   * 一直没有回音。只回绑定的那个人，或者正在配对、发来的正是这次配对码的人（电脑时间快了，配对码一样会被
   * 当成旧的丢掉，发码的就是要绑定的那个人）；别人照旧不回话，免得拿消息探出这里有个遥控。这条配对码不算
   * 输错，也不拿它配对。
   */
  private async warnClockAhead(runtime: ChannelRuntime, message: RemoteInboundText | RemoteInboundUnsupported): Promise<void> {
    if (!this.markSeen(runtime, message.messageId)) return
    const bound = (await this.options.store.readSettings()).channels[runtime.id]?.boundPeer
    const pairing = runtime.pairing
    const isBound = bound?.userId === message.peer.userId
    const holdsPairingCode = message.kind === 'text' && pairing !== null && pairing.expiresAt > this.now()
      && normalizePairingAttempt(message.text) === pairing.code
    if (!isBound && !holdsPairingCode) return
    this.options.log('warn', 'remote.clock-ahead', {
      channel: runtime.id,
      aheadSeconds: Math.round((message.clockAheadMs ?? 0) / 1000),
    })
    await this.sendText(runtime, remoteMessages.clockAhead, message.peer, message.replyContext ?? (isBound ? runtime.replyContext : null))
  }

  /**
   * 遥控开着、电脑合盖或断网时发的消息，回来时已经超过 10 分钟（D66 / YKS-9）：照旧不执行，只给绑定的人回一句，
   * 免得手机上白等。电脑回来时攒着的几条是一下子送来的，一批只回一句（1 分钟内回过就不再回），说的是
   * 这一批里第一条的分钟数；陌生人照旧不回，免得拿消息探出这里有个遥控。
   */
  private async noticeStale(runtime: ChannelRuntime, message: RemoteInboundText | RemoteInboundUnsupported, ageMs: number): Promise<void> {
    if (!this.markSeen(runtime, message.messageId) || this.staleNoticedRecently(runtime)) return
    const bound = (await this.options.store.readSettings()).channels[runtime.id]?.boundPeer
    if (bound?.userId !== message.peer.userId || this.staleNoticedRecently(runtime)) return
    runtime.staleNoticeAt = this.now()
    const minutes = Math.max(1, Math.floor(ageMs / 60_000))
    await this.sendText(runtime, staleMessageNotice(minutes), message.peer, message.replyContext ?? runtime.replyContext)
  }

  /** 记下这次打开以后收到过哪种消息（YF-2）；配对码正挂着时变了就推一份快照，卡片上那句跟着换或消失。 */
  private noteInboundSeen(runtime: ChannelRuntime, direct: boolean): void {
    const next: RemoteInboundSeen = direct ? 'direct' : runtime.inboundSeen === 'none' ? 'group' : runtime.inboundSeen
    if (next === runtime.inboundSeen) return
    runtime.inboundSeen = next
    if (runtime.pairing) this.emitSoon()
  }

  private async tryPair(runtime: ChannelRuntime, message: RemoteInbound): Promise<void> {
    const pairing = runtime.pairing
    // 没在配对、或者不是配对码：不回话，免得别人拿消息探出这里有个遥控。
    if (!pairing || message.kind !== 'text') return
    if (pairing.expiresAt <= this.now()) {
      this.clearPairing(runtime)
      this.emitSoon()
      return
    }
    const attempt = normalizePairingAttempt(message.text)
    if (!attempt) return
    if (attempt !== pairing.code) {
      pairing.failures += 1
      this.options.log('warn', 'remote.pairing-mismatch', { channel: runtime.id, failures: pairing.failures })
      if (pairing.failures >= maxPairingFailures) {
        this.clearPairing(runtime)
        runtime.pairingLocked = true
        this.options.log('warn', 'remote.pairing-locked', { channel: runtime.id })
      }
      // 电脑卡片上跟着显示错了几次、作废了没有（D66 / YKS-21）；手机那边照旧不回。
      this.emitSoon()
      return
    }
    this.clearPairing(runtime)
    // 已经绑着别人（电脑上点了「换人」）：先跟原来那个人说一声，再换。
    await this.tellUnbound(runtime)
    await this.forgetPeer(runtime)
    await this.options.store.updateSettings((settings) => {
      const stored = settings.channels[runtime.id] ?? emptyChannelSettings()
      stored.boundPeer = {
        userId: message.peer.userId,
        boundAt: this.now(),
        ...(message.peer.displayName ? { displayName: message.peer.displayName.slice(0, 64) } : {}),
      }
      settings.channels[runtime.id] = stored
    })
    runtime.peer = message.peer
    if (message.replyContext) runtime.replyContext = message.replyContext
    this.touch(runtime)
    this.options.log('info', 'remote.paired', { channel: runtime.id })
    await this.sendText(runtime, remoteMessages.paired)
    this.emitSoon()
  }

  private async answerApproval(runtime: ChannelRuntime, decision: RemoteApprovalDecision, approvalId?: string): Promise<void> {
    const waiting = this.pendingFor(runtime.id)
    let target: PendingApproval | undefined
    if (approvalId !== undefined) {
      target = waiting.find((entry) => entry.id === approvalId)
      if (!target) {
        await this.sendText(runtime, unknownApprovalMessage(approvalId))
        return
      }
    } else if (waiting.length === 1) target = waiting[0]
    else if (waiting.length > 1) {
      await this.sendText(runtime, whichApprovalMessage(waiting.map((entry) => entry.id)))
      return
    } else return
    await this.settleApproval(runtime, target, decision)
  }

  /**
   * 卡片按钮只认发这张卡片时的那一条：编号和随机串都对上才算。旧卡片一直留在聊天记录里随时能点，
   * 处理过的、超时的、星芒重开前发的都不认，免得点一张旧的「同意」同意了一条没看过的新命令。
   */
  private async answerApprovalCard(runtime: ChannelRuntime, message: RemoteInboundApproval): Promise<void> {
    const target = message.nonce === null
      ? undefined
      : this.pendingFor(runtime.id).find((entry) => entry.id === message.approvalId && entry.nonce === message.nonce)
    if (!target) {
      this.options.log('info', 'remote.approval-card-stale', { channel: runtime.id })
      await this.sendText(runtime, remoteMessages.staleApprovalCard)
      return
    }
    await this.settleApproval(runtime, target, message.decision)
  }

  private async settleApproval(runtime: ChannelRuntime, target: PendingApproval, decision: RemoteApprovalDecision): Promise<void> {
    target.settle(decision)
    this.options.log('info', 'remote.approval-answered', { channel: runtime.id, decision })
    await this.sendText(runtime, decision === 'accept' ? approvalAcceptedMessage(target.id) : approvalDeclinedMessage(target.id))
    this.emitSoon()
  }

  /** 手机上发「状态」回的那几行（YF-18）。 */
  private async statusReply(runtime: ChannelRuntime): Promise<string> {
    const [settings, balanceUsd] = await Promise.all([this.options.store.readSettings(), this.statusBalance()])
    const workspace = settings.workspaceDirectory
    const turn = runtime.turn
    return statusMessage({
      workspace: workspace ? remoteDisplayPath(workspace, this.options.homeDirectory, this.platform) : '',
      running: turn !== null,
      pendingApprovals: this.pendingFor(runtime.id).length,
      ...(turn ? { runningForMs: this.now() - turn.startedAt, step: turn.step } : {}),
      balanceUsd,
      idleCloseHours: this.idleCloseHours,
    })
  }

  /** 「状态」里的余额：读不到、出错、超过 statusBalanceTimeoutMs 都当没有，不写那一行。 */
  private async statusBalance(): Promise<number | null> {
    const read = this.options.readBalanceUsd
    if (!read) return null
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), statusBalanceTimeoutMs)
      timer.unref?.()
    })
    try {
      const value = await Promise.race([read().catch(() => null), timeout])
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    } finally {
      clearTimeout(timer)
    }
  }

  /** lead 是「收到」前面先说的那句，「重试」时说重发的是哪一句（YF-22）。 */
  private async runPrompt(runtime: ChannelRuntime, text: string, lead?: string): Promise<void> {
    if (runtime.turn) {
      await this.sendText(runtime, remoteMessages.busy)
      return
    }
    const workspace = (await this.options.store.readSettings()).workspaceDirectory
    if (!workspace) {
      await this.sendText(runtime, remoteMessages.codexUnavailable)
      return
    }
    const turn: TurnState = {
      id: null,
      startedAt: this.now(),
      step: null,
      changedFiles: [],
      finalAnswer: null,
      lastMessage: null,
      error: null,
      stoppedByUser: false,
      stallTimer: null,
    }
    runtime.turn = turn
    runtime.lastPrompt = text
    this.noteTurnProgress(runtime)
    this.emitSoon()
    // 原来的对话丢了（不是他自己发的「新对话」），这一条会从新对话开始：收到那句前面先说一声（D66 / YKS-16）。
    const received = [
      ...(lead ? [lead] : []),
      ...(runtime.threadId === null && runtime.threadLost ? [remoteMessages.threadReset] : []),
      remoteMessages.received,
    ].join('\n')
    await this.sendText(runtime, received)
    // 起 Codex、开对话不在收件队列里等（D66 / YKS-3）：起 Codex 排在全局的安装队列里，别的工具在装时能等好几分钟，
    // 这期间手机发的「停止」「状态」得有人理，「停止」靠 turnStillWanted 拦住还没交给 Codex 的这一句。
    // 这一轮已经登记在 runtime.turn 上，后面再来的话照旧回「还在处理上一条」。
    void this.startTurn(runtime, turn, workspace, text)
  }

  private async startTurn(runtime: ChannelRuntime, turn: TurnState, workspace: string, text: string): Promise<void> {
    const slowNotice = setTimeout(() => {
      if (turn.id === null && this.turnStillWanted(runtime, turn)) void this.sendText(runtime, remoteMessages.codexStarting)
    }, codexStartingNoticeMs)
    slowNotice.unref?.()
    const handoff = runtime.handoff.then(() => this.handTurnToCodex(runtime, turn, workspace, text))
    runtime.handoff = handoff.catch(() => undefined)
    try {
      await handoff
    } catch {
      this.options.log('error', 'remote.inbound-failed', { channel: runtime.id })
    } finally {
      clearTimeout(slowNotice)
    }
  }

  private async handTurnToCodex(runtime: ChannelRuntime, turn: TurnState, workspace: string, text: string): Promise<void> {
    let client: CodexAppServerClient
    try {
      client = await this.ensureCodex()
    } catch (error) {
      // 起 Codex 的这一会儿，电脑上关了遥控或者星芒在退出：这一轮已经收掉了，起到一半的 Codex 也由 ensureCodex 收了。
      if (runtime.turn !== turn) return
      this.options.log('error', 'remote.codex-start-failed', { reason: error instanceof Error ? error.name : 'unknown' })
      this.clearTurn(runtime)
      this.codexStartFailed = true
      await this.sendText(runtime, remoteMessages.codexUnavailable)
      this.emitSoon()
      return
    }
    // 起 Codex、开对话都要等，每等完一次都看看这一轮还要不要（#1407 P3-1）：话一交给 Codex 就开始扣钱，
    // 只读命令也会先跑，事后再补一次打断已经晚了。
    if (!this.turnStillWanted(runtime, turn)) return
    try {
      if (!runtime.threadId) {
        // 读不出配了哪些外部工具就不开对话：宁可这一条做不了，也不让手机用上没关掉的工具。
        const configRead = await client.request('config/read', { cwd: workspace, includeLayers: true })
        if (!this.turnStillWanted(runtime, turn)) return
        const started = await client.request('thread/start', buildThreadStartParams(workspace, buildRemoteMcpServerOverrides(configRead)))
        const thread = isRecord(started) && isRecord(started.thread) ? stringField(started.thread.id) : null
        if (!thread) throw new Error('Codex 没有开出新对话')
        if (!this.turnStillWanted(runtime, turn)) return
        runtime.threadId = thread
        runtime.threadLost = false
      }
      const threadId = runtime.threadId
      const result = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
      })
      const turnId = isRecord(result) && isRecord(result.turn) ? stringField(result.turn.id) : null
      if (turnId && this.turnStillWanted(runtime, turn)) turn.id = turnId
      else if (turnId) {
        // 「停止」、关遥控比 Codex 回执先到：现在有编号了，补一次打断，它迟到的审批也不认。
        this.retireTurn(runtime, turnId)
        await client.request('turn/interrupt', { threadId, turnId }, 10_000).catch(() => undefined)
      }
      this.emitSoon()
    } catch (error) {
      if (runtime.turn !== turn) return
      this.clearTurn(runtime)
      this.dropThread(runtime)
      const reply = this.turnFailureReply(runtime, 'remote.turn-start-failed', { message: errorMessage(error, '') || null, additionalDetails: null, codexErrorInfo: undefined })
      await this.sendText(runtime, reply)
      this.emitSoon()
    }
  }

  /**
   * 这一轮没做完时发给手机的那句（D66 / YKS-8）：认得出的余额、登录、对话太长、连不上换成大白话，
   * 认不出的照旧发原话。原话脱敏、截短后进日志，客服从日志里看得到真正的原因。
   */
  private turnFailureReply(runtime: ChannelRuntime, event: string, failure: TurnFailure | null): string {
    const message = failure?.message ?? ''
    const classifyText = [message, failure?.additionalDetails ?? ''].filter(Boolean).join('\n')
    const kind = classifyRemoteTurnFailure(classifyText, failure?.codexErrorInfo)
    const logged = redactRemoteText(classifyText, this.redaction()).slice(0, maxReasonLength)
    this.options.log('warn', event, { channel: runtime.id, kind: kind ?? 'other', ...(logged ? { reason: logged } : {}) })
    return kind ? remoteTurnFailureMessages[kind] : turnFailedMessage(truncateRemoteText(message, maxReasonLength))
  }

  private ensureCodex(): Promise<CodexAppServerClient> {
    if (this.codex?.running) return Promise.resolve(this.codex)
    if (!this.codexStarting) {
      const starting = (async () => {
        const client = new CodexAppServerClient({
          spawn: () => this.options.spawnCodex(),
          clientVersion: this.options.appVersion,
          log: (level, event, detail) => this.options.log(level, `remote.${event}`, detail),
        })
        try {
          await client.start({
            onNotification: (method, params) => this.onNotification(method, params),
            onServerRequest: (method, params) => this.onServerRequest(method, params),
            onExit: (detail) => this.onCodexExit(client, detail),
          })
        } catch (error) {
          const stderr = this.stderrDetail(client.lastStderr)
          if (stderr.stderr) this.options.log('warn', 'remote.codex-start-stderr', stderr)
          await this.retireClient(client)
          throw error
        }
        // 起 Codex 的这一会儿，电脑上可能已经把遥控全关了、星芒在退出。这时 stopCodex 还看不到这一份，
        // 不在这里收掉，它就一直开着没人管，留到下次关遥控或退出（#1407 P3-1）。
        if (this.disposed || !this.hasEnabledChannel()) {
          this.options.log('info', 'remote.codex-start-abandoned')
          await this.retireClient(client)
          throw new Error('手机遥控已经关了')
        }
        this.codex = client
        if (this.codexStartFailed) {
          this.codexStartFailed = false
          this.emitSoon()
        }
        await this.refreshSecrets(true)
        this.options.log('info', 'remote.codex-started')
        return client
      })()
      this.codexStarting = starting
      starting.then(
        () => { if (this.codexStarting === starting) this.codexStarting = null },
        () => { if (this.codexStarting === starting) this.codexStarting = null },
      )
    }
    return this.codexStarting
  }

  private async stopCodex(): Promise<void> {
    const client = this.codex
    this.codex = null
    this.fileChanges.clear()
    if (client) await this.retireClient(client)
  }

  /** 叫停一份 Codex，记着它直到真退出：刚关了遥控就点更新，releaseCodex 也要等这一份放开文件。 */
  private async retireClient(client: CodexAppServerClient): Promise<void> {
    this.retiringClients.add(client)
    void client.whenExited().then(() => { this.retiringClients.delete(client) })
    await client.stop()
  }

  /** Codex 的 stderr 尾巴，脱敏、截短后进日志：它起不来、半路退出时，客服只能从这里看出原因（#1407 P3-6）。 */
  private stderrDetail(stderr: string): RemoteChannelLogDetail {
    const text = redactRemoteText(stderr.trim(), this.redaction()).slice(-maxStderrLogLength)
    return text ? { stderr: text } : {}
  }

  private onCodexExit(client: CodexAppServerClient, detail: { expected: boolean; code: number | null; stderrTail: string }): void {
    if (this.codex === client) this.codex = null
    this.fileChanges.clear()
    if (detail.expected) return
    this.options.log('warn', 'remote.codex-exited', { code: detail.code, ...this.stderrDetail(detail.stderrTail) })
    for (const id of remoteChannelIds) {
      const runtime = this.runtimes[id]
      for (const entry of this.pendingFor(id)) entry.settle('decline')
      this.dropThread(runtime)
      if (runtime.turn) {
        this.clearTurn(runtime)
        void this.sendText(runtime, turnFailedMessage('电脑上的 Codex 意外退出了，再发一次试试。'))
      }
    }
    this.emitSoon()
  }

  private runtimeByThread(threadId: unknown): ChannelRuntime | null {
    if (typeof threadId !== 'string') return null
    return remoteChannelIds.map((id) => this.runtimes[id]).find((runtime) => runtime.threadId === threadId) ?? null
  }

  private onNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return
    const runtime = this.runtimeByThread(params.threadId)
    // 停掉的上一轮迟到的通知：不算这一轮的动静，它的回答、报错、结束也都不往这一轮上记。
    if (runtime?.turn && belongsToOtherTurn(runtime.turn.id, runtime.retiredTurnIds, params.turnId)) return
    // 这一轮的任何通知都算有动静（item/agentMessage/delta 这类不另处理的也算）。
    if (runtime?.turn) this.noteTurnProgress(runtime)
    if (method === 'item/started' || method === 'item/completed') {
      const item = isRecord(params.item) ? params.item : null
      if (!item) return
      const itemId = stringField(item.id)
      if (item.type === 'fileChange' && itemId && Array.isArray(item.changes)) {
        const files = item.changes.flatMap((change) => {
          const read = readFileChange(change)
          return read ? [read] : []
        })
        if (method === 'item/started') this.fileChanges.set(itemId, files)
        else this.fileChanges.delete(itemId)
        // 做完小结只算真改成了的（YF-16）：被拒绝、没改成的不算。
        if (method === 'item/completed' && item.status === 'completed' && runtime?.turn) noteChangedFiles(runtime.turn, files)
      }
      if (method === 'item/completed' && item.type === 'agentMessage' && runtime?.turn) {
        const text = typeof item.text === 'string' ? item.text.trim() : ''
        if (!text) return
        if (item.phase === 'final_answer') runtime.turn.finalAnswer = text
        else runtime.turn.lastMessage = text
      }
      return
    }
    if (!runtime?.turn) return
    if (method === 'turn/plan/updated') {
      runtime.turn.step = currentPlanStep(params.plan)
      return
    }
    if (method === 'error' && params.willRetry !== true && isRecord(params.error)) {
      runtime.turn.error = readTurnFailure(params.error)
      return
    }
    if (method === 'turn/completed' && isRecord(params.turn)) this.finishTurn(runtime, params.turn)
  }

  private finishTurn(runtime: ChannelRuntime, turnPayload: Record<string, unknown>): void {
    const turn = runtime.turn
    if (!turn) return
    const turnId = stringField(turnPayload.id)
    if (belongsToOtherTurn(turn.id, runtime.retiredTurnIds, turnId)) return
    this.clearTurn(runtime)
    if (turn.id) this.retireTurn(runtime, turn.id)
    for (const entry of this.pendingFor(runtime.id)) entry.settle('decline')
    let reply: string | null
    if (turnPayload.status === 'completed') {
      const answer = turn.finalAnswer ?? turn.lastMessage ?? remoteMessages.emptyAnswer
      reply = `${answer}\n\n${turnSummaryLine(this.now() - turn.startedAt, turn.changedFiles.map(remoteFileName))}`
    } else if (turnPayload.status === 'interrupted') {
      reply = turn.stoppedByUser ? null : remoteMessages.interrupted
    } else {
      // 回执里带着报错就以它为准，没带用这一轮前面那条 error 通知。
      const failure = readTurnFailure(turnPayload.error)
      reply = this.turnFailureReply(runtime, 'remote.turn-failed', failure?.message ? failure : turn.error ?? failure)
    }
    this.options.log('info', 'remote.turn-finished', { channel: runtime.id, status: stringField(turnPayload.status) })
    if (reply) void this.sendText(runtime, reply)
    this.touch(runtime)
    this.emitSoon()
  }

  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return { decision: await this.requestApproval(isRecord(params) ? commandApprovalKind(params) : 'command', params) }
      case 'item/fileChange/requestApproval':
        return { decision: await this.requestApproval('file-change', params) }
      case 'item/permissions/requestApproval': {
        const decision = await this.requestApproval('other', params)
        const requested = decision === 'accept' && isRecord(params) ? readRequestedPermissions(params.permissions) : null
        return { permissions: requested ? grantRequestedPermissions(requested) : {}, scope: 'turn' }
      }
      case 'item/tool/requestUserInput':
        // 手机上答不了 Codex 的选择题；空着交回去，Codex 会按没有回答继续。
        return { answers: {} }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null }
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: { denied: { rejection: 'Not supported by Xingmang remote control.' } } }
      default:
        this.options.log('warn', 'remote.server-request-unsupported', { method: method.slice(0, 80) })
        throw new AppServerMethodError(-32601, 'not supported by Xingmang remote control')
    }
  }

  /**
   * 下一条审批的编号，接着设置里记的上一条往下数，重开星芒也不从 1 重来：手机上留着的旧「同意 1」
   * 不会落到新的第 1 条头上。记不下来照样问，按钮另有随机串兜底；回文字的渠道这次重开后可能撞号。
   */
  private async allocateApprovalId(): Promise<string> {
    if (this.lastApprovalNumber === null) {
      const stored = (await this.options.store.readSettings()).lastApprovalNumber
      // 两条请求同时进来时，先读完的那条已经往下数了，别拿设置里的旧值盖回去。
      this.lastApprovalNumber ??= stored
    }
    let number = nextApprovalNumber(this.lastApprovalNumber)
    while (this.pending.has(String(number))) number = nextApprovalNumber(number)
    this.lastApprovalNumber = number
    try {
      await this.options.store.updateSettings((settings) => {
        settings.lastApprovalNumber = number
      })
    } catch {
      this.options.log('warn', 'remote.approval-number-unsaved')
    }
    return String(number)
  }

  private async requestApproval(kind: RemoteApprovalKind, params: unknown): Promise<RemoteApprovalDecision> {
    if (!isRecord(params)) return 'decline'
    const threadId = stringField(params.threadId)
    const runtime = this.runtimeByThread(threadId)
    const peer = runtime?.peer
    if (!runtime || !threadId || !peer || !runtime.turn || runtime.turn.stoppedByUser || !runtime.adapter) return 'decline'
    const turn = runtime.turn
    if (belongsToOtherTurn(turn.id, runtime.retiredTurnIds, params.turnId)) {
      this.options.log('info', 'remote.approval-other-turn', { channel: runtime.id, kind })
      return 'decline'
    }
    this.noteTurnProgress(runtime)
    await this.refreshSecrets()
    const display = { homeDirectory: this.options.homeDirectory, platform: this.platform, secrets: this.secrets }
    if (kind === 'other' && !permissionsShowInFull(params.permissions, display)) {
      // 手机上显示不全的权限申请不问人：问了，客户点的「同意」也不是对着他看到的那些点的。
      this.options.log('info', 'remote.permissions-refused', { channel: runtime.id })
      if (!this.disposed && runtime.turn === turn && !turn.stoppedByUser) void this.sendText(runtime, remoteMessages.permissionsRefused)
      return 'decline'
    }
    const commandDisplay = isCommandApprovalKind(kind) ? inspectCommandDisplay(kind, params, display) : 'full'
    if (commandDisplay !== 'full') {
      // 同上：只显示得出前一截的命令不问人。空的是 Codex 没给要跑什么，手机上没什么可解释的，只记日志。
      this.options.log('info', 'remote.command-refused', { channel: runtime.id, kind, reason: commandDisplay })
      if (commandDisplay === 'too-long' && !this.disposed && runtime.turn === turn && !turn.stoppedByUser) {
        void this.sendText(runtime, remoteMessages.commandRefused)
      }
      return 'decline'
    }
    // 量放不放得下和卡片上列的用同一份文件清单，只在这里取一次。
    const itemId = stringField(params.itemId)
    const changedFiles = itemId ? this.fileChanges.get(itemId) ?? [] : []
    if (kind === 'file-change' && buildFileChangeSummary(params, changedFiles, display) === null) {
      // 同上：「可写范围」整行放不下，客户点「同意」时看不全要放开写的地方。
      this.options.log('info', 'remote.file-change-refused', { channel: runtime.id })
      if (!this.disposed && runtime.turn === turn && !turn.stoppedByUser) void this.sendText(runtime, remoteMessages.permissionsRefused)
      return 'decline'
    }
    const id = await this.allocateApprovalId()
    // 读密钥、记编号的这一会儿，这一轮可能已经被停掉、渠道已经关了：不再问人。
    if (this.disposed || runtime.turn !== turn || turn.stoppedByUser || !runtime.adapter) return 'decline'
    const nonce = generateApprovalNonce()
    const request = buildApprovalRequest(id, nonce, kind, params, changedFiles, display)
    const decision = new Promise<RemoteApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.options.log('info', 'remote.approval-expired', { channel: runtime.id })
        entry.settle('decline')
        void this.sendText(runtime, approvalExpiredMessage(id, approvalTimeoutMinutes))
        this.emitSoon()
      }, approvalTimeoutMs)
      timer.unref?.()
      const reminder = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.options.log('info', 'remote.approval-reminded', { channel: runtime.id })
        void this.sendText(runtime, approvalExpiringMessage(id, approvalReminderMinutesLeft))
      }, approvalReminderMs)
      reminder.unref?.()
      const entry: PendingApproval = {
        id,
        nonce,
        channel: runtime.id,
        threadId,
        timer,
        settle: (value) => {
          if (!this.pending.delete(id)) return
          clearTimeout(timer)
          clearTimeout(reminder)
          resolve(value)
        },
      }
      this.pending.set(id, entry)
    })
    this.options.log('info', 'remote.approval-requested', { channel: runtime.id, kind })
    this.emitSoon()
    const text = redactRemoteText(formatApprovalText(request), this.redaction())
    try {
      await this.deliver(runtime, peer, { kind: 'approval', request, text })
    } catch {
      // 问不到人就不能当作同意。
      this.pending.get(id)?.settle('decline')
    }
    return decision
  }
}
