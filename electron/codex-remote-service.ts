import fs from 'node:fs'
import path from 'node:path'
import { randomInt as cryptoRandomInt } from 'node:crypto'
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
// - Text that leaves the machine is redacted (I13) and capped.

const pairingTtlMs = 10 * 60_000
const maxPairingFailures = 20
const approvalTimeoutMinutes = 10
const approvalTimeoutMs = approvalTimeoutMinutes * 60_000
const idleTimeoutMs = 4 * 60 * 60_000
const idleRecheckMs = 30 * 60_000
const staleBeforeStartMs = 60_000
const maxMessageAgeMs = 10 * 60_000
const maxReplyChunks = 5
const maxSummaryLength = 1500
const maxReasonLength = 500
const maxFileLines = 20
const seenMessageLimit = 512
const secretsTtlMs = 60_000
const shutdownSendTimeoutMs = 1500

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
  onStateChanged?(snapshot: CodexRemoteSnapshot): void
}

export function generatePairingCode(randomInt: (maxExclusive: number) => number): string {
  return String(randomInt(1_000_000)).padStart(6, '0')
}

/** 渠道开启前 1 分钟以上、或 10 分钟以前发的消息不算：星芒关着时发的指令不该在下次打开时突然执行。 */
export function isStaleInbound(sentAt: number, channelStartedAt: number, now: number): boolean {
  return sentAt < channelStartedAt - staleBeforeStartMs || sentAt < now - maxMessageAgeMs
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

function describePermissions(permissions: unknown, options: ApprovalDisplayOptions): string {
  if (!isRecord(permissions)) return ''
  const lines: string[] = []
  if (isRecord(permissions.network) && permissions.network.enabled === true) lines.push('联网')
  if (isRecord(permissions.fileSystem)) {
    for (const [key, verb] of [['write', '写'], ['read', '读']] as const) {
      const entries = permissions.fileSystem[key]
      if (!Array.isArray(entries)) continue
      for (const entry of entries.slice(0, maxFileLines)) {
        if (typeof entry === 'string') lines.push(`${verb}：${displayPath(entry, options)}`)
      }
    }
  }
  return lines.join('\n')
}

/** Codex 发来的审批请求翻成渠道无关、已脱敏截断的样子。 */
export function buildApprovalRequest(
  approvalId: string,
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
  } else summary = describePermissions(params.permissions, options)
  const cwd = stringField(params.cwd)
  const reason = stringField(params.reason)
  return {
    approvalId,
    kind,
    summary: truncateRemoteText(redact(summary), maxSummaryLength),
    ...(cwd ? { cwd: truncateRemoteText(redact(displayPath(cwd, options)), 300) } : {}),
    ...(reason ? { reason: truncateRemoteText(redact(reason), maxReasonLength) } : {}),
  }
}

/** 只放行请求里要的那几样，形状照 GrantedPermissionProfile。 */
export function grantRequestedPermissions(permissions: unknown): Record<string, unknown> {
  if (!isRecord(permissions)) return {}
  const granted: Record<string, unknown> = {}
  if (isRecord(permissions.network)) granted.network = permissions.network
  if (isRecord(permissions.fileSystem)) granted.fileSystem = permissions.fileSystem
  return granted
}

interface TurnState {
  id: string | null
  finalAnswer: string | null
  lastMessage: string | null
  error: string | null
  stoppedByUser: boolean
}

interface ChannelRuntime {
  id: RemoteChannelId
  adapter: RemoteChannelAdapter | null
  status: RemoteChannelStatus
  enabled: boolean
  startedAt: number
  pairing: { code: string; expiresAt: number; failures: number } | null
  peer: RemotePeer | null
  replyContext?: string
  seen: Set<string>
  idleTimer: NodeJS.Timeout | null
  inbox: Promise<void>
  outbox: Promise<void>
  threadId: string | null
  turn: TurnState | null
}

