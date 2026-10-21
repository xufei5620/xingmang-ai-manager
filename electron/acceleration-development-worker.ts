import path from 'node:path'
import { accelerationDevelopmentDirectory, accelerationProxyJournalPath, parseAccelerationDevelopmentConfig, parseAccelerationEntitlementSource } from './acceleration-development-host'
import { accelerationShutdownRetryDelayMs, classifyAccelerationWorkerFailure, createAccelerationDevelopmentBackend, isProxyRestoreWithheld } from './acceleration-development-backend'
import { accelerationProxyFailureCause } from './acceleration-contract'
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
let releaseProxy: (() => Promise<void>) | null = null
let runtimeRunning: () => boolean = () => false
// 最近一次还原没去改系统代理：他拒过密码，或者那一次不许弹框（只有 macOS）。成功一次就清掉。
let restoreWithheld = false

/** 没有内核在跑时，退出前的清理最多试这么多次。以前没有上限，主程序退了它还一直在后台试，
 *  每一次都可能弹一次密码框（2026-10-18 客户 Mac）。记录留着，下次打开软件再还原。 */
const shutdownAttemptsWithoutCore = 4

function sendDiagnostic(message: Record<string, unknown>): void {
  if (process.connected) process.send?.({ type: 'acceleration-diagnostic', ...message }, () => undefined)
}

/** Remembers whether the last restore left the proxy alone on purpose, so the
 *  shutdown loop can tell a refusal from a failure worth retrying. */
async function tracked(restore: () => Promise<void>): Promise<void> {
  try { await restore() } catch (error) {
    restoreWithheld = isProxyRestoreWithheld(error)
    throw error
  }
  restoreWithheld = false
}

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
  const journalPath = accelerationProxyJournalPath(message.dataDirectory)
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
  if (macProxy) {
    disposeProxy = () => macProxy.dispose()
    releaseProxy = () => macProxy.release()
  }
  // 退出前那一次补救不弹框：初始化那一次已经问过了，没改回的记录留给下次打开软件再问。
  pendingProxyRecovery = macProxy ? () => tracked(() => macProxy.restoreQuietly()) : () => proxy.recover()
  // 宿主说这次运行里还原已经没成过：后台拉起的这一个先别问，等他自己点开启或停止（见 host 的 recoveryQuiet）。
  const quietRecovery = macProxy !== null && message.quietRecovery === true
  let recoveryWithheld = false
  try { await tracked(() => quietRecovery && macProxy ? macProxy.restoreQuietly() : proxy.recover()) } catch (error) {
    if (belongsToAnotherWorker(error)) pendingProxyRecovery = null
    // 他没输密码（或这一次不许问）：照常起来，加速页说清楚还没改回、下次什么时候问；
    // 不再弹框。以前在这里失败，宿主隔几秒拉一个新的，每一个都弹一次。
    if (!isProxyRestoreWithheld(error)) throw error
    recoveryWithheld = true
    sendDiagnostic({ event: 'recover.withheld', stage: accelerationProxyFailureCause(error) })
  }
  if (!recoveryWithheld) pendingProxyRecovery = null
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
    // Mac 上看去线路服务器的那条路是不是被别的 VPN 接走了（acceleration-conflict.ts）。冲突检查在内核
    // 起来之前，第一次连接时节点还没读，所以这里先读一次，读到的留给随后的 start 用。
    ...(macProxy ? {
      lineAddresses: async () => {
        if (!accelerationProfile) accelerationProfile = await readAccelerationWorkerProfile(config)
        return accelerationProfile.nodes.map((node) => node.connection.server)
      },
    } : {}),
  })
  runtimeRunning = () => runtime.isRunning()
  backend = createAccelerationDevelopmentBackend({
    ledgerPath: path.join(directory, 'trial-ledger.json'),
    entitlementSource,
    restoreQuietlyFromStart: recoveryWithheld,
    onDiagnostic: (stage, cause) => sendDiagnostic({ event: 'stop.failed', stage, ...(cause ? { cause } : {}) }),
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
        try { await tracked(() => proxy.restore()) } catch (error) {
          if (belongsToAnotherWorker(error)) anotherOwnerDuringInitialization = true
          throw error
        }
      },
      ...(macProxy ? { restoreQuietly: () => tracked(() => macProxy.restoreQuietly()) } : {}),
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
    // 同上：没改回只是没去问，加速页上已经写着那一句（backend 的 recoveryFailure）。
    if (!restoreWithheld) throw error
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
  if (request.operation === 'idle') return backend.isIdle()
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
  if (request.operation === 'start-automatic' && (request.mode === 'system-proxy' || request.mode === 'tun')) {
    return backend.startAutomaticAcceleration(request.scope, request.mode,
      typeof request.lineId === 'string' ? request.lineId : undefined)
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
  let failedAttempts = 0
  let released = false
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
      failedAttempts += 1
      // 内核不在了，系统代理就没指着这里的东西：他拒过密码就不再试，别的失败试几次也就放手，
      // 恢复记录留给下次打开软件。
      if (!runtimeRunning() && (restoreWithheld || failedAttempts >= shutdownAttemptsWithoutCore)) break
      // 内核还在、网络照常走它，只是他没输密码：组件进程先退场，把锁和记录交出去，下次打开软件
      // 的那一个才能当面问一次（不然只会报「另一实例正在使用系统代理」）。这边接着悄悄地试。
      if (restoreWithheld && releaseProxy && !released) {
        released = true
        await releaseProxy().catch(() => undefined)
      }
      await new Promise((resolve) => setTimeout(resolve, accelerationShutdownRetryDelayMs(failedAttempts)))
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
        const cause = accelerationProxyFailureCause(error)
        if (process.connected) process.send?.({ id, ok: false, reason: classifyAccelerationWorkerFailure(error), ...(cause === 'other' ? {} : { cause }) }, () => undefined)
      },
    )
  })
  process.on('disconnect', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}
