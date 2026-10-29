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
  type RemotePeer,
} from './codex-remote-channel'
import { emptyChannelSettings, type CodexRemoteStore } from './codex-remote-store'
import {
  approvalAcceptedMessage,
  approvalDeclinedMessage,
  approvalExpiredMessage,
  formatApprovalText,
  normalizePairingAttempt,
  parseRemoteCommand,
  redactRemoteText,
  remoteDisplayPath,
  remoteMessages,
  splitRemoteText,
  statusMessage,
  truncateRemoteText,
  turnFailedMessage,
  unknownApprovalMessage,
  whichApprovalMessage,
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
// - Unanswered approvals decline themselves; nothing ever approves by default.
// - A permission request is only put to the user when every part of it fits on
//   the card, and "accept" grants exactly the paths the card listed.
// - Approval numbers keep counting across restarts, and every button carries a
//   per-request random nonce: a card left in the chat history from an earlier
//   request or an earlier run can never answer a newer one.
// - Only the turn running now may ask: a late request from a stopped or
//   finished turn is declined, and nothing reaches Codex once the turn it was
//   meant for has been switched off.
// - Text that leaves the machine is redacted (I13) and capped.

const pairingTtlMs = 10 * 60_000
const maxPairingFailures = 20
const approvalTimeoutMinutes = 10
const approvalTimeoutMs = approvalTimeoutMinutes * 60_000
const idleTimeoutMs = 4 * 60 * 60_000
const idleRecheckMs = 30 * 60_000
const staleBeforeStartMs = 60_000
const maxMessageAgeMs = 10 * 60_000
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
  onStateChanged?(snapshot: CodexRemoteSnapshot): void
}

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
 * 这条被当成旧消息，是不是只因为电脑上的时间快了（#1407 P3-5）：换成平台的钟再看一遍就不旧了。
 * 只用来决定给手机回不回一句提醒，消息照样不执行，时间校验本身不放宽。
 */
export function isStaleOnlyByClock(sentAt: number, channelStartedAt: number, now: number, clockAheadMs: number | undefined): boolean {
  if (clockAheadMs === undefined || !Number.isFinite(clockAheadMs) || clockAheadMs < clockAheadToleranceMs) return false
  return isStaleInbound(sentAt, channelStartedAt, now) && !isStaleInbound(sentAt, channelStartedAt - clockAheadMs, now - clockAheadMs)
}

