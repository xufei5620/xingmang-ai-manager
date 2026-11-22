import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppServerRequestError, AppServerTimeoutError, type AppServerProcess } from './codex-remote-app-server'
import type {
  CodexRemoteSnapshot,
  RemoteApprovalRequest,
  RemoteChannelAdapter,
  RemoteChannelHandlers,
  RemoteImageFetchResult,
  RemoteInbound,
  RemoteApprovalOutcome,
  RemoteOutbound,
  RemoteOutboundApproval,
  RemotePeer,
  RemoteProgressCard,
} from './codex-remote-channel'
import { createRemoteImageStore, type RemoteImageStore } from './codex-remote-images'
import { createCodexRemoteKeepAwake } from './codex-remote-keep-awake'
import { encodeWeixinCredential } from './codex-remote-weixin-credential'
import { CodexRemoteStore, credentialRemoveFailedMessage } from './codex-remote-store'
import type { SafeStorageLike } from './account-session-store'
import {
  autoStartRetryMs,
  belongsToOtherTurn,
  buildApprovalRequest,
  buildFileChangeSummary,
  buildRemoteMcpServerOverrides,
  buildRemoteSandboxPolicy,
  buildThreadStartParams,
  configuredCodexModel,
  collectCredentialSecrets,
  codexRemoteBusyMessages,
  CodexRemoteService,
  commandApprovalKind,
  countChangedLines,
  generateApprovalNonce,
  generatePairingCode,
  grantRequestedPermissions,
  inspectCommandDisplay,
  isStaleInbound,
  isStaleOnlyByClock,
  jumpsImageFetch,
  nextApprovalNumber,
  permissionsShowInFull,
  readFileChange,
  readRequestedPermissions,
  remoteChannelsReadyToEnable,
  remoteIdleInstallQuietMs,
  codexRejectedRequest,
  codexSupportsResume,
  readCodexVersion,
  readListedConversations,
  readResumedThread,
  remoteRulesInEffect,
  resolveChosenConversation,
  resumedPermissionFits,
  sameRemoteFolder,
  sentWhileOpen,
  startedSandboxExceeds,
  validateRemoteWorkspace,
} from './codex-remote-service'
import type { RemoteFileChangeLine } from './codex-remote-text'

const roots: string[] = []
const apiKey = 'sk-xingmang-0123456789abcdef'
const alice: RemotePeer = { channel: 'feishu', userId: 'ou_alice_1234' }
const mallory: RemotePeer = { channel: 'feishu', userId: 'ou_mallory_9' }

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-remote-service-'))
  roots.push(root)
  return root
}

function fakeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').slice(4),
  }
}

interface Waiters {
  /** done 成立时 resolve（已经成立就立刻 resolve）。 */
  until(done: () => boolean): Promise<void>
  /** 可能让某个 done 成立的事刚发生：成立了的都 resolve。 */
  wake(): void
}

/** 等某件事本身发生，不靠 vi.waitFor 的 1 秒轮询：前面排着原子写的，Windows CI 上会撞过 1 秒。 */
function createWaiters(): Waiters {
  const waiting: Array<{ done: () => boolean; resolve: () => void }> = []
  return {
    until(done) {
      if (done()) return Promise.resolve()
      return new Promise((resolve) => { waiting.push({ done, resolve }) })
    },
    wake() {
      for (const waiter of [...waiting]) {
        if (!waiter.done()) continue
        waiting.splice(waiting.indexOf(waiter), 1)
        waiter.resolve()
      }
    },
  }
}

function isRecordParams(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

class FakeCodex extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly written: Array<Record<string, unknown>> = []
  readonly kills: string[] = []
  /** 按方法名设了就等它好了才回：模拟 Codex 的回执比别的消息晚到。 */
  readonly replyGates = new Map<string, Promise<unknown>>()
  /** config/read 回什么（result 或 error）：缺省是什么外部工具都没配。 */
  configRead: Record<string, unknown> = { result: { config: {}, origins: {}, layers: [] } }
  /** 设了就拿它当 turn/interrupt 的报错回去：模拟 Codex 不答应停（M01）。 */
  interruptError: Record<string, unknown> | null = null
  /** initialize 回的 userAgent：缺省读不出版本（接已有对话不开放）。 */
  userAgent = 'codex'
  /** 别的方法按名字回什么（result 或 error），比如 thread/list、thread/resume。 */
  readonly replies2 = new Map<string, (params: Record<string, unknown>) => Record<string, unknown>>()
  private turns = 0
  private readonly replies = new Map<string, (message: Record<string, unknown>) => void>()
  private readonly requestWaiters: Array<{ done: () => boolean; resolve: () => void }> = []
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) this.receive(JSON.parse(line) as Record<string, unknown>)
      return true
    },
    end: () => undefined,
    on: () => this,
  }

  /** 设了就只记下收到的信号、先不退出，等测试调 exitNow()：模拟 Windows 上 taskkill 收掉一整棵进程要一会儿。 */
  holdExit = false

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM')
    if (!this.holdExit) this.emit('exit', null, signal ?? 'SIGTERM')
    return true
  }

  exitNow(): void {
    this.emit('exit', null, 'SIGTERM')
  }

  send(message: unknown): void {
    this.stdout.emit('data', `${JSON.stringify(message)}\n`)
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params })
  }

  /** Codex asks the client something; resolves with what the client answered. */
  ask(method: string, params: unknown, id = `srv-${this.written.length}`): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.replies.set(id, resolve)
      this.send({ id, method, params })
    })
  }

  requests(method: string): Array<Record<string, unknown>> {
    return this.written.filter((message) => message.method === method)
  }

  /**
   * 写给 Codex 的 method 请求到了 count 条时 resolve。手机发来的话要先把消息编号原子写进盘才处理（YR-2），
   * 直接等请求本身，不靠 vi.waitFor 的 1 秒（R16）。没设 replyGates 的请求当场回了才 resolve：服务收回执排在
   * 用例前面，接着 notify 的 turn/completed 对得上这一轮的编号。
   */
  requestedUntil(method: string, count = 1): Promise<void> {
    const done = () => this.requests(method).length >= count
    if (done()) return Promise.resolve()
    return new Promise((resolve) => { this.requestWaiters.push({ done, resolve }) })
  }

  private receive(message: Record<string, unknown>): void {
    this.written.push(message)
    this.answer(message)
    for (const waiter of [...this.requestWaiters]) {
      if (!waiter.done()) continue
      this.requestWaiters.splice(this.requestWaiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  private answer(message: Record<string, unknown>): void {
    const id = message.id
    if (typeof id === 'string' && !message.method) {
      this.replies.get(id)?.(message)
      this.replies.delete(id)
      return
    }
    if (typeof id !== 'string') return
    let reply: Record<string, unknown> | null = null
    if (message.method === 'initialize') reply = { id, result: { userAgent: this.userAgent } }
    if (message.method === 'config/read') reply = { id, ...this.configRead }
    if (message.method === 'thread/start') reply = { id, result: { thread: { id: 'th-1' } } }
    if (message.method === 'turn/start') {
      this.turns += 1
      reply = { id, result: { turn: { id: `tu-${this.turns}`, status: 'inProgress' } } }
    }
    // 用例给了怎么回的，照用例的回（M02 要 turn/start 明着报错）。
    const custom = typeof message.method === 'string' ? this.replies2.get(message.method) : undefined
    if (custom) reply = { id, ...custom(isRecordParams(message.params)) }
    if (message.method === 'turn/interrupt') reply = this.interruptError ? { id, error: this.interruptError } : { id, result: {} }
    if (!reply) return
    const gate = typeof message.method === 'string' ? this.replyGates.get(message.method) : undefined
    const answer = reply
    if (gate) void gate.then(() => this.send(answer))
    else this.send(answer)
  }
}

class FakeChannel implements RemoteChannelAdapter {
  readonly id = 'feishu' as const
  readonly capabilities = { approvalButtons: true, maxTextLength: 4000 }
  handlers: RemoteChannelHandlers | null = null
  readonly sent: Array<{ peer: RemotePeer; message: RemoteOutbound; replyContext?: string }> = []
  stopped = 0
  /** 设了就每一条都发不出去：模拟网断了，平台那边重发几次也没成（M03）。发不出去的记进 failed，不进 sent。 */
  offline = false
  readonly failed: RemoteOutbound[] = []
  /** 设了就每一条都等它好了才发：模拟发到一半的那一会儿。 */
  gate: Promise<void> | null = null
  /** 接下来的几次发送各等一道：第一次等 holds[0]，第二次等 holds[1]……没配到的照常发（M14）。 */
  readonly holds: Array<Promise<void>> = []
  /** 停连接、让还没发出去的别发了、发出去一条，按先后记下（M14）。 */
  readonly events: string[] = []
  private readonly waiters: Array<{ done: () => boolean; resolve: () => void }> = []

  async start(handlers: RemoteChannelHandlers): Promise<void> {
    this.handlers = handlers
    handlers.onStatus({ state: 'connected' })
  }

  async stop(): Promise<void> {
    this.stopped += 1
    this.events.push('stop')
  }

  cancelPendingSends(): void {
    this.events.push('cancel')
  }

  async send(peer: RemotePeer, message: RemoteOutbound, replyContext?: string): Promise<void> {
    const hold = this.holds.shift()
    if (hold) await hold
    if (this.gate) await this.gate
    if (this.offline) {
      this.failed.push(message)
      this.wakeWaiters()
      throw new Error('无法连接飞书，请检查网络')
    }
    this.sent.push({ peer, message, replyContext })
    this.events.push(`send:${message.text}`)
    this.wakeWaiters()
  }

  private wakeWaiters(): void {
    for (const waiter of [...this.waiters]) {
      if (!waiter.done()) continue
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  /**
   * 发到手机（或者 offline 时没发出去）的那一下让 done 成立时 resolve（已经成立就立刻 resolve）。直接等发送本身，不用 vi.waitFor 的
   * 1 秒轮询：「配对成功」和每张审批卡片都要先把设置原子写进盘才发，Windows CI 上撞过 1 秒（#1542）。
   */
  sentUntil(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve()
    return new Promise((resolve) => { this.waiters.push({ done, resolve }) })
  }

  texts(): string[] {
    return this.sent.map((entry) => (entry.message.kind === 'text' ? entry.message.text : `[approval] ${entry.message.text}`))
  }
}

/** 能原地更新进度卡的渠道（像飞书，YF-15）：发卡、更新都记下来。 */
class FakeCardChannel extends FakeChannel {
  readonly progress: Array<{ op: 'send' | 'update'; handle: string; card: RemoteProgressCard }> = []
  /** 接下来这么多次更新失败（M17）；updateAttempts 连失败的一起数。 */
  failUpdates = 0
  updateAttempts = 0
  private cards = 0

  async sendProgress(_peer: RemotePeer, card: RemoteProgressCard): Promise<string> {
    this.cards += 1
    const handle = `om_card_${this.cards}`
    this.progress.push({ op: 'send', handle, card })
    return handle
  }

  async updateProgress(handle: string, card: RemoteProgressCard): Promise<void> {
    this.updateAttempts += 1
    if (this.failUpdates > 0) {
      this.failUpdates -= 1
      throw new Error('feishu said no')
    }
    this.progress.push({ op: 'update', handle, card })
  }
}

/** 能把审批卡改成处理过的样子的渠道（像飞书，YK-8）：发卡照样记进 sent，改样子另记。 */
class FakeApprovalCardChannel extends FakeChannel {
  readonly approvalUpdates: Array<{ handle: string; message: RemoteOutboundApproval; outcome: RemoteApprovalOutcome }> = []
  failUpdates = false
  private cards = 0

  async sendApproval(peer: RemotePeer, message: RemoteOutboundApproval): Promise<string> {
    await this.send(peer, message)
    this.cards += 1
    return `om_approval_${this.cards}`
  }

  async updateApproval(handle: string, message: RemoteOutboundApproval, outcome: RemoteApprovalOutcome): Promise<void> {
    if (this.failUpdates) throw new Error('feishu said no')
    this.approvalUpdates.push({ handle, message, outcome })
  }
}

/** 一连就抛的渠道：模拟读凭据出错这类，连都没连起来、也不会自己再试。 */
class FakeFailingChannel extends FakeChannel {
  async start(handlers: RemoteChannelHandlers): Promise<void> {
    this.handlers = handlers
    throw new Error('keychain locked')
  }
}

/**
 * 能取图的渠道（YF-14）：images 里放好每个句柄取回来什么，取过哪些记在 fetched。gates 里设了的句柄等它好了
 * 才取回来：模拟网不好时取图慢（YR-6）。
 */
class FakeImageChannel extends FakeChannel {
  readonly images = new Map<string, RemoteImageFetchResult>()
  readonly gates = new Map<string, Promise<unknown>>()
  readonly fetched: string[] = []
  private readonly fetchWaiters = createWaiters()

  /** 开始取第 count 张图时 resolve：带图的消息也先把编号原子写进盘才去取（YR-2），等取图本身。 */
  fetchedUntil(count: number): Promise<void> {
    return this.fetchWaiters.until(() => this.fetched.length >= count)
  }

  async fetchImage(ref: string, maxBytes: number): Promise<RemoteImageFetchResult> {
    this.fetched.push(ref)
    this.fetchWaiters.wake()
    expect(maxBytes).toBe(10 * 1024 * 1024)
    await this.gates.get(ref)
    return this.images.get(ref) ?? { ok: false, reason: 'failed' }
  }
}

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

let messageCounter = 0
const commandRequest = { threadId: 'th-1', turnId: 'tu-1', itemId: 'i1', startedAtMs: 0, environmentId: null, kind: 'command', command: 'npm test', cwd: '/tmp/x' }

function text(peer: RemotePeer, body: string, extra: Partial<RemoteInbound> = {}): RemoteInbound {
  messageCounter += 1
  return { kind: 'text', peer, direct: true, messageId: `m-${messageCounter}`, text: body, replyContext: `ctx-${messageCounter}`, ...extra } as RemoteInbound
}

interface Setup {
  service: CodexRemoteService
  channel: FakeChannel
  channels: FakeChannel[]
  codex: FakeCodex[]
  snapshots: CodexRemoteSnapshot[]
  workspace: string
  store: CodexRemoteStore
  logs: string[]
  logDetails: Array<{ event: string; detail?: Record<string, unknown> }>
  unavailable: { reason: string | null }
  imageDirectory: string
  /**
   * 第 count 张图存好（原子写换名落盘）时 resolve（YF-14）。取图（FakeImageChannel.fetched）在存图之前，
   * 取过了文件还在写，目录里是一个 .tmp 临时文件；要看目录得等存图本身（Windows CI 上撞过，2026-11-12）。
   */
  imagesSaved(count: number): Promise<void>
  /** 删图删够 count 张时 resolve（M05）：删图在后台做，要看目录得等删图本身。 */
  imagesRemoved(count: number): Promise<void>
  /**
   * 起够 count 份 Codex 时 resolve。手机发来的话要先把消息编号原子写进盘才起 Codex（YR-2），Windows CI 上写得慢时
   * 过了 vi.waitFor 的 1 秒（2026-11-20 #1949、#2038）：等起 Codex 本身。
   */
  codexSpawned(count: number): Promise<void>
  /** 叫起 Codex 叫到第 count 次时 resolve，在 spawnGate 之前：这时服务已经算「Codex 正在起」。 */
  spawnAsked(count: number): Promise<void>
  /** 推给电脑窗口的状态（onStateChanged）有一份让 done 成立时 resolve：关渠道要先写设置，等推状态本身。 */
  stateUntil(done: (snapshot: CodexRemoteSnapshot) => boolean): Promise<void>
}

async function setup(options: {
  workspace?: boolean
  credential?: boolean
  codexProblem?: string
  root?: string
  /** 设了就等它好了才把 Codex 交出去：模拟 Codex 起得慢。 */
  spawnGate?: Promise<unknown>
  /** 起出来的每份 Codex 都按这些方法名晚回（FakeCodex.replyGates）。 */
  replyGates?: ReadonlyMap<string, Promise<unknown>>
  /** 设了就等它好了才交出 Codex 的密钥：模拟读配置读得慢。 */
  secretsGate?: Promise<unknown>
  /** 电脑上的钟，缺省 Date.now。 */
  now?: () => number
  /** 起出来的每份 Codex 回 config/read 用的（FakeCodex.configRead）。 */
  configRead?: Record<string, unknown>
  /** 还剩几次起 Codex 直接失败：模拟 Codex 坏了、起不来。 */
  failSpawns?: { remaining: number }
  /** 设置里「多久没消息就自动关」选的时长；缺省 = 不自动关（YF-10）。 */
  idleCloseHours?: 4 | 12
  /** 「状态」里报的余额（YF-18）；缺省 = 不报。 */
  readBalanceUsd?: () => Promise<number | null>
  /** 渠道能原地更新进度卡（像飞书，YF-15）；缺省像微信，只能发文字。 */
  progressCards?: boolean
  /** 渠道能把审批卡改成处理过的样子（像飞书，YK-8）。 */
  approvalCards?: boolean
  /** 服务按哪个平台的路径规矩认文件夹；缺省 darwin。 */
  platform?: NodeJS.Platform
  /** 渠道能取图（YF-14）；imageStore 缺省跟着它，设成 false 就是有渠道能取、底座没处存。 */
  images?: boolean
  imageStore?: boolean
  /** 渠道一连就抛（FakeFailingChannel）。 */
  startFails?: boolean
  /** 这台 Windows 电脑登录的账号本身就带管理员权限（CodexRemoteServiceOptions.alwaysElevatedAccount）。 */
  alwaysElevatedAccount?: boolean
  /** 起出来的 Codex 报的版本（initialize 的 userAgent）；缺省读不出版本。 */
  codexVersion?: string
  /** 起出来的每份 Codex 对这些方法怎么回（FakeCodex.replies2）。 */
  codexReplies?: Record<string, (params: Record<string, unknown>) => Record<string, unknown>>
} = {}): Promise<Setup> {
  const root = options.root ?? tempRoot()
  const home = path.join(root, 'home')
  const workspace = path.join(home, 'projects', 'demo')
  fs.mkdirSync(workspace, { recursive: true })
  const store = new CodexRemoteStore(path.join(root, 'data', 'codex-remote'), fakeStorage(), 'darwin')
  const imageDirectory = path.join(root, 'data', 'codex-remote', 'images')
  if (options.workspace !== false) await store.updateSettings((settings) => { settings.workspaceDirectory = workspace })
  if (options.idleCloseHours) await store.updateSettings((settings) => { settings.idleCloseHours = options.idleCloseHours })
  if (options.credential !== false) await store.writeCredential('feishu', JSON.stringify({ appId: 'cli_abcdef', appSecret: 'feishu-secret-value' }))
  const channels: FakeChannel[] = []
  const codex: FakeCodex[] = []
  const snapshots: CodexRemoteSnapshot[] = []
  const logs: string[] = []
  const logDetails: Setup['logDetails'] = []
  const unavailable = { reason: null as string | null }
  let savedImageCount = 0
  const imageSaveWaiters: Array<{ count: number; resolve: () => void }> = []
  function imagesSaved(count: number): Promise<void> {
    if (savedImageCount >= count) return Promise.resolve()
    return new Promise((resolve) => { imageSaveWaiters.push({ count, resolve }) })
  }
  let removedImageCount = 0
  const imageRemoveWaiters: Array<{ count: number; resolve: () => void }> = []
  function imagesRemoved(count: number): Promise<void> {
    if (removedImageCount >= count) return Promise.resolve()
    return new Promise((resolve) => { imageRemoveWaiters.push({ count, resolve }) })
  }
  const stateWaiters = createWaiters()
  function stateUntil(done: (snapshot: CodexRemoteSnapshot) => boolean): Promise<void> {
    return stateWaiters.until(() => {
      const latest = snapshots.at(-1)
      return latest !== undefined && done(latest)
    })
  }
  let spawnAskedCount = 0
  const spawnAskWaiters = createWaiters()
  function spawnAsked(count: number): Promise<void> {
    return spawnAskWaiters.until(() => spawnAskedCount >= count)
  }
  const codexSpawnWaiters = createWaiters()
  function codexSpawned(count: number): Promise<void> {
    return codexSpawnWaiters.until(() => codex.length >= count)
  }
  function observedImageStore(): RemoteImageStore {
    const real = createRemoteImageStore(imageDirectory)
    return {
      ...real,
      async save(bytes, type) {
        const saved = await real.save(bytes, type)
        savedImageCount += 1
        for (const waiter of [...imageSaveWaiters]) {
          if (savedImageCount < waiter.count) continue
          imageSaveWaiters.splice(imageSaveWaiters.indexOf(waiter), 1)
          waiter.resolve()
        }
        return saved
      },
      async remove(paths) {
        await real.remove(paths)
        removedImageCount += paths.length
        for (const waiter of [...imageRemoveWaiters]) {
          if (removedImageCount < waiter.count) continue
          imageRemoveWaiters.splice(imageRemoveWaiters.indexOf(waiter), 1)
          waiter.resolve()
        }
      },
    }
  }
  const service = new CodexRemoteService({
    store,
    createChannel: () => {
      const channel = options.startFails
        ? new FakeFailingChannel()
        : options.images
        ? new FakeImageChannel()
        : options.approvalCards ? new FakeApprovalCardChannel() : options.progressCards ? new FakeCardChannel() : new FakeChannel()
      channels.push(channel)
      return channel
    },
    fetch: vi.fn(),
    appVersion: '0.2.21',
    homeDirectory: home,
    platform: options.platform ?? 'darwin',
    log: (_level, event, detail) => {
      logs.push(event)
      logDetails.push({ event, ...(detail ? { detail } : {}) })
    },
    randomInt: () => 42,
    ...(options.now ? { now: options.now } : {}),
    spawnCodex: async () => {
      spawnAskedCount += 1
      spawnAskWaiters.wake()
      await options.spawnGate
      if (options.failSpawns && options.failSpawns.remaining > 0) {
        options.failSpawns.remaining -= 1
        throw new Error('spawn codex ENOENT')
      }
      const fake = new FakeCodex()
      for (const [method, gate] of options.replyGates ?? []) fake.replyGates.set(method, gate)
      if (options.configRead) fake.configRead = options.configRead
      if (options.codexVersion) fake.userAgent = `xingmang_remote/${options.codexVersion} (Mac OS 15.1.0; arm64) (xingmang_remote; 0.2.25)`
      for (const [method, reply] of Object.entries(options.codexReplies ?? {})) fake.replies2.set(method, reply)
      codex.push(fake)
      codexSpawnWaiters.wake()
      return fake as unknown as AppServerProcess
    },
    readCodexSecrets: async () => {
      await options.secretsGate
      return [apiKey]
    },
    inspectAvailability: () => unavailable.reason,
    ...(options.alwaysElevatedAccount ? { alwaysElevatedAccount: true } : {}),
    checkCodexReady: async () => options.codexProblem ?? null,
    onStateChanged: (snapshot) => {
      snapshots.push(snapshot)
      stateWaiters.wake()
    },
    ...(options.readBalanceUsd ? { readBalanceUsd: options.readBalanceUsd } : {}),
    ...(options.images && options.imageStore !== false ? { imageStore: observedImageStore() } : {}),
  })
  return { service, channel: new FakeChannel(), channels, codex, snapshots, workspace, store, logs, logDetails, unavailable, imageDirectory, imagesSaved, imagesRemoved, codexSpawned, spawnAsked, stateUntil }
}

async function enabledAndPaired(s: Setup): Promise<FakeChannel> {
  await s.service.setChannelEnabled('feishu', true)
  const channel = s.channels[0]
  await s.service.startPairing('feishu')
  channel.handlers?.onInbound(text(alice, '000042'))
  await channel.sentUntil(() => channel.texts().includes('配对成功，本机的 Codex 现仅响应您的消息。直接发送消息即可下达任务，发送「帮助」可查看可用指令。'))
  channel.sent.length = 0
  return channel
}

async function prompted(s: Setup, channel: FakeChannel, body = '跑一下测试'): Promise<FakeCodex> {
  channel.handlers?.onInbound(text(alice, body))
  return turnStarted(s, 1)
}

/**
 * 第 index + 1 份 Codex 收到第 count 个 turn/start 时返回它。每句话交给 Codex 之前都先原子写一次消息编号（YR-2），
 * 直接等起 Codex 和请求本身，不靠 vi.waitFor 的 1 秒。
 */
async function turnStarted(s: Setup, count: number, index = 0): Promise<FakeCodex> {
  await s.codexSpawned(index + 1)
  const codex = s.codex[index]
  await codex.requestedUntil('turn/start', count)
  return codex
}

/** 手机上收到过几次「帮助」那段话。 */
function helpReplies(channel: FakeChannel): number {
  return channel.texts().filter((line) => line.startsWith('直接发送消息即可让 Codex 执行任务。')).length
}

/** 等「状态」的回复发出去：同一个渠道的消息一条条处理，它前面那几条这时都处理完了。 */
function statusReplied(channel: FakeChannel): Promise<void> {
  return channel.sentUntil(() => channel.texts().some((line) => line.startsWith('工作文件夹：')))
}

function approvalsSent(channel: FakeChannel): RemoteApprovalRequest[] {
  return channel.sent.flatMap((entry) => (entry.message.kind === 'approval' ? [entry.message.request] : []))
}

/** 等第 count 张审批卡片发出去：每张卡片发之前都要把编号原子写进盘。 */
async function approvalCardsSent(channel: FakeChannel, count: number): Promise<RemoteApprovalRequest[]> {
  await channel.sentUntil(() => approvalsSent(channel).length >= count)
  const cards = approvalsSent(channel)
  expect(cards).toHaveLength(count)
  return cards
}

function cardClick(peer: RemotePeer, request: Pick<RemoteApprovalRequest, 'approvalId'> & { nonce: string | null }, decision: 'accept' | 'decline', direct = true): RemoteInbound {
  return { kind: 'approval', peer, direct, approvalId: request.approvalId, nonce: request.nonce, decision }
}

/** What Codex 0.164.0 sends for plain read/write roots: the legacy lists, then the same paths again as `entries`. */
function codexPermissions(read: string[] | null, write: string[] | null, network: boolean | null = null): Record<string, unknown> {
  return {
    network: network === null ? null : { enabled: network },
    fileSystem: {
      read,
      write,
      entries: [
        ...(read ?? []).map((entry) => ({ path: { type: 'path', path: entry }, access: 'read' })),
        ...(write ?? []).map((entry) => ({ path: { type: 'path', path: entry }, access: 'write' })),
      ],
    },
  }
}

const wholeDiskWrite = {
  network: null,
  fileSystem: { read: null, write: null, entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'write' }] },
}

const permissionsRefusedText = 'Codex 请求了额外权限，但请求范围无法在手机上完整显示，已自动拒绝。如确有需要，请在电脑端直接使用 Codex 完成此操作。'

const commandRefusedText = 'Codex 请求运行的命令过长，无法在手机上完整显示，已自动拒绝。如确有需要，请在电脑端直接使用 Codex 完成此操作。'

const npmRegistry = { host: 'registry.npmjs.org', protocol: 'https' }

const staleCardText = '此卡片已失效（已处理、已超时，或电脑端的星芒已重启），本次操作未生效。如有需要您确认的操作，将另发新卡片。'

const clockAheadText = '电脑与手机的时间相差过大，此消息未执行。请校准电脑时间后重新发送。'

function staleNotice(minutes: number): string {
  return `此消息发送于 ${minutes} 分钟前，当时电脑未连接，因此未执行。如仍需执行，请重新发送。`
}

/** 老版本 Codex 只给路径时卡片上列的样子：不带新建、删除这些字，也不带行数。 */
function pathsOnly(paths: readonly string[]): RemoteFileChangeLine[] {
  return paths.map((entry) => ({ path: entry, kind: null }))
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('codex-remote-service helpers', () => {
  it('keeps counting approval numbers and wraps after four digits', () => {
    expect(nextApprovalNumber(0)).toBe(1)
    expect(nextApprovalNumber(41)).toBe(42)
    expect(nextApprovalNumber(9998)).toBe(9999)
    expect(nextApprovalNumber(9999)).toBe(1)
    expect(nextApprovalNumber(-3)).toBe(1)
    expect(nextApprovalNumber(1.5)).toBe(1)
  })

  it('makes a fresh button-safe nonce for every approval', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateApprovalNonce()))
    expect(nonces.size).toBe(50)
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  it('tells a late message of a stopped turn from the running one', () => {
    expect(belongsToOtherTurn('tu-2', [], 'tu-1')).toBe(true)
    expect(belongsToOtherTurn('tu-2', [], 'tu-2')).toBe(false)
    // 新一轮的编号还没回来：只有停掉过的那几轮认得出来，别的照旧算这一轮的。
    expect(belongsToOtherTurn(null, ['tu-1'], 'tu-1')).toBe(true)
    expect(belongsToOtherTurn(null, ['tu-1'], 'tu-2')).toBe(false)
    // 老版本 Codex 不带编号：只能按对话认。
    expect(belongsToOtherTurn('tu-2', ['tu-1'], undefined)).toBe(false)
    expect(belongsToOtherTurn('tu-2', ['tu-1'], '')).toBe(false)
  })

  it('tells an old message sent while the remote was on from one sent before it was switched on', () => {
    const started = 1_000_000_000
    expect(sentWhileOpen(started + 5_000, started)).toBe(true)
    // The same one-minute grace as the stale check itself.
    expect(sentWhileOpen(started - 60_000, started)).toBe(true)
    expect(sentWhileOpen(started - 60_001, started)).toBe(false)
  })

  it('pads pairing codes to six digits', () => {
    expect(generatePairingCode(() => 42)).toBe('000042')
    expect(generatePairingCode(() => 999_999)).toBe('999999')
  })

  it('treats messages sent before the channel opened or long ago as stale', () => {
    expect(isStaleInbound(1_000_000 - 61_000, 1_000_000, 1_000_000)).toBe(true)
    expect(isStaleInbound(1_000_000 - 30_000, 1_000_000, 1_000_000)).toBe(false)
    expect(isStaleInbound(0, 0, 11 * 60_000)).toBe(true)
  })

  // #1407 P3-5：电脑时间快了，手机刚发的话也会被当成旧的；按平台的钟再看一遍才认得出来。
  it('tells a message dropped only because this computer runs fast from a really old one', () => {
    const fiveMinutes = 5 * 60_000
    // Local clock 5 minutes fast: the channel opened at platform time 700_000, the phone wrote a minute later.
    const startedAt = 700_000 + fiveMinutes
    const sentAt = 760_000
    const now = sentAt + fiveMinutes
    expect(isStaleInbound(sentAt, startedAt, now)).toBe(true)
    expect(isStaleOnlyByClock(sentAt, startedAt, now, fiveMinutes)).toBe(true)
    // 15 minutes fast: every message just sent looks older than ten minutes.
    expect(isStaleOnlyByClock(1_000_000, 0, 1_000_000 + 15 * 60_000, 15 * 60_000)).toBe(true)
    // Written five minutes before the channel opened, by the platform's own clock: really old, nothing to say.
    expect(isStaleOnlyByClock(700_000 - fiveMinutes, startedAt, now, fiveMinutes)).toBe(false)
    // No estimate, an estimate under a minute, or a slow clock: the drop is not the clock's fault.
    expect(isStaleOnlyByClock(sentAt, startedAt, now, undefined)).toBe(false)
    expect(isStaleOnlyByClock(sentAt, startedAt, now, 59_000)).toBe(false)
    expect(isStaleOnlyByClock(sentAt, startedAt, now, -fiveMinutes)).toBe(false)
    expect(isStaleOnlyByClock(sentAt, startedAt, now, Number.NaN)).toBe(false)
    // A message that was never dropped needs no warning either.
    expect(isStaleOnlyByClock(now, startedAt, now, fiveMinutes)).toBe(false)
  })

  // YR-6：取图慢的时候，只有「停止」「同意 / 拒绝」（打字的、卡片按钮）不等图。
  it('lets only stop and approval answers skip images still being fetched', () => {
    expect(jumpsImageFetch(text(alice, '停止'), false)).toBe(true)
    expect(jumpsImageFetch(text(alice, ' ／停止 '), false)).toBe(true)
    expect(jumpsImageFetch(text(alice, '同意 2'), true)).toBe(true)
    expect(jumpsImageFetch(text(alice, '拒绝'), true)).toBe(true)
    expect(jumpsImageFetch(cardClick(alice, { approvalId: '1', nonce: generateApprovalNonce() }, 'accept'), false)).toBe(true)
    expect(jumpsImageFetch({ kind: 'stop', peer: alice, direct: true, nonce: null }, false)).toBe(true)
    // Nothing waiting for an answer: 「同意」 is words for Codex and has to take the images sent before it.
    expect(jumpsImageFetch(text(alice, '同意 2'), false)).toBe(false)
    for (const body of ['看看这张图', '状态', '帮助', '新对话', '重试', '文件夹', '文件夹 2', '关闭遥控', '000042']) {
      expect(jumpsImageFetch(text(alice, body), true)).toBe(false)
    }
    // Words sent together with an image wait for that image, whatever they say.
    expect(jumpsImageFetch(imageMessage(alice, ['img-a'], '停止'), true)).toBe(false)
    expect(jumpsImageFetch(imageMessage(alice, ['img-a']), true)).toBe(false)
    expect(jumpsImageFetch({ kind: 'unsupported', peer: alice, direct: true, messageId: 'voice-1' }, true)).toBe(false)
  })

  // 权限两档（yoyo 2026-11-22 亲手打字同意）：「默认」跟电脑上的 Codex 一样，文件夹里不问、出沙箱才问；「只读」改东西也问。
  // 两档都只许人自己点同意，没有完全访问。
  it('starts threads that work inside the folder by default and ask before leaving the sandbox', () => {
    expect(buildThreadStartParams('/p')).toMatchObject({
      cwd: '/p',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    })
    expect(buildThreadStartParams('/p', {}, null, 'readOnly')).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
    })
    for (const permission of ['default', 'readOnly'] as const) {
      const params = buildThreadStartParams('/p', {}, null, permission)
      expect(params.sandbox).not.toBe('danger-full-access')
      expect(params.approvalPolicy).not.toBe('never')
      expect(params.approvalsReviewer).toBe('user')
      expect(JSON.stringify(buildRemoteSandboxPolicy(permission))).not.toContain('dangerFullAccess')
      expect(buildRemoteSandboxPolicy(permission)).toMatchObject({ networkAccess: false })
    }
    expect(buildRemoteSandboxPolicy('default')).toEqual({ type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false })
    expect(buildRemoteSandboxPolicy('readOnly')).toEqual({ type: 'readOnly', networkAccess: false })
  })

  // 第三轮复查第 5 条：新开的对话跟中途换档一样不开网、可写的只有这个文件夹，不照客户 config.toml 里开过的联网和加过的文件夹。
  // Codex 0.169 实测：config.toml 开了联网、加了可写文件夹，不压住时 thread/start 回报 networkAccess: true 和那个文件夹，压住后两样都没有。
  it('starts threads without network access or extra writable folders whatever config.toml allows', () => {
    for (const permission of ['default', 'readOnly'] as const) {
      expect(buildThreadStartParams('/p', {}, null, permission).config).toMatchObject({
        'sandbox_workspace_write.network_access': false,
        'sandbox_workspace_write.writable_roots': [],
      })
    }
    expect(JSON.stringify(buildThreadStartParams('/p'))).not.toContain('exclude_')
  })

  it('treats a started thread as wider than the phone level only on clear evidence', () => {
    const workspace = '/Users/a/projects/demo'
    const pinned = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    expect(startedSandboxExceeds(pinned, 'default', workspace, 'darwin')).toBe(false)
    expect(startedSandboxExceeds({ ...pinned, writableRoots: [`${workspace}/`] }, 'default', workspace, 'darwin')).toBe(false)
    expect(startedSandboxExceeds({ type: 'readOnly', networkAccess: false }, 'readOnly', workspace, 'darwin')).toBe(false)
    // Windows 没开沙箱时 Codex 把可写降成只读：比这一档严，不去抬。
    expect(startedSandboxExceeds({ type: 'readOnly', networkAccess: false }, 'default', 'C:\\Users\\a\\demo', 'win32')).toBe(false)
    expect(startedSandboxExceeds({ ...pinned, writableRoots: ['c:\\users\\a\\demo\\'] }, 'default', 'C:\\Users\\a\\demo', 'win32')).toBe(false)
    // 认不出的照开对话时带的那一档，不算宽。
    expect(startedSandboxExceeds(undefined, 'default', workspace, 'darwin')).toBe(false)
    expect(startedSandboxExceeds('workspace-write', 'default', workspace, 'darwin')).toBe(false)
    expect(startedSandboxExceeds({ type: 'workspaceWrite' }, 'default', workspace, 'darwin')).toBe(false)

    expect(startedSandboxExceeds({ ...pinned, networkAccess: true }, 'default', workspace, 'darwin')).toBe(true)
    expect(startedSandboxExceeds({ type: 'readOnly', networkAccess: true }, 'readOnly', workspace, 'darwin')).toBe(true)
    expect(startedSandboxExceeds({ ...pinned, writableRoots: ['/tmp/extra-root'] }, 'default', workspace, 'darwin')).toBe(true)
    expect(startedSandboxExceeds({ ...pinned, writableRoots: [workspace, '/Users/a'] }, 'default', workspace, 'darwin')).toBe(true)
    expect(startedSandboxExceeds({ ...pinned, writableRoots: [42] }, 'default', workspace, 'darwin')).toBe(true)
    expect(startedSandboxExceeds(pinned, 'readOnly', workspace, 'darwin')).toBe(true)
    expect(startedSandboxExceeds({ type: 'dangerFullAccess' }, 'default', workspace, 'darwin')).toBe(true)
    expect(startedSandboxExceeds({ type: 'externalSandbox', networkAccess: 'restricted' }, 'default', workspace, 'darwin')).toBe(true)
  })

  // #1407 P2-4：客户自己接的外部工具调用不一定先问人，遥控开的对话里一律关掉；联网搜索不动。
  it('starts threads without plugins, apps or the configured MCP servers, and leaves web search alone', () => {
    expect(buildThreadStartParams('/p').config).toEqual({
      'features.apps': false,
      'features.plugins': false,
      'sandbox_workspace_write.network_access': false,
      'sandbox_workspace_write.writable_roots': [],
    })
    expect(buildThreadStartParams('/p', { docs: { enabled: false } }).config).toEqual({
      'features.apps': false,
      'features.plugins': false,
      'sandbox_workspace_write.network_access': false,
      'sandbox_workspace_write.writable_roots': [],
      mcp_servers: { docs: { enabled: false } },
    })
    expect(JSON.stringify(buildThreadStartParams('/p'))).not.toContain('web_search')
  })

  it('switches off every MCP server any config layer defines', () => {
    const configRead = {
      config: { mcp_servers: { docs: { command: 'docs-mcp' } } },
      origins: {},
      layers: [
        { name: { type: 'sessionFlags' }, version: 'a', config: {}, disabledReason: null },
        // A project layer Codex has not trusted yet: thread/start will trust and load it.
        {
          name: { type: 'project', dotCodexFolder: '/p/.codex' },
          version: 'b',
          config: { mcp_servers: { repo: { command: './repo-mcp', args: ['--serve'] }, web: { url: 'https://mcp.example.test/' }, docs: { command: 'other' }, broken: { args: [] } } },
          disabledReason: 'untrusted',
        },
        { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'c', config: { mcp_servers: { docs: { command: 'docs-mcp' }, remote: { url: 'https://x.test/' } } }, disabledReason: null },
        { name: { type: 'system', file: '/etc/codex/config.toml' }, version: 'd', config: { model: 'x' }, disabledReason: null },
      ],
    }
    expect(buildRemoteMcpServerOverrides(configRead)).toEqual({
      docs: { enabled: false },
      remote: { enabled: false },
      repo: { command: './repo-mcp', enabled: false },
      web: { url: 'https://mcp.example.test/', enabled: false },
    })
  })

  it('takes the command of the highest disabled layer for a server only disabled layers define', () => {
    const layer = (command: string) => ({ config: { mcp_servers: { repo: { command } } }, disabledReason: 'untrusted' })
    expect(buildRemoteMcpServerOverrides({ layers: [layer('inner'), layer('outer')] })).toEqual({ repo: { command: 'inner', enabled: false } })
  })

  it('keeps a server called __proto__ as its own key', () => {
    const configRead = JSON.parse('{"layers":[{"config":{"mcp_servers":{"__proto__":{"command":"evil"}}},"disabledReason":null}]}') as unknown
    const overrides = buildRemoteMcpServerOverrides(configRead)
    expect(Object.keys(overrides)).toEqual(['__proto__'])
    expect(JSON.parse(JSON.stringify(buildThreadStartParams('/p', overrides)))).toMatchObject({ config: { mcp_servers: JSON.parse('{"__proto__":{"enabled":false}}') as unknown } })
  })

  it('falls back to the effective config when Codex sends no layers, and to nothing for an unreadable answer', () => {
    expect(buildRemoteMcpServerOverrides({ config: { mcp_servers: { docs: { command: 'docs-mcp' } } }, layers: null })).toEqual({ docs: { enabled: false } })
    expect(buildRemoteMcpServerOverrides(null)).toEqual({})
    expect(buildRemoteMcpServerOverrides({ layers: [null, { config: { mcp_servers: [] } }] })).toEqual({})
  })

  it('collects every long string of a channel credential as a secret', () => {
    expect(collectCredentialSecrets('{"appId":"cli_abcdef12","appSecret":"s3cr3t-value","n":1}')).toEqual(['cli_abcdef12', 's3cr3t-value'])
    expect(collectCredentialSecrets('plain-token-value')).toEqual(['plain-token-value'])
    expect(collectCredentialSecrets(null)).toEqual([])
  })

  it('refuses whole-computer folders as the remote workspace', () => {
    // These are real folders, so classify them with this machine's path rules: under the
    // posix rules a C:\ path is not absolute and nothing would be refused.
    const platform = process.platform
    const root = tempRoot()
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true })
    fs.mkdirSync(path.join(home, 'code'), { recursive: true })
    expect(() => validateRemoteWorkspace(home, home, platform)).toThrow('用户主目录')
    expect(() => validateRemoteWorkspace(path.join(home, 'Desktop'), home, platform)).toThrow('桌面')
    expect(() => validateRemoteWorkspace(path.join(home, 'missing'), home, platform)).toThrow('不存在')
    expect(() => validateRemoteWorkspace('relative', home, platform)).toThrow()
    expect(validateRemoteWorkspace(path.join(home, 'code'), home, platform)).toBe(path.join(home, 'code'))
  })

  it('redacts and shortens what an approval shows', () => {
    const request = buildApprovalRequest('7', 'nonce-seven', 'command', {
      command: `curl -H "Authorization: Bearer ${apiKey}" https://example.com`,
      cwd: '/Users/alice/projects/demo',
      reason: 'needs network',
    }, [], { homeDirectory: '/Users/alice', platform: 'darwin', secrets: [apiKey] })
    expect(request).toMatchObject({ approvalId: '7', nonce: 'nonce-seven' })
    expect(request.summary).not.toContain(apiKey)
    expect(request.cwd).toBe('~/projects/demo')
    expect(request.reason).toBe('needs network')
    const files = Array.from({ length: 25 }, (_, index) => `/Users/alice/projects/demo/f${index}.ts`)
    const change = buildApprovalRequest('8', 'nonce-eight', 'file-change', {}, pathsOnly(files), { homeDirectory: '/Users/alice', platform: 'darwin', secrets: [] })
    expect(change.summary.split('\n')).toHaveLength(21)
    expect(change.summary).toContain('另有 5 个文件')
  })

  it('tells running a command, typing into a running program and reaching a website apart', () => {
    expect(commandApprovalKind(commandRequest)).toBe('command')
    // Older Codex leaves kind out; that still means a command.
    expect(commandApprovalKind({ ...commandRequest, kind: undefined })).toBe('command')
    expect(commandApprovalKind({ ...commandRequest, kind: 'writeStdin', command: 'write_stdin --session-id 3 yes' })).toBe('terminal-input')
    expect(commandApprovalKind({ ...commandRequest, command: null, cwd: null, networkApprovalContext: npmRegistry })).toBe('network')
    // Without a host there is no website to show, so it is not a website card.
    expect(commandApprovalKind({ ...commandRequest, networkApprovalContext: { protocol: 'https' } })).toBe('command')
    expect(commandApprovalKind({ ...commandRequest, networkApprovalContext: { host: '', protocol: 'https' } })).toBe('command')
  })

  it('shows the website for a network approval and what Codex types for terminal input', () => {
    const display = { homeDirectory: '/Users/alice', platform: 'darwin' as const, secrets: [] }
    const site = buildApprovalRequest('5', 'nonce-five', 'network', { command: null, cwd: null, networkApprovalContext: npmRegistry }, [], display)
    expect(site).toMatchObject({ kind: 'network', summary: 'registry.npmjs.org' })
    expect(site.cwd).toBeUndefined()
    const input = buildApprovalRequest('6', 'nonce-six', 'terminal-input', {
      command: 'write_stdin --session-id 3 yes',
      cwd: '/Users/alice/projects/demo',
    }, [], display)
    expect(input).toMatchObject({ kind: 'terminal-input', summary: 'write_stdin --session-id 3 yes', cwd: '~/projects/demo' })
  })

  it('only puts a command on the card when the phone can show all of it', () => {
    const display = { homeDirectory: '/Users/alice', platform: 'darwin' as const, secrets: [apiKey] }
    expect(inspectCommandDisplay('command', { command: 'x'.repeat(1500) }, display)).toBe('full')
    expect(inspectCommandDisplay('command', { command: 'x'.repeat(1501) }, display)).toBe('too-long')
    expect(inspectCommandDisplay('terminal-input', { command: `write_stdin --session-id 3 ${'y'.repeat(1500)}` }, display)).toBe('too-long')
    // What counts is what the phone would show, after the key is hidden.
    const withKey = `echo ${apiKey} ${'x'.repeat(1489)}`
    expect(withKey.length).toBeGreaterThan(1500)
    expect(inspectCommandDisplay('command', { command: withKey }, display)).toBe('full')
    expect(inspectCommandDisplay('network', { networkApprovalContext: npmRegistry }, display)).toBe('full')
    // Nothing to show: the card would ask about a blank.
    expect(inspectCommandDisplay('command', { command: null }, display)).toBe('blank')
    expect(inspectCommandDisplay('command', { command: '   ' }, display)).toBe('blank')
    expect(inspectCommandDisplay('network', {}, display)).toBe('blank')
  })

  it('lists only whole file paths and always keeps the write scope line on a file change card', () => {
    const display = { homeDirectory: '/Users/alice', platform: 'darwin' as const, secrets: [apiKey] }
    // Twenty 81-character paths no longer fit: cutting the joined text used to drop the last lines.
    const files = Array.from({ length: 25 }, (_, index) => `/Volumes/Work/customer-portal/frontend/src/components/orders/details/panel-${String(index).padStart(2, '0')}.tsx`)
    const summary = buildApprovalRequest('8', 'nonce-eight', 'file-change', { grantRoot: '/Volumes/Work/customer-portal' }, pathsOnly(files), display).summary
    expect(summary.length).toBeLessThanOrEqual(1500)
    expect(summary).not.toContain('…')
    expect(summary.split('\n')).toEqual([...files.slice(0, 17), '另有 8 个文件', '可写范围：/Volumes/Work/customer-portal'])
    // Without a write scope the whole budget goes to the file list.
    expect(buildFileChangeSummary({}, pathsOnly(files), display)?.split('\n')).toEqual([...files.slice(0, 18), '另有 7 个文件'])
    expect(buildFileChangeSummary({}, [], display)).toBe('')
    // A write scope that cannot be shown whole leaves nothing to put to the person.
    expect(buildFileChangeSummary({ grantRoot: `/${'deep/'.repeat(300)}` }, pathsOnly(files), display)).toBeNull()
    expect(buildFileChangeSummary({ grantRoot: `/${'deep/'.repeat(300)}` }, [], display)).toBeNull()
    // What counts is what the phone would show, after the key is hidden.
    const keyedRoot = `/Volumes/${apiKey}/${'x'.repeat(1475)}`
    expect(`可写范围：${keyedRoot}`.length).toBeGreaterThan(1500)
    expect(buildFileChangeSummary({ grantRoot: keyedRoot }, [], display)).toBe(`可写范围：${keyedRoot}`)
  })

  // D66 / YKS-10：删文件和改一行在手机上要看得出不一样。
  it('says whether each file is created, deleted, changed or moved, with how many lines', () => {
    const display = { homeDirectory: '/Users/alice', platform: 'darwin' as const, secrets: [] }
    const changes = [
      { path: '/Users/alice/projects/demo/new.ts', kind: { type: 'add' }, diff: 'a\nb\nc\n' },
      { path: '/Users/alice/projects/demo/old.ts', kind: { type: 'delete' }, diff: 'x\ny' },
      { path: '/Users/alice/projects/demo/app.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,3 @@\n keep\n-old\n+new\n+more\n' },
      { path: '/Users/alice/projects/demo/a.ts', kind: { type: 'update', move_path: '/Users/alice/projects/demo/b.ts' }, diff: '@@ -1 +1 @@\n-x\n+y\n\nMoved to: /Users/alice/projects/demo/b.ts' },
      { path: '/Users/alice/projects/demo/legacy.ts' },
    ].map((change) => readFileChange(change))
    expect(changes.every((change) => change !== null)).toBe(true)
    expect(buildFileChangeSummary({}, changes.filter((change): change is RemoteFileChangeLine => change !== null), display)?.split('\n')).toEqual([
      '新建 ~/projects/demo/new.ts +3 -0 行',
      '删除 ~/projects/demo/old.ts +0 -2 行',
      '修改 ~/projects/demo/app.ts +2 -1 行',
      '~/projects/demo/a.ts 移动到 ~/projects/demo/b.ts +1 -1 行',
      '~/projects/demo/legacy.ts',
    ])
    expect(readFileChange({ kind: { type: 'add' } })).toBeNull()
    expect(readFileChange({ path: '/x', kind: { type: 'update' } })).toEqual({ path: '/x', kind: 'update' })
  })

  it('counts only the changed lines of a diff, not its file header or context', () => {
    expect(countChangedLines('update', '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n--- removed dashes\n+++ added pluses\n\\ No newline at end of file')).toEqual({ added: 1, removed: 1 })
    expect(countChangedLines('add', '')).toEqual({ added: 0, removed: 0 })
    expect(countChangedLines('add', 'one line without newline')).toEqual({ added: 1, removed: 0 })
    expect(countChangedLines('delete', 'a\r\nb\r\n')).toEqual({ added: 0, removed: 2 })
  })
})

