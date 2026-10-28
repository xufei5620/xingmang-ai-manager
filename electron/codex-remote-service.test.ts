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
  RemoteInbound,
  RemoteOutbound,
  RemotePeer,
} from './codex-remote-channel'
import { createCodexRemoteKeepAwake } from './codex-remote-keep-awake'
import { CodexRemoteStore } from './codex-remote-store'
import type { SafeStorageLike } from './account-session-store'
import {
  belongsToOtherTurn,
  buildApprovalRequest,
  buildThreadStartParams,
  collectCredentialSecrets,
  CodexRemoteService,
  generateApprovalNonce,
  generatePairingCode,
  grantRequestedPermissions,
  isStaleInbound,
  nextApprovalNumber,
  permissionsShowInFull,
  readRequestedPermissions,
  validateRemoteWorkspace,
} from './codex-remote-service'

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

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM')
    this.emit('exit', null, signal ?? 'SIGTERM')
    return true
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

  async start(handlers: RemoteChannelHandlers): Promise<void> {
    this.handlers = handlers
    handlers.onStatus({ state: 'connected' })
  }

  async stop(): Promise<void> {
    this.stopped += 1
  }

  async send(peer: RemotePeer, message: RemoteOutbound, replyContext?: string): Promise<void> {
    this.sent.push({ peer, message, replyContext })
  }

  texts(): string[] {
    return this.sent.map((entry) => (entry.message.kind === 'text' ? entry.message.text : `[approval] ${entry.message.text}`))
  }
}

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
} = {}): Promise<Setup> {
  const root = options.root ?? tempRoot()
  const home = path.join(root, 'home')
  const workspace = path.join(home, 'projects', 'demo')
  fs.mkdirSync(workspace, { recursive: true })
  const store = new CodexRemoteStore(path.join(root, 'data', 'codex-remote'), fakeStorage(), 'darwin')
  if (options.workspace !== false) await store.updateSettings((settings) => { settings.workspaceDirectory = workspace })
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
      const channel = new FakeChannel()
      channels.push(channel)
      return channel
    },
    fetch: vi.fn(),
    appVersion: '0.2.21',
    homeDirectory: home,
    platform: 'darwin',
    log: (_level, event, detail) => {
      logs.push(event)
      logDetails.push({ event, ...(detail ? { detail } : {}) })
    },
    randomInt: () => 42,
    spawnCodex: async () => {
      await options.spawnGate
      const fake = new FakeCodex()
      for (const [method, gate] of options.replyGates ?? []) fake.replyGates.set(method, gate)
      codex.push(fake)
      return fake as unknown as AppServerProcess
    },
    readCodexSecrets: async () => [apiKey],
    inspectAvailability: () => unavailable.reason,
    checkCodexReady: async () => options.codexProblem ?? null,
    onStateChanged: (snapshot) => { snapshots.push(snapshot) },
  })
  return { service, channel: new FakeChannel(), channels, codex, snapshots, workspace, store, logs, logDetails, unavailable }
}