interface PendingApproval {
  id: string
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
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export class CodexRemoteService {
  private readonly runtimes: Record<RemoteChannelId, ChannelRuntime>
  private readonly pending = new Map<string, PendingApproval>()
  private readonly fileChanges = new Map<string, string[]>()
  private nextApprovalId = 1
  private codex: CodexAppServerClient | null = null
  private codexStarting: Promise<CodexAppServerClient> | null = null
  private secrets: readonly string[] = []
  private secretsReadAt = 0
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
      if (runtime.pairing && runtime.pairing.expiresAt <= now) runtime.pairing = null
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
    return {
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
    const reason = this.options.inspectAvailability()
    if (reason) throw new Error(reason)
    const settings = await this.options.store.readSettings()
    if (!settings.workspaceDirectory) throw new Error('先选好 Codex 在哪个文件夹里干活。')
    validateRemoteWorkspace(settings.workspaceDirectory, this.options.homeDirectory, this.platform)
    if ((await this.options.store.readCredential(channel)) === null) throw new Error('先完成这个渠道的登录。')
    await this.startChannel(runtime)
    return this.emit()
  }

  async startPairing(channel: RemoteChannelId): Promise<CodexRemoteSnapshot> {
    const runtime = this.runtimes[channel]
    if (!runtime.enabled) throw new Error('先打开这个渠道，再开始配对。')
    runtime.pairing = {
      code: generatePairingCode(this.options.randomInt ?? cryptoRandomInt),
      expiresAt: this.now() + pairingTtlMs,
      failures: 0,
    }
    this.options.log('info', 'remote.pairing-started', { channel })
    return this.emit()
  }

  async cancelPairing(channel: RemoteChannelId): Promise<CodexRemoteSnapshot> {
    this.runtimes[channel].pairing = null
    return this.emit()
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

  async readChannelCredential(channel: RemoteChannelId): Promise<string | null> {
    return this.options.store.readCredential(channel)
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
        await this.startChannel(runtime)
      }
    }
    return this.emit()
  }

  /** 星芒退出：跟手机说一声（最多等一会儿），停掉渠道和 Codex。 */
  async shutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all(remoteChannelIds.map((id) => this.disableChannel(this.runtimes[id], remoteMessages.closedOnComputer)))
    await this.stopCodex()
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

  private pendingFor(channel: RemoteChannelId): PendingApproval[] {
    return [...this.pending.values()].filter((entry) => entry.channel === channel)
      .sort((left, right) => Number(left.id) - Number(right.id))
  }