describe('codex-remote-service permission requests', () => {
  const display = { homeDirectory: '/Users/alice', platform: 'darwin' as const, secrets: [] }

  it('shows and grants exactly the plain paths of a permission request', () => {
    const permissions = codexPermissions(['/Users/alice/ref'], ['/Users/alice/projects/out'], true)
    const requested = readRequestedPermissions(permissions)
    expect(requested).toEqual({ network: true, read: ['/Users/alice/ref'], write: ['/Users/alice/projects/out'] })
    expect(requested && grantRequestedPermissions(requested)).toEqual({
      network: { enabled: true },
      fileSystem: { read: ['/Users/alice/ref'], write: ['/Users/alice/projects/out'] },
    })
    expect(buildApprovalRequest('9', 'nonce-nine', 'other', { permissions }, [], display).summary)
      .toBe('联网\n写：~/projects/out\n读：~/ref')
    expect(permissionsShowInFull(permissions, display)).toBe(true)
    // The legacy lists alone (older Codex) mean the same thing.
    expect(readRequestedPermissions({ network: null, fileSystem: { read: null, write: ['/Users/alice/out'] } }))
      .toEqual({ network: false, read: [], write: ['/Users/alice/out'] })
  })

  it('refuses permission requests that carry anything the phone cannot show', () => {
    const shown = '/Users/alice/projects/out'
    function withEntries(read: string[] | null, write: string[] | null, entries: unknown[]): Record<string, unknown> {
      return { network: null, fileSystem: { read, write, entries } }
    }
    const pathEntry = (entry: string, access: string) => ({ path: { type: 'path', path: entry }, access })
    const refused: unknown[] = [
      null,
      'write everything',
      wholeDiskWrite,
      withEntries(null, null, [{ path: { type: 'glob_pattern', pattern: '/Users/alice/**' }, access: 'write' }]),
      withEntries(null, null, [{ path: { type: 'special', value: { kind: 'project_roots', subpath: null } }, access: 'write' }]),
      // Shown as read, asked as write.
      withEntries([shown], null, [pathEntry(shown, 'write')]),
      // One more path than the card lists.
      withEntries(null, [shown], [pathEntry(shown, 'write'), pathEntry('/etc', 'write')]),
      withEntries(null, [shown], [pathEntry(shown, 'write'), pathEntry('/Users/alice/.ssh', 'deny')]),
      // The card lists a path the request itself (entries win) does not ask for.
      withEntries(null, [shown], []),
      withEntries(null, [shown], [{ ...pathEntry(shown, 'write'), recursive: true }]),
      { ...codexPermissions(null, [shown]), fileSystem: { ...codexPermissions(null, [shown]).fileSystem as object, globScanMaxDepth: 3 } },
      { ...codexPermissions(null, [shown]), fileSystem: { ...codexPermissions(null, [shown]).fileSystem as object, extra: [] } },
      { ...codexPermissions(null, [shown]), macos: { accessibility: true } },
      { network: { enabled: true, domains: ['*'] }, fileSystem: null },
      { network: null, fileSystem: { read: null, write: [42] } },
      { network: null, fileSystem: { read: null, write: [''] } },
      { network: null, fileSystem: { read: null, write: shown } },
      // Nothing to show: the card would be blank.
      { network: { enabled: false }, fileSystem: null },
      codexPermissions([], []),
      codexPermissions(null, Array.from({ length: 21 }, (_, index) => `/Users/alice/projects/f${index}`)),
    ]
    for (const permissions of refused) {
      expect(readRequestedPermissions(permissions)).toBeNull()
      expect(permissionsShowInFull(permissions, display)).toBe(false)
    }
    expect(buildApprovalRequest('9', 'nonce-nine', 'other', { permissions: wholeDiskWrite }, [], display).summary).toBe('')
  })

  it('refuses a permission request whose list would be cut short on the card', () => {
    const fits = codexPermissions(null, Array.from({ length: 20 }, (_, index) => `/Users/alice/projects/f${index}`))
    expect(permissionsShowInFull(fits, display)).toBe(true)
    const long = codexPermissions(null, Array.from({ length: 20 }, (_, index) => `/Users/alice/projects/${'deep/'.repeat(20)}f${index}`))
    expect(readRequestedPermissions(long)).not.toBeNull()
    expect(permissionsShowInFull(long, display)).toBe(false)
  })
})

describe('codex-remote-service enabling', () => {
  it('refuses to start without a workspace, a credential, or when the computer cannot host it', async () => {
    const noWorkspace = await setup({ workspace: false })
    await expect(noWorkspace.service.setChannelEnabled('feishu', true)).rejects.toThrow('文件夹')
    const noCredential = await setup({ credential: false })
    await expect(noCredential.service.setChannelEnabled('feishu', true)).rejects.toThrow('登录')
    const elevated = await setup()
    elevated.unavailable.reason = '星芒正以管理员身份运行'
    await expect(elevated.service.setChannelEnabled('feishu', true)).rejects.toThrow('管理员')
    expect((await elevated.service.snapshot()).available).toBe(false)
  })

  it('tells the card when remote control runs on an account that is an administrator by itself', async () => {
    const plain = await setup()
    expect((await plain.service.snapshot()).alwaysElevated).toBeUndefined()

    const s = await setup({ alwaysElevatedAccount: true })
    expect(await s.service.snapshot()).toMatchObject({ available: true, alwaysElevated: true })
    // The reminder is about what Codex may do here; with remote control unavailable
    // there is nothing for it to warn about, and the unavailable notice says enough.
    s.unavailable.reason = '手机遥控暂时停用了，修好以后会自动恢复。'
    const suspended = await s.service.snapshot()
    expect(suspended.available).toBe(false)
    expect(suspended.alwaysElevated).toBeUndefined()
  })

  it('refuses to start when Codex is not installed on this computer', async () => {
    const s = await setup({ codexProblem: '本机尚未安装 Codex CLI，请先在首页完成安装。' })
    await expect(s.service.setChannelEnabled('feishu', true)).rejects.toThrow('本机尚未安装 Codex CLI')
    expect(s.channels).toHaveLength(0)
  })

  it('numbers every snapshot so the window can keep the newest one', async () => {
    const s = await setup()
    const first = await s.service.snapshot()
    await s.service.setChannelEnabled('feishu', true)
    const last = await s.service.snapshot()
    expect(last.revision).toBeGreaterThan(first.revision)
    const revisions = s.snapshots.map((snapshot) => snapshot.revision)
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right))
  })

  // M15：先开始的那份读的是改之前的设置，读得慢、后回来，号也不能比改完以后那份大，不然界面收下旧的。
  it('numbers a snapshot by when it started, so a slow one that read old settings never passes for the newest', async () => {
    const s = await setup()
    await s.service.snapshot()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const readCredential = s.store.readCredential.bind(s.store)
    vi.spyOn(s.store, 'readCredential').mockImplementationOnce(async (channel) => {
      await held
      return readCredential(channel)
    })
    const slow = s.service.snapshot()
    const changed = await s.service.setPermission('readOnly')
    release()
    const stale = await slow
    expect(stale.permission).toBeUndefined()
    expect(changed.permission).toBe('readOnly')
    expect(stale.revision).toBeLessThan(changed.revision)
  })

  it('never pushes a slow snapshot after a newer one, so the tray and keep-awake follow the latest', async () => {
    const s = await setup()
    await s.service.snapshot()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const readCredential = s.store.readCredential.bind(s.store)
    vi.spyOn(s.store, 'readCredential').mockImplementationOnce(async (channel) => {
      await held
      return readCredential(channel)
    })
    const pushed = s.snapshots.length
    const slow = s.service.setAutoStart(true)
    await vi.waitFor(() => expect(s.store.readCredential).toHaveBeenCalled())
    await s.service.setPermission('readOnly')
    release()
    await slow
    const after = s.snapshots.slice(pushed)
    expect(after.map((snapshot) => snapshot.revision)).toEqual([...after.map((snapshot) => snapshot.revision)].sort((left, right) => left - right))
    expect(s.snapshots.at(-1)).toMatchObject({ permission: 'readOnly', autoStart: true })
  })

  it('does not remember the switch across restarts', async () => {
    const s = await setup()
    await s.service.setChannelEnabled('feishu', true)
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(true)
    const settings = await s.store.readSettings()
    expect(JSON.stringify(settings)).not.toContain('enabled')
  })

  // D23：卡片上的「重新连接」只把停住的渠道重连一次，不像关掉再开那样给手机发「电脑上关了」，绑定的人也还在。
  it('reconnects a stuck channel in place without telling the phone it was closed or forgetting the bound person', async () => {
    const s = await setup()
    const first = await enabledAndPaired(s)
    first.handlers?.onStatus({ state: 'error', message: '该飞书应用已在其他位置连接，请先断开其他连接后重试。', problem: 'connection-limit' })
    expect((await s.service.snapshot()).channels.feishu.status.problem).toBe('connection-limit')

    const snapshot = await s.service.reconnectChannel('feishu')
    expect(first.stopped).toBe(1)
    expect(first.sent).toHaveLength(0)
    expect(s.channels).toHaveLength(2)
    expect(snapshot.channels.feishu).toMatchObject({ enabled: true, status: { state: 'connected' } })
    expect(snapshot.channels.feishu.boundPeer).not.toBeNull()
    // The replaced adapter can no longer move the card.
    first.handlers?.onStatus({ state: 'error', message: '旧的', problem: 'other' })
    expect((await s.service.snapshot()).channels.feishu.status).toEqual({ state: 'connected' })
  })

  // YR-2：卡片上点「重新连接」、关掉再开，平台把刚处理过的那条再送一遍（微信每次连上都从头拉），不再做一遍。
  it('does not act on a message again when the platform sends it once more after reconnecting or switching off and on', async () => {
    const s = await setup()
    const first = await enabledAndPaired(s)
    const help = text(alice, '帮助', { sentAt: Date.now() })
    first.handlers?.onInbound(help)
    await first.sentUntil(() => helpReplies(first) === 1)

    await s.service.reconnectChannel('feishu')
    const second = s.channels[1]
    second.handlers?.onInbound(help)
    second.handlers?.onInbound(text(alice, '状态', { sentAt: Date.now() }))
    await statusReplied(second)
    expect(helpReplies(second)).toBe(0)

    await s.service.setChannelEnabled('feishu', false)
    await s.service.setChannelEnabled('feishu', true)
    const third = s.channels[2]
    third.handlers?.onInbound(help)
    third.handlers?.onInbound(text(alice, '状态', { sentAt: Date.now() }))
    await statusReplied(third)
    expect(helpReplies(third)).toBe(0)
  })

  it('does not act on a message again when the platform sends it once more after Xingmang restarts', async () => {
    const root = tempRoot()
    const before = await setup({ root })
    const beforeChannel = await enabledAndPaired(before)
    const help = text(alice, '帮助', { sentAt: Date.now(), messageId: 'wx-before-restart' })
    beforeChannel.handlers?.onInbound(help)
    await beforeChannel.sentUntil(() => helpReplies(beforeChannel) === 1)
    expect((await before.store.readSettings()).channels.feishu?.recentMessageIds).toEqual(['wx-before-restart'])
    before.service.dispose()

    const after = await setup({ root })
    await after.service.setChannelEnabled('feishu', true)
    const channel = after.channels[0]
    channel.handlers?.onInbound(help)
    channel.handlers?.onInbound(text(alice, '状态', { sentAt: Date.now() }))
    await statusReplied(channel)
    expect(helpReplies(channel)).toBe(0)
  })

  it('still acts on a message when its id cannot be written down', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    vi.spyOn(s.store, 'updateSettings').mockRejectedValue(new Error('disk full'))
    channel.handlers?.onInbound(text(alice, '帮助', { sentAt: Date.now() }))
    await channel.sentUntil(() => helpReplies(channel) === 1)
    expect(s.logs).toContain('remote.message-id-unsaved')
  })

  it('does not open a channel that is switched off when asked to reconnect it', async () => {
    const s = await setup()
    const snapshot = await s.service.reconnectChannel('feishu')
    expect(s.channels).toHaveLength(0)
    expect(snapshot.channels.feishu).toMatchObject({ enabled: false, status: { state: 'stopped' } })
  })

  it('stops the channel and says why when it may no longer run at the moment it reconnects', async () => {
    const s = await setup()
    await s.service.setChannelEnabled('feishu', true)
    s.unavailable.reason = '星芒正以管理员身份运行'
    await expect(s.service.reconnectChannel('feishu')).rejects.toThrow('管理员')
    expect(s.channels).toHaveLength(1)
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(false)
  })

  // YKS-6：微信重新扫码、服务端认出是原来那份登录时凭据没换；渠道停在「需需重新登录」就重连一次，连着的、关着的不动。
  it('reconnects a channel stuck on signing in again once the old login is recognised, and leaves a working or closed one alone', async () => {
    const s = await setup()
    await s.service.reconnectIfLoggedOut('feishu')
    expect(s.channels).toHaveLength(0)
    const first = await enabledAndPaired(s)
    await s.service.reconnectIfLoggedOut('feishu')
    expect(first.stopped).toBe(0)
    expect(s.channels).toHaveLength(1)

    first.handlers?.onStatus({ state: 'needs-login', message: '微信登录已失效，请在电脑端重新扫码' })
    await s.service.reconnectIfLoggedOut('feishu')
    expect(first.stopped).toBe(1)
    expect(first.sent).toHaveLength(0)
    expect(s.channels).toHaveLength(2)
    const snapshot = await s.service.snapshot()
    expect(snapshot.channels.feishu).toMatchObject({ enabled: true, status: { state: 'connected' } })
    expect(snapshot.channels.feishu.boundPeer).not.toBeNull()
    expect(s.logs).toContain('remote.channel-relogin-reconnect')
  })

  it('does not throw when remote control may no longer run at the moment the old login is recognised', async () => {
    const s = await setup()
    const first = await enabledAndPaired(s)
    first.handlers?.onStatus({ state: 'needs-login', message: '微信登录已失效，请在电脑端重新扫码' })
    s.unavailable.reason = '星芒正以管理员身份运行'
    await expect(s.service.reconnectIfLoggedOut('feishu')).resolves.toBeUndefined()
    expect(first.stopped).toBe(1)
    expect(s.channels).toHaveLength(1)
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(false)
  })
})

// YF-8：托盘「打开手机遥控」。只开凭据、配对过的人都在的渠道，过的检查跟设置里那个开关一样，打不开时给原因原句。
describe('codex-remote-service switching on from the tray', () => {
  it('counts a channel as ready only with a folder, a credential and a paired person, while it is off', async () => {
    const s = await setup()
    await s.store.writeCredential('weixin', 'weixin-credential-value')
    expect(remoteChannelsReadyToEnable(await s.service.snapshot())).toEqual([])
    await enabledAndPaired(s)
    expect(remoteChannelsReadyToEnable(await s.service.snapshot())).toEqual([])
    await s.service.setChannelEnabled('feishu', false)
    const off = await s.service.snapshot()
    // 微信有凭据但没配对过人：开了也得回电脑上配对，不算。
    expect(remoteChannelsReadyToEnable(off)).toEqual(['feishu'])
    expect(remoteChannelsReadyToEnable({ ...off, workspaceDirectory: null })).toEqual([])
  })

  it('switches on every ready channel and leaves the unpaired one alone', async () => {
    const s = await setup()
    await s.store.writeCredential('weixin', 'weixin-credential-value')
    await enabledAndPaired(s)
    await s.service.setChannelEnabled('feishu', false)
    s.snapshots.length = 0
    expect(await s.service.enableReadyChannels()).toEqual({ opened: ['feishu'], failure: null })
    const after = await s.service.snapshot()
    expect(after.channels.feishu.enabled).toBe(true)
    expect(after.channels.weixin.enabled).toBe(false)
    expect(s.service.hasEnabledChannel()).toBe(true)
    expect(s.snapshots.at(-1)?.channels.feishu.enabled).toBe(true)
    expect(s.logs).toContain('remote.channel-started')
  })

  it('opens nothing and hands back the same reason the switch would show', async () => {
    const options: { codexProblem?: string } = {}
    const s = await setup(options)
    await enabledAndPaired(s)
    await s.service.setChannelEnabled('feishu', false)
    options.codexProblem = '本机尚未安装 Codex CLI，请先在首页完成安装。'
    s.snapshots.length = 0
    expect(await s.service.enableReadyChannels()).toEqual({ opened: [], failure: '本机尚未安装 Codex CLI，请先在首页完成安装。' })
    expect(s.service.hasEnabledChannel()).toBe(false)
    expect(s.logs).toContain('remote.tray-enable-failed')
    // 托盘那一项留着：没打开，下次修好了还能从这里开。
    expect(remoteChannelsReadyToEnable(s.snapshots.at(-1)!)).toEqual(['feishu'])
    options.codexProblem = undefined
    s.unavailable.reason = '星芒正以管理员身份运行。'
    expect(await s.service.enableReadyChannels()).toEqual({ opened: [], failure: '星芒正以管理员身份运行。' })
  })

  it('does nothing when no channel is ready any more, but still tells the tray', async () => {
    const s = await setup()
    expect(await s.service.enableReadyChannels()).toEqual({ opened: [], failure: null })
    expect(s.channels).toHaveLength(0)
    expect(s.snapshots).toHaveLength(1)
  })
})