async function enabledAndPaired(s: Setup): Promise<FakeChannel> {
  await s.service.setChannelEnabled('feishu', true)
  const channel = s.channels[0]
  await s.service.startPairing('feishu')
  channel.handlers?.onInbound(text(alice, '000042'))
  await vi.waitFor(() => expect(channel.texts()).toContain('配对成功。这台电脑上的 Codex 现在只听你的。直接发消息就能让它干活，发「帮助」看能用的指令。'))
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

const staleCardText = '这张卡片已经失效了（处理过、超时了，或者电脑上的星芒重开过），刚才点的没有生效。有要你同意的事会另发新卡片。'

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

  it('pads pairing codes to six digits', () => {
    expect(generatePairingCode(() => 42)).toBe('000042')
    expect(generatePairingCode(() => 999_999)).toBe('999999')
  })

  it('treats messages sent before the channel opened or long ago as stale', () => {
    expect(isStaleInbound(1_000_000 - 61_000, 1_000_000, 1_000_000)).toBe(true)
    expect(isStaleInbound(1_000_000 - 30_000, 1_000_000, 1_000_000)).toBe(false)
    expect(isStaleInbound(0, 0, 11 * 60_000)).toBe(true)
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
    const change = buildApprovalRequest('8', 'nonce-eight', 'file-change', {}, files, { homeDirectory: '/Users/alice', platform: 'darwin', secrets: [] })
    expect(change.summary.split('\n')).toHaveLength(21)
    expect(change.summary).toContain('另外还有 5 个文件')
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
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
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
})

describe('codex-remote-service turns', () => {
  it('runs a prompt in the workspace and replies with the redacted final answer', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    expect(channel.texts()[0]).toBe('收到，Codex 开始处理。')
    expect(codex.requests('thread/start')[0].params).toMatchObject({
      cwd: s.workspace,
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
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
    expect(channel.texts()[1]).toBe('测试都过了，密钥是 [已隐去]')
    expect(channel.sent[1].replyContext).toMatch(/^ctx-/)
    await vi.waitFor(async () => expect((await s.service.snapshot()).task).toBe('idle'))
  })

  it('keeps one turn at a time and reuses the thread', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    channel.handlers?.onInbound(text(alice, '再来一个'))
    await vi.waitFor(() => expect(channel.texts()).toContain('Codex 还在处理上一条。等它做完再发，或者发「停止」中断它。'))
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } })
    await vi.waitFor(() => expect(channel.texts()).toContain('这一轮做完了，Codex 没有留下文字回复。'))
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
    await vi.waitFor(() => expect(channel.sent.some((entry) => entry.message.kind === 'approval')).toBe(true))
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

  it('reports a failed turn with the redacted reason', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.notify('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'failed', error: { message: `401 for key ${apiKey}` } } })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('这一轮没做完：401 for key [已隐去]'))
  })

  it('tells the phone when Codex dies mid-turn', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    codex.emit('exit', 1, null)
    await vi.waitFor(() => expect(channel.texts().at(-1)).toContain('意外退出'))
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
    await vi.waitFor(() => expect(approvalsSent(channel)).toHaveLength(1))
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

describe('codex-remote-service approvals', () => {
  it('asks the bound person and answers Codex with plain accept or decline', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const answer = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await vi.waitFor(() => expect(channel.sent.some((entry) => entry.message.kind === 'approval')).toBe(true))
    const approval = channel.sent.find((entry) => entry.message.kind === 'approval')?.message
    expect(approval).toMatchObject({ kind: 'approval', request: { approvalId: '1', kind: 'command', summary: 'npm test' } })
    expect(approvalsSent(channel)[0].nonce).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect((await s.service.snapshot()).task).toBe('waiting-approval')
    channel.handlers?.onInbound(text(alice, '同意'))
    expect((await answer).result).toEqual({ decision: 'accept' })
    await vi.waitFor(() => expect(channel.texts()).toContain('已同意第 1 条。'))

    const second = codex.ask('item/fileChange/requestApproval', { threadId: 'th-1', turnId: 'tu-1', itemId: 'i2', startedAtMs: 0 })
    await vi.waitFor(() => expect(approvalsSent(channel)).toHaveLength(2))
    channel.handlers?.onInbound(cardClick(alice, approvalsSent(channel)[1], 'decline'))
    expect((await second).result).toEqual({ decision: 'decline' })
  })

  it('takes a card click only with the nonce of the request that card was sent for', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const answer = codex.ask('item/commandExecution/requestApproval', commandRequest)
    await vi.waitFor(() => expect(approvalsSent(channel)).toHaveLength(1))
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
    await vi.waitFor(() => expect(approvalsSent(beforeChannel)).toHaveLength(1))
    const oldCard = approvalsSent(beforeChannel)[0]
    expect(oldCard.approvalId).toBe('1')
    before.service.dispose()

    // The same person is still bound after the restart; the switch has to be turned on again.
    const after = await setup({ root })
    await after.service.setChannelEnabled('feishu', true)
    const channel = after.channels[0]
    const codex = await prompted(after, channel)
    const answer = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, command: 'rm -rf build' })
    await vi.waitFor(() => expect(approvalsSent(channel)).toHaveLength(1))
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
    await vi.waitFor(() => expect(approvalsSent(firstChannel)).toHaveLength(1))
    const oldCard = approvalsSent(firstChannel)[0]
    first.service.dispose()

    // Lost settings (or a counter that wrapped) hand out number 1 again.
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const answer = codex.ask('item/commandExecution/requestApproval', { ...commandRequest, command: 'rm -rf build' })
    await vi.waitFor(() => expect(approvalsSent(channel)).toHaveLength(1))
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
    await vi.waitFor(() => expect(channel.sent.filter((entry) => entry.message.kind === 'approval')).toHaveLength(2))
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
    await vi.waitFor(() => expect(channel.sent.some((entry) => entry.message.kind === 'approval')).toBe(true))
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
    await vi.waitFor(() => expect(channel.sent.some((entry) => entry.message.kind === 'approval')).toBe(true))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect((await answer).result).toEqual({ decision: 'decline' })
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe('第 1 条等了 10 分钟没回，已自动拒绝。'))
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
    await vi.waitFor(() => expect(channel.texts().at(-1)).toContain('联网'))
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
    await vi.waitFor(() => expect(approvalsSent(channel)).toHaveLength(1))
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
    await vi.waitFor(() => expect(approvalsSent(channel)).toHaveLength(1))
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

  // 状态文件关掉了手机遥控（G04）：开着的当场停，手机上收到的跟在电脑上点关一样。
  it('stops an open channel the moment the computer can no longer offer remote control, and only refreshes when it can', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    const before = s.snapshots.length
    await s.service.applyAvailability()
    expect(channel.stopped).toBe(0)
    expect(s.snapshots.length).toBe(before + 1)

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
    const s = await setup()
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

  it('closes itself after four idle hours', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
    const channel = await enabledAndPaired(s)
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    await vi.waitFor(() => expect(channel.texts()).toContain('4 小时没有新消息，手机遥控已自动关闭。要再用，请在电脑上的星芒里重新打开。'))
    expect((await s.service.snapshot()).channels.feishu.enabled).toBe(false)
  })

  it('reports every open, login loss and close to the state listener so the sleep blocker can follow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup()
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

  it('drops what is waiting, stops the channel and Codex, and stays off when the manager quits', async () => {
    const s = await setup()
    const channel = await enabledAndPaired(s)
    const codex = await prompted(s, channel)
    void codex.ask('item/commandExecution/requestApproval', commandRequest)
    await vi.waitFor(() => expect(channel.sent.some((entry) => entry.message.kind === 'approval')).toBe(true))
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