  private async startChannel(runtime: ChannelRuntime): Promise<void> {
    runtime.enabled = true
    runtime.startedAt = this.now()
    runtime.seen.clear()
    runtime.status = { state: 'connecting' }
    const adapter = this.options.createChannel(runtime.id, this.channelDependencies(runtime.id))
    runtime.adapter = adapter
    await this.refreshSecrets(true)
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
    runtime.pairing = null
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
    runtime.turn = null
    if (turn.id && runtime.threadId && this.codex?.running) {
      await this.codex.request('turn/interrupt', { threadId: runtime.threadId, turnId: turn.id }, 10_000).catch(() => {
        this.options.log('warn', 'remote.interrupt-failed', { channel: runtime.id })
      })
    }
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

  private deliver(runtime: ChannelRuntime, peer: RemotePeer, message: RemoteOutbound): Promise<void> {
    const adapter = runtime.adapter
    if (!adapter) return Promise.resolve()
    const replyContext = runtime.replyContext
    const next = runtime.outbox.then(() => adapter.send(peer, message, replyContext))
    runtime.outbox = next.catch(() => undefined)
    return next.catch(() => {
      this.options.log('warn', 'remote.send-failed', { channel: runtime.id, kind: message.kind })
      throw new Error('send failed')
    })
  }

  private async sendText(runtime: ChannelRuntime, text: string, peer = runtime.peer): Promise<void> {
    const adapter = runtime.adapter
    if (!peer || !adapter) return
    await this.refreshSecrets()
    const chunks = splitRemoteText(redactRemoteText(text, this.redaction()), adapter.capabilities.maxTextLength, maxReplyChunks)
    for (const chunk of chunks) {
      try {
        await this.deliver(runtime, peer, { kind: 'text', text: chunk })
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
    if (message.sentAt !== undefined && isStaleInbound(message.sentAt, runtime.startedAt, now)) {
      this.options.log('info', 'remote.dropped', { channel: runtime.id, reason: 'stale' })
      return
    }
    if (message.kind !== 'approval') {
      if (runtime.seen.has(message.messageId)) return
      runtime.seen.add(message.messageId)
      if (runtime.seen.size > seenMessageLimit) {
        const oldest = runtime.seen.values().next().value
        if (oldest !== undefined) runtime.seen.delete(oldest)
      }
    }
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
      await this.answerApproval(runtime, message.decision, message.approvalId)
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

  private async tryPair(runtime: ChannelRuntime, message: RemoteInbound): Promise<void> {
    const pairing = runtime.pairing
    // 没在配对、或者不是配对码：不回话，免得别人拿消息探出这里有个遥控。
    if (!pairing || message.kind !== 'text') return
    if (pairing.expiresAt <= this.now()) {
      runtime.pairing = null
      this.emitSoon()
      return
    }
    const attempt = normalizePairingAttempt(message.text)
    if (!attempt) return
    if (attempt !== pairing.code) {
      pairing.failures += 1
      this.options.log('warn', 'remote.pairing-mismatch', { channel: runtime.id, failures: pairing.failures })
      if (pairing.failures >= maxPairingFailures) {
        runtime.pairing = null
        this.options.log('warn', 'remote.pairing-locked', { channel: runtime.id })
        this.emitSoon()
      }
      return
    }
    runtime.pairing = null
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
    const turn: TurnState = { id: null, finalAnswer: null, lastMessage: null, error: null, stoppedByUser: false }
    runtime.turn = turn
    this.emitSoon()
    await this.sendText(runtime, remoteMessages.received)
    let client: CodexAppServerClient
    try {
      client = await this.ensureCodex()
    } catch (error) {
      this.options.log('error', 'remote.codex-start-failed', { reason: error instanceof Error ? error.name : 'unknown' })
      if (runtime.turn === turn) runtime.turn = null
      await this.sendText(runtime, remoteMessages.codexUnavailable)
      this.emitSoon()
      return
    }
    try {
      if (!runtime.threadId) {
        const started = await client.request('thread/start', buildThreadStartParams(workspace))
        const thread = isRecord(started) && isRecord(started.thread) ? stringField(started.thread.id) : null
        if (!thread) throw new Error('Codex 没有开出新对话')
        runtime.threadId = thread
      }
      const threadId = runtime.threadId
      const result = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
      })
      const turnId = isRecord(result) && isRecord(result.turn) ? stringField(result.turn.id) : null
      if (runtime.turn === turn && turnId) turn.id = turnId
      else if (turn.stoppedByUser && turnId) {
        // 「停止」比 Codex 回执先到：现在有编号了，补一次打断。
        await client.request('turn/interrupt', { threadId, turnId }, 10_000).catch(() => undefined)
      }
      this.emitSoon()
    } catch (error) {
      if (runtime.turn !== turn) return
      runtime.turn = null
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
            onExit: (detail) => this.onCodexExit(client, detail.expected, detail.code),
          })
        } catch (error) {
          await client.stop()
          throw error
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

  private onCodexExit(client: CodexAppServerClient, expected: boolean, code: number | null): void {
    if (this.codex === client) this.codex = null
    this.fileChanges.clear()
    if (expected) return
    this.options.log('warn', 'remote.codex-exited', { code })
    for (const id of remoteChannelIds) {
      const runtime = this.runtimes[id]
      for (const entry of this.pendingFor(id)) entry.settle('decline')
      runtime.threadId = null
      if (runtime.turn) {
        runtime.turn = null
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
    if (turn.id && turnId && turn.id !== turnId) return
    runtime.turn = null
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
        return {
          permissions: decision === 'accept' && isRecord(params) ? grantRequestedPermissions(params.permissions) : {},
          scope: 'turn',
        }
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

  private async requestApproval(kind: RemoteApprovalKind, params: unknown): Promise<RemoteApprovalDecision> {
    if (!isRecord(params)) return 'decline'
    const threadId = stringField(params.threadId)
    const runtime = this.runtimeByThread(threadId)
    const peer = runtime?.peer
    if (!runtime || !threadId || !peer || !runtime.turn || runtime.turn.stoppedByUser || !runtime.adapter) return 'decline'
    await this.refreshSecrets()
    const id = String(this.nextApprovalId)
    this.nextApprovalId += 1
    const itemId = stringField(params.itemId)
    const request = buildApprovalRequest(id, kind, params, itemId ? this.fileChanges.get(itemId) ?? [] : [], {
      homeDirectory: this.options.homeDirectory,
      platform: this.platform,
      secrets: this.secrets,
    })
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