describe('codex-remote-service switching on when Xingmang opens', () => {
  it('remembers the choice without touching the channels, and drops it again when turned off', async () => {
    const s = await setup()
    await enabledAndPaired(s)
    s.snapshots.length = 0
    expect((await s.service.setAutoStart(true)).autoStart).toBe(true)
    expect((await s.store.readSettings()).autoStart).toBe(true)
    expect(s.snapshots.at(-1)?.autoStart).toBe(true)
    expect(s.service.hasEnabledChannel()).toBe(true)
    const off = await s.service.setAutoStart(false)
    expect(off.autoStart).toBeUndefined()
    expect((await s.store.readSettings()).autoStart).toBeUndefined()
    // 关掉开关不顺手断开：现在开着的照旧开着，只是下次打开星芒不再自己连。
    expect(off.channels.feishu.enabled).toBe(true)
  })

  it('opens only the paired channels on the next launch, and only when the switch is on', async () => {
    const root = tempRoot()
    const first = await setup({ root })
    await first.store.writeCredential('weixin', 'weixin-credential-value')
    await enabledAndPaired(first)
    first.service.dispose()

    const plain = await setup({ root })
    await plain.service.startOnLaunch()
    expect(plain.channels).toHaveLength(0)
    expect(plain.service.hasEnabledChannel()).toBe(false)
    await plain.service.setAutoStart(true)
    plain.service.dispose()

    const s = await setup({ root })
    await s.service.startOnLaunch()
    const snapshot = await s.service.snapshot()
    expect(snapshot.channels.feishu.enabled).toBe(true)
    // 微信有凭据但没配对过人：不替他连，得回电脑上配对。
    expect(snapshot.channels.weixin.enabled).toBe(false)
    expect(s.channels).toHaveLength(1)
    expect(s.logDetails.find((entry) => entry.event === 'remote.auto-started')?.detail).toEqual({ opened: 1, failed: false })
    // 自己连上的也跟手动打开一样，给配对过的人说一声（YF-11），他在外面才知道能用了。
    await s.channels[0].sentUntil(() => s.channels[0].texts().some((line) => line.startsWith('电脑端已开启手机遥控')))
    expect(s.channels[0].sent[0].peer).toMatchObject({ userId: alice.userId })
  })

  /** 上一次打开星芒时配对好、打开了自动打开，再「重开星芒」：返回新的这一份，还没调 startOnLaunch。 */
  async function relaunchedWithAutoStart(options: Parameters<typeof setup>[0] = {}): Promise<Setup> {
    const root = tempRoot()
    const first = await setup({ root })
    await enabledAndPaired(first)
    await first.service.setAutoStart(true)
    first.service.dispose()
    return setup({ ...options, root })
  }

  function autoStartLogs(s: Setup, event: string) {
    return s.logDetails.filter((entry) => entry.event === event).map((entry) => entry.detail)
  }

  // YR-7：打不开时卡片上说原因（原句就是在设置里点开时那句），开关照旧开着等下次。
  it('tells the card why it could not open, leaving the switch on for next time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await relaunchedWithAutoStart({ codexProblem: '本机尚未安装 Codex CLI，请先在首页完成安装。' })
    await s.service.startOnLaunch()
    expect(s.service.hasEnabledChannel()).toBe(false)
    expect(autoStartLogs(s, 'remote.auto-started')).toEqual([{ opened: 0, failed: true }])
    const snapshot = await s.service.snapshot()
    expect(snapshot.autoStart).toBe(true)
    expect(snapshot.autoStartFailure).toBe('本机尚未安装 Codex CLI，请先在首页完成安装。')
    expect(s.snapshots.at(-1)?.autoStartFailure).toBe('本机尚未安装 Codex CLI，请先在首页完成安装。')
    s.service.dispose()
  })

  // YR-7：开机时移动硬盘上的文件夹还没挂上，过几分钟挂上了，自己再试一次就连上，那句原因收起。
  it('tries once more a few minutes later and clears the reason when that works', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await relaunchedWithAutoStart()
    fs.rmSync(s.workspace, { recursive: true, force: true })
    await s.service.startOnLaunch()
    expect((await s.service.snapshot()).autoStartFailure).toBe('该文件夹已不存在，请重新选择。')
    expect(s.channels).toHaveLength(0)

    fs.mkdirSync(s.workspace, { recursive: true })
    await vi.advanceTimersByTimeAsync(autoStartRetryMs - 1_000)
    expect(autoStartLogs(s, 'remote.auto-start-retried')).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    // 连上以后记日志是这次重试的最后一步。
    await vi.waitFor(() => expect(autoStartLogs(s, 'remote.auto-start-retried')).toEqual([{ opened: 1, failed: false }]))
    expect(s.service.hasEnabledChannel()).toBe(true)
    expect(s.snapshots.at(-1)?.autoStartFailure).toBeUndefined()
    expect((await s.service.snapshot()).autoStartFailure).toBeUndefined()
    s.service.dispose()
  })

  it('tries only once more, keeping the newest reason when that fails too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await relaunchedWithAutoStart()
    fs.rmSync(s.workspace, { recursive: true, force: true })
    await s.service.startOnLaunch()
    // 文件夹挂上了，换成别的原因：卡片上说的是这次重试的原因。
    fs.mkdirSync(s.workspace, { recursive: true })
    s.unavailable.reason = '星芒正以管理员身份运行，手机遥控不能打开。'
    await vi.advanceTimersByTimeAsync(autoStartRetryMs)
    // 记下新原因、推给界面是这次重试的最后一步，等它而不是等日志（日志在它前面）。
    await vi.waitFor(() => expect(s.snapshots.at(-1)?.autoStartFailure).toBe('星芒正以管理员身份运行，手机遥控不能打开。'))
    expect(autoStartLogs(s, 'remote.auto-start-retried')).toEqual([{ opened: 0, failed: true }])
    expect((await s.service.snapshot()).autoStartFailure).toBe('星芒正以管理员身份运行，手机遥控不能打开。')
    s.unavailable.reason = null
    await vi.advanceTimersByTimeAsync(10 * autoStartRetryMs)
    expect(autoStartLogs(s, 'remote.auto-start-retried')).toHaveLength(1)
    expect(s.service.hasEnabledChannel()).toBe(false)
    s.service.dispose()
  })

  it('drops the reason and the retry once the remote is opened by hand', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await relaunchedWithAutoStart()
    fs.rmSync(s.workspace, { recursive: true, force: true })
    await s.service.startOnLaunch()
    fs.mkdirSync(s.workspace, { recursive: true })
    const opened = await s.service.setChannelEnabled('feishu', true)
    expect(opened.autoStartFailure).toBeUndefined()
    await s.service.setChannelEnabled('feishu', false)
    await vi.advanceTimersByTimeAsync(autoStartRetryMs)
    // 客户在电脑前自己开过又关了：不再替他连回去。
    expect(autoStartLogs(s, 'remote.auto-start-retried')).toEqual([])
    expect(s.channels).toHaveLength(1)
    expect(s.service.hasEnabledChannel()).toBe(false)
    s.service.dispose()
  })

  it('drops the reason and the retry when the launch switch is turned off or Xingmang quits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const off = await relaunchedWithAutoStart()
    fs.rmSync(off.workspace, { recursive: true, force: true })
    await off.service.startOnLaunch()
    fs.mkdirSync(off.workspace, { recursive: true })
    expect((await off.service.setAutoStart(false)).autoStartFailure).toBeUndefined()
    // 又打开也不翻出旧原因、不当场试：等下次打开星芒。
    expect((await off.service.setAutoStart(true)).autoStartFailure).toBeUndefined()
    await vi.advanceTimersByTimeAsync(autoStartRetryMs)
    expect(autoStartLogs(off, 'remote.auto-start-retried')).toEqual([])
    expect(off.channels).toHaveLength(0)
    off.service.dispose()

    const quit = await relaunchedWithAutoStart()
    fs.rmSync(quit.workspace, { recursive: true, force: true })
    await quit.service.startOnLaunch()
    fs.mkdirSync(quit.workspace, { recursive: true })
    quit.service.dispose()
    await vi.advanceTimersByTimeAsync(autoStartRetryMs)
    expect(autoStartLogs(quit, 'remote.auto-start-retried')).toEqual([])
    expect(quit.channels).toHaveLength(0)
  })
})

describe('codex-remote-service holding off the Mac idle install (YK-2, YR-3)', () => {
  it('holds it off for the whole run while an open channel would not come back after a restart', async () => {
    const s = await setup()
    expect(s.service.idleInstallHold()).toBeNull()
    await enabledAndPaired(s)
    expect(s.service.idleInstallHold()).toBe('drops')
    await s.service.setAutoStart(true)
    expect(s.service.idleInstallHold()).toBeNull()
    await s.service.setAutoStart(false)
    expect(s.service.idleInstallHold()).toBe('drops')
    await s.service.setChannelEnabled('feishu', false)
    expect(s.service.idleInstallHold()).toBeNull()
  })

  it('with switch-on-launch on, waits until the phone has been quiet for half an hour', async () => {
    let clock = 1_000_000
    const s = await setup({ now: () => clock })
    const channel = await enabledAndPaired(s)
    await s.service.setAutoStart(true)
    // The pairing message came from someone not bound yet, so it does not count.
    expect(s.service.idleInstallHold()).toBeNull()
    channel.handlers?.onInbound(text(alice, '帮助'))
    await channel.sentUntil(() => channel.texts().length > 0)
    expect(s.service.idleInstallHold()).toBe('busy')
    clock += remoteIdleInstallQuietMs - 1
    expect(s.service.idleInstallHold()).toBe('busy')
    clock += 1
    expect(s.service.idleInstallHold()).toBeNull()
    // A clock turned back by hours must not hold it off for hours.
    clock -= 3 * 60 * 60_000
    expect(s.service.idleInstallHold()).toBeNull()
  })

  it('with switch-on-launch on, waits while a turn runs no matter how long ago the last message came', async () => {
    let clock = 1_000_000
    const s = await setup({ now: () => clock })
    const channel = await enabledAndPaired(s)
    await s.service.setAutoStart(true)
    await prompted(s, channel)
    clock += remoteIdleInstallQuietMs * 4
    expect(s.service.idleInstallHold()).toBe('busy')
  })

  it('knows the switch is on after a launch that switched the channels on by itself', async () => {
    const root = tempRoot()
    const first = await setup({ root })
    await enabledAndPaired(first)
    await first.service.setAutoStart(true)
    first.service.dispose()

    const s = await setup({ root })
    await s.service.startOnLaunch()
    expect(s.service.hasEnabledChannel()).toBe(true)
    expect(s.service.idleInstallHold()).toBeNull()
  })

  it('treats a channel switched on by hand after a launch as coming back when the switch was already on', async () => {
    const root = tempRoot()
    const first = await setup({ root })
    await enabledAndPaired(first)
    await first.service.setAutoStart(true)
    await first.service.setChannelEnabled('feishu', false)
    first.service.dispose()

    const s = await setup({ root })
    await s.service.setChannelEnabled('feishu', true)
    expect(s.service.idleInstallHold()).toBeNull()
  })

  it('stops counting on switch-on-launch once "关闭遥控" from the phone turned it off (YR-1)', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await s.service.setAutoStart(true)
    channel.handlers?.onInbound(text(alice, '关闭遥控'))
    await channel.sentUntil(() => channel.texts().length > 0)
    expect((await s.store.readSettings()).autoStart).toBeUndefined()
    // Switched back on by hand at the computer: a restart would not reconnect it any more.
    await s.service.setChannelEnabled('feishu', true)
    expect(s.service.idleInstallHold()).toBe('drops')
  })
})

describe('codex-remote-service pairing', () => {
  it('ignores strangers silently and binds whoever sends the code', async () => {
    const s = await setup()
    await s.service.setChannelEnabled('feishu', true)
    const channel = s.channels[0]
    channel.handlers?.onInbound(text(mallory, '帮我删库'))
    await s.service.startPairing('feishu')
    expect((await s.service.snapshot()).channels.feishu.pairing?.code).toBe('000042')
    channel.handlers?.onInbound(text(mallory, '123456'))
    channel.handlers?.onInbound(text(alice, '000 042'))
    await channel.sentUntil(() => channel.sent.length > 0)
    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0].peer).toEqual(alice)
    const snapshot = await s.service.snapshot()
    expect(snapshot.channels.feishu.boundPeer).toMatchObject({ userIdTail: '1234' })
    expect(snapshot.channels.feishu.pairing).toBeNull()
    // The stranger is still ignored after pairing.
    channel.handlers?.onInbound(text(mallory, '000042'))
    channel.handlers?.onInbound(text(mallory, '跑一下 rm -rf'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.sent).toHaveLength(1)
    expect(s.codex).toHaveLength(0)
  })

  // YR-10：输入法切在全角时发来的配对码照样能配上。
  it('binds whoever sends the code in full-width digits', async () => {
    const s = await setup()
    await s.service.setChannelEnabled('feishu', true)
    const channel = s.channels[0]
    await s.service.startPairing('feishu')
    channel.handlers?.onInbound(text(alice, '０００ ０４２'))
    await channel.sentUntil(() => channel.sent.length > 0)
    expect(channel.sent[0].peer).toEqual(alice)
    const snapshot = await s.service.snapshot()
    expect(snapshot.channels.feishu.boundPeer).toMatchObject({ userIdTail: '1234' })
    expect(snapshot.channels.feishu.pairing).toBeNull()
  })

  it('locks pairing after too many wrong codes', async () => {
    const s = await setup()
    await s.service.setChannelEnabled('feishu', true)
    const channel = s.channels[0]
    await s.service.startPairing('feishu')
    for (let index = 0; index < 20; index += 1) channel.handlers?.onInbound(text(mallory, String(100000 + index)))
    await vi.waitFor(async () => expect((await s.service.snapshot()).channels.feishu.pairing).toBeNull())
    channel.handlers?.onInbound(text(mallory, '000042'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await s.service.snapshot()).channels.feishu.boundPeer).toBeNull()
  })

  // D66 / YKS-21：电脑卡片上看得到错了几次、错满作废；手机那边照旧不回。
  it('shows the window how many wrong codes came in and that the code was voided', async () => {
    const s = await setup()
    await s.service.setChannelEnabled('feishu', true)
    const channel = s.channels[0]
    await s.service.startPairing('feishu')
    expect((await s.service.snapshot()).channels.feishu.pairing).toEqual({ code: '000042', expiresAt: expect.any(Number) })
    channel.handlers?.onInbound(text(mallory, '123456'))
    channel.handlers?.onInbound(text(mallory, '654321'))
    await vi.waitFor(() => expect(s.snapshots.at(-1)?.channels.feishu.pairing?.failures).toBe(2))
    for (let index = 0; index < 18; index += 1) channel.handlers?.onInbound(text(mallory, String(100000 + index)))
    await vi.waitFor(() => expect(s.snapshots.at(-1)?.channels.feishu).toMatchObject({ pairing: null, pairingLocked: true }))
    expect(channel.sent).toHaveLength(0)
    // Starting again clears it; so does cancelling.
    await s.service.startPairing('feishu')
    expect((await s.service.snapshot()).channels.feishu.pairingLocked).toBeUndefined()
  })

  // YF-2：码挂了 1 分钟还没收到私聊，电脑卡片上说是一条都没收到还是只收到群里的；手机那边照旧不回。
  it('tells the window a minute into pairing whether nothing or only group messages arrived', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = Date.UTC(2026, 10, 10, 9)
    const s = await setup({ now: () => clock })
    await s.service.setChannelEnabled('feishu', true)
    const channel = s.channels[0]
    await s.service.startPairing('feishu')
    clock += 59_000
    await vi.advanceTimersByTimeAsync(59_000)
    expect((await s.service.snapshot()).channels.feishu.pairing).not.toHaveProperty('quiet')
    const shown = s.snapshots.length
    clock += 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(s.snapshots.length).toBeGreaterThan(shown))
    expect(s.snapshots.at(-1)?.channels.feishu.pairing?.quiet).toBe('nothing')
    channel.handlers?.onInbound(text(alice, '000042', { direct: false }))
    await vi.waitFor(() => expect(s.snapshots.at(-1)?.channels.feishu.pairing?.quiet).toBe('group-only'))
    // Any private message, even one that is not the code, shows the bot is set up.
    channel.handlers?.onInbound(text(mallory, '你好'))
    await vi.waitFor(() => expect(s.snapshots.at(-1)?.channels.feishu.pairing).not.toHaveProperty('quiet'))
    expect(s.snapshots.at(-1)?.channels.feishu.pairing?.code).toBe('000042')
    expect(s.snapshots.at(-1)?.channels.feishu.boundPeer).toBeNull()
    expect(channel.sent).toHaveLength(0)
  })

  it('counts only what arrived since the channel was last turned on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = Date.UTC(2026, 10, 10, 9)
    const s = await setup({ now: () => clock })
    await s.service.setChannelEnabled('feishu', true)
    s.channels[0].handlers?.onInbound(text(mallory, '你好'))
    await vi.advanceTimersByTimeAsync(20)
    await s.service.setChannelEnabled('feishu', false)
    await s.service.setChannelEnabled('feishu', true)
    await s.service.startPairing('feishu')
    clock += 60_000
    await vi.advanceTimersByTimeAsync(60_000)
    expect((await s.service.snapshot()).channels.feishu.pairing?.quiet).toBe('nothing')
  })

  it('drops the code by itself after ten minutes and tells the window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    await s.service.setChannelEnabled('feishu', true)
    await s.service.startPairing('feishu')
    const shown = s.snapshots.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.waitFor(() => expect(s.snapshots.length).toBeGreaterThan(shown))
    expect(s.snapshots.at(-1)?.channels.feishu.pairing).toBeNull()
    // A correct code that arrives late binds nobody.
    s.channels[0].handlers?.onInbound(text(alice, '000042'))
    await vi.advanceTimersByTimeAsync(20)
    expect((await s.service.snapshot()).channels.feishu.boundPeer).toBeNull()
    expect(s.channels[0].sent).toHaveLength(0)
  })

  it('drops group messages and messages from before the channel opened', async () => {
    const s = await setup()
    await s.service.setChannelEnabled('feishu', true)
    const channel = s.channels[0]
    await s.service.startPairing('feishu')
    channel.handlers?.onInbound(text(alice, '000042', { direct: false }))
    channel.handlers?.onInbound(text(alice, '000042', { sentAt: Date.now() - 5 * 60_000 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await s.service.snapshot()).channels.feishu.boundPeer).toBeNull()
  })

  // #1407 P3-5：电脑时间快了，配对码一样会被当成旧的；发对码的就是要绑定的人，跟他说一声，但不拿这条配对。
  it('tells whoever sends the right code that this computer runs fast, without pairing or counting a failure', async () => {
    const s = await setup()
    await s.service.setChannelEnabled('feishu', true)
    const channel = s.channels[0]
    await s.service.startPairing('feishu')
    const fast = { sentAt: Date.now() - 15 * 60_000, clockAheadMs: 15 * 60_000 }
    channel.handlers?.onInbound(text(mallory, '123456', fast))
    channel.handlers?.onInbound(text(alice, '000042', { ...fast, replyContext: 'ctx-fast-code' }))
    await vi.waitFor(() => expect(channel.texts()).toEqual([clockAheadText]))
    expect(channel.sent[0].peer).toEqual(alice)
    expect(channel.sent[0].replyContext).toBe('ctx-fast-code')
    const snapshot = await s.service.snapshot()
    expect(snapshot.channels.feishu.boundPeer).toBeNull()
    expect(snapshot.channels.feishu.pairing?.code).toBe('000042')
    expect(s.logs).toContain('remote.clock-ahead')
    expect(s.logs).not.toContain('remote.pairing-mismatch')
    // Once the clock is right the same code pairs as usual.
    channel.handlers?.onInbound(text(alice, '000042'))
    await channel.sentUntil(() => channel.texts().includes('配对成功，本机的 Codex 现仅响应您的消息。直接发送消息即可下达任务，发送「帮助」可查看可用指令。'))
    expect((await s.service.snapshot()).channels.feishu.boundPeer?.userIdTail).toBe('1234')
  })
})

