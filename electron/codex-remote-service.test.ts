import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppServerProcess } from './codex-remote-app-server'
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
import { createRemoteImageStore } from './codex-remote-images'
import { createCodexRemoteKeepAwake } from './codex-remote-keep-awake'
import { encodeWeixinCredential } from './codex-remote-weixin-credential'
import { CodexRemoteStore, credentialRemoveFailedMessage } from './codex-remote-store'
import type { SafeStorageLike } from './account-session-store'
import {
  belongsToOtherTurn,
  buildApprovalRequest,
  buildFileChangeSummary,
  buildRemoteMcpServerOverrides,
  buildThreadStartParams,
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
  nextApprovalNumber,
  permissionsShowInFull,
  readFileChange,
  readRequestedPermissions,
  remoteChannelsReadyToEnable,
  sentWhileOpen,
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

class FakeCodex extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly written: Array<Record<string, unknown>> = []
  readonly kills: string[] = []
  /** 按方法名设了就等它好了才回：模拟 Codex 的回执比别的消息晚到。 */
  readonly replyGates = new Map<string, Promise<unknown>>()
  /** config/read 回什么（result 或 error）：缺省是什么外部工具都没配。 */
  configRead: Record<string, unknown> = { result: { config: {}, origins: {}, layers: [] } }
  private turns = 0
  private readonly replies = new Map<string, (message: Record<string, unknown>) => void>()
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

  private receive(message: Record<string, unknown>): void {
    this.written.push(message)
    const id = message.id
    if (typeof id === 'string' && !message.method) {
      this.replies.get(id)?.(message)
      this.replies.delete(id)
      return
    }
    if (typeof id !== 'string') return
    let reply: Record<string, unknown> | null = null
    if (message.method === 'initialize') reply = { id, result: { userAgent: 'codex' } }
    if (message.method === 'config/read') reply = { id, ...this.configRead }
    if (message.method === 'thread/start') reply = { id, result: { thread: { id: 'th-1' } } }
    if (message.method === 'turn/start') {
      this.turns += 1
      reply = { id, result: { turn: { id: `tu-${this.turns}`, status: 'inProgress' } } }
    }
    if (message.method === 'turn/interrupt') reply = { id, result: {} }
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
  private readonly waiters: Array<{ done: () => boolean; resolve: () => void }> = []

  async start(handlers: RemoteChannelHandlers): Promise<void> {
    this.handlers = handlers
    handlers.onStatus({ state: 'connected' })
  }

  async stop(): Promise<void> {
    this.stopped += 1
  }

  async send(peer: RemotePeer, message: RemoteOutbound, replyContext?: string): Promise<void> {
    this.sent.push({ peer, message, replyContext })
    for (const waiter of [...this.waiters]) {
      if (!waiter.done()) continue
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  /**
   * 发到手机的那一下让 done 成立时 resolve（已经成立就立刻 resolve）。直接等发送本身，不用 vi.waitFor 的
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
  private cards = 0

  async sendProgress(_peer: RemotePeer, card: RemoteProgressCard): Promise<string> {
    this.cards += 1
    const handle = `om_card_${this.cards}`
    this.progress.push({ op: 'send', handle, card })
    return handle
  }

  async updateProgress(handle: string, card: RemoteProgressCard): Promise<void> {
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

/** 能取图的渠道（YF-14）：images 里放好每个句柄取回来什么，取过哪些记在 fetched。 */
class FakeImageChannel extends FakeChannel {
  readonly images = new Map<string, RemoteImageFetchResult>()
  readonly fetched: string[] = []

  async fetchImage(ref: string, maxBytes: number): Promise<RemoteImageFetchResult> {
    this.fetched.push(ref)
    expect(maxBytes).toBe(10 * 1024 * 1024)
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
  const service = new CodexRemoteService({
    store,
    createChannel: () => {
      const channel = options.images
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
      await options.spawnGate
      if (options.failSpawns && options.failSpawns.remaining > 0) {
        options.failSpawns.remaining -= 1
        throw new Error('spawn codex ENOENT')
      }
      const fake = new FakeCodex()
      for (const [method, gate] of options.replyGates ?? []) fake.replyGates.set(method, gate)
      if (options.configRead) fake.configRead = options.configRead
      codex.push(fake)
      return fake as unknown as AppServerProcess
    },
    readCodexSecrets: async () => {
      await options.secretsGate
      return [apiKey]
    },
    inspectAvailability: () => unavailable.reason,
    checkCodexReady: async () => options.codexProblem ?? null,
    onStateChanged: (snapshot) => { snapshots.push(snapshot) },
    ...(options.readBalanceUsd ? { readBalanceUsd: options.readBalanceUsd } : {}),
    ...(options.images && options.imageStore !== false ? { imageStore: createRemoteImageStore(imageDirectory) } : {}),
  })
  return { service, channel: new FakeChannel(), channels, codex, snapshots, workspace, store, logs, logDetails, unavailable, imageDirectory }
}

async function enabledAndPaired(s: Setup): Promise<FakeChannel> {
  await s.service.setChannelEnabled('feishu', true)
  const channel = s.channels[0]
  await s.service.startPairing('feishu')
  channel.handlers?.onInbound(text(alice, '000042'))
  await channel.sentUntil(() => channel.texts().includes('配对成功。这台电脑上的 Codex 现在只听你的。直接发消息就能让它干活，发「帮助」看能用的指令。'))
  channel.sent.length = 0
  return channel
}

async function prompted(s: Setup, channel: FakeChannel, body = '跑一下测试'): Promise<FakeCodex> {
  channel.handlers?.onInbound(text(alice, body))
  await vi.waitFor(() => expect(s.codex[0]?.requests('turn/start').length ?? 0).toBeGreaterThan(0))
  return s.codex[0]
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

const permissionsRefusedText = 'Codex 想多要一些权限，但要的范围手机上显示不全，已经替你拒绝了。确实需要的话，请在电脑上直接用 Codex 做这件事。'

const commandRefusedText = 'Codex 想运行的命令太长，手机上显示不全，已经替你拒绝了。确实需要的话，请在电脑上直接用 Codex 做这件事。'

const npmRegistry = { host: 'registry.npmjs.org', protocol: 'https' }

const staleCardText = '这张卡片已经失效了（处理过、超时了，或者电脑上的星芒重开过），刚才点的没有生效。有要你同意的事会另发新卡片。'

const clockAheadText = '电脑上的时间和手机差得太多，这条消息没有执行。请把电脑时间调准后再发。'

function staleNotice(minutes: number): string {
  return `这条是 ${minutes} 分钟前发的，那会儿电脑没连上，没有执行。还要做的话请再发一次。`
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

  it('starts threads that ask the user before anything outside the safe list runs', () => {
    expect(buildThreadStartParams('/p')).toMatchObject({
      cwd: '/p',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    })
    expect(JSON.stringify(buildThreadStartParams('/p'))).not.toContain('danger-full-access')
  })

  // #1407 P2-4：客户自己接的外部工具调用不一定先问人，遥控开的对话里一律关掉；联网搜索不动。
  it('starts threads without plugins, apps or the configured MCP servers, and leaves web search alone', () => {
    expect(buildThreadStartParams('/p').config).toEqual({ 'features.apps': false, 'features.plugins': false })
    expect(buildThreadStartParams('/p', { docs: { enabled: false } }).config).toEqual({
      'features.apps': false,
      'features.plugins': false,
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
    expect(change.summary).toContain('另外还有 5 个文件')
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
    expect(summary.split('\n')).toEqual([...files.slice(0, 17), '另外还有 8 个文件', '可写范围：/Volumes/Work/customer-portal'])
    // Without a write scope the whole budget goes to the file list.
    expect(buildFileChangeSummary({}, pathsOnly(files), display)?.split('\n')).toEqual([...files.slice(0, 18), '另外还有 7 个文件'])
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
      '改 ~/projects/demo/app.ts +2 -1 行',
      '~/projects/demo/a.ts 挪到 ~/projects/demo/b.ts +1 -1 行',
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

  it('refuses to start when Codex is not installed on this computer', async () => {
    const s = await setup({ codexProblem: '这台电脑还没装 Codex 命令行工具，先在首页把它装好。' })
    await expect(s.service.setChannelEnabled('feishu', true)).rejects.toThrow('这台电脑还没装 Codex 命令行工具')
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
    first.handlers?.onStatus({ state: 'error', message: '这个飞书应用在别处也连着，先关掉别处再试。', problem: 'connection-limit' })
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

  // YKS-6：微信重新扫码、服务端认出是原来那份登录时凭据没换；渠道停在「需要重新登录」就重连一次，连着的、关着的不动。
  it('reconnects a channel stuck on signing in again once the old login is recognised, and leaves a working or closed one alone', async () => {
    const s = await setup()
    await s.service.reconnectIfLoggedOut('feishu')
    expect(s.channels).toHaveLength(0)
    const first = await enabledAndPaired(s)
    await s.service.reconnectIfLoggedOut('feishu')
    expect(first.stopped).toBe(0)
    expect(s.channels).toHaveLength(1)

    first.handlers?.onStatus({ state: 'needs-login', message: '微信这边的登录已经过期，请在电脑上重新扫码' })
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
    first.handlers?.onStatus({ state: 'needs-login', message: '微信这边的登录已经过期，请在电脑上重新扫码' })
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
    options.codexProblem = '这台电脑还没装 Codex 命令行工具，先在首页把它装好。'
    s.snapshots.length = 0
    expect(await s.service.enableReadyChannels()).toEqual({ opened: [], failure: '这台电脑还没装 Codex 命令行工具，先在首页把它装好。' })
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
    await s.channels[0].sentUntil(() => s.channels[0].texts().some((line) => line.startsWith('电脑上的手机遥控打开了')))
    expect(s.channels[0].sent[0].peer).toMatchObject({ userId: alice.userId })
  })

  it('only logs when it cannot open, leaving the switch on for next time', async () => {
    const root = tempRoot()
    const first = await setup({ root })
    await enabledAndPaired(first)
    await first.service.setAutoStart(true)
    first.service.dispose()

    const s = await setup({ root, codexProblem: '这台电脑还没装 Codex 命令行工具，先在首页把它装好。' })
    await s.service.startOnLaunch()
    expect(s.service.hasEnabledChannel()).toBe(false)
    expect(s.logDetails.find((entry) => entry.event === 'remote.auto-started')?.detail).toEqual({ opened: 0, failed: true })
    expect((await s.service.snapshot()).autoStart).toBe(true)
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
    await vi.waitFor(async () => expect((await s.service.snapshot()).channels.feishu.boundPeer?.userIdTail).toBe('1234'))
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
    await vi.waitFor(() => expect(s.codex[0]?.requests('turn/start').length ?? 0).toBe(1))
    expect(channel.texts()).toEqual([clockAheadText, '收到，Codex 开始处理。'])
    // Something sent before the clock was set right is still too old to run.
    channel.handlers?.onInbound(text(alice, '调钟以前发的', { sentAt: Date.now() - 2 * 60_000, clockAheadMs: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.texts()).toEqual([clockAheadText, '收到，Codex 开始处理。'])
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
    await vi.waitFor(() => expect(channel.texts()).toHaveLength(4))
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
    expect(channel.texts()[0]).toBe('收到，Codex 开始处理。')
    expect(codex.requests('config/read')[0].params).toEqual({ cwd: s.workspace, includeLayers: true })
    expect(codex.requests('thread/start')[0].params).toMatchObject({
      cwd: s.workspace,
      approvalPolicy: 'untrusted',
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
    await vi.waitFor(() => expect(channel.texts()).toContain('这一轮没做完：failed to read configuration layers'))
    expect(s.codex[0].requests('thread/start')).toHaveLength(0)
    expect(s.codex[0].requests('turn/start')).toHaveLength(0)
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
  })

  it('keeps one turn at a time and reuses the thread', async () => {
    const s = await setup({ now: () => Date.UTC(2026, 10, 11, 6, 0, 0) })
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await vi.waitFor(() => expect(channel.texts()).toContain('Codex 还在处理上一条。等它做完再发，或者发「停止」中断它。'))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(() => expect(channel.texts()).toContain('这一轮做完了，Codex 没有留下文字回复。\n\n用时 1 秒。'))
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
    expect(codex.requests('thread/start')).toHaveLength(1)
  })

  it('stops a running turn on request', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    channel.handlers?.onInbound(text(alice, '停止'))
    await vi.waitFor(() => expect(codex.requests('turn/interrupt')).toHaveLength(1))
    expect(codex.requests('turn/interrupt')[0].params).toEqual({ threadId: 'th-1', turnId: 'tu-1' })
    await vi.waitFor(() => expect(channel.texts()).toContain('已停止。'))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'interrupted' } })
    channel.handlers?.onInbound(text(alice, '停止'))
    await vi.waitFor(() => expect(channel.texts()).toContain('现在没有在处理的任务。'))
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
    await vi.waitFor(() => expect(channel.texts()).toContain('这件事 1 小时没有任何进展，已经停下。可以重新说一遍要做什么。'))
    expect(s.logs).toContain('remote.turn-stalled')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'interrupted' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    expect(channel.texts()).not.toContain('已停止。')
    channel.handlers?.onInbound(text(alice, '再来一次'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
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
    await vi.waitFor(() => expect(channel.texts()).toContain('第 1 条等了 10 分钟没回，已自动拒绝。'))
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
    // 问审批算一次动静：卡死从第 55 分钟再数一小时（第 115 分钟），不是从开始数的第 60 分钟。
    await vi.advanceTimersByTimeAsync(49 * 60_000)
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(codex.requests('turn/interrupt')).toHaveLength(1))
    await vi.waitFor(() => expect(channel.texts()).toContain('这件事 1 小时没有任何进展，已经停下。可以重新说一遍要做什么。'))
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
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'failed', error: { message: `401 for key ${apiKey}` } } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).lastRequest).toMatchObject({ state: 'failed', reason: '401 for key [已隐去]' }))
  })

  it('gives the plain reason for a failure it recognises, and none when Codex could not start', async () => {
    const s = await setup({ failSpawns: { remaining: 1 } })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.texts().includes('电脑上的 Codex 没能启动，请在电脑上的星芒里看一下。'))
    await vi.waitFor(async () => expect((await s.service.snapshot()).lastRequest?.state).toBe('failed'))
    expect((await s.service.snapshot()).lastRequest?.reason).toBeUndefined()
    const codex = await prompted(s, channel, '再跑一次')
    const quota = 'unexpected status 403 Forbidden: {"error":{"message":"用户额度不足, 剩余额度: $0.01","code":"insufficient_user_quota"}}'
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'failed', error: { message: quota, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } } } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).lastRequest).toMatchObject({ state: 'failed', reason: '余额不够了，充值后再发一次。' }))
  })

  it('marks the last request stopped when the phone says stop, and forgets it once every channel is off', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await prompted(s, channel)
    channel.handlers?.onInbound(text(alice, '停止'))
    await vi.waitFor(() => expect(channel.texts()).toContain('已停止。'))
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
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
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
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('这一轮没做完：401 for key [已隐去]'))
  })

  // D66 / YKS-8：余额不够、登录失效这类原话（英文、JSON）不再原样发到手机，原话进日志。
  it('says what went wrong in plain words for the failures the customer can fix, and logs the original', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const quota = 'unexpected status 403 Forbidden: {"error":{"message":"用户额度不足, 剩余额度: $0.01","code":"insufficient_user_quota"}}, url: https://relay.example.test/v1/responses'
    codex.notify('error', { threadId: 'th-1', turnId: 'tu-1', willRetry: false, error: { message: quota, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } }, additionalDetails: null } })
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'failed', error: null } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('余额不够了，充值后再发一次。'))
    expect(channel.texts().join('\n')).not.toContain('insufficient_user_quota')
    const logged = s.logDetails.find((entry) => entry.event === 'remote.turn-failed')?.detail
    expect(logged).toMatchObject({ channel: 'feishu', kind: 'balance' })
    expect(String(logged?.reason)).toContain('insufficient_user_quota')

    channel.handlers?.onInbound(text(alice, '再来'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'failed', error: { message: 'Codex ran out of room in the model\'s context window.', codexErrorInfo: 'contextWindowExceeded' } } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('这段对话太长了，发「新对话」重新开始。'))

    channel.handlers?.onInbound(text(alice, '再来'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(3))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-3', status: 'failed', error: { message: `unexpected status 401 Unauthorized: {"error":{"message":"无效的令牌 ${apiKey}"}}`, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } } } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('电脑上的登录失效了，请在电脑上的星芒里重新登录。'))
    const loginLog = s.logDetails.filter((entry) => entry.event === 'remote.turn-failed').at(-1)?.detail
    expect(String(loginLog?.reason)).not.toContain(apiKey)

    channel.handlers?.onInbound(text(alice, '再来'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(4))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-4', status: 'failed', error: { message: 'stream disconnected before completion: error sending request', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('电脑这会儿连不上星芒的线路，过一会儿再发。'))
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
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(`工作文件夹：${path.join('~', 'projects', 'demo')}\n现在：正在处理，已经 6 分钟，做到「运行测试」\n余额：$12.40\n再过 4 小时没新消息就自动关`))
    // 计划里一条正在做的都没有了（都做完了），就不写「做到…」。
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', explanation: null, plan: [{ step: '读代码', status: 'completed' }] })
    channel.handlers?.onInbound(text(alice, '状态'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(`工作文件夹：${path.join('~', 'projects', 'demo')}\n现在：正在处理，已经 6 分钟\n余额：$12.40\n再过 4 小时没新消息就自动关`))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    channel.handlers?.onInbound(text(alice, '状态'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(`工作文件夹：${path.join('~', 'projects', 'demo')}\n现在：空闲\n余额：$12.40\n再过 4 小时没新消息就自动关`))
  })

  it('leaves the balance and idle close lines out when the balance cannot be read and the remote never closes by itself', async () => {
    const s = await setup({ readBalanceUsd: async () => { throw new Error('network down') } })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '状态'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(`工作文件夹：${path.join('~', 'projects', 'demo')}\n现在：空闲`))
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
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('改好了。\n\n用时 3 分 20 秒，改了 2 个文件：a.ts、b.css。'))

    channel.handlers?.onInbound(text(alice, '再来一个'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
    now += 45_000
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'failed', error: { message: 'boom' } } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('这一轮没做完：boom'))
  })

  // YF-22：「重试」把这次打开以后最后一句交给 Codex 的话再发一次；关了再开就没有「上一条」了。
  it('sends the last prompt again on retry, says which one, and forgets it once the remote is switched off', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '重试'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('还没有可以重发的上一条。直接发要做的事就行。'))
    const prompt = '把登录页的表单校验全部改成新的写法，再补上测试'
    const codex = await prompted(s, channel, prompt)
    channel.handlers?.onInbound(text(alice, '重试'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('Codex 还在处理上一条。等它做完再发，或者发「停止」中断它。'))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'failed', error: { message: 'boom' } } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    channel.handlers?.onInbound(text(alice, '重试'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
    expect(channel.texts()).toContain('再发一次上一条：「把登录页的表单校验全部改成新的写法，再补…」\n收到，Codex 开始处理。')
    expect(codex.requests('turn/start')[1].params).toEqual({ threadId: 'th-1', input: [{ type: 'text', text: prompt, text_elements: [] }] })

    await s.service.setChannelEnabled('feishu', false)
    await s.service.setChannelEnabled('feishu', true)
    const reopened = s.channels.at(-1) as FakeChannel
    reopened.handlers?.onInbound(text(alice, '重试'))
    await vi.waitFor(() => expect(reopened.texts()).toContain('还没有可以重发的上一条。直接发要做的事就行。'))
  })

  it('tells the phone when Codex dies mid-turn', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.emit('exit', 1, null)
    await vi.waitFor(() => expect(channel.texts().at(-1)).toContain('意外退出'))
    // 卡片「最近一次」跟着说没做完，不会一直停在「正在处理」（YF-13）。
    expect((await s.service.snapshot()).lastRequest).toMatchObject({ state: 'failed', reason: '电脑上的 Codex 意外退出了，再发一次试试。' })
    channel.handlers?.onInbound(text(alice, '再试一次'))
    await vi.waitFor(() => expect(s.codex).toHaveLength(2))
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
    await vi.waitFor(() => expect(channel.texts()).toEqual(['收到，Codex 开始处理。']))
    channel.handlers?.onInbound(text(alice, '状态'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toContain('现在：正在处理'))
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('Codex 还在处理上一条。等它做完再发，或者发「停止」中断它。'))
    channel.handlers?.onInbound(text(alice, '停止'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('已停止。'))
    release()
    await vi.waitFor(() => expect(s.codex).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(s.codex[0].requests('thread/start')).toHaveLength(0)
    expect(s.codex[0].requests('turn/start')).toHaveLength(0)
    expect((await s.service.snapshot()).task).toBe('idle')
  })

  it('hands the next turn to Codex only after the one stopped on its way has been interrupted', async () => {
    let release!: () => void
    const s = await setup({ replyGates: new Map([['turn/start', new Promise<void>((resolve) => { release = resolve })]]) })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await vi.waitFor(() => expect(s.codex[0]?.requests('turn/start').length ?? 0).toBe(1))
    const codex = s.codex[0]
    channel.handlers?.onInbound(text(alice, '停止'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('已停止。'))
    channel.handlers?.onInbound(text(alice, '换个做法'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('收到，Codex 开始处理。'))
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
    expect(channel.texts()).toEqual(['收到，Codex 开始处理。'])
    await vi.advanceTimersByTimeAsync(1_000)
    await channel.sentUntil(() => channel.texts().length === 2)
    expect(channel.texts()[1]).toBe('电脑正在准备 Codex，稍等一下；想取消就发「停止」。')
    release()
    await vi.waitFor(() => expect(s.codex[0]?.requests('turn/start').length ?? 0).toBe(1))
    // A Codex that is already running answers at once: no such line on the next turn.
    s.codex[0].notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await channel.sentUntil(() => channel.texts().length === 3)
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await vi.waitFor(() => expect(s.codex[0].requests('turn/start')).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(channel.texts().filter((line) => line.startsWith('电脑正在准备 Codex'))).toHaveLength(1)
  })

  // D66 / YKS-16：对话不是他自己发「新对话」丢的，下一次回复前说一声。
  it('says the conversation starts afresh only when it was dropped without the phone asking', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect(channel.texts()[0]).toBe('收到，Codex 开始处理。')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    // The same thread goes on: nothing to warn about.
    channel.handlers?.onInbound(text(alice, '接着改'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
    expect(channel.texts().filter((line) => line.includes('这是新对话'))).toHaveLength(0)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    // The folder changed on the computer: the old conversation is gone.
    const other = path.join(path.dirname(s.workspace), 'other')
    fs.mkdirSync(other)
    await s.service.addWorkspace(other)
    await s.service.useWorkspace(path.join('~', 'projects', 'other'))
    channel.sent.length = 0
    channel.handlers?.onInbound(text(alice, '再改一下'))
    await vi.waitFor(() => expect(codex.requests('thread/start')).toHaveLength(2))
    expect(channel.texts()[0]).toBe('这是新对话，前面的记不得了。\n收到，Codex 开始处理。')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-3', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    // Asked for by the phone: no warning afterwards.
    channel.handlers?.onInbound(text(alice, '新对话'))
    await vi.waitFor(() => expect(channel.texts()).toContain('已开始新对话。'))
    channel.sent.length = 0
    channel.handlers?.onInbound(text(alice, '从头来'))
    await vi.waitFor(() => expect(codex.requests('thread/start')).toHaveLength(3))
    expect(channel.texts()[0]).toBe('收到，Codex 开始处理。')
  })

  // #1407 P3-1：起 Codex 要一会儿，这期间电脑上关了遥控。话不能再交给 Codex（交了就扣钱、只读命令先跑），
  // 起好的那份 Codex 也不能留着没人管。
  it('hands nothing to a Codex that finishes starting after the remote was switched off, and stops it', async () => {
    let release!: () => void
    const s = await setup({ spawnGate: new Promise<void>((resolve) => { release = resolve }) })
    const channel = await enabledAndPaired(s)
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await vi.waitFor(() => expect(channel.texts()).toContain('收到，Codex 开始处理。'))
    await s.service.setChannelEnabled('feishu', false)
    release()
    await vi.waitFor(() => expect(s.codex[0]?.kills.length ?? 0).toBeGreaterThan(0))
    expect(s.codex[0].requests('thread/start')).toHaveLength(0)
    expect(s.codex[0].requests('turn/start')).toHaveLength(0)
    expect(s.logs).toContain('remote.codex-start-abandoned')
    expect(s.logs).not.toContain('remote.codex-start-failed')
    expect(channel.texts()).not.toContain('电脑上的 Codex 没能启动，请在电脑上的星芒里看一下。')
    expect((await s.service.snapshot()).codexStartFailed).toBeUndefined()
  })

  // YK-5：手机上收到「Codex 没能启动」，电脑卡片上也要看得见；Codex 下次起来了就收起。
  it('tells the window Codex could not start until a later message gets it started', async () => {
    const s = await setup({ failSpawns: { remaining: 1 } })
    const channel = await enabledAndPaired(s)
    expect((await s.service.snapshot()).codexStartFailed).toBeUndefined()
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await channel.sentUntil(() => channel.texts().includes('电脑上的 Codex 没能启动，请在电脑上的星芒里看一下。'))
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
    await channel.sentUntil(() => channel.texts().includes('电脑上的 Codex 没能启动，请在电脑上的星芒里看一下。'))
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
    await vi.waitFor(() => expect(channel.texts()).toContain('收到，Codex 开始处理。'))
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
    await vi.waitFor(() => expect(s.codex[0]?.requests('thread/start').length ?? 0).toBe(1))
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
    await vi.waitFor(() => expect(channel.texts()).toContain('已停止。'))
    let release!: () => void
    codex.replyGates.set('turn/start', new Promise<void>((resolve) => { release = resolve }))
    channel.handlers?.onInbound(text(alice, '换个做法'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
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
  const receivedImage = '收到图片。再发一句要 Codex 做什么，会跟图片一起交给它。'

  // YF-14：只发图时先攒着、回一句；下一句话交给 Codex 时带上，「收到」那句说几张。
  it('holds images until the next prompt, then hands them to Codex as local images', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.images.set('img-b', { ok: true, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a']))
    await vi.waitFor(() => expect(channel.texts()).toEqual([receivedImage]))
    channel.handlers?.onInbound(imageMessage(alice, ['img-b']))
    await vi.waitFor(() => expect(channel.fetched).toEqual(['img-a', 'img-b']))
    const stored = storedImages(s.imageDirectory)
    expect(stored).toHaveLength(2)
    expect(stored.some((name) => name.endsWith('.png')) && stored.some((name) => name.endsWith('.jpg'))).toBe(true)

    const codex = await prompted(s, channel, '这两张图里的报错是什么')
    expect(channel.texts()).toEqual([receivedImage, '收到，带着 2 张图片，Codex 开始处理。'])
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
    await vi.waitFor(() => expect(channel.texts()).toHaveLength(1))
    expect(channel.fetched).toEqual([])
    expect(storedImages(s.imageDirectory)).toEqual([])
  })

  it('takes the words sent with the images as the prompt', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a'], '照这张图改按钮颜色'))
    await vi.waitFor(() => expect(s.codex[0]?.requests('turn/start').length ?? 0).toBe(1))
    expect(channel.texts()).toEqual(['收到，带着 1 张图片，Codex 开始处理。'])
    const input = (s.codex[0].requests('turn/start')[0].params as { input: Array<Record<string, unknown>> }).input
    expect(input.map((entry) => entry.type)).toEqual(['text', 'localImage'])
  })

  it('says why an image was not taken, once per reason', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('big', { ok: false, reason: 'too-large' })
    channel.images.set('denied', { ok: false, reason: 'permission' })
    channel.images.set('broken', { ok: false, reason: 'failed' })
    channel.images.set('not-image', { ok: true, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) })
    channel.handlers?.onInbound(imageMessage(alice, ['big', 'denied', 'broken', 'not-image', 'big']))
    await vi.waitFor(() => expect(channel.texts()).toEqual([
      '这张图片太大了，电脑没收。请发小一点的，或者截一部分。',
      '这张图片电脑没取到。飞书后台要多开一个权限「获取单聊、群组消息」，再发布一个版本。',
      '这张图片电脑没取到，请再发一次。',
    ]))
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
    await vi.waitFor(() => expect(channel.texts()).toEqual([receivedImage, '一次最多带 5 张图片，这张没收。']))
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
    await vi.waitFor(() => expect(channel.fetched).toEqual(['img-a', 'img-b']))
    channel.handlers?.onInbound(text(alice, '新对话'))
    await vi.waitFor(() => expect(storedImages(s.imageDirectory)).toHaveLength(1))

    channel.handlers?.onInbound(text(alice, '重试'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(2))
    expect(channel.texts().at(-1)).toBe('再发一次上一条：「看看这张」\n收到，带着 1 张图片，Codex 开始处理。')
    const first = (codex.requests('turn/start')[0].params as { input: unknown[] }).input
    const again = (codex.requests('turn/start')[1].params as { input: unknown[] }).input
    expect(again).toEqual(first)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))

    // 下一句不带图：上一句的图不再要了。
    channel.handlers?.onInbound(text(alice, '接着做'))
    await vi.waitFor(() => expect(codex.requests('turn/start')).toHaveLength(3))
    expect((codex.requests('turn/start')[2].params as { input: unknown[] }).input).toHaveLength(1)
    await vi.waitFor(() => expect(storedImages(s.imageDirectory)).toEqual([]))
  })

  it('deletes every stored image when the remote is switched off', async () => {
    const s = await setup({ images: true })
    const channel = await enabledAndPaired(s) as FakeImageChannel
    channel.images.set('img-a', { ok: true, bytes: pngBytes })
    channel.handlers?.onInbound(imageMessage(alice, ['img-a']))
    await vi.waitFor(() => expect(storedImages(s.imageDirectory)).toHaveLength(1))
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
    await vi.waitFor(() => expect(channel.texts()).toEqual([
      '暂时只支持文字和图片。语音、文件发不过来，请打成字。',
      '暂时只支持文字和图片。语音、文件发不过来，请打成字。',
    ]))
    expect(channel.fetched).toEqual([])
  })
})

// YF-19（yoyo 2026-11-11「文件夹改」）：电脑上加几个干活的文件夹，手机上发「文件夹」看、发「文件夹 2」换。
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
    await expect(s.service.removeWorkspace(shown('blog'))).rejects.toThrow('正在用的文件夹不能移除，先换到别的再移除。')
    snapshot = await s.service.removeWorkspace(shown('demo'))
    expect(snapshot.workspaceDirectory).toBe(shown('blog'))
    expect(snapshot).not.toHaveProperty('workspaces')
    // Only folders on the list: the renderer cannot name another one.
    await expect(s.service.useWorkspace(shown('demo'))).rejects.toThrow('这个文件夹已经不在单子上了。')
    await expect(s.service.useWorkspace('/etc')).rejects.toThrow('这个文件夹已经不在单子上了。')
  })

  it('keeps at most five folders and still refuses a folder too broad to work in', async () => {
    // These are real folders, so the guard has to use this machine's path rules: under the
    // darwin rules a C:\ path is not absolute and the home folder would slip through.
    const s = await setup({ platform: process.platform })
    for (const name of ['b', 'c', 'd', 'e']) await s.service.addWorkspace(folder(s, name))
    expect((await s.service.snapshot()).workspaces).toHaveLength(5)
    await expect(s.service.addWorkspace(folder(s, 'f'))).rejects.toThrow('最多加 5 个文件夹，先移除一个再添加。')
    await s.service.removeWorkspace(shown('e'))
    await expect(s.service.addWorkspace(path.dirname(path.dirname(s.workspace)))).rejects.toThrow('手机遥控不能在这里用')
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
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(`1. ${shown('demo')}（正在用）\n2. ${shown('blog')}\n回「文件夹 2」切过去。`))
    channel.handlers?.onInbound(text(alice, '文件夹 1'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(`现在用的就是 ${shown('demo')}。`))
    channel.handlers?.onInbound(text(alice, '文件夹 3'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('没有第 3 个文件夹。发「文件夹」看有哪些。'))
    channel.handlers?.onInbound(text(alice, '文件夹 2'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(`已切到 ${shown('blog')}，从新对话开始。`))
    expect((await s.service.snapshot()).workspaceDirectory).toBe(shown('blog'))
    expect(s.logs).toContain('remote.workspace-switched')
    channel.sent.length = 0
    const codex = await prompted(s, channel)
    expect(codex.requests('thread/start')[0]).toMatchObject({ params: { cwd: path.join(path.dirname(s.workspace), 'blog') } })
    // The phone already heard it starts afresh: no second warning.
    expect(channel.texts()[0]).toBe('收到，Codex 开始处理。')
  })

  it('does not switch folders while a turn is still going, and says so when the folder is gone', async () => {
    const s = await setup()
    const blog = folder(s, 'blog')
    await s.service.addWorkspace(blog)
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    channel.handlers?.onInbound(text(alice, '文件夹 2'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('Codex 还在处理上一条，等它做完再换文件夹。'))
    await expect(s.service.useWorkspace(shown('blog'))).rejects.toThrow('Codex 正在处理手机上发来的任务，等它做完再换文件夹。')
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
    fs.rmSync(blog, { recursive: true })
    channel.handlers?.onInbound(text(alice, '文件夹 2'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(`${shown('blog')} 现在打不开了，可能被移走或删掉了。先在电脑上看一下。`))
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
    expect(update.message.text).not.toContain('回「同意')
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
    const answer = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect((await answer).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.approvalUpdates.map((entry) => entry.outcome)).toEqual(['expired']))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('第 1 条等了 10 分钟没回，已自动拒绝。'))
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
      card: { state: 'running', steps: [{ text: '读登录页的代码', status: 'inProgress' }, { text: '改登录页', status: 'pending' }], elapsed: '已经不到 1 分钟' },
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
    expect(channel.progress[0]).toMatchObject({ op: 'send', card: { state: 'running', steps: [], elapsed: '已经 2 分钟' } })
    clock += 5 * 60_000
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(channel.progress).toHaveLength(2))
    expect(channel.progress[1]).toMatchObject({ op: 'update', card: { elapsed: '已经 7 分钟' } })
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
    await vi.waitFor(() => expect(channel.texts()).toContain('这张卡片是上一轮的，现在这一轮没有停。要停请发「停止」。'))
    expect(codex.requests('turn/interrupt')).toHaveLength(0)
    // Someone else pressing a card the bot sent is not the bound person.
    channel.handlers?.onInbound({ kind: 'stop', peer: mallory, direct: true, nonce })
    channel.handlers?.onInbound({ kind: 'stop', peer: alice, direct: true, nonce })
    await vi.waitFor(() => expect(channel.texts()).toContain('已停止。'))
    expect(codex.requests('turn/interrupt')).toHaveLength(1)
    await vi.waitFor(() => expect(channel.progress.at(-1)?.card.state).toBe('stopped'))
    expect(s.logs).toContain('remote.turn-stopped-from-card')
    channel.handlers?.onInbound({ kind: 'stop', peer: alice, direct: true, nonce })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('现在没有在处理的任务。'))
  })

  it('says it is still working every five minutes on a channel without cards, and keeps quiet while waiting for approval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = Date.UTC(2026, 10, 11, 12)
    const s = await setup({ now: () => clock })
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    clock += 5 * 60_000
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('还在做，已经 5 分钟。'))
    codex.notify('turn/plan/updated', { threadId: 'th-1', turnId: 'tu-1', plan: [{ step: '读登录页的代码', status: 'completed' }, { step: '改登录页', status: 'inProgress' }] })
    clock += 5 * 60_000
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('还在做，已经 10 分钟。现在这一步：改登录页'))
    void codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    const sent = channel.sent.length
    clock += 5 * 60_000
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(channel.texts().slice(sent).filter((line) => line.startsWith('还在做'))).toHaveLength(0)
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
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('没有第 1 条等你同意的操作。'))
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
    await vi.waitFor(() => expect(channel.texts().at(-1)).toContain('现在有 2 条等你同意（1、2）'))
    channel.handlers?.onInbound(text(alice, '同意 9'))
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('没有第 9 条等你同意的操作。'))
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
    const answer = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect((await answer).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('第 1 条等了 10 分钟没回，已自动拒绝。'))
  })

  // YF-20：还剩 3 分钟时提醒一次，人在路上没看到也还来得及回；回过了就不再提醒。
  it('reminds once with three minutes left, and not at all once answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const reminder = '第 1 条还在等你，3 分钟后自动拒绝。回「同意 1」或「拒绝 1」。'
    const first = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await approvalCardsSent(channel, 1)
    await vi.advanceTimersByTimeAsync(7 * 60_000 - 1_000)
    expect(channel.texts()).not.toContain(reminder)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe(reminder))
    expect(s.logs).toContain('remote.approval-reminded')
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect((await first).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('第 1 条等了 10 分钟没回，已自动拒绝。'))
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
    await vi.waitFor(() => expect(approvalsSent(channel)).toHaveLength(1))
    expect(approvalsSent(channel)[0]).toMatchObject({ approvalId: '1', kind: 'file-change' })
    const lines = approvalsSent(channel)[0].summary.split('\n')
    expect(lines[0]).toBe(`改 ${files[0]} +0 -0 行`)
    expect(lines.slice(-2)).toEqual(['另外还有 10 个文件', '可写范围：/Volumes/Work/customer-portal'])
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
    expect(channel.texts()).toContain('[approval] Codex 想连网站（第 1 条）：\nregistry.npmjs.org\n原因：要下载依赖\n回「同意 1」或「拒绝 1」。')
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
    expect(channel.texts().some((line) => line.startsWith('[approval] Codex 想往正在运行的程序里输入（第 2 条）：\nwrite_stdin --session-id 3 yes\n'))).toBe(true)
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
    await vi.waitFor(() => expect(s.service.hasEnabledChannel()).toBe(false))
    await vi.waitFor(() => expect(s.snapshots.at(-1)).toMatchObject({ channels: { feishu: { enabled: false }, weixin: { enabled: false } } }))
    expect(channel.texts()).toEqual(['手机遥控已关闭。要再用，请在电脑上的星芒里重新打开。'])
    expect(channel.sent[0].replyContext).toMatch(/^ctx-/)
    expect(channel.stopped).toBe(1)
    expect(weixin.stopped).toBe(1)
    expect(codex.kills).toContain('SIGTERM')
    expect(s.logs).toContain('remote.closed-from-phone')
    // 关了以后再发什么都没人理，得回电脑上打开。
    channel.handlers?.onInbound(text(alice, '跑一下测试'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.texts()).toHaveLength(1)
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
    expect(first.texts().some((line) => line.startsWith('电脑上的手机遥控打开了'))).toBe(false)
    await s.service.setChannelEnabled('feishu', false)

    await s.service.setChannelEnabled('feishu', true)
    const second = s.channels[1]
    // The folder is real (path.join), so on Windows it reads ~\projects\demo.
    const opened = `电脑上的手机遥控打开了，可以发消息了。工作文件夹：${path.join('~', 'projects', 'demo')}`
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
    expect(channel.texts()).toEqual(['电脑上的星芒关了，遥控已停。再打开星芒并打开遥控才能继续。'])
    expect(channel.stopped).toBe(0)
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(true)
    s.service.dispose()
    await vi.waitFor(() => expect(channel.stopped).toBe(1))
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
    expect(channel.texts()).toEqual(['电脑上的星芒关了，遥控已停。再打开星芒并打开遥控才能继续。', '电脑上的星芒没关成，遥控还开着，可以接着用。'])
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
    await vi.waitFor(() => expect(channel.texts()).toContain('4 小时没有新消息，手机遥控已自动关闭。要再用，请在电脑上的星芒里重新打开。'))
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(false)
  })

  // D66 / YKS-19：自动关之前 10 分钟提醒一次，回什么都续上。
  it('warns ten minutes before the idle close and stays open when the phone answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup({ idleCloseHours: 4 })
    const channel = await enabledAndPaired(s)
    const warning = '手机遥控 10 分钟后自动关闭，还要用的话随便回一句就行。'
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
    await channel.sentUntil(() => channel.texts().includes('手机遥控 10 分钟后自动关闭，还要用的话随便回一句就行。'))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await vi.waitFor(() => expect(channel.texts()).toContain('12 小时没有新消息，手机遥控已自动关闭。要再用，请在电脑上的星芒里重新打开。'))
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
    await vi.waitFor(() => expect(channel.texts()).toContain('4 小时没有新消息，手机遥控已自动关闭。要再用，请在电脑上的星芒里重新打开。'))
  })

  // D66 / YKS-18：解绑、换人、退出登录，原来那个人要知道之后发的话不会再执行。
  it('tells the bound person before unbinding, handing over to someone else, or logging out', async () => {
    const unboundText = '电脑上已经把你解绑了，之后发的消息不会再执行。'
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

  it('does not swallow a failure to save a new credential as a logout failure', async () => {
    const s = await setup()
    vi.spyOn(s.store, 'writeCredential').mockRejectedValueOnce(new Error('这台电脑没法安全保存密码，凭据没有保存。'))
    await expect(s.service.saveChannelCredential('feishu', JSON.stringify({ appId: 'cli_other1', appSecret: 'z'.repeat(16) }), 'cli_other1')).rejects.toThrow('没法安全保存')
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
      update: '手机遥控里的 Codex 正在干活，等它做完再更新，或者先在设置里关掉手机遥控。',
      uninstall: '手机遥控里的 Codex 正在干活，等它做完再卸载，或者先在设置里关掉手机遥控。',
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
    await vi.waitFor(() => expect(s.codex[1]?.requests('turn/start').length ?? 0).toBe(1))
    expect(s.codex[1].requests('thread/start')).toHaveLength(1)
  })

  it('leaves a Codex in the middle of a phone task alone and says why', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    await expect(s.service.releaseCodex('update')).rejects.toThrow(codexRemoteBusyMessages.update)
    // 等你同意的那一会儿也算在干活。
    void codex.ask('item/commandExecution/requestApproval', commandRequest)
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('waiting-approval'))
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
    await vi.waitFor(() => expect(channel.texts()).toContain('收到，Codex 开始处理。'))
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
