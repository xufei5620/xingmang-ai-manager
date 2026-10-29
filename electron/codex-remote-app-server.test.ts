import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AppServerMethodError, CodexAppServerClient, type AppServerHandlers, type AppServerProcess } from './codex-remote-app-server'

class FakeProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly written: Record<string, unknown>[] = []
  readonly kills: string[] = []
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) this.written.push(JSON.parse(line) as Record<string, unknown>)
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
}

function handlers(overrides: Partial<AppServerHandlers> = {}): AppServerHandlers {
  return {
    onNotification: vi.fn(),
    onServerRequest: vi.fn(async () => ({ decision: 'decline' })),
    onExit: vi.fn(),
    ...overrides,
  }
}

async function started(fake: FakeProcess, events: AppServerHandlers = handlers()) {
  const client = new CodexAppServerClient({
    spawn: async () => fake as unknown as AppServerProcess,
    clientVersion: '1.0.0',
    log: vi.fn(),
  })
  const starting = client.start(events)
  await vi.waitFor(() => expect(fake.written.length).toBe(1))
  fake.send({ id: fake.written[0].id, result: { userAgent: 'codex' } })
  await starting
  return client
}

describe('codex-remote-app-server', () => {
  it('initializes, opts out of delta notifications and sends initialized', async () => {
    const fake = new FakeProcess()
    await started(fake)
    expect(fake.written[0]).toMatchObject({ method: 'initialize', params: { capabilities: { experimentalApi: false } } })
    const capabilities = (fake.written[0].params as { capabilities: { optOutNotificationMethods: string[] } }).capabilities
    expect(capabilities.optOutNotificationMethods).toContain('item/agentMessage/delta')
    expect(fake.written[0]).not.toHaveProperty('jsonrpc')
    expect(fake.written[1]).toEqual({ method: 'initialized' })
  })

  it('matches responses to requests and surfaces errors', async () => {
    const fake = new FakeProcess()
    const client = await started(fake)
    const ok = client.request('thread/start', { cwd: '/w' })
    const bad = client.request('turn/start', {})
    fake.send({ id: fake.written[3].id, error: { code: -32600, message: 'bad turn' } })
    fake.send({ id: fake.written[2].id, result: { thread: { id: 't1' } } })
    await expect(ok).resolves.toEqual({ thread: { id: 't1' } })
    await expect(bad).rejects.toThrow('bad turn')
  })

  it('answers server requests through the handler, including failures', async () => {
    const fake = new FakeProcess()
    const onServerRequest = vi.fn(async (method: string) => {
      if (method === 'item/tool/call') throw new AppServerMethodError(-32601, 'no tools')
      return { decision: 'accept' }
    })
    await started(fake, handlers({ onServerRequest }))
    fake.send({ id: 41, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } })
    fake.send({ id: 'x', method: 'item/tool/call', params: {} })
    await vi.waitFor(() => expect(fake.written.length).toBe(4))
    expect(fake.written).toContainEqual({ id: 41, result: { decision: 'accept' } })
    expect(fake.written).toContainEqual({ id: 'x', error: { code: -32601, message: 'no tools' } })
  })

  it('delivers notifications split across chunks', async () => {
    const fake = new FakeProcess()
    const events = handlers()
    await started(fake, events)
    const line = JSON.stringify({ method: 'turn/completed', params: { threadId: 't' } })
    fake.stdout.emit('data', line.slice(0, 10))
    fake.stdout.emit('data', `${line.slice(10)}\n`)
    expect(events.onNotification).toHaveBeenCalledWith('turn/completed', { threadId: 't' })
  })

  it('kills the process when a line exceeds the cap', async () => {
    const fake = new FakeProcess()
    const client = new CodexAppServerClient({
      spawn: async () => fake as unknown as AppServerProcess,
      clientVersion: '1',
      maxLineBytes: 64,
      log: vi.fn(),
    })
    const events = handlers()
    const starting = client.start(events)
    await vi.waitFor(() => expect(fake.written.length).toBe(1))
    fake.stdout.emit('data', 'x'.repeat(100))
    await expect(starting).rejects.toThrow()
    expect(fake.kills).toContain('SIGKILL')
    expect(events.onExit).toHaveBeenCalledWith(expect.objectContaining({ expected: false }))
  })

  it('rejects pending requests and reports an expected exit on stop', async () => {
    const fake = new FakeProcess()
    const events = handlers()
    const client = await started(fake, events)
    const pending = client.request('turn/start', {})
    await client.stop()
    await expect(pending).rejects.toThrow('已停止')
    expect(events.onExit).toHaveBeenCalledWith(expect.objectContaining({ expected: true }))
    expect(client.running).toBe(false)
  })

  // 装、卸 Codex 前要等它真退出、放开程序文件（#1407 P3-3）：stop() 只发信号，退出得另等。
  it('settles the exit wait only once the process has really gone, and at once when there is none', async () => {
    const idle = new CodexAppServerClient({ spawn: async () => new FakeProcess() as unknown as AppServerProcess, clientVersion: '1', log: vi.fn() })
    await expect(idle.whenExited()).resolves.toBeUndefined()

    const fake = new FakeProcess()
    fake.kill = (signal?: NodeJS.Signals) => {
      fake.kills.push(signal ?? 'SIGTERM')
      return true
    }
    const client = await started(fake)
    let exited = false
    const waiting = client.whenExited().then(() => { exited = true })
    await client.stop()
    await Promise.resolve()
    expect(fake.kills).toEqual(['SIGTERM'])
    expect(exited).toBe(false)
    fake.emit('exit', null, 'SIGTERM')
    await waiting
    expect(exited).toBe(true)
    await expect(client.whenExited()).resolves.toBeUndefined()
  })

  it('keeps only a short stderr tail', async () => {
    const fake = new FakeProcess()
    const events = handlers()
    await started(fake, events)
    fake.stderr.emit('data', 'y'.repeat(10_000))
    fake.emit('exit', 1, null)
    const detail = vi.mocked(events.onExit).mock.calls[0][0]
    expect(detail.stderrTail.length).toBe(4096)
    expect(detail.code).toBe(1)
  })
})