describe('codex-remote-service clock running fast', () => {
  it('tells the bound person their message was not run because this computer runs fast, once per message', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const message = text(alice, '跑一下测试', { sentAt: Date.now() - 15 * 60_000, clockAheadMs: 15 * 60_000 })
    channel.handlers?.onInbound(message)
    channel.handlers?.onInbound(message)
    await vi.waitFor(() => expect(channel.texts()).toEqual([clockAheadText]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.texts()).toEqual([clockAheadText])
    expect(channel.sent[0].replyContext).toBe(message.replyContext)
    expect(s.codex).toHaveLength(0)
    expect(s.logDetails).toContainEqual({ event: 'remote.clock-ahead', detail: { channel: 'feishu', aheadSeconds: 900 } })
  })

  it('runs what the phone sends once the clock has been set right, without waiting out the hours it was fast', async () => {
    const eightHours = 8 * 60 * 60_000
    const clock = { aheadMs: eightHours }
    const s = await setup({ now: () => Date.now() + clock.aheadMs })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试', { sentAt: Date.now(), clockAheadMs: eightHours }))
    await vi.waitFor(() => expect(channel.texts()).toEqual([clockAheadText]))
    // The customer sets the clock right and sends again: the channel counts as opened just now, not eight hours ahead.
    clock.aheadMs = 0
    channel.handlers?.onInbound(text(alice, '跑一下测试', { sentAt: Date.now(), clockAheadMs: 0 }))
    await turnStarted(s, 1)
    expect(s.codex[0].requests('turn/start')).toHaveLength(1)
    expect(channel.texts()).toEqual([clockAheadText, '已收到，Codex 开始处理。'])
    // Something sent before the clock was set right is still too old to run.
    channel.handlers?.onInbound(text(alice, '调钟以前发的', { sentAt: Date.now() - 2 * 60_000, clockAheadMs: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.texts()).toEqual([clockAheadText, '已收到，Codex 开始处理。'])
  })

  it('stays silent for really old messages, unknown clocks and strangers', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    // Old by the platform's clock too: sent twenty minutes ago on a clock five minutes fast.
    channel.handlers?.onInbound(text(alice, '昨天的话', { sentAt: Date.now() - 20 * 60_000, clockAheadMs: 5 * 60_000 }))
    // The channel could not tell how far off this computer is.
    channel.handlers?.onInbound(text(alice, '不知道钟准不准', { sentAt: Date.now() - 15 * 60_000 }))
    // Someone else, even when the clock is to blame.
    channel.handlers?.onInbound(text(mallory, '你好', { sentAt: Date.now() - 15 * 60_000, clockAheadMs: 15 * 60_000 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.sent).toHaveLength(0)
    expect(s.codex).toHaveLength(0)
    expect(s.logs).not.toContain('remote.clock-ahead')
  })

  // D66 / YKS-9：遥控开着、合盖或断网时发的话回来已经太旧，照旧不执行，但要跟绑定的人说一声。
  it('tells the bound person once per batch that old messages were not run, and again for a later batch', async () => {
    let now = Date.now()
    const s = await setup({ now: () => now })
    const channel = await enabledAndPaired(s)
    // Sent before the remote was switched on: it may have run last time, so nothing is said about it.
    channel.handlers?.onInbound(text(alice, '上次开着时的话', { sentAt: now - 5 * 60_000 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.sent).toHaveLength(0)
    now += 60 * 60_000
    const first = text(alice, '帮我跑测试', { sentAt: now - 35 * 60_000, replyContext: 'ctx-old-1' })
    channel.handlers?.onInbound(first)
    channel.handlers?.onInbound(first)
    channel.handlers?.onInbound(text(alice, '再看看日志', { sentAt: now - 30 * 60_000 }))
    channel.handlers?.onInbound({ kind: 'unsupported', peer: alice, direct: true, messageId: 'img-1', sentAt: now - 29 * 60_000 })
    await vi.waitFor(() => expect(channel.sent.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.texts()).toEqual([staleNotice(35)])
    expect(channel.sent[0].replyContext).toBe('ctx-old-1')
    expect(s.codex).toHaveLength(0)
    // The next time the computer comes back, the new batch gets its own line.
    now += 2 * 60 * 60_000
    channel.handlers?.onInbound(text(alice, '晚上的话', { sentAt: now - 12 * 60_000 }))
    await vi.waitFor(() => expect(channel.texts()).toEqual([staleNotice(35), staleNotice(12)]))
    // A message that runs as usual starts a new batch straight away.
    channel.handlers?.onInbound(text(alice, '帮助', { sentAt: now }))
    channel.handlers?.onInbound(text(alice, '更早的', { sentAt: now - 11 * 60_000 }))
    await channel.sentUntil(() => channel.sent.length >= 4)
    expect(channel.texts()).toHaveLength(4)
    expect(channel.texts()[3]).toBe(staleNotice(11))
    expect(s.codex).toHaveLength(0)
  })
})

describe('codex-remote-service turns', () => {
  it('runs a prompt in the workspace and replies with the redacted final answer', async () => {
    // 钟停着，做完小结（YF-16）里的用时总是 1 秒。
    const s = await setup({ now: () => Date.UTC(2026, 10, 11, 6, 0, 0) })
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect(channel.texts()[0]).toBe('已收到，Codex 开始处理。')
    expect(codex.requests('config/read')[0].params).toEqual({ cwd: s.workspace, includeLayers: true })
    expect(codex.requests('thread/start')[0].params).toMatchObject({
      cwd: s.workspace,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      config: { 'features.apps': false, 'features.plugins': false },
    })
    expect(codex.requests('turn/start')[0].params).toEqual({
      threadId: 'th-1',
      input: [{ type: 'text', text: '跑一下测试', text_elements: [] }],
    })
    expect((await s.service.snapshot()).task).toBe('running')
    codex.notify('item/completed', { threadId: 'th-1', turnId: 'tu-1', item: { type: 'agentMessage', id: 'a1', text: '先看看', phase: 'commentary' } })
    codex.notify('item/completed', { threadId: 'th-1', turnId: 'tu-1', item: { type: 'agentMessage', id: 'a2', text: `测试都过了，密钥是 ${apiKey}`, phase: 'final_answer' } })
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed', error: null } })
    await vi.waitFor(() => expect(channel.texts()).toHaveLength(2))
    expect(channel.texts()[1]).toBe('测试都过了，密钥是 [已隐去]\n\n用时 1 秒。')
    expect(channel.sent[1].replyContext).toMatch(/^ctx-/)
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
  })

  // #1407 P2-4：配了外部工具的电脑，遥控开的对话把它们逐个停用，电脑上的配置不动。
  it('opens the thread with every configured MCP server switched off', async () => {
    const s = await setup({
      configRead: {
        result: {
          config: { mcp_servers: { docs: { command: 'docs-mcp' } } },
          origins: {},
          layers: [
            { name: { type: 'project', dotCodexFolder: '/w/.codex' }, version: 'b', config: { mcp_servers: { repo: { url: 'https://mcp.example.test/' } } }, disabledReason: 'untrusted' },
            { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'a', config: { mcp_servers: { docs: { command: 'docs-mcp' } } }, disabledReason: null },
          ],
        },
      },
    })
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect(codex.requests('thread/start')[0].params).toMatchObject({
      config: {
        'features.apps': false,
        'features.plugins': false,
        mcp_servers: { docs: { enabled: false }, repo: { url: 'https://mcp.example.test/', enabled: false } },
      },
    })
    expect(codex.written.findIndex((message) => message.method === 'config/read'))
      .toBeLessThan(codex.written.findIndex((message) => message.method === 'thread/start'))
  })

  it('opens no thread when Codex cannot say which MCP servers are configured', async () => {
    const s = await setup({ configRead: { error: { code: -32603, message: 'failed to read configuration layers' } } })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.texts().includes('本轮未完成：failed to read configuration layers'))
    expect(s.codex[0].requests('thread/start')).toHaveLength(0)
    expect(s.codex[0].requests('turn/start')).toHaveLength(0)
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
  })

  it('keeps one turn at a time and reuses the thread', async () => {
    const s = await setup({ now: () => Date.UTC(2026, 10, 11, 6, 0, 0) })
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await channel.sentUntil(() => channel.texts().includes('Codex 正在处理上一条消息，请待其完成后再发送，或发送「停止」中断。'))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(() => expect(channel.texts()).toContain('本轮已完成，Codex 未返回文字回复。\n\n用时 1 秒。'))
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
    expect(codex.requests('thread/start')).toHaveLength(1)
  })

  // 「手机端使用的模型」（yoyo 2026-11-19「改」）：选了就开对话时带上；开着的对话中途改，下一句的 turn/start 里改，
  // 改回「与电脑端相同」时明着带上电脑上那个，不然 Codex 一直用着之前单独选的。
  it('uses the phone model when one is chosen and follows the computer model again when set back', async () => {
    const s = await setup({ now: () => Date.UTC(2026, 10, 11, 6, 0, 0), configRead: { result: { config: { model: 'gpt-6.2' } } } })
    expect((await s.service.setModel('gpt-6.3-sol')).model).toBe('gpt-6.3-sol')
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect(codex.requests('thread/start')[0].params).toMatchObject({ model: 'gpt-6.3-sol' })
    expect(codex.requests('turn/start')[0].params).not.toHaveProperty('model')
    async function nextTurn(count: number) {
      codex.notify('turn/completed', { threadId: 'th-1', turn: { id: `tu-${count - 1}`, status: 'completed' } })
      await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
      channel.handlers?.onInbound(text(alice, `第 ${count} 句`))
      await codex.requestedUntil('turn/start', count)
      return codex.requests('turn/start')[count - 1].params
    }
    expect(await s.service.setModel(null)).not.toHaveProperty('model')
    expect(await nextTurn(2)).toMatchObject({ threadId: 'th-1', model: 'gpt-6.2' })
    expect(codex.requests('config/read').at(-1)?.params).toEqual({ cwd: s.workspace })
    expect(await nextTurn(3)).not.toHaveProperty('model')
    await s.service.setModel('gpt-6.1-mini')
    expect(await nextTurn(4)).toMatchObject({ model: 'gpt-6.1-mini' })
    expect(await nextTurn(5)).not.toHaveProperty('model')
    expect(codex.requests('thread/start')).toHaveLength(1)
    expect((await s.store.readSettings()).model).toBe('gpt-6.1-mini')
  })

  // 权限两档：选了「只读」开对话就是只读；开着的对话中途换档，下一句的 turn/start 带上新沙箱，之后不再重复带。
  it('opens the thread with the chosen permission and switches an open thread on its next message', async () => {
    const s = await setup({ now: () => Date.UTC(2026, 10, 11, 6, 0, 0) })
    expect((await s.service.setPermission('readOnly')).permission).toBe('readOnly')
    expect((await s.store.readSettings()).permission).toBe('readOnly')
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect(codex.requests('thread/start')[0].params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only' })
    expect(codex.requests('turn/start')[0].params).not.toHaveProperty('sandboxPolicy')
    async function nextTurn(count: number) {
      codex.notify('turn/completed', { threadId: 'th-1', turn: { id: `tu-${count - 1}`, status: 'completed' } })
      await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
      channel.handlers?.onInbound(text(alice, `第 ${count} 句`))
      await codex.requestedUntil('turn/start', count)
      return codex.requests('turn/start')[count - 1].params
    }
    expect(await s.service.setPermission('default')).not.toHaveProperty('permission')
    expect((await s.store.readSettings()).permission).toBeUndefined()
    expect(await nextTurn(2)).toMatchObject({
      threadId: 'th-1',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    })
    expect(await nextTurn(3)).not.toHaveProperty('sandboxPolicy')
    await s.service.setPermission('readOnly')
    expect(await nextTurn(4)).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    expect(await nextTurn(5)).not.toHaveProperty('sandboxPolicy')
    expect(codex.requests('thread/start')).toHaveLength(1)
    expect(s.logs).toContain('remote.permission-set')
  })

  // 第三轮复查第 5 条：新开的对话照 Codex 回报的看，比手机这一档宽（哪个版本没认压住的那两项）就跟接已有对话一样第一句降下来。
  it('lowers a new thread on its first message when Codex reports a wider sandbox than the phone level', async () => {
    const s = await setup({
      now: () => Date.UTC(2026, 10, 11, 6, 0, 0),
      codexReplies: {
        'thread/start': () => ({
          result: {
            thread: { id: 'th-1' },
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox: { type: 'workspaceWrite', writableRoots: ['/tmp/extra-root'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
          },
        }),
      },
    })
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect(codex.requests('turn/start')[0].params).toMatchObject({
      threadId: 'th-1',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
    })
    expect(s.logs).toContain('remote.thread-start-sandbox-wider')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')[1].params).not.toHaveProperty('sandboxPolicy')
  })

  it('leaves a new thread alone when Codex reports the pinned sandbox', async () => {
    const s = await setup({
      codexReplies: {
        'thread/start': () => ({
          result: {
            thread: { id: 'th-1' },
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
          },
        }),
      },
    })
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect(codex.requests('turn/start')[0].params).not.toHaveProperty('sandboxPolicy')
    expect(s.logs).not.toContain('remote.thread-start-sandbox-wider')
  })

  it('opens the thread without a model when the phone follows the computer', async () => {
    expect(buildThreadStartParams('/p')).not.toHaveProperty('model')
    expect(buildThreadStartParams('/p', {}, null)).not.toHaveProperty('model')
    expect(buildThreadStartParams('/p', {}, 'gpt-6.3-sol')).toMatchObject({ model: 'gpt-6.3-sol' })
    expect(configuredCodexModel({ config: { model: 'gpt-6.2' } })).toBe('gpt-6.2')
    for (const value of [null, {}, { config: null }, { config: { model: '' } }, { config: { model: 7 } }]) expect(configuredCodexModel(value)).toBeNull()
  })

  it('stops a running turn on request', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    channel.handlers?.onInbound(text(alice, '停止'))
    await codex.requestedUntil('turn/interrupt', 1)
    expect(codex.requests('turn/interrupt')).toHaveLength(1)
    expect(codex.requests('turn/interrupt')[0].params).toEqual({ threadId: 'th-1', turnId: 'tu-1' })
    await vi.waitFor(() => expect(channel.texts()).toContain('已停止。'))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'interrupted' } })
    channel.handlers?.onInbound(text(alice, '停止'))
    await channel.sentUntil(() => channel.texts().includes('当前没有正在处理的任务。'))
  })

  // M01：Codex 不答应停（回了错、10 秒没回）时不说「已停止。」，这一轮照旧算在做，不让下一句叠一轮上去。
  it('keeps the turn running and says so when Codex refuses to stop it, then reports the stop once Codex ends it', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.interruptError = { code: -32600, message: 'thread runtime is no longer accepting interrupts' }
    channel.handlers?.onInbound(text(alice, '停止'))
    await channel.sentUntil(() => channel.texts().includes('Codex 仍在处理上一条消息，尚未停止。停止后将通知您，您也可稍后再次发送「停止」。'))
    expect(channel.texts()).not.toContain('已停止。')
    expect(s.logs).toContain('remote.interrupt-failed')
    expect(await s.service.snapshot()).toMatchObject({ task: 'running', lastRequest: { state: 'running' } })
    channel.handlers?.onInbound(text(alice, '换个做法'))
    await channel.sentUntil(() => channel.texts().includes('Codex 正在处理上一条消息，请待其完成后再发送，或发送「停止」中断。'))
    expect(codex.requests('turn/start')).toHaveLength(1)
    // 没停成的这一轮照旧能问审批，手机上照常收到卡片。
    const asked = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    channel.handlers?.onInbound(text(alice, '拒绝'))
    await expect(asked).resolves.toMatchObject({ result: { decision: 'decline' } })
    // Codex 后来自己停下了：这时才说「已停止。」，下一句开新的一轮。
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'interrupted' } })
    await channel.sentUntil(() => channel.texts().includes('已停止。'))
    await vi.waitFor(async () => expect((await s.service.snapshot()).lastRequest?.state).toBe('stopped'))
    channel.handlers?.onInbound(text(alice, '再来一次'))
    await codex.requestedUntil('turn/start', 2)
  })

  it('keeps the turn when Codex does not answer the stop within ten seconds, and still delivers its answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.replyGates.set('turn/interrupt', new Promise(() => undefined))
    channel.handlers?.onInbound(text(alice, '停止'))
    await codex.requestedUntil('turn/interrupt')
    // 等回执这一会儿 Codex 再要同意的一律拒绝，不发卡片。
    await expect(codex.ask('item/commandExecution/requestApproval', commandRequest)).resolves.toMatchObject({ result: { decision: 'decline' } })
    expect(approvalsSent(channel)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await channel.sentUntil(() => channel.texts().includes('Codex 仍在处理上一条消息，尚未停止。停止后将通知您，您也可稍后再次发送「停止」。'))
    expect((await s.service.snapshot()).task).toBe('running')
    codex.notify('item/completed', { threadId: 'th-1', turnId: 'tu-1', item: { type: 'agentMessage', id: 'a1', text: '测试都过了。', phase: 'final_answer' } })
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await channel.sentUntil(() => channel.texts().some((entry) => entry.startsWith('测试都过了。')))
    expect(channel.texts()).not.toContain('已停止。')
    expect((await s.service.snapshot()).lastRequest?.state).toBe('done')
  })

  it('says it stopped exactly once when Codex ends the turn before answering the stop request', async () => {
    let release!: () => void
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.replyGates.set('turn/interrupt', new Promise<void>((resolve) => { release = resolve }))
    channel.handlers?.onInbound(text(alice, '停止'))
    await codex.requestedUntil('turn/interrupt')
    // 电脑上也点了「停止本轮」：等同一次打断，不再请 Codex 停第二次。
    const fromComputer = s.service.stopTurnFromComputer()
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'interrupted' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    release()
    await expect(fromComputer).resolves.toMatchObject({ task: 'idle', lastRequest: { state: 'stopped' } })
    await channel.sentUntil(() => channel.texts().includes('已停止。'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.texts().filter((entry) => entry === '已停止。')).toHaveLength(1)
    expect(codex.requests('turn/interrupt')).toHaveLength(1)
  })

  it('does not start a new conversation while the turn it could not stop is still running', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.interruptError = { code: -32603, message: 'failed to interrupt turn' }
    channel.handlers?.onInbound(text(alice, '新对话'))
    await channel.sentUntil(() => channel.texts().includes('上一条消息尚未停止，新对话未开启。Codex 停止后将通知您，届时请再次发送「新对话」。'))
    expect(channel.texts()).not.toContain('已开始新对话。')
    channel.handlers?.onInbound(text(alice, '换个做法'))
    await channel.sentUntil(() => channel.texts().includes('Codex 正在处理上一条消息，请待其完成后再发送，或发送「停止」中断。'))
    codex.interruptError = null
    channel.handlers?.onInbound(text(alice, '新对话'))
    await channel.sentUntil(() => channel.texts().includes('已开始新对话。'))
    channel.handlers?.onInbound(text(alice, '换个做法'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('thread/start')).toHaveLength(2)
  })

  it('tells the computer the turn has not stopped yet when Codex refuses, and says nothing to the phone', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    await channel.sentUntil(() => channel.texts().includes('已收到，Codex 开始处理。'))
    const sentBefore = channel.sent.length
    codex.interruptError = { code: -32600, message: 'no active turn to interrupt' }
    await expect(s.service.stopTurnFromComputer()).rejects.toThrow('Codex 仍在处理，尚未停止。请稍后再次点击「停止本轮」。')
    expect(channel.sent.length).toBe(sentBefore)
    expect(s.logs).not.toContain('remote.turn-stopped-on-computer')
    expect((await s.service.snapshot())).toMatchObject({ task: 'running', lastRequest: { state: 'running' } })
    codex.interruptError = null
    await expect(s.service.stopTurnFromComputer()).resolves.toMatchObject({ task: 'idle', lastRequest: { state: 'stopped' } })
    expect(channel.texts().at(-1)).toBe('已停止。')
  })

  it('says the turn is still running when a stop pressed on its progress card is refused', async () => {
    const s = await setup({ progressCards: true })
    const channel = await enabledAndPaired(s) as FakeCardChannel
    const codex = await prompted(s, channel)
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', plan: [{ step: '跑测试', status: 'inProgress' }] })
    await vi.waitFor(() => expect(channel.progress).toHaveLength(1))
    codex.interruptError = { code: -32600, message: 'thread runtime is no longer accepting interrupts' }
    channel.handlers?.onInbound({ kind: 'stop', peer: alice, direct: true, nonce: channel.progress[0].card.stopNonce ?? '' })
    await channel.sentUntil(() => channel.texts().includes('Codex 仍在处理上一条消息，尚未停止。停止后将通知您，您也可稍后再次发送「停止」。'))
    expect(channel.progress.at(-1)?.card.state).toBe('running')
    expect((await s.service.snapshot()).task).toBe('running')
  })

  // 一轮一小时没任何动静就当 Codex 卡死（0.2.22 打磨 C2，yoyo 10-27「停改」）：请它停下、告诉手机，之后能开新的一轮。
  it('stops a turn that shows no progress for an hour and tells the phone to say it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    // Codex 还在出声：五十分钟后一条通知，计时跟着重新起算。
    await vi.advanceTimersByTimeAsync(50 * 60_000)
    codex.notify('item/completed', { threadId: 'th-1', turnId: 'tu-1', item: { type: 'agentMessage', id: 'a1', text: '还在看', phase: 'commentary' } })
    await vi.advanceTimersByTimeAsync(50 * 60_000)
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.waitFor(() => expect(codex.requests('turn/interrupt')).toHaveLength(1))
    await vi.waitFor(() => expect(channel.texts()).toContain('该任务 1 小时内无任何进展，已停止。请重新描述需要执行的任务。'))
    expect(s.logs).toContain('remote.turn-stalled')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'interrupted' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    expect(channel.texts()).not.toContain('已停止。')
    channel.handlers?.onInbound(text(alice, '再来一次'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
  })

  it('counts a pending approval as progress: it expires on its own ten minutes later and the stall clock restarts from it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    await vi.advanceTimersByTimeAsync(55 * 60_000)
    const asked = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    // 审批十分钟没人回先按原有规则自己过期（第 65 分钟），这一轮照旧跑着、不算卡死。
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await expect(asked).resolves.toMatchObject({ result: { decision: 'decline' } })
    await vi.waitFor(() => expect(channel.texts()).toContain('第 1 条在 10 分钟内未获回复，已自动拒绝。'))
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
    // 问审批算一次动静：卡死从第 55 分钟再数一小时（第 115 分钟），不是从开始数的第 60 分钟。
    await vi.advanceTimersByTimeAsync(49 * 60_000)
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(codex.requests('turn/interrupt')).toHaveLength(1))
    await vi.waitFor(() => expect(channel.texts()).toContain('该任务 1 小时内无任何进展，已停止。请重新描述需要执行的任务。'))
  })

  // YF-13：电脑卡片上「最近一次」——几点发来的、做到哪儿了；手机上发来的原话不上卡片。
  it('tells the window when the last phone request came in and how it ended', async () => {
    let clock = 1_800_000_000_000
    const s = await setup({ now: () => clock })
    const channel = await enabledAndPaired(s)
    expect((await s.service.snapshot()).lastRequest).toBeUndefined()
    const receivedAt = clock
    const codex = await prompted(s, channel, '修一下登录页')
    clock += 3 * 60_000
    expect((await s.service.snapshot()).lastRequest).toEqual({ receivedAt, state: 'running' })
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).lastRequest).toEqual({ receivedAt, state: 'done' }))
    expect(JSON.stringify(await s.service.snapshot())).not.toContain('修一下登录页')
    channel.handlers?.onInbound(text(alice, '再跑一次'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'failed', error: { message: `401 for key ${apiKey}` } } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).lastRequest).toMatchObject({ state: 'failed', reason: '401 for key [已隐去]' }))
  })

  it('gives the plain reason for a failure it recognises, and none when Codex could not start', async () => {
    const s = await setup({ failSpawns: { remaining: 1 } })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.texts().includes('电脑端的 Codex 启动失败，请在电脑端的星芒中查看。'))
    await vi.waitFor(async () => expect((await s.service.snapshot()).lastRequest?.state).toBe('failed'))
    expect((await s.service.snapshot()).lastRequest?.reason).toBeUndefined()
    const codex = await prompted(s, channel, '再跑一次')
    const quota = 'unexpected status 403 Forbidden: {"error":{"message":"用户额度不足, 剩余额度: $0.01","code":"insufficient_user_quota"}}'
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'failed', error: { message: quota, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } } } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).lastRequest).toMatchObject({ state: 'failed', reason: '余额不足，请充值后重新发送。' }))
  })

  it('marks the last request stopped when the phone says stop, and forgets it once every channel is off', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await prompted(s, channel)
    channel.handlers?.onInbound(text(alice, '停止'))
    await channel.sentUntil(() => channel.texts().includes('已停止。'))
    expect((await s.service.snapshot()).lastRequest?.state).toBe('stopped')
    const off = await s.service.setChannelEnabled('feishu', false)
    expect(off.lastRequest).toBeUndefined()
  })

  it('stops the running turn from the computer the same way the phone does, and tells the phone', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const asked = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    const stopped = await s.service.stopTurnFromComputer()
    await expect(asked).resolves.toMatchObject({ result: { decision: 'decline' } })
    expect(codex.requests('turn/interrupt')[0].params).toEqual({ threadId: 'th-1', turnId: 'tu-1' })
    expect(channel.texts()).toContain('已停止。')
    expect(stopped).toMatchObject({ task: 'idle', pendingApprovals: 0, lastRequest: { state: 'stopped' } })
    expect(s.logs).toContain('remote.turn-stopped-on-computer')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'interrupted' } })
    channel.handlers?.onInbound(text(alice, '再来一次'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
  })

  it('does nothing on the phone when the computer asks to stop and nothing is running', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const sentBefore = channel.sent.length
    const snapshot = await s.service.stopTurnFromComputer()
    expect(snapshot.task).toBe('idle')
    expect(channel.sent.length).toBe(sentBefore)
  })

  it('declines every waiting approval from the computer, tells the phone each one, and lets the turn go on', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const first = codex.ask('item/commandExecution/requestApproval', commandRequest, 'a')
    const second = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, itemId: 'i2' }, 'b')
    await approvalCardsSent(channel, 2)
    expect((await s.service.snapshot()).pendingApprovals).toBe(2)
    const declined = await s.service.declineApprovalsFromComputer()
    await expect(first).resolves.toMatchObject({ result: { decision: 'decline' } })
    await expect(second).resolves.toMatchObject({ result: { decision: 'decline' } })
    expect(channel.texts()).toEqual(expect.arrayContaining(['已拒绝第 1 条。', '已拒绝第 2 条。']))
    expect(declined).toMatchObject({ task: 'running', pendingApprovals: 0, lastRequest: { state: 'running' } })
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
  })

  it('reports a failed turn with the redacted reason', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'failed', error: { message: `401 for key ${apiKey}` } } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('本轮未完成：401 for key [已隐去]'))
  })

  // D66 / YKS-8：余额不够、登录失效这类原话（英文、JSON）不再原样发到手机，原话进日志。
  it('says what went wrong in plain words for the failures the customer can fix, and logs the original', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const quota = 'unexpected status 403 Forbidden: {"error":{"message":"用户额度不足, 剩余额度: $0.01","code":"insufficient_user_quota"}}, url: https://relay.example.test/v1/responses'
    codex.notify('error', { threadId: 'th-1', turnId: 'tu-1', willRetry: false, error: { message: quota, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } }, additionalDetails: null } })
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'failed', error: null } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('余额不足，请充值后重新发送。'))
    expect(channel.texts().join('\n')).not.toContain('insufficient_user_quota')
    const logged = s.logDetails.find((entry) => entry.event === 'remote.turn-failed')?.detail
    expect(logged).toMatchObject({ channel: 'feishu', kind: 'balance' })
    expect(String(logged?.reason)).toContain('insufficient_user_quota')

    channel.handlers?.onInbound(text(alice, '再来'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'failed', error: { message: 'Codex ran out of room in the model\'s context window.', codexErrorInfo: 'contextWindowExceeded' } } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('当前对话过长，请发送「新对话」重新开始。'))

    channel.handlers?.onInbound(text(alice, '再来'))
    await codex.requestedUntil('turn/start', 3)
    expect(codex.requests('turn/start')).toHaveLength(3)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-3', status: 'failed', error: { message: `unexpected status 401 Unauthorized: {"error":{"message":"无效的令牌 ${apiKey}"}}`, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } } } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('电脑端登录已失效，请在电脑端的星芒中重新登录。'))
    const loginLog = s.logDetails.filter((entry) => entry.event === 'remote.turn-failed').at(-1)?.detail
    expect(String(loginLog?.reason)).not.toContain(apiKey)

    channel.handlers?.onInbound(text(alice, '再来'))
    await codex.requestedUntil('turn/start', 4)
    expect(codex.requests('turn/start')).toHaveLength(4)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-4', status: 'failed', error: { message: 'stream disconnected before completion: error sending request', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('电脑暂时无法连接星芒线路，请稍后重新发送。'))
  })

  // YF-18（「状态重试」那批）：「状态」带上跑了多久、做到哪一步、余额、还有多久自动关。
  it('reports how long the turn has run, the plan step, the balance and when it closes by itself', async () => {
    let now = Date.UTC(2026, 10, 11, 6, 0, 0)
    const s = await setup({ now: () => now, idleCloseHours: 4, readBalanceUsd: async () => 12.4 })
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.notify('turn/plan/updated', {
      threadId: 'th-1',
      turnId: 'tu-1',
      explanation: null,
      plan: [{ step: '读代码', status: 'completed' }, { step: '运行测试', status: 'inProgress' }, { step: '写总结', status: 'pending' }],
    })
    now += 6 * 60_000 + 30_000
    channel.handlers?.onInbound(text(alice, '状态'))
    await channel.sentUntil(() => channel.texts().at(-1) === `工作文件夹：${path.join('~', 'projects', 'demo')}\n当前状态：正在处理，已用时 6 分钟，当前步骤「运行测试」\n余额：$12.40\n4 小时内无新消息将自动关闭`)
    // 计划里一条正在做的都没有了（都做完了），就不写「做到…」。
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', explanation: null, plan: [{ step: '读代码', status: 'completed' }] })
    channel.handlers?.onInbound(text(alice, '状态'))
    await channel.sentUntil(() => channel.texts().at(-1) === `工作文件夹：${path.join('~', 'projects', 'demo')}\n当前状态：正在处理，已用时 6 分钟\n余额：$12.40\n4 小时内无新消息将自动关闭`)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    channel.handlers?.onInbound(text(alice, '状态'))
    await channel.sentUntil(() => channel.texts().at(-1) === `工作文件夹：${path.join('~', 'projects', 'demo')}\n当前状态：空闲\n余额：$12.40\n4 小时内无新消息将自动关闭`)
  })

  it('leaves the balance and idle close lines out when the balance cannot be read and the remote never closes by itself', async () => {
    const s = await setup({ readBalanceUsd: async () => { throw new Error('network down') } })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '状态'))
    await channel.sentUntil(() => channel.texts().at(-1) === `工作文件夹：${path.join('~', 'projects', 'demo')}\n当前状态：空闲`)
  })

  // YF-16：做完以后在回答后面接一行，用了多久、真改成了哪些文件；停下、没做完的不接。
  it('sums up the time taken and the files actually changed after the answer', async () => {
    let now = Date.UTC(2026, 10, 11, 6, 0, 0)
    const s = await setup({ now: () => now })
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const fileChange = (id: string, status: string, paths: string[]) => ({
      threadId: 'th-1',
      turnId: 'tu-1',
      item: { type: 'fileChange', id, status, changes: paths.map((entry) => ({ path: entry, kind: { type: 'update', move_path: null }, diff: '' })) },
    })
    codex.notify('item/completed', fileChange('f1', 'completed', [`${s.workspace}/src/a.ts`, `${s.workspace}/styles/b.css`]))
    codex.notify('item/completed', fileChange('f2', 'declined', [`${s.workspace}/src/secret.ts`]))
    codex.notify('item/completed', fileChange('f3', 'completed', [`${s.workspace}/src/a.ts`]))
    codex.notify('item/completed', { threadId: 'th-1', turnId: 'tu-1', item: { type: 'agentMessage', id: 'a1', text: '改好了。', phase: 'final_answer' } })
    now += 200_000
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('改好了。\n\n用时 3 分 20 秒，修改了 2 个文件：a.ts、b.css。'))

    channel.handlers?.onInbound(text(alice, '再来一个'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
    now += 45_000
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'failed', error: { message: 'boom' } } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('本轮未完成：boom'))
  })

  // YF-22：「重试」把这次打开以后最后一句交给 Codex 的话再发一次；关了再开就没有「上一条」了。
  it('sends the last prompt again on retry, says which one, and forgets it once the remote is switched off', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '重试'))
    await channel.sentUntil(() => channel.texts().at(-1) === '暂无可重新发送的上一条消息，请直接发送需要执行的任务。')
    const prompt = '把登录页的表单校验全部改成新的写法，再补上测试'
    const codex = await prompted(s, channel, prompt)
    channel.handlers?.onInbound(text(alice, '重试'))
    await channel.sentUntil(() => channel.texts().at(-1) === 'Codex 正在处理上一条消息，请待其完成后再发送，或发送「停止」中断。')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'failed', error: { message: 'boom' } } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    channel.handlers?.onInbound(text(alice, '重试'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
    expect(channel.texts()).toContain('重新发送上一条：「把登录页的表单校验全部改成新的写法，再补…」\n已收到，Codex 开始处理。')
    expect(codex.requests('turn/start')[1].params).toEqual({ threadId: 'th-1', input: [{ type: 'text', text: prompt, text_elements: [] }] })

    await s.service.setChannelEnabled('feishu', false)
    await s.service.setChannelEnabled('feishu', true)
    const reopened = s.channels.at(-1) as FakeChannel
    reopened.handlers?.onInbound(text(alice, '重试'))
    await reopened.sentUntil(() => reopened.texts().includes('暂无可重新发送的上一条消息，请直接发送需要执行的任务。'))
  })

  // M03：做完了，回答刚好没送到手机。手机那头通了补发，「重试」不让 Codex 再做一遍。
  describe('answers that never reached the phone', () => {
    const resentPrefix = '此前有一条回复未能送达，现补发如下：'
    const idleStatus = `工作文件夹：${path.join('~', 'projects', 'demo')}\n当前状态：空闲`
    const retryNote = '上一条消息已处理完成，回复即为上方内容，因此本次未重新执行。如确需重新执行，请再次发送「重试」。'

    /** 交一句、Codex 做完，回答发的那一下网断了；返回时手机那头已经又通了。 */
    async function finishedWhileOffline(s: Setup, channel: FakeChannel, codex: FakeCodex, answer: string): Promise<void> {
      codex.notify('item/completed', { threadId: 'th-1', turnId: 'tu-1', item: { type: 'agentMessage', id: 'a1', text: answer, phase: 'final_answer' } })
      channel.offline = true
      codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
      // 没送到的那一份是在发送失败以后才留下的：等到它留下了再放开网络。
      await vi.waitFor(() => expect(s.logs).toContain('remote.answer-undelivered'))
      channel.offline = false
    }

    it('sends the missed answer before the status reply, only once', async () => {
      let now = Date.UTC(2026, 10, 18, 6, 0, 0)
      const s = await setup({ now: () => now })
      const channel = await enabledAndPaired(s)
      const codex = await prompted(s, channel, '把首页的标题改大一点')
      now += 45_000
      await finishedWhileOffline(s, channel, codex, '改好了。')
      expect(channel.texts().some((entry) => entry.includes('改好了。'))).toBe(false)
      expect((await s.service.snapshot()).lastRequest).toMatchObject({ state: 'done' })

      channel.handlers?.onInbound(text(alice, '状态'))
      await channel.sentUntil(() => channel.texts().at(-1) === idleStatus)
      expect(channel.texts().slice(-2)).toEqual([`${resentPrefix}\n\n改好了。\n\n用时 45 秒。`, idleStatus])
      expect(s.logs).toContain('remote.answer-resent')

      channel.handlers?.onInbound(text(alice, '状态'))
      await channel.sentUntil(() => channel.texts().filter((entry) => entry === idleStatus).length === 2)
      expect(channel.texts().filter((entry) => entry.startsWith(resentPrefix))).toHaveLength(1)
      expect(codex.requests('turn/start')).toHaveLength(1)
    })

    it('answers retry with the missed answer instead of running the task again, and runs it on the next retry', async () => {
      const s = await setup()
      const channel = await enabledAndPaired(s)
      const codex = await prompted(s, channel, '跑一下测试')
      await finishedWhileOffline(s, channel, codex, '测试都过了。')

      channel.handlers?.onInbound(text(alice, '重试'))
      await channel.sentUntil(() => channel.texts().at(-1) === retryNote)
      expect(channel.texts().at(-2)).toMatch(new RegExp(`^${resentPrefix}\\n\\n测试都过了。\\n\\n用时 `))
      expect(codex.requests('turn/start')).toHaveLength(1)

      channel.handlers?.onInbound(text(alice, '重试'))
      await channel.sentUntil(() => channel.texts().includes('重新发送上一条：「跑一下测试」\n已收到，Codex 开始处理。'))
      await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
    })

    it('sends the missed answer by itself once the channel is connected again', async () => {
      const s = await setup()
      const channel = await enabledAndPaired(s)
      const codex = await prompted(s, channel)
      await finishedWhileOffline(s, channel, codex, '做完了。')
      channel.handlers?.onStatus({ state: 'connecting', message: '无法连接飞书，正在重试。' })
      channel.handlers?.onStatus({ state: 'connected' })
      await channel.sentUntil(() => channel.texts().some((entry) => entry.startsWith(`${resentPrefix}\n\n做完了。`)))
      // 已经连着时再报一次「连上了」不算又连上，送到了的也不会再发。
      channel.handlers?.onStatus({ state: 'connected' })
      channel.handlers?.onInbound(text(alice, '状态'))
      await channel.sentUntil(() => channel.texts().at(-1) === idleStatus)
      expect(channel.texts().filter((entry) => entry.startsWith(resentPrefix))).toHaveLength(1)
    })

    it('does not run the task again when retry arrives while the missed answer is still being sent', async () => {
      const s = await setup()
      const channel = await enabledAndPaired(s)
      const codex = await prompted(s, channel)
      await finishedWhileOffline(s, channel, codex, '做完了。')
      let release!: () => void
      channel.gate = new Promise((resolve) => { release = resolve })
      channel.handlers?.onStatus({ state: 'connecting' })
      channel.handlers?.onStatus({ state: 'connected' })
      // 连上了那次补发卡在发的半路。之后头一个写设置的是手机来的「重试」记下消息编号（YR-2），那是它补发以前最后
      // 一次等：写完它一路走到补发那里停下等，这时才放行，补发确实是在它等着的时候才发完。放早了它会看不到在补发，
      // 这条用例只会红、不会假绿。
      const updateSettings = s.store.updateSettings.bind(s.store)
      vi.spyOn(s.store, 'updateSettings').mockImplementationOnce(async (mutate) => {
        const settings = await updateSettings(mutate)
        setTimeout(() => {
          channel.gate = null
          release()
        }, 0)
        return settings
      })
      channel.handlers?.onInbound(text(alice, '重试'))
      await channel.sentUntil(() => channel.texts().at(-1) === retryNote)
      expect(channel.texts().filter((entry) => entry.startsWith(`${resentPrefix}\n\n做完了。`))).toHaveLength(1)
      expect(codex.requests('turn/start')).toHaveLength(1)
    })

    it('keeps the answer when sending it again fails too, and tries once more on the next message', async () => {
      const s = await setup()
      const channel = await enabledAndPaired(s)
      const codex = await prompted(s, channel)
      await finishedWhileOffline(s, channel, codex, '做完了。')
      channel.offline = true
      // 先补发、再回「状态」，两条都没发出去（加上原来那条回答一共 3 条）。
      channel.handlers?.onInbound(text(alice, '状态'))
      await channel.sentUntil(() => channel.failed.length === 3)
      channel.offline = false
      channel.handlers?.onInbound(text(alice, '状态'))
      await channel.sentUntil(() => channel.texts().at(-1) === idleStatus)
      expect(channel.texts().filter((entry) => entry.startsWith(`${resentPrefix}\n\n做完了。`))).toHaveLength(1)
    })

    it('runs the newer prompt on retry when the missed answer belongs to an older one', async () => {
      const s = await setup()
      const channel = await enabledAndPaired(s)
      const codex = await prompted(s, channel, '第一件事')
      await finishedWhileOffline(s, channel, codex, '第一件做完了。')
      // 第二句到的时候手机那头又断了：补发没成，第二句照常交给 Codex。
      channel.offline = true
      channel.handlers?.onInbound(text(alice, '第二件事'))
      // 原来那条回答、补发、「收到」三条都没发出去。
      await channel.sentUntil(() => channel.failed.length === 3)
      await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
      channel.offline = false
      codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'failed', error: { message: 'boom' } } })
      await channel.sentUntil(() => channel.texts().at(-1) === '本轮未完成：boom')

      channel.handlers?.onInbound(text(alice, '重试'))
      await channel.sentUntil(() => channel.texts().includes('重新发送上一条：「第二件事」\n已收到，Codex 开始处理。'))
      await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(3))
      expect(channel.texts().filter((entry) => entry.startsWith(`${resentPrefix}\n\n第一件做完了。`))).toHaveLength(1)
      expect(channel.texts()).not.toContain(retryNote)
    })

    it('drops the missed answer after a day', async () => {
      let now = Date.UTC(2026, 10, 18, 6, 0, 0)
      const s = await setup({ now: () => now })
      const channel = await enabledAndPaired(s)
      const codex = await prompted(s, channel)
      await finishedWhileOffline(s, channel, codex, '做完了。')
      now += 24 * 60 * 60_000 + 1
      channel.handlers?.onInbound(text(alice, '重试'))
      await channel.sentUntil(() => channel.texts().some((entry) => entry.startsWith('重新发送上一条：')))
      await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
      expect(channel.texts().some((entry) => entry.startsWith(resentPrefix))).toBe(false)
    })

    it('drops the missed answer once the remote is switched off on the computer', async () => {
      const s = await setup()
      const channel = await enabledAndPaired(s)
      const codex = await prompted(s, channel)
      await finishedWhileOffline(s, channel, codex, '做完了。')
      await s.service.setChannelEnabled('feishu', false)
      await s.service.setChannelEnabled('feishu', true)
      const reopened = s.channels.at(-1) as FakeChannel
      reopened.handlers?.onInbound(text(alice, '状态'))
      await reopened.sentUntil(() => reopened.texts().at(-1) === idleStatus)
      expect([...channel.texts(), ...reopened.texts()].some((entry) => entry.startsWith(resentPrefix))).toBe(false)
    })
  })

  it('tells the phone when Codex dies mid-turn', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.emit('exit', 1, null)
    await vi.waitFor(() => expect(channel.texts().at(-1)).toContain('意外退出'))
    // 卡片「最近一次」跟着说没做完，不会一直停在「正在处理」（YF-13）。
    expect((await s.service.snapshot()).lastRequest).toMatchObject({ state: 'failed', reason: '电脑端的 Codex 意外退出，请重新发送。' })
    channel.handlers?.onInbound(text(alice, '再试一次'))
    await s.codexSpawned(2)
    expect(s.codex).toHaveLength(2)
  })

  it('logs the redacted tail of what Codex wrote to stderr when it dies', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.stderr.emit('data', `panic: config.toml is broken\nusing key ${apiKey}\n`)
    codex.emit('exit', 1, null)
    await vi.waitFor(() => expect(s.logs).toContain('remote.codex-exited'))
    const detail = s.logDetails.find((entry) => entry.event === 'remote.codex-exited')?.detail
    expect(detail).toMatchObject({ code: 1 })
    expect(String(detail?.stderr)).toContain('panic: config.toml is broken')
    expect(String(detail?.stderr)).not.toContain(apiKey)
  })

  // D66 / YKS-3：起 Codex 排在全局安装队列里，可能等好几分钟；这期间「状态」「停止」要有人理，「停止」要拦得住。
  it('answers status and stop while Codex is still starting, and hands nothing over once stopped', async () => {
    let release!: () => void
    const s = await setup({ spawnGate: new Promise<void>((resolve) => { release = resolve }) })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.sent.length >= 1)
    expect(channel.texts()).toEqual(['已收到，Codex 开始处理。'])
    channel.handlers?.onInbound(text(alice, '状态'))
    await channel.sentUntil(() => channel.texts().at(-1)?.includes('当前状态：正在处理') === true)
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await channel.sentUntil(() => channel.texts().at(-1) === 'Codex 正在处理上一条消息，请待其完成后再发送，或发送「停止」中断。')
    channel.handlers?.onInbound(text(alice, '停止'))
    await channel.sentUntil(() => channel.texts().at(-1) === '已停止。')
    release()
    await vi.waitFor(() => expect(s.codex).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(s.codex[0].requests('thread/start')).toHaveLength(0)
    expect(s.codex[0].requests('turn/start')).toHaveLength(0)
    expect((await s.service.snapshot()).task).toBe('idle')
  })

  // M02：turn/start 等满 60 秒没回执就当没做成收掉了，Codex 那边却可能已经开始做：那一轮冒出动静时补一次打断，
  // 不让它在手机看不见的地方接着跑、接着扣钱。
  it('interrupts a turn Codex started after its turn/start receipt was given up on, and only once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let release!: () => void
    const s = await setup({ replyGates: new Map([['turn/start', new Promise<void>((resolve) => { release = resolve })]]) })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    const codex = await turnStarted(s, 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    expect(s.logs).toContain('remote.turn-start-timeout')
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
    // The receipt turns up late and nobody is waiting for it; then the turn shows itself.
    release()
    codex.notify('turn/started', { threadId: 'th-1', turn: { id: 'tu-1', status: 'inProgress' } })
    await vi.waitFor(() => expect(codex.requests('turn/interrupt')).toHaveLength(1))
    expect(codex.requests('turn/interrupt')[0].params).toEqual({ threadId: 'th-1', turnId: 'tu-1' })
    expect(s.logs).toContain('remote.late-turn-interrupted')
    codex.notify('item/started', { threadId: 'th-1', turnId: 'tu-1', item: { id: 'item-1', type: 'agentMessage' } })
    expect(codex.requests('turn/interrupt')).toHaveLength(1)
  })

  it('does not interrupt anything when turn/start is refused outright', async () => {
    const s = await setup({ codexReplies: { 'turn/start': () => ({ error: { code: -32600, message: 'bad request' } }) } })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    const codex = await turnStarted(s, 1)
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    codex.notify('turn/started', { threadId: 'th-1', turn: { id: 'tu-9', status: 'inProgress' } })
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
    expect(s.logs).not.toContain('remote.turn-start-timeout')
  })

  it('hands the next turn to Codex only after the one stopped on its way has been interrupted', async () => {
    let release!: () => void
    const s = await setup({ replyGates: new Map([['turn/start', new Promise<void>((resolve) => { release = resolve })]]) })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await turnStarted(s, 1)
    expect(s.codex[0].requests('turn/start')).toHaveLength(1)
    const codex = s.codex[0]
    channel.handlers?.onInbound(text(alice, '停止'))
    await channel.sentUntil(() => channel.texts().at(-1) === '已停止。')
    channel.handlers?.onInbound(text(alice, '换个做法'))
    await channel.sentUntil(() => channel.texts().at(-1) === '已收到，Codex 开始处理。')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(codex.requests('turn/start')).toHaveLength(1)
    release()
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
    const interrupt = codex.written.findIndex((message) => message.method === 'turn/interrupt')
    expect(interrupt).toBeGreaterThan(-1)
    expect(codex.written.findIndex((message) => message === codex.requests('turn/start')[1])).toBeGreaterThan(interrupt)
    expect(codex.requests('turn/interrupt')[0].params).toEqual({ threadId: 'th-1', turnId: 'tu-1' })
  })

  it('tells the phone Codex is still being prepared when starting takes more than fifteen seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let release!: () => void
    const s = await setup({ spawnGate: new Promise<void>((resolve) => { release = resolve }) })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.texts().length === 1)
    await vi.advanceTimersByTimeAsync(14_000)
    expect(channel.texts()).toEqual(['已收到，Codex 开始处理。'])
    await vi.advanceTimersByTimeAsync(1_000)
    await channel.sentUntil(() => channel.texts().length === 2)
    expect(channel.texts()[1]).toBe('电脑正在启动 Codex，请稍候；如需取消，请发送「停止」。')
    release()
    await vi.waitFor(() => expect(s.codex[0]?.requests('turn/start').length ?? 0).toBe(1))
    // A Codex that is already running answers at once: no such line on the next turn.
    s.codex[0].notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await channel.sentUntil(() => channel.texts().length === 3)
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await s.codex[0].requestedUntil('turn/start', 2)
    expect(s.codex[0].requests('turn/start')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(channel.texts().filter((line) => line.startsWith('电脑正在启动 Codex'))).toHaveLength(1)
  })

  // D66 / YKS-16：对话不是他自己发「新对话」丢的，下一次回复前说一声。
  it('says the conversation starts afresh only when it was dropped without the phone asking', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect(channel.texts()[0]).toBe('已收到，Codex 开始处理。')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    // The same thread goes on: nothing to warn about.
    channel.handlers?.onInbound(text(alice, '接着改'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
    expect(channel.texts().filter((line) => line.includes('当前为新对话'))).toHaveLength(0)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    // The folder changed on the computer: the old conversation is gone.
    const other = path.join(path.dirname(s.workspace), 'other')
    fs.mkdirSync(other)
    await s.service.addWorkspace(other)
    await s.service.useWorkspace(path.join('~', 'projects', 'other'))
    channel.sent.length = 0
    channel.handlers?.onInbound(text(alice, '再改一下'))
    await codex.requestedUntil('thread/start', 2)
    expect(codex.requests('thread/start')).toHaveLength(2)
    expect(channel.texts()[0]).toBe('当前为新对话，Codex 无法读取此前的对话内容。\n已收到，Codex 开始处理。')
    await codex.requestedUntil('turn/start', 3)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-3', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    // Asked for by the phone: no warning afterwards.
    channel.handlers?.onInbound(text(alice, '新对话'))
    await channel.sentUntil(() => channel.texts().includes('已开始新对话。'))
    channel.sent.length = 0
    channel.handlers?.onInbound(text(alice, '从头来'))
    await codex.requestedUntil('thread/start', 3)
    expect(codex.requests('thread/start')).toHaveLength(3)
    expect(channel.texts()[0]).toBe('已收到，Codex 开始处理。')
  })

  // #1407 P3-1：起 Codex 要一会儿，这期间电脑上关了遥控。话不能再交给 Codex（交了就扣钱、只读命令先跑），
  // 起好的那份 Codex 也不能留着没人管。
  it('hands nothing to a Codex that finishes starting after the remote was switched off, and stops it', async () => {
    let release!: () => void
    const s = await setup({ spawnGate: new Promise<void>((resolve) => { release = resolve }) })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.texts().includes('已收到，Codex 开始处理。'))
    await s.service.setChannelEnabled('feishu', false)
    release()
    await vi.waitFor(() => expect(s.codex[0]?.kills.length ?? 0).toBeGreaterThan(0))
    expect(s.codex[0].requests('thread/start')).toHaveLength(0)
    expect(s.codex[0].requests('turn/start')).toHaveLength(0)
    expect(s.logs).toContain('remote.codex-start-abandoned')
    expect(s.logs).not.toContain('remote.codex-start-failed')
    expect(channel.texts()).not.toContain('电脑端的 Codex 启动失败，请在电脑端的星芒中查看。')
    expect((await s.service.snapshot()).codexStartFailed).toBeUndefined()
  })

  // YK-5：手机上收到「Codex 没能启动」，电脑卡片上也要看得见；Codex 下次起来了就收起。
  it('tells the window Codex could not start until a later message gets it started', async () => {
    const s = await setup({ failSpawns: { remaining: 1 } })
    const channel = await enabledAndPaired(s)
    expect((await s.service.snapshot()).codexStartFailed).toBeUndefined()
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.texts().includes('电脑端的 Codex 启动失败，请在电脑端的星芒中查看。'))
    await vi.waitFor(() => expect(s.snapshots.at(-1)?.codexStartFailed).toBe(true))
    expect(s.logs).toContain('remote.codex-start-failed')
    expect((await s.service.snapshot()).task).toBe('idle')
    channel.sent.length = 0
    s.snapshots.length = 0
    const codex = await prompted(s, channel, '再跑一次')
    expect(codex.requests('turn/start')).toHaveLength(1)
    await vi.waitFor(() => expect(s.snapshots.length).toBeGreaterThan(0))
    expect(s.snapshots.every((snapshot) => snapshot.codexStartFailed === undefined)).toBe(true)
    expect((await s.service.snapshot()).codexStartFailed).toBeUndefined()
  })

  it('drops the Codex-could-not-start notice once every channel is off, not while one is still on', async () => {
    const s = await setup({ failSpawns: { remaining: 1 } })
    await s.store.writeCredential('weixin', 'weixin-credential-value')
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.texts().includes('电脑端的 Codex 启动失败，请在电脑端的星芒中查看。'))
    await vi.waitFor(async () => expect((await s.service.snapshot()).codexStartFailed).toBe(true))
    await s.service.setChannelEnabled('weixin', true)
    await s.service.setChannelEnabled('weixin', false)
    expect((await s.service.snapshot()).codexStartFailed).toBe(true)
    const off = await s.service.setChannelEnabled('feishu', false)
    expect(off.codexStartFailed).toBeUndefined()
    await s.service.setChannelEnabled('feishu', true)
    expect((await s.service.snapshot()).codexStartFailed).toBeUndefined()
  })

  it('hands nothing to a Codex that finishes starting after the manager began quitting, and stops it', async () => {
    let release!: () => void
    const s = await setup({ spawnGate: new Promise<void>((resolve) => { release = resolve }) })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.texts().includes('已收到，Codex 开始处理。'))
    s.service.dispose()
    release()
    await vi.waitFor(() => expect(s.codex[0]?.kills.length ?? 0).toBeGreaterThan(0))
    expect(s.codex[0].requests('thread/start')).toHaveLength(0)
    expect(s.codex[0].requests('turn/start')).toHaveLength(0)
  })

  it('does not start the turn when the remote is switched off while the thread is being opened', async () => {
    let releaseThread!: () => void
    const threadGate = new Promise<void>((resolve) => { releaseThread = resolve })
    const s = await setup({ replyGates: new Map([['thread/start', threadGate]]) })
    const channel = await enabledAndPaired(s)
    // 微信也开着，Codex 就不会跟着飞书一起停，thread/start 的回执照样回来。
    await s.store.writeCredential('weixin', 'weixin-credential-value')
    await s.service.setChannelEnabled('weixin', true)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    // thread/start 已经发出去、回执还在路上时关掉遥控。
    await s.codexSpawned(1)
    await s.codex[0].requestedUntil('thread/start')
    expect(s.codex[0].requests('thread/start')).toHaveLength(1)
    const codex = s.codex[0]
    await s.service.setChannelEnabled('feishu', false)
    releaseThread()
    await threadGate
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(codex.kills).toHaveLength(0)
    expect(codex.requests('turn/start')).toHaveLength(0)
  })

  // #1407 P3-2：「停止」以后上一轮迟到的审批和结束通知，在新一轮的编号还没回来时，不能挂到新一轮头上。
  it('declines a late approval and ignores a late finish of a stopped turn while the next turn is still starting', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('running'))
    channel.handlers?.onInbound(text(alice, '停止'))
    await channel.sentUntil(() => channel.texts().includes('已停止。'))
    let release!: () => void
    codex.replyGates.set('turn/start', new Promise<void>((resolve) => { release = resolve }))
    channel.handlers?.onInbound(text(alice, '换个做法'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
    const late = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, turnId: 'tu-1', command: 'rm -rf build' })
    await expect(late).resolves.toMatchObject({ result: { decision: 'decline' } })
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'interrupted' } })
    expect(approvalsSent(channel)).toHaveLength(0)
    expect(s.logs).toContain('remote.approval-other-turn')
    release()
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('running'))
    expect(channel.texts().filter((entry) => entry === '已停止。')).toHaveLength(1)
    const current = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, turnId: 'tu-2' })
    await approvalCardsSent(channel, 1)
    channel.handlers?.onInbound(text(alice, '同意'))
    await expect(current).resolves.toMatchObject({ result: { decision: 'accept' } })
  })

  it('declines an approval that names a turn other than the running one', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('running'))
    const asked = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, turnId: 'tu-9' })
    await expect(asked).resolves.toMatchObject({ result: { decision: 'decline' } })
    expect(approvalsSent(channel)).toHaveLength(0)
  })
})

