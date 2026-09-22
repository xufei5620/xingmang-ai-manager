import path from 'node:path'
import { accelerationDevelopmentDirectory, parseAccelerationDevelopmentConfig, parseAccelerationEntitlementSource } from './acceleration-development-host'
import { classifyAccelerationWorkerFailure, createAccelerationDevelopmentBackend } from './acceleration-development-backend'
import { createAccelerationConflictDetector } from './acceleration-conflict'
import { accelerationLinesFromProfile, createMihomoRuntime } from './acceleration-mihomo-runtime'
import { createWindowsSystemProxy } from './platform/windows-system-proxy'
import { createMacosSystemProxy } from './platform/macos-system-proxy'
import { ensureSafeDataDirectory } from './safe-local-data'
import { readAccelerationWorkerProfile } from './acceleration-worker-profile'

let backend: ReturnType<typeof createAccelerationDevelopmentBackend> | null = null
let queue: Promise<unknown> = Promise.resolve()
let shuttingDown = false
let pendingProxyRecovery: (() => Promise<void>) | null = null
let accelerationProfile: Awaited<ReturnType<typeof readAccelerationWorkerProfile>> | null = null
let disposeProxy: (() => Promise<void>) | null = null

function belongsToAnotherWorker(error: unknown): boolean {
  // restorePending checks this before any write. This worker has never acquired
  // that live owner's lease, so its shutdown must not wait to reclaim it later.
  return error instanceof Error && error.message === '另一实例正在使用系统代理，请先停止该实例的加速。'
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation)
  queue = result.then(() => undefined, () => undefined)
  return result
}

async function initialize(message: Record<string, unknown>): Promise<void> {
  if (backend || !['win32', 'darwin'].includes(process.platform)) throw new Error('开发加速进程初始化无效。')
  const config = parseAccelerationDevelopmentConfig(message.config)
  const entitlementSource = parseAccelerationEntitlementSource(message.entitlementSource)
  if (typeof message.dataDirectory !== 'string' || !path.isAbsolute(message.dataDirectory)) throw new Error('开发数据目录无效。')
  const directory = accelerationDevelopmentDirectory(message.dataDirectory)
  ensureSafeDataDirectory(directory, '本机加速数据')
  const journalPath = path.join(directory, 'proxy-lease.json')
  const macProxy = process.platform === 'darwin'
    ? createMacosSystemProxy({
      journalPath,
      helperPath: path.join(process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE
        ? path.join(process.resourcesPath, 'native') : path.join(__dirname, '..', 'dist-native'),
      `macos-system-proxy-${process.arch}`),
    })
    : null
  const windowsProxy = macProxy ? null : createWindowsSystemProxy({ journalPath })
  const proxy = macProxy ?? windowsProxy
  if (!proxy) throw new Error('开发加速进程初始化无效。')
  if (macProxy) disposeProxy = () => macProxy.dispose()
  pendingProxyRecovery = () => proxy.recover()
  try { await proxy.recover() } catch (error) {
    if (belongsToAnotherWorker(error)) pendingProxyRecovery = null
    throw error
  }
  pendingProxyRecovery = null
  const runtime = createMihomoRuntime({
    corePath: config.corePath, coreSha256: config.coreSha256,
    runtimeDirectory: path.join(directory, 'runtime'),
    onUnexpectedExit: () => { void backend?.notifyRuntimeExit().catch(() => undefined) },
  })
  let anotherOwnerDuringInitialization = false
  // Read-only: it looks at who already holds the OS proxy, never writes it.
  const conflicts = createAccelerationConflictDetector({
    platform: process.platform,
    ...(windowsProxy ? { inspectWindowsProxy: () => windowsProxy.inspect() } : {}),
  })
  backend = createAccelerationDevelopmentBackend({
    ledgerPath: path.join(directory, 'trial-ledger.json'),
    entitlementSource,
    onDiagnostic: (stage) => {
      if (process.connected) process.send?.({ type: 'acceleration-diagnostic', event: 'stop.failed', stage }, () => undefined)
    },
    onStartDiagnostic: (stage) => {
      if (process.connected) process.send?.({ type: 'acceleration-diagnostic', event: 'start.failed', stage }, () => undefined)
    },
    // 只有事件名，没有原因或文本：宿主拿到它只会回头读一次状态（I13）。
    onRuntimeInterrupted: () => {
      if (process.connected) process.send?.({ type: 'acceleration-diagnostic', event: 'runtime.exited' }, () => undefined)
    },
    detectConflicts: () => conflicts.read(),
    onConflictDiagnostic: (stage, ignored) => {
      if (process.connected) process.send?.({ type: 'acceleration-diagnostic', event: 'start.conflict', stage, ignored }, () => undefined)
    },
    proxy: {
      enable: (port) => proxy.enable(port),
      async restore() {
        try { await proxy.restore() } catch (error) {
          if (belongsToAnotherWorker(error)) anotherOwnerDuringInitialization = true
          throw error
        }
      },
    },
    runtime: {
      async start(lineId?: string) {
        if (!accelerationProfile) {
          accelerationProfile = await readAccelerationWorkerProfile(config)
        }
        return runtime.start(accelerationProfile, lineId)
      },
      stop: () => runtime.stop(), isRunning: () => runtime.isRunning(),
    },
    listLines: async () => {
      accelerationProfile = await readAccelerationWorkerProfile(config)
      return accelerationLinesFromProfile(accelerationProfile)
    },
    pingLine: async (lineId) => {
      if (runtime.isRunning()) throw new Error('加速连接进行中，暂不能检测线路。')
      if (!accelerationProfile) {
        accelerationProfile = await readAccelerationWorkerProfile(config)
      }
      // Mihomo performs the authenticated delay probe and CONNECT check while
      // starting. No system proxy is enabled for this short-lived probe.
      try { return (await runtime.start(accelerationProfile, lineId)).line }
      finally { await runtime.stop() }
    },
  })
  try { await backend.recover() } catch (error) {
    // Another helper can acquire the lease between the two startup recovery
    // checks. No start request has run yet, so this helper owns no live core or
    // proxy; leave that owner's network alone instead of retrying indefinitely.
    if (anotherOwnerDuringInitialization && !runtime.isRunning()) backend = null
    throw error
  }
}

