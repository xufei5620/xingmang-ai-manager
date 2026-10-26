import { isRecord } from './input-guards'

// 驱动本机 `codex app-server`（标准输入输出，一行一条 JSON-RPC，不带 "jsonrpc" 字段）。手机遥控只用
// 它的会话、发消息、打断和「请求批准」那几样。协议照 codex-cli 0.162.1 `app-server generate-ts` 的产物。
//
// The child is spawned by the service with an argv array (I1); this module only
// speaks the protocol. Lines from the child are bounded: a line longer than the
// cap means the stream can no longer be trusted to be in sync, so the process is
// killed rather than buffered without limit.

export interface AppServerReadable {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

export interface AppServerWritable {
  write(chunk: string): boolean
  end(): void
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** 测试里换成假的；正式环境是 child_process.spawn 的结果。 */
export interface AppServerProcess {
  stdin: AppServerWritable
  stdout: AppServerReadable
  stderr: AppServerReadable
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type AppServerRequestId = string | number

export interface AppServerHandlers {
  onNotification(method: string, params: unknown): void
  /** 返回值原样作为 result 回给 Codex；抛 AppServerMethodError 回 error。 */
  onServerRequest(method: string, params: unknown, id: AppServerRequestId): Promise<unknown>
  /** expected = 是 stop() 叫停的，不是自己退出的。 */
  onExit(detail: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string; expected: boolean }): void
}

export class AppServerMethodError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'AppServerMethodError'
  }
}

export class AppServerRequestError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message)
    this.name = 'AppServerRequestError'
  }
}

export interface AppServerClientOptions {
  spawn(): Promise<AppServerProcess>
  clientVersion: string
  /** 单次请求的超时；turn/start 只等它确认收到，不等这一轮做完。 */
  requestTimeoutMs?: number
  maxLineBytes?: number
  log(level: 'info' | 'warn' | 'error', event: string, detail?: Record<string, string | number | boolean | null>): void
}

/** 这些通知手机遥控用不上，量又大（逐字输出），请 Codex 别发。 */
export const appServerOptOutNotifications = [
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'command/exec/outputDelta',
  'process/outputDelta',
  'thread/tokenUsage/updated',
  'rawResponseItem/completed',
  'rawResponse/completed',
] as const

const defaultRequestTimeoutMs = 60_000
const defaultMaxLineBytes = 16 * 1024 * 1024
const stderrTailBytes = 4096
const stopGraceMs = 5000

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  method: string
}

export function parseAppServerLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return null
  }
}

export class CodexAppServerClient {
  private child: AppServerProcess | null = null
  private handlers: AppServerHandlers | null = null
  private nextId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private buffer = ''
  private stderrTail = ''
  private exited = false
  private stopping = false

  constructor(private readonly options: AppServerClientOptions) {}

  get running(): boolean {
    return this.child !== null && !this.exited
  }

  async start(handlers: AppServerHandlers): Promise<unknown> {
    if (this.child) throw new Error('Codex 已经在运行')
    this.handlers = handlers
    this.exited = false
    this.stopping = false
    const child = await this.options.spawn()
    this.child = child
    child.stdout.on('data', (chunk) => this.onStdout(chunk))
    child.stderr.on('data', (chunk) => this.onStderr(chunk))
    child.stdin.on('error', () => this.fail('stdin-error'))
    child.on('error', () => this.fail('spawn-error'))
    child.on('exit', (code, signal) => this.onExit(code, signal))
    const result = await this.request('initialize', {
      clientInfo: { name: 'xingmang_remote', title: '星芒手机遥控', version: this.options.clientVersion },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [...appServerOptOutNotifications],
      },
    })
    this.write({ method: 'initialized' })
    return result
  }

  request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? defaultRequestTimeoutMs): Promise<unknown> {
    if (!this.child || this.exited) return Promise.reject(new AppServerRequestError('Codex 没有在运行', null))
    const id = `xm-${this.nextId}`
    this.nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppServerRequestError(`Codex 没有回应（${method}）`, null))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    this.rejectAll('Codex 已停止')
    try {
      child.stdin.end()
    } catch {
      // Already closed.
    }
    if (this.exited) return
    child.kill('SIGTERM')
    const escalate = setTimeout(() => {
      if (!this.exited) child.kill('SIGKILL')
    }, stopGraceMs)
    escalate.unref?.()
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child || this.exited) throw new AppServerRequestError('Codex 没有在运行', null)
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private onStdout(chunk: Buffer | string): void {
    const maxLineBytes = this.options.maxLineBytes ?? defaultMaxLineBytes
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > maxLineBytes) {
        this.overflow(Buffer.byteLength(line))
        return
      }
      if (line) this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
    const pendingBytes = Buffer.byteLength(this.buffer)
    if (pendingBytes > maxLineBytes) this.overflow(pendingBytes)
  }

  private overflow(bytes: number): void {
    this.options.log('error', 'app-server.line-too-long', { bytes })
    this.buffer = ''
    this.fail('line-too-long')
  }

  private onStderr(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.stderrTail = `${this.stderrTail}${text}`.slice(-stderrTailBytes)
  }

  private onLine(line: string): void {
    const message = parseAppServerLine(line)
    if (!isRecord(message)) {
      this.options.log('warn', 'app-server.unparsable-line', { bytes: line.length })
      return
    }
    const id = message.id
    const hasId = typeof id === 'string' || typeof id === 'number'
    const method = typeof message.method === 'string' ? message.method : null
    if (hasId && method) {
      void this.answerServerRequest(id, method, message.params)
      return
    }
    if (hasId) {
      this.settle(String(id), message)
      return
    }
    if (method) {
      try {
        this.handlers?.onNotification(method, message.params)
      } catch (error) {
        this.options.log('error', 'app-server.notification-handler-failed', {
          method,
          reason: error instanceof Error ? error.name : 'unknown',
        })
      }
    }
  }

  private settle(id: string, message: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : null
      const text = typeof message.error.message === 'string' ? message.error.message : ''
      pending.reject(new AppServerRequestError(text || `Codex 拒绝了请求（${pending.method}）`, code))
      return
    }
    pending.resolve(message.result)
  }

  private async answerServerRequest(id: AppServerRequestId, method: string, params: unknown): Promise<void> {
    let reply: Record<string, unknown>
    try {
      if (!this.handlers) throw new AppServerMethodError(-32601, 'not supported')
      const result = await this.handlers.onServerRequest(method, params, id)
      reply = { id, result }
    } catch (error) {
      const code = error instanceof AppServerMethodError ? error.code : -32603
      const message = error instanceof AppServerMethodError ? error.message : 'request failed'
      reply = { id, error: { code, message } }
    }
    if (!this.child || this.exited) return
    try {
      this.write(reply)
    } catch {
      // The process went away while the user was deciding; nothing to answer.
    }
  }

  private fail(reason: string): void {
    this.options.log('error', 'app-server.failed', { reason })
    this.child?.kill('SIGKILL')
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    this.rejectAll('Codex 已退出')
    this.child = null
    this.handlers?.onExit({ code, signal, stderrTail: this.stderrTail, expected: this.stopping })
  }

  private rejectAll(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new AppServerRequestError(message, null))
      this.pending.delete(id)
    }
  }
}