// YF-14（yoyo 2026-11-11「图片改」）：手机上发图片，攒着跟下一句话一起交给 Codex。
function imageMessage(peer: RemotePeer, images: string[], body?: string): RemoteInbound {
  messageCounter += 1
  return { kind: 'image', peer, direct: true, messageId: `m-${messageCounter}`, images, replyContext: `ctx-${messageCounter}`, ...(body ? { text: body } : {}) }
}

function storedImages(directory: string): string[] {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : []
}

describe('codex-remote-service images', () => {
  const receivedImage = '已收到图片。请再发送一条消息说明需要 Codex 执行的任务，图片将一并提交。'

  // YF-14：只发图时先攒着、回一句；下一句话交给 Codex 时带上，「收到」那句说几张。
  it('holds images until the next prompt, then hands them to Codex as local images', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.images.set('img-b', { ok: true, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a']))
    await channel.sentUntil(() => channel.sent.length >= 1)
    expect(channel.texts()).toEqual([receivedImage])
    channel.handlers?.onInbound(imageMessage(alice, ['img-b']))
    await s.imagesSaved(2)
    expect(channel.fetched).toEqual(['img-a', 'img-b'])
    const stored = storedImages(s.imageDirectory)
    expect(stored).toHaveLength(2)
    expect(stored.some((name) => name.endsWith('.png')) && stored.some((name) => name.endsWith('.jpg'))).toBe(true)

    const codex = await prompted(s, channel, '这两张图里的报错是什么')
    expect(channel.texts()).toEqual([receivedImage, '已收到（含 2 张图片），Codex 开始处理。'])
    const input = (codex.requests('turn/start')[0].params as { input: Array<Record<string, unknown>> }).input
    expect(input[0]).toEqual({ type: 'text', text: '这两张图里的报错是什么', text_elements: [] })
    expect(input.slice(1).map((entry) => entry.type)).toEqual(['localImage', 'localImage'])
    for (const entry of input.slice(1)) expect(path.dirname(String(entry.path))).toBe(s.imageDirectory)
    expect(fs.readFileSync(String(input[1].path))).toEqual(Buffer.from(pngBytes))
  })

  it('never fetches images from someone who is not paired', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.handlers?.onInbound(imageMessage(mallory, ['img-a']))
    channel.handlers?.onInbound(text(alice, '帮助'))
    await channel.sentUntil(() => channel.sent.length >= 1)
    expect(channel.texts()).toHaveLength(1)
    expect(channel.fetched).toEqual([])
    expect(storedImages(s.imageDirectory)).toEqual([])
  })

  it('takes the words sent with the images as the prompt', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a'], '照这张图改按钮颜色'))
    await turnStarted(s, 1)
    expect(s.codex[0].requests('turn/start')).toHaveLength(1)
    expect(channel.texts()).toEqual(['已收到（含 1 张图片），Codex 开始处理。'])
    const input = (s.codex[0].requests('turn/start')[0].params as { input: Array<Record<string, unknown>> }).input
    expect(input.map((entry) => entry.type)).toEqual(['text', 'localImage'])
  })

  // M04（11-18 手机遥控专项）：图和字一起发、这条的图一张都没收下，字不交给 Codex（它没看到图就开始做，客户以为
  // 图跟着去了）；收下了几张的照常带着交出去，跟图一起发的指令照常回。
  it('holds back the words sent with images when none of them was taken, but still answers a command', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('broken', { ok: false, reason: 'failed' })
    channel.images.set('big', { ok: false, reason: 'too-large' })
    channel.handlers?.onInbound(imageMessage(alice, ['broken', 'big'], '照这张图改按钮颜色'))
    await channel.sentUntil(() => channel.texts().length >= 3)
    expect(channel.texts()).toEqual([
      '电脑未能获取此图片，请重新发送。',
      '图片过大，未能接收。请发送较小的图片或截取部分内容。',
      '图片均未接收成功，本条消息中的文字未发送给 Codex，请重新发送图片和文字。',
    ])
    channel.handlers?.onInbound(imageMessage(alice, ['broken'], '状态'))
    await channel.sentUntil(() => channel.texts().length >= 5)
    expect(channel.texts()[4]).toMatch(/^工作文件夹：/)
    expect(s.codex.flatMap((codex) => codex.requests('turn/start'))).toEqual([])

    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a', 'broken'], '照这张图改按钮颜色'))
    await turnStarted(s, 1)
    expect(channel.texts().at(-1)).toBe('已收到（含 1 张图片），Codex 开始处理。')
  })

  // M05（Codex 复核 11-18）：图和字一起发、赶上还在做上一条，回「还在处理上一条」时图也一起退回，
  // 不留给下一句不相干的话。
  it('turns away the images sent with a prompt while the last one is still running', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    const codex = await prompted(s, channel, '先跑一下测试')
    channel.handlers?.onInbound(imageMessage(alice, ['img-a'], '照这张图改按钮颜色'))
    await channel.sentUntil(() => channel.texts().at(-1) === 'Codex 正在处理上一条消息，请待其完成后再发送，或发送「停止」中断。')
    expect(channel.fetched).toEqual(['img-a'])
    await s.imagesRemoved(1)
    expect(storedImages(s.imageDirectory)).toEqual([])
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))

    channel.handlers?.onInbound(text(alice, '把标题改大一点'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
    expect(channel.texts().at(-1)).toBe('已收到，Codex 开始处理。')
    expect((codex.requests('turn/start')[1].params as { input: unknown[] }).input).toEqual([{ type: 'text', text: '把标题改大一点', text_elements: [] }])
  })

  // M05：退回的只是跟那句话一起发来的；早先单独发来、等着下一句的图照旧留着，先发图、再说要做什么的用法不变。
  it('keeps images sent on their own when a prompt with more images is turned away', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.images.set('img-b', { ok: true, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) })
    const codex = await prompted(s, channel, '先跑一下测试')
    channel.handlers?.onInbound(imageMessage(alice, ['img-a']))
    await s.imagesSaved(1)
    const kept = storedImages(s.imageDirectory)
    expect(kept).toHaveLength(1)
    channel.handlers?.onInbound(imageMessage(alice, ['img-b'], '照这张图改'))
    await channel.sentUntil(() => channel.texts().at(-1) === 'Codex 正在处理上一条消息，请待其完成后再发送，或发送「停止」中断。')
    await s.imagesRemoved(1)
    expect(storedImages(s.imageDirectory)).toEqual(kept)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))

    channel.handlers?.onInbound(text(alice, '看看这张图'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
    expect(channel.texts().at(-1)).toBe('已收到（含 1 张图片），Codex 开始处理。')
    const input = (codex.requests('turn/start')[1].params as { input: Array<Record<string, unknown>> }).input
    expect(input.map((entry) => entry.type)).toEqual(['text', 'localImage'])
    expect(path.basename(String(input[1].path))).toBe(kept[0])
  })

  // M05：设置一时读不到文件夹、回「Codex 没能启动」时同样没收下这句，图一起退回。
  it('turns away the images sent with a prompt when there is no folder to work in', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    await s.store.updateSettings((settings) => { settings.workspaceDirectory = null })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a'], '照这张图改按钮颜色'))
    await channel.sentUntil(() => channel.texts().at(-1) === '电脑端的 Codex 启动失败，请在电脑端的星芒中查看。')
    expect(channel.fetched).toEqual(['img-a'])
    await s.imagesRemoved(1)
    expect(storedImages(s.imageDirectory)).toEqual([])

    await s.store.updateSettings((settings) => { settings.workspaceDirectory = s.workspace })
    const codex = await prompted(s, channel, '把标题改大一点')
    expect(channel.texts().at(-1)).toBe('已收到，Codex 开始处理。')
    expect((codex.requests('turn/start')[0].params as { input: unknown[] }).input).toHaveLength(1)
  })

  it('says why an image was not taken, once per reason', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('big', { ok: false, reason: 'too-large' })
    channel.images.set('denied', { ok: false, reason: 'permission' })
    channel.images.set('broken', { ok: false, reason: 'failed' })
    channel.images.set('not-image', { ok: true, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) })
    channel.handlers?.onInbound(imageMessage(alice, ['big', 'denied', 'broken', 'not-image', 'big']))
    await channel.sentUntil(() => channel.sent.length >= 3)
    expect(channel.texts()).toEqual([
      '图片过大，未能接收。请发送较小的图片或截取部分内容。',
      '电脑未能获取此图片。请在飞书后台开通「获取单聊、群组消息」权限，并重新发布一个版本。',
      '电脑未能获取此图片，请重新发送。',
    ])
    expect(storedImages(s.imageDirectory)).toEqual([])
    expect(s.logs).toContain('remote.image-not-recognized')
  })

  it('keeps at most five images waiting for the next prompt', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    const refs = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7']
    for (const ref of refs) channel.images.set(ref, { ok: true, bytes: pngBytes })
    channel.handlers?.onInbound(imageMessage(alice, refs.slice(0, 4)))
    channel.handlers?.onInbound(imageMessage(alice, refs.slice(4)))
    // 等发送本身，不用 vi.waitFor 的 1 秒：第二句之前要原子写 7 次（两条消息各记一次编号进设置、存 5 张图），
    // Windows CI 上一次一两百毫秒，凑满 1 秒就等不全（11-18 #1929、11-20 main 和 #1940 各红一次）。
    await channel.sentUntil(() => channel.texts().length >= 2)
    expect(channel.texts()).toEqual([receivedImage, '每次最多附带 5 张图片，此图片未接收。'])
    expect(channel.fetched).toEqual(refs.slice(0, 5))
    expect(storedImages(s.imageDirectory)).toHaveLength(5)
  })

  it('drops waiting images on a new conversation but keeps the last prompt\'s for retry', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.images.set('img-b', { ok: true, bytes: pngBytes })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a']))
    const codex = await prompted(s, channel, '看看这张')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'failed', error: { message: 'boom' } } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    channel.handlers?.onInbound(imageMessage(alice, ['img-b']))
    await s.imagesSaved(2)
    expect(channel.fetched).toEqual(['img-a', 'img-b'])
    channel.handlers?.onInbound(text(alice, '新对话'))
    await s.imagesRemoved(1)
    expect(storedImages(s.imageDirectory)).toHaveLength(1)

    channel.handlers?.onInbound(text(alice, '重试'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')).toHaveLength(2)
    expect(channel.texts().at(-1)).toBe('重新发送上一条：「看看这张」\n已收到（含 1 张图片），Codex 开始处理。')
    const first = (codex.requests('turn/start')[0].params as { input: unknown[] }).input
    const again = (codex.requests('turn/start')[1].params as { input: unknown[] }).input
    expect(again).toEqual(first)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))

    // 下一句不带图：上一句的图不再要了。
    channel.handlers?.onInbound(text(alice, '接着做'))
    await codex.requestedUntil('turn/start', 3)
    expect(codex.requests('turn/start')).toHaveLength(3)
    expect((codex.requests('turn/start')[2].params as { input: unknown[] }).input).toHaveLength(1)
    await vi.waitFor(() => expect(storedImages(s.imageDirectory)).toEqual([]))
  })

  it('deletes every stored image when the remote is switched off', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a']))
    await s.imagesSaved(1)
    expect(storedImages(s.imageDirectory)).toHaveLength(1)
    // 上次没删成留下的一张，也一起清掉。
    fs.writeFileSync(path.join(s.imageDirectory, `${'0'.repeat(32)}.png`), Buffer.from(pngBytes))
    await s.service.setChannelEnabled('feishu', false)
    expect(storedImages(s.imageDirectory)).toEqual([])
  })

  it('clears images left over from last time when the remote is first switched on', async () => {
    const root = tempRoot()
    const leftover = path.join(root, 'data', 'codex-remote', 'images', `${'a'.repeat(32)}.jpg`)
    fs.mkdirSync(path.dirname(leftover), { recursive: true })
    fs.writeFileSync(leftover, 'old')
    const s = await setup({ images: true, root })
    await s.service.setChannelEnabled('feishu', true)
    expect(fs.existsSync(leftover)).toBe(false)
  })

  it('answers that only words and pictures work when there is nowhere to keep images', async () => {
    const s = await setup({ images: true, imageStore: false })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.handlers?.onInbound(imageMessage(alice, ['img-a']))
    channel.handlers?.onInbound({ kind: 'unsupported', peer: alice, direct: true, messageId: 'voice-1' })
    await channel.sentUntil(() => channel.sent.length >= 2)
    expect(channel.texts()).toEqual([
      '目前仅支持文字和图片，暂不支持语音和文件，请改用文字发送。',
      '目前仅支持文字和图片，暂不支持语音和文件，请改用文字发送。',
    ])
    expect(channel.fetched).toEqual([])
  })

  // YR-6：网不好时取一张图最长要等 30 秒，「停止」不该排在后面等。
  it('stops the running turn at once while an image sent before 「停止」 is still being fetched', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    let release!: () => void
    channel.images.set('slow', { ok: true, bytes: pngBytes })
    channel.gates.set('slow', new Promise<void>((resolve) => { release = resolve }))
    const codex = await prompted(s, channel)
    channel.handlers?.onInbound(imageMessage(alice, ['slow']))
    await channel.fetchedUntil(1)
    expect(channel.fetched).toEqual(['slow'])
    channel.handlers?.onInbound(text(alice, '停止'))
    await channel.sentUntil(() => channel.texts().includes('已停止。'))
    expect(codex.requests('turn/interrupt')).toHaveLength(1)
    // The image is still taken once it arrives, and waits for the next prompt as usual.
    release()
    await s.imagesSaved(1)
    await channel.sentUntil(() => channel.texts().includes(receivedImage))
    expect(channel.texts()).toEqual(['已收到，Codex 开始处理。', '已停止。', receivedImage])
  })

  it('answers approvals at once, typed or tapped, while an image sent before them is still being fetched', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    let release!: () => void
    channel.images.set('slow', { ok: true, bytes: pngBytes })
    channel.gates.set('slow', new Promise<void>((resolve) => { release = resolve }))
    const codex = await prompted(s, channel)
    const first = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    channel.handlers?.onInbound(imageMessage(alice, ['slow']))
    await channel.fetchedUntil(1)
    expect(channel.fetched).toEqual(['slow'])
    channel.handlers?.onInbound(text(alice, '同意 1'))
    await channel.sentUntil(() => channel.texts().includes('已同意第 1 条。'))
    expect((await first).result).toEqual({ decision: 'accept' })

    const second = codex.ask('item/fileChange/requestApproval', { threadId: 'th-1', turnId: 'tu-1', itemId: 'i2', startedAtMs: 0 })
    await approvalCardsSent(channel, 2)
    channel.handlers?.onInbound(cardClick(alice, approvalsSent(channel)[1], 'decline'))
    await vi.waitFor(() => expect(channel.texts()).toContain('已拒绝第 2 条。'))
    expect((await second).result).toEqual({ decision: 'decline' })
    expect(storedImages(s.imageDirectory)).toEqual([])
    release()
    await s.imagesSaved(1)
    await channel.sentUntil(() => channel.texts().at(-1) === receivedImage)
  })

  it('keeps a prompt behind the images sent before it, and 「停止」 behind that prompt', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    let release!: () => void
    channel.images.set('slow', { ok: true, bytes: pngBytes })
    channel.gates.set('slow', new Promise<void>((resolve) => { release = resolve }))
    channel.handlers?.onInbound(imageMessage(alice, ['slow']))
    await channel.fetchedUntil(1)
    expect(channel.fetched).toEqual(['slow'])
    channel.handlers?.onInbound(text(alice, '看看这张'))
    channel.handlers?.onInbound(text(alice, '停止'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 「停止」 is meant for 「看看这张」: answering it now would say there is nothing to stop.
    expect(channel.texts()).toEqual([])
    release()
    await s.imagesSaved(1)
    await channel.sentUntil(() => channel.texts().includes('已停止。'))
    expect(channel.texts()).toEqual([receivedImage, '已收到（含 1 张图片），Codex 开始处理。', '已停止。'])
  })

  it('puts an approval answer back in line when nothing is waiting for it by the time its turn comes', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    channel.images.set('first', { ok: true, bytes: pngBytes })
    channel.images.set('second', { ok: true, bytes: pngBytes })
    channel.gates.set('first', new Promise<void>((resolve) => { releaseFirst = resolve }))
    channel.gates.set('second', new Promise<void>((resolve) => { releaseSecond = resolve }))
    const codex = await prompted(s, channel)
    void codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    // Words sent with an image are not skipped: 「同意 1」 waits for this one, but not for the bare image after it.
    channel.handlers?.onInbound(imageMessage(alice, ['first'], '状态'))
    channel.handlers?.onInbound(imageMessage(alice, ['second']))
    channel.handlers?.onInbound(text(alice, '同意 1'))
    await s.service.stopTurnFromComputer()
    releaseFirst()
    await s.imagesSaved(1)
    await channel.sentUntil(() => channel.texts().at(-1)?.includes('当前状态：空闲') === true)
    // The approval is gone, so 「同意 1」 is now words for Codex: they go out only with the second image too.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(codex.requests('turn/start')).toHaveLength(1)
    releaseSecond()
    await s.imagesSaved(2)
    await channel.sentUntil(() => channel.texts().at(-1) === '已收到（含 2 张图片），Codex 开始处理。')
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
    const input = (codex.requests('turn/start')[1].params as { input: Array<Record<string, unknown>> }).input
    expect(input.map((entry) => entry.type)).toEqual(['text', 'localImage', 'localImage'])
  })
})

// YF-19（yoyo 2026-11-11「文件夹改」）：电脑上加几个工作文件夹，手机上发「文件夹」看、发「文件夹 2」换。
describe('codex-remote-service folders', () => {
  // 界面和手机上显示的路径按本机分隔符写（Windows 上是反斜杠）。
  function shown(name: string): string {
    return path.join('~', 'projects', name)
  }

  function folder(s: Setup, name: string): string {
    const directory = path.join(path.dirname(s.workspace), name)
    fs.mkdirSync(directory, { recursive: true })
    return directory
  }

  it('adds folders on the computer, switches between them and removes all but the one in use', async () => {
    const s = await setup()
    await s.service.addWorkspace(folder(s, 'blog'))
    let snapshot = await s.service.snapshot()
    expect(snapshot.workspaceDirectory).toBe(shown('demo'))
    expect(snapshot.workspaces).toEqual([shown('demo'), shown('blog')])
    // Adding the same folder again changes nothing.
    await s.service.addWorkspace(folder(s, 'blog'))
    expect((await s.service.snapshot()).workspaces).toEqual([shown('demo'), shown('blog')])
    snapshot = await s.service.useWorkspace(shown('blog'))
    expect(snapshot.workspaceDirectory).toBe(shown('blog'))
    await expect(s.service.removeWorkspace(shown('blog'))).rejects.toThrow('使用中的文件夹无法移除，请先切换至其他文件夹。')
    snapshot = await s.service.removeWorkspace(shown('demo'))
    expect(snapshot.workspaceDirectory).toBe(shown('blog'))
    expect(snapshot).not.toHaveProperty('workspaces')
    // Only folders on the list: the renderer cannot name another one.
    await expect(s.service.useWorkspace(shown('demo'))).rejects.toThrow('该文件夹已不在列表中。')
    await expect(s.service.useWorkspace('/etc')).rejects.toThrow('该文件夹已不在列表中。')
  })

  it('keeps at most five folders and still refuses a folder too broad to work in', async () => {
    // These are real folders, so the guard has to use this machine's path rules: under the
    // darwin rules a C:\ path is not absolute and the home folder would slip through.
    const s = await setup({ platform: process.platform })
    for (const name of ['b', 'c', 'd', 'e']) await s.service.addWorkspace(folder(s, name))
    expect((await s.service.snapshot()).workspaces).toHaveLength(5)
    await expect(s.service.addWorkspace(folder(s, 'f'))).rejects.toThrow('最多添加 5 个文件夹，请先移除一个再添加。')
    await s.service.removeWorkspace(shown('e'))
    await expect(s.service.addWorkspace(path.dirname(path.dirname(s.workspace)))).rejects.toThrow('无法用于手机遥控')
    expect((await s.service.snapshot()).workspaces).toHaveLength(4)
  })

  it('makes the first folder the one in use when none was chosen yet', async () => {
    const s = await setup({ workspace: false })
    const snapshot = await s.service.addWorkspace(s.workspace)
    expect(snapshot.workspaceDirectory).toBe(shown('demo'))
    expect(snapshot).not.toHaveProperty('workspaces')
  })

  it('lists and switches folders from the phone, starting a new conversation in the new one', async () => {
    const s = await setup()
    await s.service.addWorkspace(folder(s, 'blog'))
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '文件夹'))
    await channel.sentUntil(() => channel.texts().at(-1) === `1. ${shown('demo')}（使用中）\n2. ${shown('blog')}\n回复「文件夹 2」即可切换。`)
    channel.handlers?.onInbound(text(alice, '文件夹 1'))
    await channel.sentUntil(() => channel.texts().at(-1) === `当前已在使用 ${shown('demo')}。`)
    channel.handlers?.onInbound(text(alice, '文件夹 3'))
    await channel.sentUntil(() => channel.texts().at(-1) === '不存在第 3 个文件夹，请发送「文件夹」查看列表。')
    channel.handlers?.onInbound(text(alice, '文件夹 2'))
    await channel.sentUntil(() => channel.texts().at(-1) === `已切换至 ${shown('blog')}，将从新对话开始。`)
    expect((await s.service.snapshot()).workspaceDirectory).toBe(shown('blog'))
    expect(s.logs).toContain('remote.workspace-switched')
    channel.sent.length = 0
    const codex = await prompted(s, channel)
    expect(codex.requests('thread/start')[0]).toMatchObject({ params: { cwd: path.join(path.dirname(s.workspace), 'blog') } })
    // The phone already heard it starts afresh: no second warning.
    expect(channel.texts()[0]).toBe('已收到，Codex 开始处理。')
  })

  // M07：电脑上「用这个」写设置的那一会儿手机上发来一句。原来这一轮在旧文件夹开了对话，写完对话编号被清掉，
  // 这一轮结束的消息找不到人，卡在「正在处理」。
  it('starts a phone message that arrives while the computer is switching folders in the new folder, and finishes it', async () => {
    const s = await setup()
    const blog = folder(s, 'blog')
    await s.service.addWorkspace(blog)
    const channel = await enabledAndPaired(s)
    const update = s.store.updateSettings.bind(s.store)
    let reached!: () => void
    const atSwitchWrite = new Promise<void>((resolve) => { reached = resolve })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let messageSaved!: () => void
    const messageIdWritten = new Promise<void>((resolve) => { messageSaved = resolve })
    let calls = 0
    vi.spyOn(s.store, 'updateSettings').mockImplementation(async (mutate) => {
      calls += 1
      if (calls === 1) {
        reached()
        await held
        return update(mutate)
      }
      const saved = await update(mutate)
      messageSaved()
      return saved
    })
    const switching = s.service.useWorkspace(shown('blog'))
    await atSwitchWrite
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await messageIdWritten
    // Let the message go as far as it gets while the folder is still being switched.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    release()
    await switching
    const codex = await turnStarted(s, 1)
    expect(codex.requests('thread/start')[0]).toMatchObject({ params: { cwd: blog } })
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
  })

  // M18（11-18 手机遥控专项）：「文件夹 N」认手机上看到的那份单子，列过以后电脑上增删了也是他看到的那个。
  it('picks 「文件夹 N」 from the list the phone was shown, and asks to look again once that folder is gone', async () => {
    const s = await setup()
    await s.service.addWorkspace(folder(s, 'blog'))
    await s.service.addWorkspace(folder(s, 'shop'))
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '文件夹'))
    await channel.sentUntil(() => channel.texts().at(-1) === `1. ${shown('demo')}（使用中）\n2. ${shown('blog')}\n3. ${shown('shop')}\n回复「文件夹 2」即可切换。`)
    await s.service.removeWorkspace(shown('blog'))
    channel.handlers?.onInbound(text(alice, '文件夹 3'))
    await channel.sentUntil(() => channel.texts().at(-1) === `已切换至 ${shown('shop')}，将从新对话开始。`)
    channel.handlers?.onInbound(text(alice, '文件夹 2'))
    await channel.sentUntil(() => channel.texts().at(-1) === '电脑端的文件夹列表已变更，请发送「文件夹」重新查看。')
    expect((await s.service.snapshot()).workspaceDirectory).toBe(shown('shop'))
    channel.handlers?.onInbound(text(alice, '文件夹'))
    await channel.sentUntil(() => channel.texts().at(-1) === `1. ${shown('demo')}\n2. ${shown('shop')}（使用中）\n回复「文件夹 1」即可切换。`)
    channel.handlers?.onInbound(text(alice, '文件夹 1'))
    await channel.sentUntil(() => channel.texts().at(-1) === `已切换至 ${shown('demo')}，将从新对话开始。`)
  })

  // M06（11-18 手机遥控专项）：换了文件夹跟「新对话」一样扔掉攒着没用的图，上一句也不在新文件夹里「重试」。
  it('leaves waiting images and the last prompt behind when the folder changes, on the phone or the computer', async () => {
    const s = await setup({ images: true })
    await s.service.addWorkspace(folder(s, 'blog'))
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.images.set('img-b', { ok: true, bytes: pngBytes })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a']))
    const codex = await prompted(s, channel, '看看这张')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    channel.handlers?.onInbound(imageMessage(alice, ['img-b']))
    await s.imagesSaved(2)

    channel.handlers?.onInbound(text(alice, '文件夹 2'))
    await channel.sentUntil(() => channel.texts().at(-1) === `已切换至 ${shown('blog')}，将从新对话开始。\n此前发送、尚未使用的图片已清除，如需使用请重新发送。`)
    await s.imagesRemoved(2)
    expect(storedImages(s.imageDirectory)).toEqual([])
    channel.handlers?.onInbound(text(alice, '重试'))
    await channel.sentUntil(() => channel.texts().at(-1) === '文件夹已切换，上一条消息不会在新文件夹中重新执行，如需执行请重新发送。')
    expect(codex.requests('turn/start')).toHaveLength(1)

    // A new prompt in the new folder can be retried again; switching back on the computer leaves it behind too.
    channel.handlers?.onInbound(text(alice, '接着做'))
    await codex.requestedUntil('turn/start', 2)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    await s.service.useWorkspace(shown('demo'))
    channel.handlers?.onInbound(text(alice, '重试'))
    await channel.sentUntil(() => channel.texts().at(-1) === '文件夹已切换，上一条消息不会在新文件夹中重新执行，如需执行请重新发送。')
    expect(codex.requests('turn/start')).toHaveLength(2)
  })

  it('does not switch folders while a turn is still going, and says so when the folder is gone', async () => {
    const s = await setup()
    const blog = folder(s, 'blog')
    await s.service.addWorkspace(blog)
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    channel.handlers?.onInbound(text(alice, '文件夹 2'))
    await channel.sentUntil(() => channel.texts().at(-1) === 'Codex 正在处理上一条消息，请待其完成后再切换文件夹。')
    await expect(s.service.useWorkspace(shown('blog'))).rejects.toThrow('Codex 正在处理手机发来的任务，请待其完成后再切换文件夹。')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    fs.rmSync(blog, { recursive: true })
    channel.handlers?.onInbound(text(alice, '文件夹 2'))
    await channel.sentUntil(() => channel.texts().at(-1) === `${shown('blog')} 当前无法打开，可能已被移动或删除，请在电脑端检查。`)
    expect((await s.service.snapshot()).workspaceDirectory).toBe(shown('demo'))
  })
})