async function handle(message: unknown): Promise<unknown> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('开发加速消息无效。')
  const request = message as Record<string, unknown>
  if (request.operation === 'init') return initialize(request)
  if (!backend || shuttingDown) throw new Error('开发加速进程未就绪。')
  if (request.operation === 'dispose') {
    await backend.dispose()
    await disposeProxy?.()
    return
  }
  if (request.operation === 'resume') return backend.resume()
  if (typeof request.scope !== 'string' || !/^(xm|api)-account:[1-9]\d{0,15}$/.test(request.scope)) throw new Error('加速账号参数无效。')
  if (request.operation === 'get') return backend.getAccelerationState(request.scope)
  if (request.operation === 'list-lines') return backend.listAccelerationLines?.(request.scope) ?? []
  if (request.operation === 'ping-line' && typeof request.lineId === 'string') {
    return backend.pingAccelerationLine?.(request.scope, request.lineId)
  }
  if (request.operation === 'stop') return backend.stopAcceleration(request.scope)
  // 下载专用线路：只起内核、只交出本机端口，不动系统代理（见 backend 里的注释）。
  if (request.operation === 'download-start') return backend.startDownloadRoute(request.scope)
  if (request.operation === 'download-stop') return backend.stopDownloadRoute()
  if (request.operation === 'redeem-code' && typeof request.code === 'string' && request.code.length <= 64) {
    return backend.redeemAccelerationCode?.(request.scope, request.code)
  }
  if (request.operation === 'start' && (request.mode === 'system-proxy' || request.mode === 'tun')) {
    return backend.startAcceleration(request.scope, request.mode,
      typeof request.lineId === 'string' ? request.lineId : undefined, request.ignoreConflicts === true)
  }
  throw new Error('开发加速操作无效。')
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  let stopped = false
  // Parent crashes cannot leave the proxy pointing at an orphaned helper.
  // Failed restoration stays alive for retry instead of killing the live core.
  while (!stopped) {
    try {
      await enqueue(async () => {
        if (backend) await backend.dispose()
        else if (pendingProxyRecovery) {
          try { await pendingProxyRecovery() } catch (error) {
            if (!belongsToAnotherWorker(error)) throw error
          }
        }
        await disposeProxy?.()
      })
      stopped = true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  process.exit(0)
}

if (process.send) {
  process.on('message', (message: unknown) => {
    if (shuttingDown) return
    const id = message && typeof message === 'object' && 'id' in message ? message.id : null
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return
    // 睡眠前那一两秒排不起队：这一步只冻结计时、撤掉定时器，当场做完就回话。
    if ((message as Record<string, unknown>).operation === 'suspend') {
      try { backend?.suspend() } catch { /* 冻结失败只是退回睡眠照常计时。 */ }
      if (process.connected) process.send?.({ id, ok: true }, () => undefined)
      return
    }
    void enqueue(() => handle(message)).then(
      (value) => { if (process.connected) process.send?.({ id, ok: true, value }, () => undefined) },
      // The reason, never the message: the host maps it onto a sentence of its
      // own, and a stray path or proxy detail can never ride along (I13).
      (error: unknown) => {
        if (process.connected) process.send?.({ id, ok: false, reason: classifyAccelerationWorkerFailure(error) }, () => undefined)
      },
    )
  })
  process.on('disconnect', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}