export function buildThreadStartParams(workspace: string): Record<string, unknown> {
  return {
    cwd: workspace,
    approvalPolicy: 'untrusted',
    // auto_review / guardian 会让另一个模型替人点同意；遥控只许人自己点。
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    developerInstructions,
  }
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

/** Codex 发来的审批请求翻成渠道无关、已脱敏截断的样子。 */
export function buildApprovalRequest(
  approvalId: string,
  nonce: string,
  kind: RemoteApprovalKind,
  params: Record<string, unknown>,
  changedFiles: readonly string[],
  options: ApprovalDisplayOptions,
): RemoteApprovalRequest {
  const redact = (text: string) => redactRemoteText(text, {
    secrets: options.secrets,
    homeDirectory: options.homeDirectory,
    platform: options.platform,
  })
  let summary = ''
  if (kind === 'command') summary = stringField(params.command) ?? ''
  else if (kind === 'file-change') {
    const lines = changedFiles.slice(0, maxFileLines).map((file) => displayPath(file, options))
    if (changedFiles.length > maxFileLines) lines.push(`另外还有 ${changedFiles.length - maxFileLines} 个文件`)
    const grantRoot = stringField(params.grantRoot)
    if (grantRoot) lines.push(`可写范围：${displayPath(grantRoot, options)}`)
    summary = lines.join('\n')
  } else {
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

interface TurnState {
  id: string | null
  finalAnswer: string | null
  lastMessage: string | null
  error: string | null
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
  pairing: { code: string; expiresAt: number; failures: number; timer: NodeJS.Timeout } | null
  peer: RemotePeer | null
  replyContext?: string
  seen: Set<string>
  idleTimer: NodeJS.Timeout | null
  inbox: Promise<void>
  outbox: Promise<void>
  threadId: string | null
  turn: TurnState | null
  /** 最近结束的几轮的编号（retireTurn）。 */
  retiredTurnIds: string[]
}

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
    peer: null,
    seen: new Set(),
    idleTimer: null,
    inbox: Promise.resolve(),
    outbox: Promise.resolve(),
    threadId: null,
    turn: null,
    retiredTurnIds: [],
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export class CodexRemoteService {
  private readonly runtimes: Record<RemoteChannelId, ChannelRuntime>
  private readonly pending = new Map<string, PendingApproval>()
  private readonly fileChanges = new Map<string, string[]>()
  /** 上一条审批的编号；null = 这次打开星芒还没从设置里读过。 */
  private lastApprovalNumber: number | null = null
  private revision = 0
  private codex: CodexAppServerClient | null = null
  private codexStarting: Promise<CodexAppServerClient> | null = null
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
        pairing: runtime.pairing ? { code: runtime.pairing.code, expiresAt: runtime.pairing.expiresAt } : null,
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
    for (const id of remoteChannelIds) this.runtimes[id].threadId = null
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

  async startPairing(channel: RemoteChannelId): Promise<CodexRemoteSnapshot> {
    const runtime = this.runtimes[channel]
    if (!runtime.enabled) throw new Error('先打开这个渠道，再开始配对。')
    this.clearPairing(runtime)
    // 到点自己收掉，界面上的配对码跟着消失，不用界面自己掐表。
    const timer = setTimeout(() => {
      if (runtime.pairing?.timer !== timer) return
      runtime.pairing = null
      this.emitSoon()
    }, pairingTtlMs)
    timer.unref?.()
    runtime.pairing = {
      code: generatePairingCode(this.options.randomInt ?? cryptoRandomInt),
      expiresAt: this.now() + pairingTtlMs,
      failures: 0,
      timer,
    }
    this.options.log('info', 'remote.pairing-started', { channel })
    return this.emit()
  }

  async cancelPairing(channel: RemoteChannelId): Promise<CodexRemoteSnapshot> {
    this.clearPairing(this.runtimes[channel])
    return this.emit()
  }

  private clearPairing(runtime: ChannelRuntime): void {
    if (runtime.pairing) clearTimeout(runtime.pairing.timer)
    runtime.pairing = null
  }

  async unbind(channel: RemoteChannelId): Promise<CodexRemoteSnapshot> {
    const runtime = this.runtimes[channel]
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
   */
  async saveChannelCredential(channel: RemoteChannelId, value: string | null, accountLabel: string | null): Promise<CodexRemoteSnapshot> {
    const runtime = this.runtimes[channel]
    const before = (await this.options.store.readSettings()).channels[channel]
    const sameAccount = value !== null && accountLabel !== null && before?.accountLabel === accountLabel
    if (!sameAccount) await this.forgetPeer(runtime)
    await this.options.store.writeCredential(channel, value)
    await this.options.store.updateSettings((settings) => {
      const stored = settings.channels[channel] ?? emptyChannelSettings()
      stored.accountLabel = value === null ? null : accountLabel
      if (!sameAccount) stored.boundPeer = null
      settings.channels[channel] = stored
    })
    this.secretsReadAt = 0
    if (runtime.enabled) {
      if (value === null) await this.disableChannel(runtime, null)
      else {
        await this.stopAdapter(runtime)
        // 这时手机遥控被关掉了就不连，也不报错：凭据已经存好（微信扫码登录也认这一步算成功），设置页上那句停用的话就是交代。
        await this.startChannel(runtime)
      }
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
    runtime.status = { state: 'connecting' }
    const adapter = this.options.createChannel(runtime.id, this.channelDependencies(runtime.id))
    runtime.adapter = adapter
    await this.refreshSecrets(true)
    // 读密钥这一下里渠道被关掉了（或者又开了一次、换上了新的一份）：这一份还没连，就别连了，连上就没人停它。
    if (runtime.adapter !== adapter) return null
    this.touch(runtime)
    this.options.log('info', 'remote.channel-started', { channel: runtime.id })
    try {
      await adapter.start({
        onInbound: (message) => this.onInbound(runtime, adapter, message),
        onStatus: (status) => {
          if (runtime.adapter !== adapter) return
          runtime.status = status
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
    runtime.threadId = null
    if (wasEnabled) this.options.log('info', 'remote.channel-stopped', { channel: runtime.id })
    if (!remoteChannelIds.some((id) => this.runtimes[id].enabled)) await this.stopCodex()
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

  private touch(runtime: ChannelRuntime, delayMs = idleTimeoutMs): void {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer)
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = null
      if (!runtime.enabled) return
      // 还在干活或者还在等你同意，就再等等，不在半截断开。
      if (runtime.turn || this.pendingFor(runtime.id).length > 0) {
        this.touch(runtime, idleRecheckMs)
        return
      }
      this.options.log('info', 'remote.idle-closed', { channel: runtime.id })
      void this.disableChannel(runtime, remoteMessages.idleClosed).then(() => this.emit()).catch(() => undefined)
    }, delayMs)
    runtime.idleTimer.unref?.()
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
      if (message.kind !== 'approval' && isStaleOnlyByClock(message.sentAt, runtime.startedAt, now, message.clockAheadMs)) {
        await this.warnClockAhead(runtime, message)
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
      case 'status': {
        const workspace = (await this.options.store.readSettings()).workspaceDirectory
        await this.sendText(runtime, statusMessage({
          workspace: workspace ? remoteDisplayPath(workspace, this.options.homeDirectory, this.platform) : '',
          running: runtime.turn !== null,
          pendingApprovals: this.pendingFor(runtime.id).length,
        }))
        return
      }
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
        await this.sendText(runtime, remoteMessages.newThread)
        this.emitSoon()
        return
      case 'approval':
        await this.answerApproval(runtime, command.decision, command.approvalId)
        return
      case 'prompt':
        await this.runPrompt(runtime, command.text)
    }
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
        this.options.log('warn', 'remote.pairing-locked', { channel: runtime.id })
        this.emitSoon()
      }
      return
    }
    this.clearPairing(runtime)
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

  private async runPrompt(runtime: ChannelRuntime, text: string): Promise<void> {
    if (runtime.turn) {
      await this.sendText(runtime, remoteMessages.busy)
      return
    }
    const workspace = (await this.options.store.readSettings()).workspaceDirectory
    if (!workspace) {
      await this.sendText(runtime, remoteMessages.codexUnavailable)
      return
    }
    const turn: TurnState = { id: null, finalAnswer: null, lastMessage: null, error: null, stoppedByUser: false, stallTimer: null }
    runtime.turn = turn
    this.noteTurnProgress(runtime)
    this.emitSoon()
    await this.sendText(runtime, remoteMessages.received)
    let client: CodexAppServerClient
    try {
      client = await this.ensureCodex()
    } catch (error) {
      // 起 Codex 的这一会儿，电脑上关了遥控或者星芒在退出：这一轮已经收掉了，起到一半的 Codex 也由 ensureCodex 收了。
      if (runtime.turn !== turn) return
      this.options.log('error', 'remote.codex-start-failed', { reason: error instanceof Error ? error.name : 'unknown' })
      this.clearTurn(runtime)
      await this.sendText(runtime, remoteMessages.codexUnavailable)
      this.emitSoon()
      return
    }
    // 起 Codex、开对话都要等，每等完一次都看看这一轮还要不要（#1407 P3-1）：话一交给 Codex 就开始扣钱，
    // 只读命令也会先跑，事后再补一次打断已经晚了。
    if (!this.turnStillWanted(runtime, turn)) return
    try {
      if (!runtime.threadId) {
        const started = await client.request('thread/start', buildThreadStartParams(workspace))
        const thread = isRecord(started) && isRecord(started.thread) ? stringField(started.thread.id) : null
        if (!thread) throw new Error('Codex 没有开出新对话')
        if (!this.turnStillWanted(runtime, turn)) return
        runtime.threadId = thread
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
      runtime.threadId = null
      this.options.log('warn', 'remote.turn-start-failed', { channel: runtime.id })
      await this.sendText(runtime, turnFailedMessage(truncateRemoteText(errorMessage(error, ''), maxReasonLength)))
      this.emitSoon()
    }
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
          await client.stop()
          throw error
        }
        // 起 Codex 的这一会儿，电脑上可能已经把遥控全关了、星芒在退出。这时 stopCodex 还看不到这一份，
        // 不在这里收掉，它就一直开着没人管，留到下次关遥控或退出（#1407 P3-1）。
        if (this.disposed || !this.hasEnabledChannel()) {
          this.options.log('info', 'remote.codex-start-abandoned')
          await client.stop()
          throw new Error('手机遥控已经关了')
        }
        this.codex = client
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
    if (client) await client.stop()
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
      runtime.threadId = null
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
        const files = item.changes.flatMap((change) => (isRecord(change) && typeof change.path === 'string' ? [change.path] : []))
        if (method === 'item/started') this.fileChanges.set(itemId, files)
        else this.fileChanges.delete(itemId)
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
    if (method === 'error' && params.willRetry !== true && isRecord(params.error)) {
      runtime.turn.error = stringField(params.error.message)
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
    if (turnPayload.status === 'completed') reply = turn.finalAnswer ?? turn.lastMessage ?? remoteMessages.emptyAnswer
    else if (turnPayload.status === 'interrupted') reply = turn.stoppedByUser ? null : remoteMessages.interrupted
    else {
      const error = isRecord(turnPayload.error) ? stringField(turnPayload.error.message) : null
      reply = turnFailedMessage(truncateRemoteText(error ?? turn.error ?? '', maxReasonLength))
    }
    this.options.log('info', 'remote.turn-finished', { channel: runtime.id, status: stringField(turnPayload.status) })
    if (reply) void this.sendText(runtime, reply)
    this.touch(runtime)
    this.emitSoon()
  }

  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return { decision: await this.requestApproval('command', params) }
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
    const id = await this.allocateApprovalId()
    // 读密钥、记编号的这一会儿，这一轮可能已经被停掉、渠道已经关了：不再问人。
    if (this.disposed || runtime.turn !== turn || turn.stoppedByUser || !runtime.adapter) return 'decline'
    const nonce = generateApprovalNonce()
    const itemId = stringField(params.itemId)
    const request = buildApprovalRequest(id, nonce, kind, params, itemId ? this.fileChanges.get(itemId) ?? [] : [], display)
    const decision = new Promise<RemoteApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.options.log('info', 'remote.approval-expired', { channel: runtime.id })
        entry.settle('decline')
        void this.sendText(runtime, approvalExpiredMessage(id, approvalTimeoutMinutes))
        this.emitSoon()
      }, approvalTimeoutMs)
      timer.unref?.()
      const entry: PendingApproval = {
        id,
        nonce,
        channel: runtime.id,
        threadId,
        timer,
        settle: (value) => {
          if (!this.pending.delete(id)) return
          clearTimeout(timer)
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