describe('codex-remote-service answered approval cards', () => {
  async function cardSetup(): Promise<{ s: Setup; channel: FakeApprovalCardChannel; codex: FakeCodex }> {
    const s = await setup({ approvalCards: true })
    const channel = await enabledAndPaired(s)
    if (!(channel instanceof FakeApprovalCardChannel)) throw new Error('expected a channel with approval cards')
    const codex = await prompted(s, channel)
    return { s, channel, codex }
  }

  it('marks a card as agreed or declined once answered on the card or by text, keeping only the body', async () => {
    const { channel, codex } = await cardSetup()
    const first = codex.ask('item/commandExecution/requestApproval', commandRequest)
    const [request] = await approvalCardsSent(channel, 1)
    channel.handlers?.onInbound(cardClick(alice, request, 'accept'))
    expect((await first).result).toEqual({ decision: 'accept' })
    await vi.waitFor(() => expect(channel.approvalUpdates).toHaveLength(1))
    const [update] = channel.approvalUpdates
    expect(update).toMatchObject({ handle: 'om_approval_1', outcome: 'accepted', message: { kind: 'approval', request: { approvalId: '1' } } })
    expect(update.message.text).toContain('npm test')
    expect(update.message.text).not.toContain('请回复「同意')
    await vi.waitFor(() => expect(channel.texts()).toContain('已同意第 1 条。'))

    const second = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, itemId: 'i2' })
    await approvalCardsSent(channel, 2)
    channel.handlers?.onInbound(text(alice, '拒绝 2'))
    expect((await second).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.approvalUpdates).toHaveLength(2))
    expect(channel.approvalUpdates[1]).toMatchObject({ handle: 'om_approval_2', outcome: 'declined' })
    await vi.waitFor(() => expect(channel.texts()).toContain('已拒绝第 2 条。'))
  })

  it('marks a card as declined by itself after ten minutes without an answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { channel, codex } = await cardSetup()
    // Codex asks a moment after the turn started, as it really does. Asked on the very tick the turn started, the
    // ten-minute deadline would fall on the same tick as the second five-minute progress line, which then follows it.
    await vi.advanceTimersByTimeAsync(1_000)
    const answer = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect((await answer).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.approvalUpdates.map((entry) => entry.outcome)).toEqual(['expired']))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('第 1 条在 10 分钟内未获回复，已自动拒绝。'))
  })

  it('marks cards as declined when declined from the computer or swept up by 「停止」', async () => {
    const { s, channel, codex } = await cardSetup()
    const first = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    await s.service.declineApprovalsFromComputer()
    expect((await first).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.approvalUpdates.map((entry) => entry.outcome)).toEqual(['declined']))

    const second = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, itemId: 'i2' })
    await approvalCardsSent(channel, 2)
    channel.handlers?.onInbound(text(alice, '停止'))
    expect((await second).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.approvalUpdates).toHaveLength(2))
    expect(channel.approvalUpdates[1]).toMatchObject({ handle: 'om_approval_2', outcome: 'declined' })
  })

  it('still answers and says so in text when the card cannot be changed', async () => {
    const { s, channel, codex } = await cardSetup()
    channel.failUpdates = true
    const answer = codex.ask('item/commandExecution/requestApproval', commandRequest)
    const [request] = await approvalCardsSent(channel, 1)
    channel.handlers?.onInbound(cardClick(alice, request, 'accept'))
    expect((await answer).result).toEqual({ decision: 'accept' })
    await vi.waitFor(() => expect(s.logs).toContain('remote.approval-card-update-failed'))
    await vi.waitFor(() => expect(channel.texts()).toContain('已同意第 1 条。'))
  })
})

// YF-15（yoyo 2026-11-11「进度改」）：长任务中途给进度。飞书一张原地更新的卡，微信每满 5 分钟一句。
describe('codex-remote-service progress', () => {
  const twoSteps = [{ step: '读登录页的代码', status: 'inProgress' }, { step: '改登录页', status: 'pending' }]

  it('shows a progress card once Codex reports its plan, updates it at most every thirty seconds and leaves it as done', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = Date.UTC(2026, 10, 11, 12)
    const s = await setup({ now: () => clock, progressCards: true })
    const channel = await enabledAndPaired(s) as FakeCardChannel
    const codex = await prompted(s, channel)
    expect(channel.progress).toHaveLength(0)
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', plan: twoSteps })
    await vi.waitFor(() => expect(channel.progress).toHaveLength(1))
    expect(channel.progress[0]).toMatchObject({
      op: 'send',
      card: { state: 'running', steps: [{ text: '读登录页的代码', status: 'inProgress' }, { text: '改登录页', status: 'pending' }], elapsed: '已用时不到 1 分钟' },
    })
    expect(channel.progress[0].card.stopNonce).toMatch(/^[A-Za-z0-9_-]{16}$/)
    // The same plan sent again changes nothing on the card.
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', plan: twoSteps })
    clock += 10_000
    await vi.advanceTimersByTimeAsync(10_000)
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', plan: [{ step: '读登录页的代码', status: 'completed' }, { step: '改登录页', status: 'inProgress' }] })
    clock += 19_000
    await vi.advanceTimersByTimeAsync(19_000)
    expect(channel.progress).toHaveLength(1)
    clock += 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(channel.progress).toHaveLength(2))
    expect(channel.progress[1]).toMatchObject({ op: 'update', handle: 'om_card_1', card: { state: 'running', steps: [{ status: 'completed' }, { status: 'inProgress' }] } })
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(() => expect(channel.progress.at(-1)?.card.state).toBe('done'))
    expect(channel.progress.at(-1)).toMatchObject({ op: 'update', handle: 'om_card_1', card: { steps: [{ status: 'completed' }, { status: 'inProgress' }] } })
    expect(channel.progress.at(-1)?.card).not.toHaveProperty('stopNonce')
    expect(channel.progress.at(-1)?.card).not.toHaveProperty('elapsed')
    // Nothing more once the turn is over.
    const count = channel.progress.length
    clock += 10 * 60_000
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(channel.progress).toHaveLength(count)
  })

  // M17：最后那次把卡改成「已完成」没成，原来只记日志，卡一直停在「正在处理」、还带着「停止」。
  it('tries the last card update again a little later instead of leaving the card running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup({ now: () => Date.UTC(2026, 10, 11, 12), progressCards: true })
    const channel = await enabledAndPaired(s) as FakeCardChannel
    const codex = await prompted(s, channel)
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', plan: twoSteps })
    await vi.waitFor(() => expect(channel.progress).toHaveLength(1))
    channel.failUpdates = 1
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(() => expect(s.logs).toContain('remote.progress-final-retry'))
    expect(channel.progress.at(-1)?.card.state).toBe('running')
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(channel.progress.at(-1)).toMatchObject({ op: 'update', handle: 'om_card_1', card: { state: 'done' } }))
    expect(channel.progress.at(-1)?.card).not.toHaveProperty('stopNonce')
    expect(s.logs).not.toContain('remote.progress-failed')
  })

  it('gives the last card update up after three tries, and stops trying once the channel is turned off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup({ now: () => Date.UTC(2026, 10, 11, 12), progressCards: true })
    const channel = await enabledAndPaired(s) as FakeCardChannel
    const codex = await prompted(s, channel)
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', plan: twoSteps })
    await vi.waitFor(() => expect(channel.progress).toHaveLength(1))
    channel.failUpdates = Number.POSITIVE_INFINITY
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(() => expect(channel.updateAttempts).toBe(1))
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(channel.updateAttempts).toBe(2))
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(s.logs).toContain('remote.progress-failed'))
    expect(channel.updateAttempts).toBe(3)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(channel.updateAttempts).toBe(3)

    // Next turn: the channel is switched off while the last update waits to be tried again.
    channel.handlers?.onInbound(text(alice, '再做一件'))
    await turnStarted(s, 2)
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-2', plan: twoSteps })
    await vi.waitFor(() => expect(channel.progress.filter((entry) => entry.op === 'send')).toHaveLength(2))
    const attempts = channel.updateAttempts
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'completed' } })
    await vi.waitFor(() => expect(channel.updateAttempts).toBe(attempts + 1))
    await s.service.setChannelEnabled('feishu', false)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(channel.updateAttempts).toBe(attempts + 1)
  })

  it('posts the card after two minutes without a plan and refreshes the time every five minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = Date.UTC(2026, 10, 11, 12)
    const s = await setup({ now: () => clock, progressCards: true })
    const channel = await enabledAndPaired(s) as FakeCardChannel
    await prompted(s, channel)
    clock += 119_000
    await vi.advanceTimersByTimeAsync(119_000)
    expect(channel.progress).toHaveLength(0)
    clock += 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(channel.progress).toHaveLength(1))
    expect(channel.progress[0]).toMatchObject({ op: 'send', card: { state: 'running', steps: [], elapsed: '已用时 2 分钟' } })
    clock += 5 * 60_000
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(channel.progress).toHaveLength(2))
    expect(channel.progress[1]).toMatchObject({ op: 'update', card: { elapsed: '已用时 7 分钟' } })
    // The card goes out after 「收到」 in the same queue as the text messages.
    expect(channel.texts()[0]).toContain('收到')
  })

  it('stops the turn from this turn\'s card like 「停止」, and leaves the turn alone for a card from an earlier turn', async () => {
    const s = await setup({ progressCards: true })
    const channel = await enabledAndPaired(s) as FakeCardChannel
    const codex = await prompted(s, channel)
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', plan: twoSteps })
    await vi.waitFor(() => expect(channel.progress).toHaveLength(1))
    const nonce = channel.progress[0].card.stopNonce ?? ''
    channel.handlers?.onInbound({ kind: 'stop', peer: alice, direct: true, nonce: 'an-earlier-turn-1' })
    await vi.waitFor(() => expect(channel.texts()).toContain('此卡片属于上一轮，当前任务未停止。如需停止，请发送「停止」。'))
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
    // Someone else pressing a card the bot sent is not the bound person.
    channel.handlers?.onInbound({ kind: 'stop', peer: mallory, direct: true, nonce })
    channel.handlers?.onInbound({ kind: 'stop', peer: alice, direct: true, nonce })
    await vi.waitFor(() => expect(channel.texts()).toContain('已停止。'))
    expect(codex.requests('turn/interrupt')).toHaveLength(1)
    await vi.waitFor(() => expect(channel.progress.at(-1)?.card.state).toBe('stopped'))
    expect(s.logs).toContain('remote.turn-stopped-from-card')
    channel.handlers?.onInbound({ kind: 'stop', peer: alice, direct: true, nonce })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('当前没有正在处理的任务。'))
  })

  it('says it is still working every five minutes on a channel without cards, and keeps quiet while waiting for approval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = Date.UTC(2026, 10, 11, 12)
    const s = await setup({ now: () => clock })
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    clock += 5 * 60_000
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('仍在处理，已用时 5 分钟。'))
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', plan: [{ step: '读登录页的代码', status: 'completed' }, { step: '改登录页', status: 'inProgress' }] })
    clock += 5 * 60_000
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('仍在处理，已用时 10 分钟。当前步骤：改登录页'))
    void codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    const sent = channel.sent.length
    clock += 5 * 60_000
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(channel.texts().slice(sent).filter((line) => line.startsWith('仍在处理'))).toHaveLength(0)
  })
})

describe('codex-remote-service approvals', () => {
  it('asks the bound person and answers Codex with plain accept or decline', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const answer = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    const approval = channel.sent.find((entry) => entry.message.kind === 'approval')?.message
    expect(approval).toMatchObject({ kind: 'approval', request: { approvalId: '1', kind: 'command', summary: 'npm test' } })
    expect(approvalsSent(channel)[0].nonce).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect((await s.service.snapshot()).task).toBe('waiting-approval')
    channel.handlers?.onInbound(text(alice, '同意'))
    expect((await answer).result).toEqual({ decision: 'accept' })
    await vi.waitFor(() => expect(channel.texts()).toContain('已同意第 1 条。'))

    const second = codex.ask('item/fileChange/requestApproval', { threadId: 'th-1', turnId: 'tu-1', itemId: 'i2', startedAtMs: 0 })
    await approvalCardsSent(channel, 2)
    channel.handlers?.onInbound(cardClick(alice, approvalsSent(channel)[1], 'decline'))
    expect((await second).result).toEqual({ decision: 'decline' })
  })

  it('takes a card click only with the nonce of the request that card was sent for', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const answer = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    const request = approvalsSent(channel)[0]
    channel.handlers?.onInbound(cardClick(alice, { approvalId: request.approvalId, nonce: generateApprovalNonce() }, 'accept'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(staleCardText))
    channel.handlers?.onInbound(cardClick(alice, { approvalId: request.approvalId, nonce: null }, 'accept'))
    await vi.waitFor(() => expect(channel.texts().filter((line) => line === staleCardText)).toHaveLength(2))
    expect((await s.service.snapshot()).pendingApprovals).toBe(1)
    channel.handlers?.onInbound(cardClick(alice, request, 'accept'))
    expect((await answer).result).toEqual({ decision: 'accept' })
    await vi.waitFor(() => expect(channel.texts()).toContain('已同意第 1 条。'))
    // Pressing the same card again after it was answered changes nothing.
    channel.handlers?.onInbound(cardClick(alice, request, 'decline'))
    await vi.waitFor(() => expect(channel.texts().filter((line) => line === staleCardText)).toHaveLength(3))
    expect(s.logs).toContain('remote.approval-card-stale')
  })

  it('keeps counting after a restart so an old card or an old number answers nothing new', async () => {
    const root = tempRoot()
    const before = await setup({ root })
    const beforeChannel = await enabledAndPaired(before)
    const beforeCodex = await prompted(before, beforeChannel)
    void beforeCodex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(beforeChannel, 1)
    const oldCard = approvalsSent(beforeChannel)[0]
    expect(oldCard.approvalId).toBe('1')
    before.service.dispose()

    // The same person is still bound after the restart; the switch has to be turned on again.
    const after = await setup({ root })
    await after.service.setChannelEnabled('feishu', true)
    const channel = after.channels[0]
    const codex = await prompted(after, channel)
    const answer = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, command: 'rm -rf build' })
    await approvalCardsSent(channel, 1)
    const fresh = approvalsSent(channel)[0]
    expect(fresh.approvalId).toBe('2')
    expect(fresh.nonce).not.toBe(oldCard.nonce)
    channel.handlers?.onInbound(cardClick(alice, oldCard, 'accept'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(staleCardText))
    channel.handlers?.onInbound(text(alice, '同意 1'))
    await channel.sentUntil(() => channel.texts().at(-1) === '不存在第 1 条待确认的操作。')
    expect((await after.service.snapshot()).pendingApprovals).toBe(1)
    channel.handlers?.onInbound(text(alice, '拒绝 2'))
    expect((await answer).result).toEqual({ decision: 'decline' })
    expect((await after.store.readSettings()).lastApprovalNumber).toBe(2)
  })

  it('refuses an old card even when its number comes round again', async () => {
    const first = await setup()
    const firstChannel = await enabledAndPaired(first)
    const firstCodex = await prompted(first, firstChannel)
    void firstCodex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(firstChannel, 1)
    const oldCard = approvalsSent(firstChannel)[0]
    first.service.dispose()

    // Lost settings (or a counter that wrapped) hand out number 1 again.
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const answer = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, command: 'rm -rf build' })
    await approvalCardsSent(channel, 1)
    expect(approvalsSent(channel)[0].approvalId).toBe(oldCard.approvalId)
    channel.handlers?.onInbound(cardClick(alice, oldCard, 'accept'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(staleCardText))
    expect((await s.service.snapshot()).pendingApprovals).toBe(1)
    channel.handlers?.onInbound(text(alice, '停止'))
    expect((await answer).result).toEqual({ decision: 'decline' })
  })

  it('asks which one when several are waiting and rejects unknown numbers', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const first = codex.ask('item/commandExecution/requestApproval', commandRequest, 'a')
    const second = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, itemId: 'i2' }, 'b')
    await approvalCardsSent(channel, 2)
    channel.handlers?.onInbound(text(alice, '同意'))
    await channel.sentUntil(() => channel.texts().at(-1)?.includes('当前有 2 条待确认（1、2）') === true)
    channel.handlers?.onInbound(text(alice, '同意 9'))
    await channel.sentUntil(() => channel.texts().at(-1) === '不存在第 9 条待确认的操作。')
    channel.handlers?.onInbound(text(alice, '拒绝 2'))
    channel.handlers?.onInbound(text(alice, '同意 1'))
    expect((await first).result).toEqual({ decision: 'accept' })
    expect((await second).result).toEqual({ decision: 'decline' })
  })

  it('ignores approvals from anyone but the bound person', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const answer = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    const request = approvalsSent(channel)[0]
    channel.handlers?.onInbound(cardClick(mallory, request, 'accept'))
    channel.handlers?.onInbound(text(mallory, '同意 1'))
    channel.handlers?.onInbound(cardClick(alice, request, 'accept', false))
    channel.handlers?.onInbound(text(alice, '停止'))
    expect((await answer).result).toEqual({ decision: 'decline' })
  })

  it('declines by itself after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    // Codex asks a moment after the turn started, as it really does. Asked on the very tick the turn started, the
    // ten-minute deadline would fall on the same tick as the second five-minute progress line, which then follows it.
    await vi.advanceTimersByTimeAsync(1_000)
    const answer = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect((await answer).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('第 1 条在 10 分钟内未获回复，已自动拒绝。'))
  })

  // YF-20：还剩 3 分钟时提醒一次，人在路上没看到也还来得及回；回过了就不再提醒。
  it('reminds once with three minutes left, and not at all once answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    // Codex asks a moment after the turn started, as it really does. Asked on the very tick the turn started, the
    // ten-minute deadline would fall on the same tick as the second five-minute progress line, which then follows it.
    await vi.advanceTimersByTimeAsync(1_000)
    const reminder = '第 1 条仍在等待您的确认，将于 3 分钟后自动拒绝。请回复「同意 1」或「拒绝 1」。'
    const first = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    await vi.advanceTimersByTimeAsync(7 * 60_000 - 1_000)
    expect(channel.texts()).not.toContain(reminder)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(reminder))
    expect(s.logs).toContain('remote.approval-reminded')
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect((await first).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('第 1 条在 10 分钟内未获回复，已自动拒绝。'))
    expect(channel.texts().filter((line) => line === reminder)).toHaveLength(1)

    const second = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, itemId: 'i2' })
    await approvalCardsSent(channel, 2)
    channel.handlers?.onInbound(text(alice, '同意'))
    expect((await second).result).toEqual({ decision: 'accept' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(channel.texts().some((line) => line.startsWith('第 2 条还在等你'))).toBe(false)
  })

  it('declines a command the card would cut short without asking, says why, and spends no approval number', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    // The dangerous part sits past what the card can show.
    const long = `${'echo ok && '.repeat(150)}rm -rf ~/important`
    expect((await codex.ask('item/commandExecution/requestApproval', { ...commandRequest, command: long })).result)
      .toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.texts()).toContain(commandRefusedText))
    expect(s.logs).toContain('remote.command-refused')
    // Typing into a running program is held to the same rule.
    const input = { ...commandRequest, itemId: 'i2', kind: 'writeStdin', command: `write_stdin --session-id 3 ${'y'.repeat(1600)}` }
    expect((await codex.ask('item/commandExecution/requestApproval', input)).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.texts().filter((line) => line === commandRefusedText)).toHaveLength(2))
    // A command Codex left blank is declined too; there is nothing to explain on the phone.
    expect((await codex.ask('item/commandExecution/requestApproval', { ...commandRequest, itemId: 'i3', command: null })).result)
      .toEqual({ decision: 'decline' })
    expect(approvalsSent(channel)).toHaveLength(0)
    const next = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, itemId: 'i4' })
    await approvalCardsSent(channel, 1)
    expect(approvalsSent(channel)[0].approvalId).toBe('1')
    expect(channel.texts().filter((line) => line === commandRefusedText)).toHaveLength(2)
    channel.handlers?.onInbound(text(alice, '拒绝'))
    expect((await next).result).toEqual({ decision: 'decline' })
  })

  it('keeps the write scope on a file change card and declines one whose write scope cannot fit', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const files = Array.from({ length: 25 }, (_, index) => `/Volumes/Work/customer-portal/frontend/src/components/orders/details/panel-${String(index).padStart(2, '0')}.tsx`)
    codex.notify('item/started', {
      threadId: 'th-1',
      turnId: 'tu-1',
      item: { type: 'fileChange', id: 'f1', changes: files.map((file) => ({ path: file, kind: { type: 'update' }, diff: '' })) },
    })
    const fileChange = { threadId: 'th-1', turnId: 'tu-1', itemId: 'f1', startedAtMs: 0 }
    expect((await codex.ask('item/fileChange/requestApproval', { ...fileChange, grantRoot: `/${'deep/'.repeat(300)}` })).result)
      .toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.texts()).toContain(permissionsRefusedText))
    expect(s.logs).toContain('remote.file-change-refused')
    expect(approvalsSent(channel)).toHaveLength(0)
    const asked = codex.ask('item/fileChange/requestApproval', { ...fileChange, grantRoot: '/Volumes/Work/customer-portal' })
    await approvalCardsSent(channel, 1)
    expect(approvalsSent(channel)[0]).toMatchObject({ approvalId: '1', kind: 'file-change' })
    const lines = approvalsSent(channel)[0].summary.split('\n')
    expect(lines[0]).toBe(`修改 ${files[0]} +0 -0 行`)
    expect(lines.slice(-2)).toEqual(['另有 10 个文件', '可写范围：/Volumes/Work/customer-portal'])
    channel.handlers?.onInbound(text(alice, '拒绝'))
    expect((await asked).result).toEqual({ decision: 'decline' })
  })

  it('titles a website request and typing into a running program for what they are', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const site = codex.ask('item/commandExecution/requestApproval', {
      ...commandRequest,
      command: null,
      cwd: null,
      reason: '要下载依赖',
      networkApprovalContext: npmRegistry,
    }, 'a')
    await approvalCardsSent(channel, 1)
    expect(approvalsSent(channel)[0]).toMatchObject({ kind: 'network', summary: 'registry.npmjs.org' })
    expect(channel.texts()).toContain('[approval] Codex 请求访问网站（第 1 条）：\nCodex 说明：要下载依赖\nregistry.npmjs.org\n请回复「同意 1」或「拒绝 1」。')
    channel.handlers?.onInbound(text(alice, '同意'))
    expect((await site).result).toEqual({ decision: 'accept' })

    const input = codex.ask('item/commandExecution/requestApproval', {
      ...commandRequest,
      itemId: 'i2',
      kind: 'writeStdin',
      command: 'write_stdin --session-id 3 yes',
    }, 'b')
    await approvalCardsSent(channel, 2)
    expect(approvalsSent(channel)[1]).toMatchObject({ kind: 'terminal-input', summary: 'write_stdin --session-id 3 yes' })
    expect(channel.texts().some((line) => line.startsWith('[approval] Codex 请求向运行中的程序输入内容（第 2 条）：\n') && line.includes('\nwrite_stdin --session-id 3 yes\n请回复「同意 2」'))).toBe(true)
    channel.handlers?.onInbound(text(alice, '拒绝'))
    expect((await input).result).toEqual({ decision: 'decline' })
  })

  it('declines approvals for threads it did not start and grants nothing by default', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect((await codex.ask('item/commandExecution/requestApproval', { ...commandRequest, threadId: 'other' })).result)
      .toEqual({ decision: 'decline' })
    expect((await codex.ask('item/tool/requestUserInput', { threadId: 'th-1', questions: [] })).result).toEqual({ answers: {} })
    expect((await codex.ask('mcpServer/elicitation/request', {})).result).toMatchObject({ action: 'decline' })
    expect((await codex.ask('account/chatgptAuthTokens/refresh', {})).error).toMatchObject({ code: -32601 })
    const permissions = codex.ask('item/permissions/requestApproval', {
      threadId: 'th-1', turnId: 'tu-1', itemId: 'p', cwd: '/tmp', reason: null, startedAtMs: 0, environmentId: null,
      permissions: { network: { enabled: true }, fileSystem: null },
    })
    await approvalCardsSent(channel, 1)
    expect(channel.texts().at(-1)).toContain('联网')
    channel.handlers?.onInbound(text(alice, '拒绝'))
    expect((await permissions).result).toEqual({ permissions: {}, scope: 'turn' })
  })
})

describe('codex-remote-service permission approvals', () => {
  function permissionRequest(permissions: unknown): Record<string, unknown> {
    return { threadId: 'th-1', turnId: 'tu-1', itemId: 'p', cwd: '/tmp', reason: '要写结果', startedAtMs: 0, environmentId: null, permissions }
  }

  it('declines a request the phone cannot show without asking, says why, and spends no approval number', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect((await codex.ask('item/permissions/requestApproval', permissionRequest(wholeDiskWrite))).result)
      .toEqual({ permissions: {}, scope: 'turn' })
    await vi.waitFor(() => expect(channel.texts()).toContain(permissionsRefusedText))
    expect(approvalsSent(channel)).toHaveLength(0)
    expect(s.logs).toContain('remote.permissions-refused')
    const next = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    expect(approvalsSent(channel)[0].approvalId).toBe('1')
    channel.handlers?.onInbound(text(alice, '拒绝'))
    expect((await next).result).toEqual({ decision: 'decline' })
  })

  it('grants only the paths the card listed, not the entries Codex sent alongside', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const out = path.join(s.workspace, 'out')
    const answer = codex.ask('item/permissions/requestApproval', permissionRequest(codexPermissions(null, [out], true)))
    await approvalCardsSent(channel, 1)
    // The workspace is a real folder here, so its separators are this machine's.
    expect(approvalsSent(channel)[0]).toMatchObject({ kind: 'other', summary: `联网\n写：${path.join('~', 'projects', 'demo', 'out')}` })
    channel.handlers?.onInbound(text(alice, '同意'))
    expect((await answer).result).toEqual({
      permissions: { network: { enabled: true }, fileSystem: { read: null, write: [out] } },
      scope: 'turn',
    })
  })
})

// M14：电脑上关了遥控，手机上收到「已关闭」以后不能再冒出别的消息；道别那句不排在它们后面；关了马上再开也不等它们。
describe('codex-remote-service closing while messages are still waiting to go out', () => {
  const closed = '手机遥控已在电脑上关闭。'

  /**
   * 手机上发「状态」，那句回复卡在发的半路（第一道闸）；Codex 这时做完了，回答排在它后面。交回放行那道闸的函数。
   */
  async function answerQueuedBehindStatus(s: Setup, channel: FakeChannel): Promise<() => void> {
    const codex = await prompted(s, channel)
    await channel.sentUntil(() => channel.texts().includes('已收到，Codex 开始处理。'))
    channel.sent.length = 0
    let release!: () => void
    channel.holds.push(new Promise((resolve) => { release = resolve }))
    channel.handlers?.onInbound(text(alice, '状态'))
    await vi.waitFor(() => expect(channel.holds).toHaveLength(0))
    codex.notify('item/completed', { threadId: 'th-1', turnId: 'tu-1', item: { type: 'agentMessage', id: 'a1', text: '测试都过了。', phase: 'final_answer' } })
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    expect((await s.service.snapshot()).lastRequest?.state).toBe('done')
    // 回答交进发件队前要先等一下密钥（refreshSecrets），让它排进去。
    await new Promise((resolve) => setTimeout(resolve, 10))
    return release
  }

  it('drops what was still queued, and says goodbye without waiting behind the message being sent', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const release = await answerQueuedBehindStatus(s, channel)
    await s.service.setChannelEnabled('feishu', false)
    // 道别没等卡住的那条：关的时候它已经发出去了。
    expect(channel.texts()).toEqual([closed])
    release()
    await statusReplied(channel)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(channel.texts().some((line) => line.startsWith('测试都过了。'))).toBe(false)
    expect(s.logs).toContain('remote.send-dropped')
  })

  it('tells the connection to give up on retries before saying goodbye, and again before stopping it', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    channel.events.length = 0
    await s.service.setChannelEnabled('feishu', false)
    expect(channel.events).toEqual(['cancel', `send:${closed}`, 'cancel', 'stop'])
  })

  it('opens again right away after closing, and never sends what was left from before', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const release = await answerQueuedBehindStatus(s, channel)
    await s.service.setChannelEnabled('feishu', false)
    await s.service.setChannelEnabled('feishu', true)
    const reopened = s.channels[1]
    // 新的这份连接不排在旧的那条卡住的后面。
    await reopened.sentUntil(() => reopened.texts().some((line) => line.startsWith('电脑端已开启手机遥控')))
    release()
    await statusReplied(channel)
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const each of [channel, reopened]) {
      expect(each.texts().some((line) => line.startsWith('测试都过了。'))).toBe(false)
    }
  })

  it('leaves the connection opened again while saying goodbye alone, and only stops the old one', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    let release!: () => void
    channel.holds.push(new Promise((resolve) => { release = resolve }))
    const closing = s.service.setChannelEnabled('feishu', false)
    await vi.waitFor(() => expect(channel.holds).toHaveLength(0))
    await s.service.setChannelEnabled('feishu', true)
    const reopened = s.channels[1]
    release()
    await closing
    expect(channel.stopped).toBe(1)
    expect(reopened.stopped).toBe(0)
    const snapshot = await s.service.snapshot()
    expect(snapshot.channels.feishu.enabled).toBe(true)
    expect(snapshot.channels.feishu.status.state).toBe('connected')
  })
})

describe('codex-remote-service lifecycle', () => {
  it('says goodbye and stops everything when switched off on the computer', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    await s.service.setChannelEnabled('feishu', false)
    expect(channel.texts()).toContain('手机遥控已在电脑上关闭。')
    expect(channel.stopped).toBe(1)
    expect(codex.kills).toContain('SIGTERM')
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(false)
  })

  // 托盘里那一项「关掉手机遥控」（#1407 P2-1）：开着的渠道一起关，手机上收到的跟在设置里点关一样。
  it('switches every open channel off at once from the tray and tells the bound person', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await s.store.writeCredential('weixin', 'weixin-credential-value')
    await s.service.setChannelEnabled('weixin', true)
    const weixin = s.channels[1]
    const codex = await prompted(s, channel)
    expect(s.service.hasEnabledChannel()).toBe(true)

    const snapshot = await s.service.disableAllChannels()
    expect(channel.texts()).toContain('手机遥控已在电脑上关闭。')
    expect(channel.stopped).toBe(1)
    expect(weixin.stopped).toBe(1)
    expect(codex.kills).toContain('SIGTERM')
    expect(snapshot).toMatchObject({ channels: { feishu: { enabled: false }, weixin: { enabled: false } } })
    expect(s.snapshots).toContain(snapshot)
    expect(s.service.hasEnabledChannel()).toBe(false)

    // 再点一次（菜单还没跟上）不重复道别、不再停一遍。
    await s.service.disableAllChannels()
    expect(channel.texts().filter((line) => line === '手机遥控已在电脑上关闭。')).toHaveLength(1)
    expect(channel.stopped).toBe(1)
    s.service.dispose()
    expect(await s.service.disableAllChannels()).toBeNull()
  })

  // YF-17：手机上发「关闭遥控」，开着的渠道一起关，跟托盘那一项一样；那句话换成「已关闭」，要再开只能回电脑。
  it('switches every open channel off when the paired person sends the close command from the phone', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await s.store.writeCredential('weixin', 'weixin-credential-value')
    await s.service.setChannelEnabled('weixin', true)
    const weixin = s.channels[1]
    const codex = await prompted(s, channel)
    channel.sent.length = 0
    s.snapshots.length = 0

    channel.handlers?.onInbound(text(alice, '关闭遥控'))
    await s.stateUntil((snapshot) => !snapshot.channels.feishu.enabled && !snapshot.channels.weixin.enabled)
    expect(s.service.hasEnabledChannel()).toBe(false)
    expect(s.snapshots.at(-1)).toMatchObject({ channels: { feishu: { enabled: false }, weixin: { enabled: false } } })
    expect(channel.texts()).toEqual(['手机遥控已关闭。如需继续使用，请在电脑端的星芒中重新开启。'])
    expect(channel.sent[0].replyContext).toMatch(/^ctx-/)
    expect(channel.stopped).toBe(1)
    expect(weixin.stopped).toBe(1)
    expect(codex.kills).toContain('SIGTERM')
    expect(s.logDetails.find((entry) => entry.event === 'remote.closed-from-phone')?.detail).toEqual({ channel: 'feishu', autoStartCleared: false })
    // 关了以后再发什么都没人理，得回电脑上打开。
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.texts()).toHaveLength(1)
  })

  // YR-1：开了「打开星芒时自动打开遥控」（YF-9）的，手机上急停要管到下一次打开星芒，不然一重开就自己连回去。
  it('also turns off switching on at launch, so reopening Xingmang does not connect again', async () => {
    const root = tempRoot()
    const first = await setup({ root })
    const channel = await enabledAndPaired(first)
    await first.service.setAutoStart(true)
    first.snapshots.length = 0

    channel.handlers?.onInbound(text(alice, '关闭遥控'))
    // 先把关掉的开关原子写进盘才断渠道、发「已关闭」：直接等发送本身，不靠 vi.waitFor 的 1 秒（R16）。
    await channel.sentUntil(() => channel.texts().length > 0)
    expect(channel.texts()).toEqual(['手机遥控已关闭。如需继续使用，请在电脑端的星芒中重新开启。'])
    await vi.waitFor(() => expect(first.snapshots.at(-1)).toMatchObject({ channels: { feishu: { enabled: false } } }))
    // 卡片上的开关跟着显示关着，客户回到电脑前一看就明白。
    expect(first.snapshots.at(-1)).not.toHaveProperty('autoStart')
    expect((await first.store.readSettings()).autoStart).toBeUndefined()
    expect(first.logDetails.find((entry) => entry.event === 'remote.closed-from-phone')?.detail).toEqual({ channel: 'feishu', autoStartCleared: true })
    first.service.dispose()

    const reopened = await setup({ root })
    await reopened.service.startOnLaunch()
    expect(reopened.service.hasEnabledChannel()).toBe(false)
    expect(reopened.channels).toHaveLength(0)
    expect(reopened.logs).not.toContain('remote.auto-started')
    expect((await reopened.service.snapshot()).autoStart).toBeUndefined()
  })

  it('still switches every channel off when turning off switching on at launch cannot be saved', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await s.service.setAutoStart(true)
    // 只让清掉自动打开的那一次写失败，按写进去的内容认，不按第几次：处理这句之前还要先记下消息编号（YR-2），
    // 那一次写照常成功。按次数数（mockRejectedValueOnce）会被那一次吃掉，测的就不是这件事了。
    const realUpdateSettings = s.store.updateSettings.bind(s.store)
    vi.spyOn(s.store, 'updateSettings').mockImplementation(async (mutate) => {
      const probe = structuredClone(await s.store.readSettings())
      mutate(probe)
      if (!probe.autoStart) throw new Error('disk full')
      return realUpdateSettings(mutate)
    })

    channel.handlers?.onInbound(text(alice, '关闭遥控'))
    await channel.sentUntil(() => channel.texts().length > 0)
    expect(s.service.hasEnabledChannel()).toBe(false)
    await vi.waitFor(() => expect(channel.stopped).toBe(1))
    expect(channel.texts()).toEqual(['手机遥控已关闭。如需继续使用，请在电脑端的星芒中重新开启。'])
    expect(s.logs).not.toContain('remote.message-id-unsaved')
    expect((await s.store.readSettings()).autoStart).toBe(true)
    expect(s.logs).toContain('remote.auto-start-unsaved')
    expect(s.logDetails.find((entry) => entry.event === 'remote.closed-from-phone')?.detail).toEqual({ channel: 'feishu', autoStartCleared: false })
  })

  it('ignores the close command from anyone but the paired person, and from a group', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text({ channel: 'feishu', userId: 'ou_stranger_9999' }, '关闭遥控'))
    channel.handlers?.onInbound(text(alice, '关闭遥控', { direct: false }))
    channel.handlers?.onInbound(text(alice, '状态'))
    await channel.sentUntil(() => channel.texts().some((line) => line.startsWith('工作文件夹')))
    expect(s.service.hasEnabledChannel()).toBe(true)
    expect(channel.stopped).toBe(0)
    expect(channel.texts()).toHaveLength(1)
    expect(s.logs).not.toContain('remote.closed-from-phone')
  })

  // YF-11：电脑上打开、连上了给配对过的人说一声，手机上不用自己发一句试；断线重连不再说，没配对过的没人可说。
  it('tells the paired person once the remote is switched on and connected, with the folder, but not again on a reconnect', async () => {
    const s = await setup()
    await s.service.setChannelEnabled('feishu', true)
    expect(s.channels[0].sent).toHaveLength(0)
    const first = s.channels[0]
    await s.service.startPairing('feishu')
    first.handlers?.onInbound(text(alice, '000042'))
    await first.sentUntil(() => first.texts().some((line) => line.startsWith('配对成功')))
    expect(first.texts().some((line) => line.startsWith('电脑端已开启手机遥控'))).toBe(false)
    await s.service.setChannelEnabled('feishu', false)

    await s.service.setChannelEnabled('feishu', true)
    const second = s.channels[1]
    // The folder is real (path.join), so on Windows it reads ~\projects\demo.
    const opened = `电脑端已开启手机遥控，现在可以发送消息。工作文件夹：${path.join('~', 'projects', 'demo')}`
    await second.sentUntil(() => second.texts().includes(opened))
    expect(second.sent).toHaveLength(1)
    expect(second.sent[0].peer).toMatchObject({ channel: 'feishu', userId: alice.userId })
    expect(second.sent[0].replyContext).toBeUndefined()
    expect(s.logs).toContain('remote.opened-announced')
    second.handlers?.onStatus({ state: 'connecting', message: '网络断了，正在重连' })
    second.handlers?.onStatus({ state: 'connected' })
    second.handlers?.onInbound(text(alice, '状态'))
    await second.sentUntil(() => second.texts().some((line) => line.startsWith('工作文件夹')))
    expect(second.texts().filter((line) => line === opened)).toHaveLength(1)
  })

  // 状态文件关掉了手机遥控（G04）：开着的当场停，手机上收到的跟在电脑上点关一样。
  it('stops an open channel the moment the computer can no longer offer remote control, and only refreshes when it can', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    // Other work still emits on its own schedule (emitSoon), so count nothing: the refresh is the very
    // snapshot handed to the listener.
    const refreshed = await s.service.applyAvailability()
    expect(channel.stopped).toBe(0)
    expect(refreshed).toMatchObject({ available: true, channels: { feishu: { enabled: true } } })
    expect(s.snapshots).toContain(refreshed)

    s.unavailable.reason = '手机遥控暂时停用了，修好以后会自动恢复。'
    const snapshot = await s.service.applyAvailability()
    expect(channel.texts()).toContain('手机遥控已在电脑上关闭。')
    expect(channel.stopped).toBe(1)
    expect(codex.kills).toContain('SIGTERM')
    expect(snapshot).toMatchObject({ available: false, unavailableReason: '手机遥控暂时停用了，修好以后会自动恢复。', channels: { feishu: { enabled: false } } })
    expect(s.logs).toContain('remote.channel-suspended')
    await expect(s.service.setChannelEnabled('feishu', true)).rejects.toThrow('手机遥控暂时停用了')

    // 放开以后不替他打开，等他自己点。
    s.unavailable.reason = null
    expect(await s.service.applyAvailability()).toMatchObject({ available: true, channels: { feishu: { enabled: false } } })
    expect(s.channels).toHaveLength(1)
    s.service.dispose()
    expect(await s.service.applyAvailability()).toBeNull()
  })

  // 打开要先等读设置、读凭据、查 Codex 装没装，那几秒渠道还不算开着，远程关停不到它（R29-06）。
  it('does not connect a channel that remote control was switched off for while it was still opening', async () => {
    const s = await setup()
    const opening = expect(s.service.setChannelEnabled('feishu', true)).rejects.toThrow('手机遥控暂时停用了，修好以后会自动恢复。')
    s.unavailable.reason = '手机遥控暂时停用了，修好以后会自动恢复。'
    await s.service.applyAvailability()
    await opening
    expect(s.channels).toHaveLength(0)
    expect((await s.service.snapshot()).channels.feishu).toMatchObject({ enabled: false, status: { state: 'stopped' } })
  })

  it('does not connect a channel the manager started quitting for while it was still opening', async () => {
    const s = await setup()
    const opening = expect(s.service.setChannelEnabled('feishu', true)).rejects.toThrow('星芒正在退出。')
    s.service.dispose()
    await opening
    expect(s.channels).toHaveLength(0)
  })

  it('does not hand a channel to the network once it was switched off while reading secrets', async () => {
    let release: () => void = () => undefined
    const s = await setup({ secretsGate: new Promise<void>((resolve) => { release = resolve }) })
    const opening = s.service.setChannelEnabled('feishu', true)
    await vi.waitFor(() => expect(s.channels).toHaveLength(1))
    s.unavailable.reason = '手机遥控暂时停用了，修好以后会自动恢复。'
    await s.service.applyAvailability()
    release()
    expect(await opening).toMatchObject({ available: false, channels: { feishu: { enabled: false } } })
    expect(s.channels[0].stopped).toBe(1)
    expect(s.channels[0].handlers).toBeNull()
    expect(s.logs).not.toContain('remote.channel-started')
  })

  // 换凭据要先等旧连接停下，再用新凭据连上：远程关落在这一下里，同样不能再连（R29-06）。
  it('does not reconnect with a new credential once remote control was switched off while the old connection stopped', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    channel.stop = async () => {
      channel.stopped += 1
      s.unavailable.reason = '手机遥控暂时停用了，修好以后会自动恢复。'
      await s.service.applyAvailability()
    }
    const snapshot = await s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_abcdef', appSecret: 'y'.repeat(16) }), 'cli_abcdef')
    expect(s.channels).toHaveLength(1)
    expect(snapshot).toMatchObject({ available: false, channels: { feishu: { enabled: false, hasCredential: true } } })
  })

  it('shuts a running channel down cleanly when remote control went off before it could reconnect with a new credential', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    channel.stop = async () => {
      channel.stopped += 1
      s.unavailable.reason = '手机遥控暂时停用了，修好以后会自动恢复。'
    }
    const snapshot = await s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_abcdef', appSecret: 'y'.repeat(16) }), 'cli_abcdef')
    expect(s.channels).toHaveLength(1)
    expect(snapshot).toMatchObject({ available: false, task: 'idle', channels: { feishu: { enabled: false } } })
    expect(codex.kills).toContain('SIGTERM')
    expect(s.logs).toContain('remote.channel-suspended')
    // 之后状态文件再来那一下只剩刷新：渠道已经停了，不会再停一遍。
    await s.service.applyAvailability()
    expect(channel.stopped).toBe(1)
  })

  // 星芒退出前跟手机道别（0.2.22 打磨 B8）：只说一句、不停渠道，停渠道和 Codex 仍归 dispose。
  it('says goodbye to the phone before the manager quits and leaves the channel to dispose', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await s.service.farewell()
    expect(channel.texts()).toEqual(['电脑端的星芒已退出，遥控已停止。请重新打开星芒并开启遥控后继续使用。'])
    expect(channel.stopped).toBe(0)
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(true)
    s.service.dispose()
    await vi.waitFor(() => expect(channel.stopped).toBe(1))
  })

  // YR-8：开了「打开星芒时自动打开遥控」，再打开星芒就会自己连上，道别那句跟着换；没开的照旧（上一条）。
  it('tells the phone the remote comes back on its own at the next launch when switching on at launch is on', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await s.service.setAutoStart(true)
    await s.service.farewell()
    // 换了道别那句，退出没退成时照旧补「没关成」。
    await s.service.quitAborted()
    expect(channel.texts()).toEqual(['电脑端的星芒已退出，遥控已停止。星芒再次打开时将自动连接。', '电脑端的星芒未退出，遥控仍保持开启，可继续使用。'])
  })

  it('falls back to the plain goodbye when the switch cannot be read, rather than promising a reconnect', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await s.service.setAutoStart(true)
    vi.spyOn(s.store, 'readSettings').mockRejectedValueOnce(new Error('disk'))
    await s.service.farewell()
    expect(channel.texts()).toEqual(['电脑端的星芒已退出，遥控已停止。请重新打开星芒并开启遥控后继续使用。'])
  })

  it('keeps the goodbye inside one and a half seconds when reading the switch hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    vi.spyOn(s.store, 'readSettings').mockImplementationOnce(() => new Promise(() => undefined))
    let done = false
    const farewell = s.service.farewell().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(1_499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await farewell
    expect(done).toBe(true)
    expect(channel.texts()).toEqual([])
  })

  // 主窗口 prepareToQuit 的清理预算是 2 秒（window-lifecycle），道别要在它之前放手。
  it('does not let a stuck channel hold the quit for more than one and a half seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    channel.send = () => new Promise(() => undefined)
    let done = false
    const farewell = s.service.farewell().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(1_499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await farewell
    expect(done).toBe(true)
  })

  // 退出没退成（装更新的安装器没启动、Mac 卸载移不进废纸篓）：说过「关了」的渠道补一句「没关成」，没说过的不补。
  it('tells the phone the remote is still on when the quit was aborted after the goodbye', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await s.service.farewell()
    await s.service.quitAborted()
    expect(channel.texts()).toEqual(['电脑端的星芒已退出，遥控已停止。请重新打开星芒并开启遥控后继续使用。', '电脑端的星芒未退出，遥控仍保持开启，可继续使用。'])
    // 补过一次就清账：下一次没说「关了」的退出被撤回，不再补。
    await s.service.quitAborted()
    expect(channel.texts()).toHaveLength(2)
  })

  it('says nothing on an aborted quit when no goodbye went out', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await s.service.quitAborted()
    expect(channel.texts()).toEqual([])
  })

  it('says nothing on quit when no channel is on', async () => {
    const s = await setup()
    await s.service.farewell()
    expect(s.channels).toHaveLength(0)
  })

  it('tells the idle update install whether any channel is on, through switch-off and the four-hour close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup({ idleCloseHours: 4 })
    expect(s.service.hasEnabledChannel()).toBe(false)
    await enabledAndPaired(s)
    expect(s.service.hasEnabledChannel()).toBe(true)
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    await vi.waitFor(() => expect(s.service.hasEnabledChannel()).toBe(false))
    await s.service.setChannelEnabled('feishu', true)
    expect(s.service.hasEnabledChannel()).toBe(true)
    await s.service.setChannelEnabled('feishu', false)
    expect(s.service.hasEnabledChannel()).toBe(false)
  })

  it('closes itself after four idle hours when four hours is chosen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup({ idleCloseHours: 4 })
    const channel = await enabledAndPaired(s)
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    await vi.waitFor(() => expect(channel.texts()).toContain('4 小时内无新消息，手机遥控已自动关闭。如需继续使用，请在电脑端的星芒中重新开启。'))
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(false)
  })

  // YR-8：开了自动打开的，星芒下次打开会自己连上，自动关那句跟着换。
  it('says the remote comes back at the next launch when it closes itself with switching on at launch on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup({ idleCloseHours: 4 })
    const channel = await enabledAndPaired(s)
    await s.service.setAutoStart(true)
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    await channel.sentUntil(() => channel.texts().includes('4 小时内无新消息，手机遥控已自动关闭。星芒下次打开时将自动连接；如需立即使用，请在电脑端重新开启。'))
    expect(channel.texts()).not.toContain('4 小时内无新消息，手机遥控已自动关闭。如需继续使用，请在电脑端的星芒中重新开启。')
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(false)
  })

  // 挑那句话要读盘，渠道不等它：到点当场关，读不出来也照样在 1.5 秒后收掉连接，只是那句不发了。
  it('switches off on the idle close at once even while reading the switch hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup({ idleCloseHours: 4 })
    const channel = await enabledAndPaired(s)
    const warning = '手机遥控将在 10 分钟后自动关闭，如需继续使用，请回复任意消息。'
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000 - 1)
    await channel.sentUntil(() => channel.texts().includes(warning))
    vi.spyOn(s.store, 'readSettings').mockImplementationOnce(() => new Promise(() => undefined))
    await vi.advanceTimersByTimeAsync(1)
    expect(s.service.hasEnabledChannel()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_500)
    await vi.waitFor(() => expect(channel.stopped).toBe(1))
    expect(channel.texts()).toEqual([warning])
  })

  // D66 / YKS-19：自动关之前 10 分钟提醒一次，回什么都续上。
  it('warns ten minutes before the idle close and stays open when the phone answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup({ idleCloseHours: 4 })
    const channel = await enabledAndPaired(s)
    const warning = '手机遥控将在 10 分钟后自动关闭，如需继续使用，请回复任意消息。'
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000 + 49 * 60_000)
    expect(channel.texts()).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    await channel.sentUntil(() => channel.texts().includes(warning))
    expect(channel.sent[0].peer).toEqual(alice)
    channel.handlers?.onInbound(text(alice, '帮助'))
    await channel.sentUntil(() => channel.texts().length === 2)
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000)
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(true)
    expect(channel.texts().filter((line) => line === warning)).toHaveLength(1)
  })

  // YF-10：缺省「不自动关」，闲多久都开着、也不发提醒。
  it('stays open however long it idles when nothing is chosen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000)
    expect(channel.texts()).toEqual([])
    const snapshot = await s.service.snapshot()
    expect(snapshot.channels.feishu.enabled).toBe(true)
    expect(snapshot.idleCloseHours).toBeUndefined()
    expect(s.logs).not.toContain('remote.idle-closing-soon')
  })

  it('warns and closes on the twelve-hour mark, saying twelve hours', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup({ idleCloseHours: 12 })
    const channel = await enabledAndPaired(s)
    await vi.advanceTimersByTimeAsync(11 * 60 * 60_000 + 49 * 60_000)
    expect(channel.texts()).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    await channel.sentUntil(() => channel.texts().includes('手机遥控将在 10 分钟后自动关闭，如需继续使用，请回复任意消息。'))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.waitFor(() => expect(channel.texts()).toContain('12 小时内无新消息，手机遥控已自动关闭。如需继续使用，请在电脑端的星芒中重新开启。'))
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(false)
  })

  it('restarts the countdown from now when the duration changes, and drops it for never', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000)
    s.snapshots.length = 0
    const chosen = await s.service.setIdleClose(4)
    expect(chosen.idleCloseHours).toBe(4)
    expect(s.snapshots.at(-1)?.idleCloseHours).toBe(4)
    expect((await s.store.readSettings()).idleCloseHours).toBe(4)
    // 从改的这一刻起算 4 小时，不是从打开那一刻：前面闲着的 5 小时不算。
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000 + 49 * 60_000)
    expect(channel.texts()).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    await channel.sentUntil(() => channel.texts().length === 1)
    // 提醒发出去以后换成不自动关：后面那一下关闭也撤掉。
    const never = await s.service.setIdleClose(null)
    expect(never.idleCloseHours).toBeUndefined()
    expect((await s.store.readSettings()).idleCloseHours).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(channel.texts()).toHaveLength(1)
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(true)
  })

  it('reads the chosen duration back after a restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const root = tempRoot()
    const first = await setup({ root })
    await first.service.setIdleClose(4)
    first.service.dispose()
    const s = await setup({ root })
    const channel = await enabledAndPaired(s)
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    await vi.waitFor(() => expect(channel.texts()).toContain('4 小时内无新消息，手机遥控已自动关闭。如需继续使用，请在电脑端的星芒中重新开启。'))
  })

  // D66 / YKS-18：解绑、换人、退出登录，原来那个人要知道之后发的话不会再执行。
  it('tells the bound person before unbinding, handing over to someone else, or logging out', async () => {
    const unboundText = '您已在电脑端被解绑，此后发送的消息将不再执行。'
    const s = await setup()
    await s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_abcdef', appSecret: 'x'.repeat(16) }), 'cli_abcdef')
    let channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '帮助', { replyContext: 'ctx-alice-last' }))
    await channel.sentUntil(() => channel.texts().length === 1)
    await s.service.unbind('feishu')
    expect(channel.texts().at(-1)).toBe(unboundText)
    expect(channel.sent.at(-1)).toMatchObject({ peer: alice, replyContext: 'ctx-alice-last' })

    // Alice pairs again, then the computer hands over to Mallory.
    channel.sent.length = 0
    await s.service.startPairing('feishu')
    channel.handlers?.onInbound(text(alice, '000042'))
    await channel.sentUntil(() => channel.texts().length === 1)
    await s.service.startPairing('feishu')
    channel.handlers?.onInbound(text(mallory, '000042'))
    await channel.sentUntil(() => channel.sent.some((entry) => entry.peer.userId === mallory.userId))
    const toAlice = channel.sent.filter((entry) => entry.peer.userId === alice.userId)
    expect(toAlice.at(-1)?.message).toEqual({ kind: 'text', text: unboundText })
    expect(channel.sent.findIndex((entry) => entry.peer.userId === mallory.userId))
      .toBeGreaterThan(channel.sent.findIndex((entry) => entry.message.kind === 'text' && entry.message.text === unboundText))

    // Logging out tells Mallory before the credential is gone.
    channel.sent.length = 0
    await s.service.saveChannelCredential('feishu', null, null)
    expect(channel.sent).toEqual([{ peer: mallory, message: { kind: 'text', text: unboundText }, replyContext: expect.any(String) }])
    // Nothing to say when nobody is bound or the channel is off.
    channel = s.channels[0]
    channel.sent.length = 0
    await s.service.unbind('feishu')
    expect(channel.sent).toHaveLength(0)
  })

  it('reports every open, login loss and close to the state listener so the sleep blocker can follow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup({ idleCloseHours: 4 })
    let held = 0
    const keepAwake = createCodexRemoteKeepAwake({
      blocker: {
        start: () => {
          held += 1
          return held
        },
        stop: () => { held -= 1 },
      },
    })
    function follow(): boolean {
      for (const snapshot of s.snapshots) keepAwake.observe(snapshot)
      return keepAwake.holding()
    }
    await s.service.setChannelEnabled('feishu', true)
    await vi.waitFor(() => expect(follow()).toBe(true))
    s.channels[0].handlers?.onStatus({ state: 'needs-login', message: '飞书应用的密钥失效了' })
    await vi.waitFor(() => expect(follow()).toBe(false))
    s.channels[0].handlers?.onStatus({ state: 'connected' })
    await vi.waitFor(() => expect(follow()).toBe(true))
    await s.service.setChannelEnabled('feishu', false)
    await vi.waitFor(() => expect(follow()).toBe(false))
    await s.service.setChannelEnabled('feishu', true)
    await vi.waitFor(() => expect(follow()).toBe(true))
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    await vi.waitFor(() => expect(follow()).toBe(false))
    expect(held).toBe(0)
  })

  // YKS-12：渠道没连起来就停下了、不会自己再试，开关还开着（卡片上留着那句话和「重新连接」），可已经收不到手机上的消息，
  // 不能再挡着电脑睡眠；YF-10 默认不自动关，原来这一挡就是几天。
  it('marks a channel that failed to start as halted so the sleep blocker lets go', async () => {
    const s = await setup({ startFails: true })
    const keepAwake = createCodexRemoteKeepAwake({ blocker: { start: () => 1, stop: () => undefined } })
    await s.service.setChannelEnabled('feishu', true)
    const snapshot = await s.service.snapshot()
    expect(snapshot.channels.feishu).toMatchObject({ enabled: true, status: { state: 'error', halted: true } })
    expect(s.logs).toContain('remote.channel-start-failed')
    // Only what the service pushed to the listener: main.ts feeds the blocker from onStateChanged alone.
    for (const each of s.snapshots) keepAwake.observe(each)
    expect(s.snapshots.at(-1)?.channels.feishu.status.halted).toBe(true)
    expect(keepAwake.holding()).toBe(false)
  })

  // YF-5：微信扫码过了手机上那串数字，扫码的人直接绑上，不用配对码；原来绑着别人时先跟他说一声。
  it('binds the person who passed the number on the phone while scanning, telling whoever was bound before', async () => {
    const s = await setup()
    const weixinCredential = encodeWeixinCredential({ version: 1, token: 'tok', botId: 'b1@im.bot', origin: 'https://ilinkai.weixin.qq.com', ownerUserId: 'owner@im.wechat' })
    const first = await s.service.saveChannelCredential('weixin', weixinCredential, 'ClawBot 1bot', { verifiedPeerUserId: 'owner@im.wechat' })
    expect(first.channels.weixin.boundPeer).toMatchObject({ userIdTail: expect.any(String) })
    expect((await s.store.readSettings()).channels.weixin?.boundPeer).toMatchObject({ userId: 'owner@im.wechat' })
    expect(s.logs).toContain('remote.paired-by-scan')

    // 同一个机器人、同一个人再扫一次：绑定原样留着（时间也不变）。
    const boundAt = (await s.store.readSettings()).channels.weixin?.boundPeer?.boundAt
    await s.service.saveChannelCredential('weixin', weixinCredential, 'ClawBot 1bot', { verifiedPeerUserId: 'owner@im.wechat' })
    expect((await s.store.readSettings()).channels.weixin?.boundPeer?.boundAt).toBe(boundAt)

    // 同一个机器人换了个人扫、也过了数字：换成他。
    await s.service.saveChannelCredential('weixin', weixinCredential, 'ClawBot 1bot', { verifiedPeerUserId: 'other@im.wechat' })
    expect((await s.store.readSettings()).channels.weixin?.boundPeer?.userId).toBe('other@im.wechat')

    // 没过数字的再扫：同一个机器人留着原来的人，换了机器人就解绑、等配对。
    await s.service.saveChannelCredential('weixin', weixinCredential, 'ClawBot 1bot')
    expect((await s.store.readSettings()).channels.weixin?.boundPeer?.userId).toBe('other@im.wechat')
    await s.service.saveChannelCredential('weixin', weixinCredential, 'ClawBot 2bot')
    expect((await s.store.readSettings()).channels.weixin?.boundPeer).toBeNull()
  })

  // YR-9：换了机器人重新扫码、过了数字的还是原来绑着的那个人：绑定照旧，手机上不先收一句「已经把你解绑了」。
  // 换成别人扫，原来那个人照旧先收到那句。
  it('keeps the binding quietly when the person bound before passes the number on a new bot', async () => {
    const unboundText = '您已在电脑端被解绑，此后发送的消息将不再执行。'
    const s = await setup()
    function weixinCredential(botId: string): string {
      return encodeWeixinCredential({ version: 1, token: `tok-${botId}`, botId, origin: 'https://ilinkai.weixin.qq.com', ownerUserId: 'owner@im.wechat' })
    }
    function unboundTexts(): string[] {
      return s.channels.flatMap((channel) => channel.texts()).filter((line) => line === unboundText)
    }
    await s.service.saveChannelCredential('weixin', weixinCredential('b1@im.bot'), 'ClawBot 1bot', { verifiedPeerUserId: 'owner@im.wechat' })
    await s.service.setChannelEnabled('weixin', true)
    const boundAt = (await s.store.readSettings()).channels.weixin?.boundPeer?.boundAt

    await s.service.saveChannelCredential('weixin', weixinCredential('b2@im.bot'), 'ClawBot 2bot', { verifiedPeerUserId: 'owner@im.wechat' })
    expect(unboundTexts()).toEqual([])
    expect((await s.store.readSettings()).channels.weixin?.boundPeer).toMatchObject({ userId: 'owner@im.wechat', boundAt })
    expect((await s.service.snapshot()).channels.weixin.enabled).toBe(true)

    await s.service.saveChannelCredential('weixin', weixinCredential('b3@im.bot'), 'ClawBot 3bot', { verifiedPeerUserId: 'other@im.wechat' })
    expect(unboundTexts()).toEqual([unboundText])
    expect(s.channels.flatMap((channel) => channel.sent).find((entry) => entry.message.kind === 'text' && entry.message.text === unboundText)?.peer.userId)
      .toBe('owner@im.wechat')
    expect((await s.store.readSettings()).channels.weixin?.boundPeer?.userId).toBe('other@im.wechat')
  })

  it('voids a pairing code that was waiting when the scan binds someone', async () => {
    const s = await setup()
    await s.store.writeCredential('weixin', 'weixin-credential-value')
    await s.store.updateSettings((settings) => { settings.channels.weixin = { accountLabel: 'ClawBot 1bot', boundPeer: null } })
    await s.service.setChannelEnabled('weixin', true)
    await s.service.startPairing('weixin')
    expect((await s.service.snapshot()).channels.weixin.pairing).not.toBeNull()
    const after = await s.service.saveChannelCredential('weixin', 'weixin-credential-value', 'ClawBot 1bot', { verifiedPeerUserId: 'owner@im.wechat' })
    expect(after.channels.weixin.pairing).toBeNull()
    expect(after.channels.weixin.boundPeer).not.toBeNull()
  })

  it('keeps the binding when the same account logs in again and drops it for a different one', async () => {
    const s = await setup()
    await s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_abcdef', appSecret: 'x'.repeat(16) }), 'cli_abcdef')
    await enabledAndPaired(s)
    await s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_abcdef', appSecret: 'y'.repeat(16) }), 'cli_abcdef')
    expect((await s.service.snapshot()).channels.feishu.boundPeer).not.toBeNull()
    expect(s.channels).toHaveLength(2)
    await s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_other1', appSecret: 'z'.repeat(16) }), 'cli_other1')
    expect((await s.service.snapshot()).channels.feishu.boundPeer).toBeNull()
    await s.service.saveChannelCredential('feishu', null, null)
    const snapshot = await s.service.snapshot()
    expect(snapshot.channels.feishu).toMatchObject({ hasCredential: false, accountLabel: null, enabled: false })
  })

  it('still unbinds and stops the channel but reports it when logging out cannot remove the saved credential', async () => {
    const s = await setup()
    await s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_abcdef', appSecret: 'x'.repeat(16) }), 'cli_abcdef')
    const channel = await enabledAndPaired(s)
    const locked = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    vi.spyOn(s.store, 'writeCredential').mockRejectedValueOnce(new Error(credentialRemoveFailedMessage, { cause: locked }))
    await expect(s.service.saveChannelCredential('feishu', null, null)).rejects.toThrow(new Error(credentialRemoveFailedMessage))
    expect(s.logs).toContain('remote.credential-remove-failed')
    expect(channel.stopped).toBe(1)
    // The failed call returns nothing, so the card catches up from the state-changed snapshot.
    expect(s.snapshots.at(-1)?.channels.feishu).toMatchObject({ enabled: false, boundPeer: null, hasCredential: true, accountLabel: 'cli_abcdef' })
    // Clicking 退出登录 again once the file can go finishes the job.
    await s.service.saveChannelCredential('feishu', null, null)
    expect((await s.service.snapshot()).channels.feishu).toMatchObject({ hasCredential: false, accountLabel: null, enabled: false, boundPeer: null })
  })

  // M21：退出登录时凭据删掉了、设置却没写进去，原来在停渠道之前就抛了，渠道带着内存里的凭据照样收消息。
  it('still stops the channel and shows nobody bound when logging out cannot save the settings', async () => {
    const s = await setup()
    await s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_abcdef', appSecret: 'x'.repeat(16) }), 'cli_abcdef')
    const channel = await enabledAndPaired(s)
    vi.spyOn(s.store, 'updateSettings').mockRejectedValueOnce(new Error('disk full'))
    await expect(s.service.saveChannelCredential('feishu', null, null)).rejects.toThrow('disk full')
    expect(s.logs).toContain('remote.logout-settings-failed')
    expect(channel.stopped).toBe(1)
    expect(s.snapshots.at(-1)?.channels.feishu).toMatchObject({ enabled: false, hasCredential: false, boundPeer: null })
    // The binding left on disk does not come back when the same app logs in again: that is a new login.
    await s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_abcdef', appSecret: 'y'.repeat(16) }), 'cli_abcdef')
    expect((await s.service.snapshot()).channels.feishu).toMatchObject({ hasCredential: true, boundPeer: null })
    expect((await s.store.readSettings()).channels.feishu?.boundPeer).toBeNull()
  })

  it('does not swallow a failure to save a new credential as a logout failure', async () => {
    const s = await setup()
    vi.spyOn(s.store, 'writeCredential').mockRejectedValueOnce(new Error('本机不支持安全保存密码，凭据未保存。'))
    await expect(s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_other1', appSecret: 'z'.repeat(16) }), 'cli_other1')).rejects.toThrow('不支持安全保存')
    expect(s.logs).not.toContain('remote.credential-remove-failed')
  })

  it('drops what is waiting, stops the channel and Codex, and stays off when the manager quits', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    void codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    await s.service.startPairing('feishu')
    s.service.dispose()
    // Codex itself is killed, so the waiting command can never run; nothing was ever accepted.
    await vi.waitFor(() => expect(codex.kills.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(channel.stopped).toBeGreaterThan(0))
    expect(codex.written.some((message) => JSON.stringify(message.result ?? null).includes('accept'))).toBe(false)
    const snapshot = await s.service.snapshot()
    expect(snapshot).toMatchObject({ pendingApprovals: 0, task: 'idle' })
    expect(snapshot.channels.feishu).toMatchObject({ enabled: false, pairing: null })
    await expect(s.service.setChannelEnabled('feishu', true)).rejects.toThrow('星芒正在退出。')
  })

  it('hands channels the same dependencies the login flow uses', async () => {
    const s = await setup()
    const deps = s.service.channelDependencies('feishu')
    expect(deps.appVersion).toBe('0.2.21')
    expect(await deps.readCredential()).toContain('feishu-secret-value')
    deps.log('info', 'probe')
    expect(s.logs).toContain('feishu.probe')
  })
})

// #1407 P3-3（yoyo 10-29「按推荐」）：Windows 上遥控那份 Codex 一直开着，锁着自己的程序文件，在星芒里更新、卸载
// Codex 会撞上「文件被占用」。闲着就停掉、等它真退出再放行，正在干活就挡下来。哪个平台调由安装那边定。
describe('codex-remote-service releasing Codex for an update or uninstall', () => {
  async function idleAfterOneTask(s: Setup): Promise<{ channel: FakeChannel; codex: FakeCodex }> {
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    return { channel, codex }
  }

  it('says what the customer sees in so many words', () => {
    expect(codexRemoteBusyMessages).toEqual({
      update: '手机遥控中的 Codex 正在处理任务，请待其完成后再更新，或先在设置中关闭手机遥控。',
      uninstall: '手机遥控中的 Codex 正在处理任务，请待其完成后再卸载，或先在设置中关闭手机遥控。',
    })
  })

  it('stops an idle Codex, waits until it has really exited, and starts afresh on the next message', async () => {
    const s = await setup()
    const { channel, codex } = await idleAfterOneTask(s)
    const toldBefore = channel.texts()
    codex.holdExit = true
    let released = false
    const releasing = s.service.releaseCodex('update').then(() => { released = true })
    await vi.waitFor(() => expect(codex.kills.length).toBeGreaterThan(0))
    await new Promise((resolve) => setImmediate(resolve))
    expect(released).toBe(false)
    codex.exitNow()
    await releasing
    expect(s.logs).toContain('remote.codex-released')
    // 停的是电脑这边自己要的：手机上不说「意外退出」，遥控照样开着。
    expect(channel.texts()).toEqual(toldBefore)
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(true)
    // 下一条消息再起一份，对话开在新的那份里：旧对话的编号停掉以后接不上。
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await turnStarted(s, 1, 1)
    expect(s.codex[1].requests('turn/start')).toHaveLength(1)
    expect(s.codex[1].requests('thread/start')).toHaveLength(1)
  })

  it('leaves a Codex in the middle of a phone task alone and says why', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    await expect(s.service.releaseCodex('update')).rejects.toThrow(codexRemoteBusyMessages.update)
    // 等你同意的那一会儿也算在干活。
    void codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    expect((await s.service.snapshot()).task).toBe('waiting-approval')
    await expect(s.service.releaseCodex('uninstall')).rejects.toThrow(codexRemoteBusyMessages.uninstall)
    expect(codex.kills).toEqual([])
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
    expect(s.logs).toContain('remote.codex-release-refused')
    expect(s.logs).not.toContain('remote.codex-released')
  })

  it('counts a Codex that is still starting as working rather than waiting for it', async () => {
    let release!: () => void
    const s = await setup({ spawnGate: new Promise<void>((resolve) => { release = resolve }) })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.texts().includes('已收到，Codex 开始处理。'))
    await s.spawnAsked(1)
    // 起 Codex 也排在安装队列里：这时它可能排在这次安装后面，在这里等它就互相等死。
    await expect(s.service.releaseCodex('uninstall')).rejects.toThrow(codexRemoteBusyMessages.uninstall)
    release()
    await vi.waitFor(() => expect(s.codex[0]?.requests('turn/start').length ?? 0).toBe(1))
    expect(s.codex[0].kills).toEqual([])
  })

  it('has nothing to stop when the phone has not used Codex yet', async () => {
    const s = await setup()
    await enabledAndPaired(s)
    await expect(s.service.releaseCodex('update')).resolves.toBeUndefined()
    expect(s.codex).toHaveLength(0)
    expect(s.logs).not.toContain('remote.codex-released')
  })

  it('also waits for a Codex that was just stopped by switching the remote off', async () => {
    const s = await setup()
    const { codex } = await idleAfterOneTask(s)
    codex.holdExit = true
    await s.service.setChannelEnabled('feishu', false)
    expect(codex.kills.length).toBeGreaterThan(0)
    let released = false
    const releasing = s.service.releaseCodex('update').then(() => { released = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(released).toBe(false)
    codex.exitNow()
    await releasing
  })

  it('goes ahead after ten seconds when Codex will not exit, and logs it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const { codex } = await idleAfterOneTask(s)
    codex.holdExit = true
    let released = false
    const releasing = s.service.releaseCodex('update').then(() => { released = true })
    await vi.advanceTimersByTimeAsync(9_000)
    expect(released).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await releasing
    expect(s.logs).toContain('remote.codex-release-timeout')
  })
})

const threadA = '01a20102-19e8-7b23-968d-694964b4899f'
const threadB = '01a20101-8c39-7c23-a0e8-2036f142d454'
const threadC = '01a20100-f4da-7522-b3c0-d0abd6ea5b07'
const fitsDefault = {
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
}
const fullAccess = { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } }

/** 本机时间 11 月 day 日 hour:minute，Codex 记的是秒。 */
function codexSeconds(day: number, hour: number, minute: number): number {
  return new Date(2026, 10, day, hour, minute).getTime() / 1000
}

function codexThread(id: string, cwd: string, preview: string, updatedAt: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, cwd, preview, name: null, updatedAt, ephemeral: false, parentThreadId: null, source: 'vscode', ...extra }
}

/**
 * rules 是 Codex 报的这份对话现在套着的规矩（collaborationMode 的 developer_instructions），跟 Codex 0.169、0.171 一样：
 * 没写过是 null，thread/settings/update 写过以后再接，答回来的就是写进去的那段。
 */
function resumeReply(threadId: string, cwd: string, permission: Record<string, unknown> = fitsDefault, rules: string | null = null): Record<string, unknown> {
  return {
    result: {
      thread: { id: threadId, cwd },
      cwd,
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      ...permission,
      collaborationMode: { mode: 'default', settings: { model: 'gpt-5.5', reasoning_effort: 'medium', developer_instructions: rules } },
    },
  }
}

/** thread/settings/update 写进去的规矩（collaborationMode.settings.developer_instructions）；没带是 null。 */
function sentRules(params: Record<string, unknown>): string | null {
  const mode = params.collaborationMode
  if (!mode || typeof mode !== 'object') return null
  const settings = (mode as { settings?: unknown }).settings
  if (!settings || typeof settings !== 'object') return null
  const rules = (settings as { developer_instructions?: unknown }).developer_instructions
  return typeof rules === 'string' ? rules : null
}

interface ConversationSetup {
  s: Setup
  workspace: string
  other: string
}

async function conversationSetup(options: {
  list?: (folders: { workspace: string; other: string }) => Array<Record<string, unknown>>
  /** rules：这份对话现在套着的规矩，由下面 thread/settings/update 记下（跟真 Codex 一样）。 */
  resume?: (params: Record<string, unknown>, folders: { workspace: string; other: string }, rules: string | null) => Record<string, unknown>
  /** 缺省照真 Codex：记下写进去的规矩，回 {}。给了就照它回，回了 result 也不记（模拟字段改了名，Codex 照样回成功）。 */
  settingsUpdate?: (params: Record<string, unknown>) => Record<string, unknown>
  codexVersion?: string | null
  images?: boolean
} = {}): Promise<ConversationSetup> {
  const root = tempRoot()
  const workspace = path.join(root, 'home', 'projects', 'demo')
  const other = path.join(root, 'home', 'projects', 'other')
  fs.mkdirSync(other, { recursive: true })
  const folders = { workspace, other }
  const list = options.list ?? (() => [
    codexThread(threadA, workspace, '修复登录页报错', codexSeconds(21, 18, 30)),
    codexThread(threadC, path.join(root, 'home', 'elsewhere'), '别处的对话', codexSeconds(21, 12, 0)),
    codexThread(threadB, `${other}/`, '整理接口文档', codexSeconds(20, 9, 12)),
  ])
  const rulesByThread = new Map<string, string | null>()
  // 按本机的路径规矩起服务：文件夹是真建出来的，Windows 上是 C:\…，按 darwin 的规矩会认不出主目录、取不对文件夹名。
  const s = await setup({
    root,
    platform: process.platform,
    ...(options.images ? { images: true } : {}),
    ...(options.codexVersion === null ? {} : { codexVersion: options.codexVersion ?? '0.169.0' }),
    codexReplies: {
      'thread/list': () => ({ result: { data: list(folders), nextCursor: null, backwardsCursor: null } }),
      'thread/resume': (params) => {
        const rules = rulesByThread.get(String(params.threadId)) ?? null
        return options.resume ? options.resume(params, folders, rules) : resumeReply(String(params.threadId), params.threadId === threadB ? other : workspace, fitsDefault, rules)
      },
      'thread/settings/update': (params) => {
        if (options.settingsUpdate) return options.settingsUpdate(params)
        rulesByThread.set(String(params.threadId), sentRules(params))
        return { result: {} }
      },
    },
  })
  await s.store.updateSettings((settings) => { settings.workspaceDirectories = [workspace, other] })
  return { s, workspace, other }
}

async function phoneReply(channel: FakeChannel, body: string): Promise<string> {
  const before = channel.sent.length
  channel.handlers?.onInbound(text(alice, body))
  await channel.sentUntil(() => channel.sent.length > before)
  return channel.texts()[before]
}

const switchedToB = [
  '已切换到对话「整理接口文档」，请发送消息继续。手机遥控的规则（不发送密钥和密码、回复简洁等）将保留在该对话中，在电脑端继续时同样生效。',
  '请勿在电脑端和手机端同时向该对话发送消息。',
].join('\n')

describe('codex-remote-service continuing a Codex conversation from the phone', () => {
  it('lists the recent conversations in the added folders only, newest first, with an example to send', async () => {
    const { s } = await conversationSetup()
    const channel = await enabledAndPaired(s)
    expect(await phoneReply(channel, '对话')).toBe([
      '本机最近的 Codex 对话（仅限电脑端已添加的文件夹）：',
      '1. 修复登录页报错（demo，11-21 18:30）',
      '2. 整理接口文档（other，11-20 09:12）',
      '请发送「对话 1」继续该对话。',
    ].join('\n'))
    expect(s.codex[0].requests('thread/list')[0].params).toMatchObject({ sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['cli', 'vscode', 'appServer'] })
  })

  it('says there is nothing to continue when no conversation is in an added folder', async () => {
    const { s } = await conversationSetup({ list: () => [] })
    const channel = await enabledAndPaired(s)
    expect(await phoneReply(channel, '对话')).toBe('电脑端已添加的文件夹中暂无 Codex 对话，发送消息即可开始新对话。')
  })

  it('does not offer existing conversations on a Codex older than the first version it was tried on', async () => {
    const { s } = await conversationSetup({ codexVersion: '0.168.0' })
    const channel = await enabledAndPaired(s)
    expect(await phoneReply(channel, '对话')).toBe('当前 Codex 版本暂不支持继续已有对话，请发送「新对话」开始新对话。')
    expect(await phoneReply(channel, '对话 1')).toBe('当前 Codex 版本暂不支持继续已有对话，请发送「新对话」开始新对话。')
    expect(s.codex[0].requests('thread/resume')).toHaveLength(0)
  })

  // M06：「对话 N」接的是别的文件夹里的对话，也算换了文件夹，攒着没用的图清掉并说一声。
  it('leaves waiting images behind when the chosen conversation is in another folder', async () => {
    const { s } = await conversationSetup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a']))
    await channel.sentUntil(() => channel.texts().length >= 1)
    await s.imagesSaved(1)
    await phoneReply(channel, '对话')
    expect(await phoneReply(channel, '对话 2')).toBe(`${switchedToB}\n此前发送、尚未使用的图片已清除，如需使用请重新发送。`)
    await s.imagesRemoved(1)
    expect(storedImages(s.imageDirectory)).toEqual([])
  })

  it('continues the chosen conversation where it is, switching to its folder, with the remote rules set once and checked before any message', async () => {
    const { s, other } = await conversationSetup()
    const channel = await enabledAndPaired(s)
    await phoneReply(channel, '对话')
    expect(await phoneReply(channel, '对话 2')).toBe(switchedToB)
    const codex = s.codex[0]
    const resumeParams = {
      threadId: threadB,
      excludeTurns: true,
      config: { 'features.apps': false, 'features.plugins': false },
    }
    // 接上、写进规矩、再接一次看 Codex 报的是不是这段规矩：一句话都还没交给 Codex。
    expect(codex.requests('thread/resume').map((request) => request.params)).toEqual([resumeParams, resumeParams])
    const update = codex.requests('thread/settings/update')
    expect(update).toHaveLength(1)
    expect(update[0].params).toMatchObject({ threadId: threadB, collaborationMode: { mode: 'default', settings: { model: 'gpt-5.5', reasoning_effort: 'medium' } } })
    expect(sentRules(update[0].params as Record<string, unknown>)).toContain('Never print, copy or summarise API keys')
    expect(codex.written.map((message) => message.method).filter((method) => method === 'thread/settings/update' || method === 'thread/resume' || method === 'turn/start'))
      .toEqual(['thread/resume', 'thread/settings/update', 'thread/resume'])
    const settings = await s.store.readSettings()
    expect(settings.workspaceDirectory).toBe(other)
    expect(settings.conversation).toMatchObject({ threadId: threadB, title: '整理接口文档', folder: other })
    expect((await s.service.snapshot()).conversation).toMatchObject({ id: threadB, title: '整理接口文档', folder: path.join('~', 'projects', 'other') })
    channel.handlers?.onInbound(text(alice, '再改一下'))
    await codex.requestedUntil('turn/start', 1)
    expect(codex.requests('thread/start')).toHaveLength(0)
    const first = codex.requests('turn/start')[0].params as Record<string, unknown>
    expect(first.threadId).toBe(threadB)
    expect(first).not.toHaveProperty('approvalPolicy')
    expect(first).not.toHaveProperty('sandboxPolicy')
    expect(first).not.toHaveProperty('collaborationMode')
    codex.notify('turn/completed', { threadId: threadB, turn: { id: 'tu-1', status: 'completed', error: null } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    channel.handlers?.onInbound(text(alice, '再看一下'))
    await codex.requestedUntil('turn/start', 2)
    expect(codex.requests('turn/start')[1].params).not.toHaveProperty('collaborationMode')
    expect(codex.requests('thread/settings/update')).toHaveLength(1)
    expect(channel.texts().filter((line) => line.includes('当前为新对话'))).toHaveLength(0)
  })

  // 0.2.25 第三轮复查第 4 条：以前只认 0.169.x，推荐版一抬到 0.170，照着「更新」的客户就接不了对话。
  it('continues a conversation on a Codex newer than the one it was first tried on', async () => {
    const { s } = await conversationSetup({ codexVersion: '0.171.0' })
    const channel = await enabledAndPaired(s)
    expect(await phoneReply(channel, '对话')).toContain('2. 整理接口文档（other，11-20 09:12）')
    expect(await phoneReply(channel, '对话 2')).toBe(switchedToB)
    channel.handlers?.onInbound(text(alice, '再改一下'))
    await s.codex[0].requestedUntil('turn/start', 1)
    expect(s.codex[0].requests('turn/start')[0].params).toMatchObject({ threadId: threadB })
  })

  it('says this Codex cannot continue conversations when it does not report the remote rules back, and changes nothing', async () => {
    // 字段改了名的那种 Codex：照样回成功，再接答回来的没有这段规矩。
    const { s, workspace } = await conversationSetup({ codexVersion: '0.180.0', settingsUpdate: () => ({ result: {} }) })
    const channel = await enabledAndPaired(s)
    await phoneReply(channel, '对话')
    expect(await phoneReply(channel, '对话 2')).toBe('当前 Codex 版本暂不支持继续已有对话，请发送「新对话」开始新对话。')
    const settings = await s.store.readSettings()
    expect(settings.workspaceDirectory).toBe(workspace)
    expect(settings.conversation).toBeUndefined()
    expect(s.logDetails.find((entry) => entry.event === 'remote.conversation-rules-unconfirmed')?.detail).toEqual({ version: '0.180.0', reason: 'not-in-effect' })
    // 这一版记下了：再列、再选、电脑上打开列表都直接说不支持，不再接上去试。
    expect(await phoneReply(channel, '对话')).toBe('当前 Codex 版本暂不支持继续已有对话，请发送「新对话」开始新对话。')
    expect(await phoneReply(channel, '对话 1')).toBe('当前 Codex 版本暂不支持继续已有对话，请发送「新对话」开始新对话。')
    expect(await s.service.listConversations()).toEqual({ supported: false })
    expect(s.codex[0].requests('thread/resume')).toHaveLength(2)
    // 手机上照常能用新对话。
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await s.codex[0].requestedUntil('turn/start', 1)
    expect(s.codex[0].requests('thread/start')).toHaveLength(1)
  })

  it('treats a settings update Codex refuses as unsupported, and one that fails for another reason as a failed resume', async () => {
    const refused = await conversationSetup({ settingsUpdate: () => ({ error: { code: -32600, message: 'Invalid request: unknown variant `thread/settings/update`' } }) })
    const refusedChannel = await enabledAndPaired(refused.s)
    await phoneReply(refusedChannel, '对话')
    expect(await phoneReply(refusedChannel, '对话 2')).toBe('当前 Codex 版本暂不支持继续已有对话，请发送「新对话」开始新对话。')
    expect(refused.s.logDetails.find((entry) => entry.event === 'remote.conversation-rules-unconfirmed')?.detail).toEqual({ version: '0.169.0', reason: 'rejected' })
    expect(refused.s.codex[0].requests('thread/resume')).toHaveLength(1)

    const failed = await conversationSetup({ settingsUpdate: () => ({ error: { code: -32603, message: 'failed to update thread settings: channel closed' } }) })
    const failedChannel = await enabledAndPaired(failed.s)
    await phoneReply(failedChannel, '对话')
    expect(await phoneReply(failedChannel, '对话 2')).toBe('无法继续该对话，请稍后重试，或发送「新对话」开始新对话。')
    expect(failed.s.logs).not.toContain('remote.conversation-rules-unconfirmed')
    // 一时出错不记这一版：再发「对话」照常列。
    expect(await phoneReply(failedChannel, '对话')).toContain('1. 修复登录页报错（demo，11-21 18:30）')
  })

  it('lowers a conversation that had more access than the phone level and says so', async () => {
    const { s } = await conversationSetup({ resume: (params, folders, rules) => resumeReply(String(params.threadId), folders.other, fullAccess, rules) })
    const channel = await enabledAndPaired(s)
    await phoneReply(channel, '对话')
    expect(await phoneReply(channel, '对话 2')).toBe([
      '已切换到对话「整理接口文档」，请发送消息继续。手机遥控的规则（不发送密钥和密码、回复简洁等）将保留在该对话中，在电脑端继续时同样生效。',
      '该对话原有权限超出手机遥控允许的范围，已调整为「默认」，在电脑端继续时也将保持「默认」。',
      '请勿在电脑端和手机端同时向该对话发送消息。',
    ].join('\n'))
    channel.handlers?.onInbound(text(alice, '再改一下'))
    const codex = s.codex[0]
    await codex.requestedUntil('turn/start', 1)
    expect(codex.requests('turn/start')[0].params).toMatchObject({
      threadId: threadB,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    })
  })

  it('names the read-only level when the phone is set to read-only', async () => {
    const { s } = await conversationSetup({ resume: (params, folders, rules) => resumeReply(String(params.threadId), folders.other, fitsDefault, rules) })
    await s.service.setPermission('readOnly')
    const channel = await enabledAndPaired(s)
    await phoneReply(channel, '对话')
    expect(await phoneReply(channel, '对话 2')).toContain('已调整为「只读」，在电脑端继续时也将保持「只读」。')
  })

  it('refuses a number that is not on the list, the conversation already in use and a switch while Codex is busy', async () => {
    const { s } = await conversationSetup()
    const channel = await enabledAndPaired(s)
    await phoneReply(channel, '对话')
    expect(await phoneReply(channel, '对话 3')).toBe('不存在第 3 个对话，请发送「对话」查看列表。')
    await phoneReply(channel, '对话 2')
    expect(await phoneReply(channel, '对话 2')).toBe('当前已在该对话中。')
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await s.codex[0].requestedUntil('turn/start', 1)
    expect(await phoneReply(channel, '对话 1')).toBe('Codex 正在处理上一条消息，请待其完成后再切换对话。')
  })

  it('keeps the current conversation and folder when Codex cannot continue the chosen one', async () => {
    const { s, workspace } = await conversationSetup({ resume: () => ({ error: { code: -32600, message: 'thread not found' } }) })
    const channel = await enabledAndPaired(s)
    await phoneReply(channel, '对话')
    expect(await phoneReply(channel, '对话 2')).toBe('无法继续该对话，请稍后重试，或发送「新对话」开始新对话。')
    const settings = await s.store.readSettings()
    expect(settings.workspaceDirectory).toBe(workspace)
    expect(settings.conversation).toBeUndefined()
  })

  it('goes back to a new conversation when the phone sends 新对话', async () => {
    const { s } = await conversationSetup()
    const channel = await enabledAndPaired(s)
    await phoneReply(channel, '对话')
    await phoneReply(channel, '对话 2')
    expect(await phoneReply(channel, '新对话')).toBe('已开始新对话。')
    expect((await s.store.readSettings()).conversation).toBeUndefined()
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await s.codex[0].requestedUntil('turn/start', 1)
    expect(s.codex[0].requests('thread/start')).toHaveLength(1)
  })
})

describe('codex-remote-service choosing the phone conversation on the computer', () => {
  it('lists every recent conversation, even with the remote switched off, and stops the Codex it started for that', async () => {
    const { s } = await conversationSetup()
    const list = await s.service.listConversations()
    expect(list).toEqual({
      supported: true,
      items: [
        { id: threadA, title: '修复登录页报错', folder: path.join('~', 'projects', 'demo'), updatedAt: codexSeconds(21, 18, 30) * 1000 },
        { id: threadC, title: '别处的对话', folder: path.join('~', 'elsewhere'), updatedAt: codexSeconds(21, 12, 0) * 1000 },
        { id: threadB, title: '整理接口文档', folder: `${path.join('~', 'projects', 'other')}/`, updatedAt: codexSeconds(20, 9, 12) * 1000 },
      ],
    })
    expect(s.codex).toHaveLength(1)
    expect(s.codex[0].kills.length).toBeGreaterThan(0)
  })

  it('reports an unchecked Codex version instead of listing', async () => {
    const { s } = await conversationSetup({ codexVersion: null })
    expect(await s.service.listConversations()).toEqual({ supported: false })
  })

  it('turns a failed read into the sentence shown in the dialog', async () => {
    const s = await setup({ codexVersion: '0.169.0', codexReplies: { 'thread/list': () => ({ error: { code: -32603, message: 'state db locked' } }) } })
    await expect(s.service.listConversations()).rejects.toThrow('无法读取对话列表，请稍后重试。')
  })

  it('switches to the chosen conversation and its folder, tells the phone and continues it on the next message', async () => {
    const { s, other } = await conversationSetup()
    const channel = await enabledAndPaired(s)
    await s.service.listConversations()
    const snapshot = await s.service.chooseConversation(threadB)
    expect(snapshot.conversation).toMatchObject({ id: threadB, title: '整理接口文档' })
    expect(snapshot.workspaceDirectory).toBe(path.join('~', 'projects', 'other'))
    await channel.sentUntil(() => channel.texts().includes('电脑端已切换到对话「整理接口文档」。'))
    channel.handlers?.onInbound(text(alice, '接着做'))
    const codex = s.codex[0]
    await codex.requestedUntil('turn/start', 1)
    expect(codex.requests('thread/start')).toHaveLength(0)
    expect(codex.requests('thread/resume')[0].params).toMatchObject({ threadId: threadB })
    expect(codex.requests('config/read').at(-1)?.params).toEqual({ cwd: other, includeLayers: true })
    expect(codex.requests('thread/settings/update')[0].params).toMatchObject({ threadId: threadB, collaborationMode: { mode: 'default' } })
    expect(codex.requests('turn/start')[0].params).toMatchObject({ threadId: threadB })
    expect(codex.requests('turn/start')[0].params).not.toHaveProperty('collaborationMode')
    expect(channel.texts()).toContain('已收到，Codex 开始处理。')
  })

  it('adds the folder of a conversation chosen outside the added folders, and refuses one whose folder is gone', async () => {
    const third = path.join(tempRoot(), 'projects', 'third')
    fs.mkdirSync(third, { recursive: true })
    const { s, workspace, other } = await conversationSetup({
      list: () => [
        codexThread(threadC, third, '别处的对话', codexSeconds(21, 12, 0)),
        codexThread(threadA, path.join(os.tmpdir(), 'xm-remote-folder-that-is-gone'), '已删掉的文件夹', codexSeconds(21, 11, 0)),
      ],
    })
    await s.service.listConversations()
    await s.service.chooseConversation(threadC)
    const settings = await s.store.readSettings()
    expect(settings.workspaceDirectories).toEqual([workspace, other, third])
    expect(settings.workspaceDirectory).toBe(third)
    await expect(s.service.chooseConversation(threadA)).rejects.toThrow('该对话所在的文件夹不允许用于手机遥控，请选择其他对话。')
  })

  it('refuses a conversation in a folder the remote may not use, and an id it did not list', async () => {
    const { s } = await conversationSetup({
      list: (folders) => [codexThread(threadC, path.dirname(path.dirname(folders.workspace)), '整个主目录', codexSeconds(21, 12, 0))],
    })
    await s.service.listConversations()
    await expect(s.service.chooseConversation(threadC)).rejects.toThrow('该对话所在的文件夹不允许用于手机遥控，请选择其他对话。')
    await expect(s.service.chooseConversation(threadA)).rejects.toThrow('无法读取对话列表，请稍后重试。')
  })

  it('does not switch while Codex is working on a phone message', async () => {
    const { s } = await conversationSetup()
    const channel = await enabledAndPaired(s)
    await prompted(s, channel)
    await s.service.listConversations()
    await expect(s.service.chooseConversation(threadB)).rejects.toThrow('Codex 正在处理消息，请待其完成后再切换对话。')
  })

  it('goes back to a new conversation, tells the phone and starts one on the next message', async () => {
    const { s } = await conversationSetup()
    const channel = await enabledAndPaired(s)
    await s.service.listConversations()
    await s.service.chooseConversation(threadB)
    expect((await s.service.chooseConversation(null)).conversation).toBeUndefined()
    await channel.sentUntil(() => channel.texts().includes('电脑端已切换为新对话。'))
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await s.codex[0].requestedUntil('turn/start', 1)
    expect(s.codex[0].requests('thread/start')).toHaveLength(1)
    expect(s.codex[0].requests('thread/resume')).toHaveLength(0)
  })

  it('forgets the chosen conversation once another folder is put in use', async () => {
    const { s } = await conversationSetup()
    await s.service.listConversations()
    await s.service.chooseConversation(threadB)
    const snapshot = await s.service.useWorkspace(path.join('~', 'projects', 'demo'))
    expect(snapshot.conversation).toBeUndefined()
    expect((await s.store.readSettings()).conversation).toBeUndefined()
  })

  it('tells the phone this Codex cannot continue conversations when it does not take the remote rules, without sending the message', async () => {
    const { s } = await conversationSetup({ codexVersion: '0.180.0', settingsUpdate: () => ({ result: {} }) })
    const channel = await enabledAndPaired(s)
    expect((await s.service.listConversations()).supported).toBe(true)
    await s.service.chooseConversation(threadB)
    channel.handlers?.onInbound(text(alice, '接着做'))
    const unsupported = '当前 Codex 版本暂不支持继续已有对话，请发送「新对话」开始新对话。'
    await channel.sentUntil(() => channel.texts().includes(unsupported))
    expect(s.codex[0].requests('thread/start')).toHaveLength(0)
    expect(s.codex[0].requests('turn/start')).toHaveLength(0)
    await vi.waitFor(async () => expect((await s.service.snapshot()).lastRequest).toMatchObject({ state: 'failed', reason: unsupported }))
    // 这一版记下了：电脑上再选别的对话、再打开列表，都直接说不支持。
    await expect(s.service.chooseConversation(threadA)).rejects.toThrow('当前 Codex 版本暂不支持继续已有对话，请选择新对话。')
    expect(await s.service.listConversations()).toEqual({ supported: false })
  })

  it('tells the phone it cannot continue when the chosen conversation is gone, without starting a new one', async () => {
    const { s } = await conversationSetup({ resume: () => ({ error: { code: -32600, message: 'thread not found' } }) })
    const channel = await enabledAndPaired(s)
    await s.service.listConversations()
    await s.service.chooseConversation(threadB)
    channel.handlers?.onInbound(text(alice, '接着做'))
    await channel.sentUntil(() => channel.texts().includes('无法继续该对话，请稍后重试，或发送「新对话」开始新对话。'))
    expect(s.codex[0].requests('thread/start')).toHaveLength(0)
    expect(s.codex[0].requests('turn/start')).toHaveLength(0)
    await vi.waitFor(async () => expect((await s.service.snapshot()).lastRequest).toMatchObject({ state: 'failed', reason: '无法继续该对话，请稍后重试，或发送「新对话」开始新对话。' }))
  })
})

describe('codex-remote-service conversation helpers', () => {
  const workspace = '/Users/a/projects/demo'

  it('keeps an existing conversation that stays within the phone level and lowers anything wider', () => {
    const readOnly = { type: 'readOnly', networkAccess: false }
    expect(resumedPermissionFits(fitsDefault, 'default', workspace, 'darwin')).toBe(true)
    expect(resumedPermissionFits({ ...fitsDefault, approvalPolicy: 'untrusted', sandbox: readOnly }, 'readOnly', workspace, 'darwin')).toBe(true)
    expect(resumedPermissionFits({ ...fitsDefault, sandbox: { ...fitsDefault.sandbox, writableRoots: [`${workspace}/`] } }, 'default', workspace, 'darwin')).toBe(true)
    expect(resumedPermissionFits(fitsDefault, 'readOnly', workspace, 'darwin')).toBe(false)
    expect(resumedPermissionFits(fullAccess, 'default', workspace, 'darwin')).toBe(false)
    expect(resumedPermissionFits({ ...fitsDefault, approvalPolicy: 'never' }, 'default', workspace, 'darwin')).toBe(false)
    expect(resumedPermissionFits({ ...fitsDefault, approvalPolicy: { granular: {} } }, 'default', workspace, 'darwin')).toBe(false)
    expect(resumedPermissionFits({ ...fitsDefault, approvalsReviewer: 'auto_review' }, 'default', workspace, 'darwin')).toBe(false)
    expect(resumedPermissionFits({ ...fitsDefault, sandbox: { ...fitsDefault.sandbox, networkAccess: true } }, 'default', workspace, 'darwin')).toBe(false)
    expect(resumedPermissionFits({ ...fitsDefault, sandbox: { ...fitsDefault.sandbox, writableRoots: ['/Users/a'] } }, 'default', workspace, 'darwin')).toBe(false)
    expect(resumedPermissionFits({ ...fitsDefault, sandbox: { type: 'externalSandbox', networkAccess: 'restricted' } }, 'default', workspace, 'darwin')).toBe(false)
    expect(resumedPermissionFits({ ...fitsDefault, sandbox: undefined }, 'default', workspace, 'darwin')).toBe(false)
  })

  it('treats folders as the same only up to a trailing slash, ignoring case on Windows alone', () => {
    expect(sameRemoteFolder('/Users/a/demo/', '/Users/a/demo', 'darwin')).toBe(true)
    expect(sameRemoteFolder('/Users/a/Demo', '/Users/a/demo', 'darwin')).toBe(false)
    expect(sameRemoteFolder('c:\\Users\\a\\demo\\', 'C:\\Users\\a\\Demo', 'win32')).toBe(true)
  })

  it('offers continuing conversations from the first Codex version it was tried on, newer ones included', () => {
    expect(readCodexVersion({ userAgent: 'xingmang_remote/0.169.0 (Ubuntu 24.4.0; x86_64) linux (xingmang_remote; 0.2.25)' })).toBe('0.169.0')
    expect(readCodexVersion({ userAgent: 'codex' })).toBeNull()
    expect(readCodexVersion(null)).toBeNull()
    expect(codexSupportsResume('0.169.0')).toBe(true)
    expect(codexSupportsResume('0.169.3')).toBe(true)
    expect(codexSupportsResume('0.170.0')).toBe(true)
    expect(codexSupportsResume('0.171.0')).toBe(true)
    expect(codexSupportsResume('1.0.0')).toBe(true)
    expect(codexSupportsResume('0.168.9')).toBe(false)
    expect(codexSupportsResume('0.16.9')).toBe(false)
    expect(codexSupportsResume('0.1690.0x')).toBe(false)
    expect(codexSupportsResume(null)).toBe(false)
  })

  it('counts the remote rules as set only when Codex reports exactly them back', () => {
    const rules = String(buildThreadStartParams(workspace).developerInstructions)
    const reported = (developerInstructions: unknown) => ({ ...resumeReply(threadA, workspace).result as Record<string, unknown>, collaborationMode: { mode: 'default', settings: { model: 'gpt-5.5', reasoning_effort: null, developer_instructions: developerInstructions } } })
    expect(remoteRulesInEffect(reported(rules))).toBe(true)
    expect(remoteRulesInEffect(resumeReply(threadA, workspace, fitsDefault, rules).result)).toBe(true)
    expect(remoteRulesInEffect(reported(`${rules} `))).toBe(false)
    expect(remoteRulesInEffect(reported(null))).toBe(false)
    expect(remoteRulesInEffect(reported('Be brief.'))).toBe(false)
    expect(remoteRulesInEffect(resumeReply(threadA, workspace).result)).toBe(false)
    expect(remoteRulesInEffect({ thread: { id: threadA } })).toBe(false)
    expect(remoteRulesInEffect(null)).toBe(false)
  })

  it('tells a request Codex refuses apart from one it never answered', () => {
    expect(codexRejectedRequest(new AppServerRequestError('Invalid request: unknown variant', -32600))).toBe(true)
    expect(codexRejectedRequest(new AppServerRequestError('Invalid params', -32602))).toBe(true)
    expect(codexRejectedRequest(new AppServerRequestError('failed to update thread settings', -32603))).toBe(false)
    expect(codexRejectedRequest(new AppServerTimeoutError('Codex 未响应（thread/settings/update）'))).toBe(false)
    expect(codexRejectedRequest(new AppServerRequestError('Codex 未运行', null))).toBe(false)
    expect(codexRejectedRequest(new Error('nope'))).toBe(false)
  })

  it('lists conversations people had, with one short title line, and leaves out sub-agents, throwaway ones and empty ones', () => {
    const listed = readListedConversations({
      data: [
        codexThread(threadA, workspace, '  修复\n登录页   报错  ', 1_795_313_244, { name: null }),
        codexThread(threadB, workspace, '第一句', 1_795_313_000, { name: '整理接口文档' }),
        codexThread(threadC, workspace, '子任务', 1_795_313_000, { parentThreadId: threadA }),
        codexThread('01a20100-0000-7000-8000-000000000001', workspace, '一次性', 1_795_313_000, { ephemeral: true }),
        codexThread('01a20100-0000-7000-8000-000000000002', workspace, '', 1_795_313_000),
        codexThread('../../etc', workspace, '编号不对', 1_795_313_000),
        codexThread('01a20100-0000-7000-8000-000000000003', 'relative/folder', '路径不对', 1_795_313_000),
        codexThread('01a20100-0000-7000-8000-000000000004', workspace, '很长'.repeat(40), 1_795_313_000),
      ],
    })
    expect(listed.map((entry) => entry.title)).toEqual(['修复 登录页 报错', '整理接口文档', `${'很长'.repeat(19)}很…`])
    expect(listed[0]).toEqual({ threadId: threadA, title: '修复 登录页 报错', cwd: workspace, updatedAt: 1_795_313_244_000 })
    expect(readListedConversations({ data: 'nope' })).toEqual([])
  })

  it('reads what thread/resume answered and refuses an answer without a thread, folder or model', () => {
    expect(readResumedThread(resumeReply(threadA, workspace).result)).toMatchObject({ threadId: threadA, cwd: workspace, model: 'gpt-5.5', reasoningEffort: 'medium', approvalPolicy: 'on-request' })
    expect(readResumedThread({ thread: { id: threadA }, model: 'gpt-5.5' })).toBeNull()
    expect(readResumedThread({ thread: { id: threadA }, cwd: workspace })).toBeNull()
  })

  it('only counts the chosen conversation while its folder is the one in use', () => {
    const conversation = { threadId: threadA, title: '修复登录页报错', folder: workspace, updatedAt: 1 }
    expect(resolveChosenConversation({ conversation, workspaceDirectory: workspace })).toEqual(conversation)
    expect(resolveChosenConversation({ conversation, workspaceDirectory: '/Users/a/projects/other' })).toBeNull()
    expect(resolveChosenConversation({ workspaceDirectory: workspace })).toBeNull()
  })
})
