import path from 'node:path'
import { stat } from 'node:fs/promises'
import { fork, spawn, type ChildProcess, type ForkOptions } from 'node:child_process'
import type { AccelerationApi, AccelerationConflictKind, AccelerationFailureReason, AccelerationState } from './acceleration-contract'
import { accelerationFailureReason, isAccelerationConflictKind, isAccelerationFailureReason, withAccelerationReason } from './acceleration-contract'
import { trustedCommandEnvironment } from './command-runner'
import { readSafeUtf8File } from './safe-local-data'
import { accelerationWorkerArgument } from './acceleration-worker-entry'
import { createAccelerationElectronProfile } from './acceleration-electron-profile'
import type { AccelerationStartFailureStage, AccelerationStopFailureStage } from './acceleration-development-backend'

export interface AccelerationDevelopmentConfig {
  version: 1
  corePath: string
  coreSha256: string
  profilePath: string
  profileSha256?: string
}

export interface AccelerationDevelopmentHost extends AccelerationApi {
  /** Replays a system-proxy lease left behind by a crash, without an account. */
  recover(): Promise<void>
  dispose(): Promise<void>
}

/** The worker creates this directory on its first initialization and keeps the
 *  system-proxy recovery journal and lease in it. Both sides derive it here so
 *  the startup recovery check cannot drift away from where the worker writes. */
export function accelerationDevelopmentDirectory(dataDirectory: string): string {
  return path.join(dataDirectory, 'acceleration-development')
}

export function parseAccelerationDevelopmentConfig(value: unknown): AccelerationDevelopmentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本机加速配置无效。')
  const config = value as Record<string, unknown>
  if (config.version !== 1 || typeof config.corePath !== 'string' || typeof config.profilePath !== 'string'
    || !path.isAbsolute(config.corePath) || !path.isAbsolute(config.profilePath)
    || [config.corePath, config.profilePath].some((file) => file.length > 4096 || /[\x00-\x1f]/.test(file))
    || typeof config.coreSha256 !== 'string' || !/^[a-f\d]{64}$/i.test(config.coreSha256)
    || config.profileSha256 !== undefined && (typeof config.profileSha256 !== 'string' || !/^[a-f\d]{64}$/i.test(config.profileSha256))) {
    throw new Error('本机加速配置无效。')
  }
  return {
    version: 1, corePath: config.corePath, coreSha256: config.coreSha256.toLowerCase(), profilePath: config.profilePath,
    ...(typeof config.profileSha256 === 'string' ? { profileSha256: config.profileSha256.toLowerCase() } : {}),
  }
}

export function parseAccelerationEntitlementSource(value: unknown): 'local-device' | undefined {
  if (value === undefined || value === 'local-device') return value
  throw new Error('本机加速时长来源无效。')
}

/** No private configuration, environment switch or node file enables this in a release. */
export async function readAccelerationDevelopmentConfig(options: {
  isPackaged: boolean
  platform: string
  dataDirectory: string
}): Promise<AccelerationDevelopmentConfig | null> {
  if (options.isPackaged || !['win32', 'darwin'].includes(options.platform)) return null
  try {
    if (!path.isAbsolute(options.dataDirectory) || options.dataDirectory.length > 4096 || /[\x00-\x1f]/.test(options.dataDirectory)) throw new Error('invalid directory')
    const source = await readSafeUtf8File(path.join(options.dataDirectory, 'acceleration-development.json'), '本机加速配置', 16 * 1024)
    if (!source) return null
    return parseAccelerationDevelopmentConfig(JSON.parse(source) as unknown)
  } catch { throw new Error('本机加速配置无效。') }
}

/** Whoever reads the log should not have to open the source to learn what a
 *  stage name means. Exhaustive by construction: adding a stage without a
 *  sentence here is a compile error, and the accepted set below is derived
 *  from these keys so the two cannot drift apart. */
export const accelerationStartFailureDescriptions: Record<AccelerationStartFailureStage, string> = {
  'core-architecture': '加速内核与本机架构不一致',
  'core-integrity': '加速内核完整性校验未通过',
  'core-launch': '加速内核未能启动或提前退出',
  'core-storage': '加速运行目录或内核文件未通过本地安全检查',
  'line-unavailable': '没有可用的加速线路',
  'runtime-invalid': '加速内核已启动但状态不可用',
  'ledger-write': '本机免费时长账本写入失败',
  'proxy-authorization': '系统代理授权未完成',
  'proxy-helper': '系统代理组件不可用',
  'proxy-enable': '系统代理设置失败',
  unknown: '未归类的失败',
}
const stopFailureStages: readonly string[] = ['proxy-restore', 'core-stop', 'ledger-write']
const startFailureStages: readonly string[] = Object.keys(accelerationStartFailureDescriptions)

/** The worker owns the core and proxy lease. Parent IPC loss triggers its cleanup. */
export function createAccelerationDevelopmentHost(options: {
  config: AccelerationDevelopmentConfig
  dataDirectory: string
  packaged?: boolean
  entitlementSource?: 'local-device'
  onDiagnostic?(stage: AccelerationStopFailureStage): void
  onStartDiagnostic?(stage: AccelerationStartFailureStage): void
  onConflictDiagnostic?(kind: AccelerationConflictKind, ignored: boolean): void
  /** Both the closed reason and the error behind it. Unlike the worker-side
   *  callbacks above, this one fires in the main process, so it may carry the
   *  original error: the log redacts paths (I13) and nothing crosses a process
   *  boundary here. Without it a failed launch left no cause anywhere. */
  onHelperFailure?(reason: AccelerationFailureReason, error: unknown): void
}): AccelerationDevelopmentHost {
  const config = parseAccelerationDevelopmentConfig(options.config)
  const entitlementSource = parseAccelerationEntitlementSource(options.entitlementSource)
    ?? (options.packaged ? 'local-device' : undefined)
  if (options.packaged && !config.profileSha256) throw new Error('发布加速节点缺少完整性校验。')
  if (!path.isAbsolute(options.dataDirectory) || options.dataDirectory.length > 4096 || /[\x00-\x1f]/.test(options.dataDirectory)) {
    throw new Error('本机加速数据目录无效。')
  }
  let child: ChildProcess | null = null
  let ready: Promise<void> | null = null
  let disposed = false
  let disposal: Promise<void> | null = null
  let nextId = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()

  function failPending() {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(withAccelerationReason(new Error('本机加速进程已断开，请重新打开软件。'), 'helper-launch'))
    }
    pending.clear()
  }

  function disconnectWorker(worker: ChildProcess) {
    try { if (worker.connected) worker.disconnect() } catch { /* The worker may already be closing its IPC channel. */ }
    if (child === worker) failPending()
  }

  function rpc(operation: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!child?.connected) return Promise.reject(withAccelerationReason(new Error('本机加速进程未就绪。'), 'helper-launch'))
    const id = ++nextId
    const worker = child
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        // Disconnect makes the worker unwind and restore its proxy lease. Do
        // not kill it while it may be restoring the user's previous settings.
        reject(withAccelerationReason(new Error('本机加速操作超时，正在恢复网络。'), 'helper-timeout'))
        disconnectWorker(worker)
      }, 90_000)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      const sendFailed = () => {
        const request = pending.get(id)
        if (!request) return
        clearTimeout(request.timer)
        pending.delete(id)
        request.reject(withAccelerationReason(new Error('本机加速进程通信失败。'), 'helper-launch'))
        disconnectWorker(worker)
      }
      try { worker.send({ id, operation, ...payload }, (error) => { if (error) sendFailed() }) }
      catch { sendFailed() }
    })
  }

  function ensureReady(): Promise<void> {
    if (disposed) return Promise.reject(withAccelerationReason(new Error('本机加速服务已关闭。'), 'helper-launch'))
    if (ready) return ready
    const workerOptions: ForkOptions & { windowsHide: boolean } = {
      execPath: process.execPath,
      execArgv: [],
      // Windows puts ordinary children in the parent's kill-on-close Job. A
      // detached worker survives a parent crash long enough to receive IPC
      // disconnect, restore the proxy and stop its own core before exiting.
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...trustedCommandEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
    }
    let profile: ReturnType<typeof createAccelerationElectronProfile> | undefined
    // 这两步以前共用一个 catch，于是「临时工作目录建不出来」和「进程拉不起来」
    // 在日志里长得一模一样：只有「本机加速进程启动失败。」，errno 和原文都没有。
    // 2026-09-22 一台客户机卡在这里，定位只能靠反编译压缩产物数字节。分开接住，
    // 归类就不用去猜 errno 到底是谁报的。
    function launchFailed(reason: AccelerationFailureReason, error: unknown): Promise<void> {
      profile?.cleanup()
      try { options.onHelperFailure?.(reason, error) } catch { /* Reporting must not change the launch result. */ }
      return Promise.reject(withAccelerationReason(new Error('本机加速进程启动失败。'), reason))
    }
    if (options.packaged) {
      let environment: NodeJS.ProcessEnv
      try {
        environment = trustedCommandEnvironment()
        for (const key of Object.keys(environment)) {
          if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete environment[key]
        }
        profile = createAccelerationElectronProfile()
      } catch (error) { return launchFailed('helper-temp', error) }
      try {
        // Run the integrity-protected application entry in a detached Electron
        // main process. Unlike a utility process, it survives parent IPC loss
        // long enough to restore the proxy without enabling the RunAsNode fuse.
        child = spawn(process.execPath, [accelerationWorkerArgument, profile.argument], {
          detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: environment,
        })
      } catch (error) { return launchFailed('helper-launch', error) }
    } else {
      try { child = fork(path.join(__dirname, 'acceleration-development-worker.js'), [], workerOptions) }
      catch (error) { return launchFailed('helper-launch', error) }
    }
    const worker = child
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return
      const response = message as Record<string, unknown>
      if (response.type === 'acceleration-diagnostic') {
        if (child !== worker || Object.keys(response).some((key) => !['type', 'event', 'stage', 'ignored'].includes(key))) return
        // The worker is the one process allowed to see the underlying error.
        // Only a member of the stage set it is allowed to report crosses here,
        // so a compromised or confused worker cannot turn this into a channel
        // for arbitrary text reaching the log.
        if (response.event === 'stop.failed' && stopFailureStages.includes(response.stage as string)) {
          try { options.onDiagnostic?.(response.stage as AccelerationStopFailureStage) } catch { /* Diagnostics must not interrupt recovery. */ }
          return
        }
        if (response.event === 'start.failed' && startFailureStages.includes(response.stage as string)) {
          try { options.onStartDiagnostic?.(response.stage as AccelerationStartFailureStage) } catch { /* Diagnostics must not interrupt recovery. */ }
          return
        }
        if (response.event === 'start.conflict' && isAccelerationConflictKind(response.stage) && typeof response.ignored === 'boolean') {
          try { options.onConflictDiagnostic?.(response.stage, response.ignored) } catch { /* Diagnostics must not interrupt recovery. */ }
        }
        return
      }
      if (child !== worker) return
      if (typeof response.id !== 'number') return
      const request = pending.get(response.id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(response.id)
      if (response.ok === true) request.resolve(response.value)
      else {
        // The worker never sends error text (it can carry a private path or
        // proxy detail, I13). It sends one member of the closed reason set, so
        // a confused worker cannot turn this into a channel for free text.
        const reason = isAccelerationFailureReason(response.reason) ? response.reason : 'unknown'
        request.reject(withAccelerationReason(new Error('本机加速操作未完成，请重新检查线路。'), reason))
      }
    })
    child.on('error', () => disconnectWorker(worker))
    const exited = () => {
      profile?.cleanup()
      if (child !== worker) return
      failPending()
      child = null
      ready = null
    }
    child.on('exit', exited)
    child.on('close', exited)
    child.on('disconnect', () => { if (child === worker) failPending() })
    ready = rpc('init', { config, dataDirectory: options.dataDirectory, ...(entitlementSource ? { entitlementSource } : {}) }).then(() => undefined, (error: unknown) => {
      // Initialization can fail after acquiring or recovering a proxy lease.
      // Parent IPC loss tells the worker to retry its own cleanup before exit.
      disconnectWorker(worker)
      const reason = accelerationFailureReason(error) ?? 'unknown'
      try { options.onHelperFailure?.(reason, error) } catch { /* Reporting must not change the launch result. */ }
      throw withAccelerationReason(new Error('本机加速进程初始化未完成。'), reason)
    })
    return ready
  }

  async function hasProxyRecoveryRecords(): Promise<boolean> {
    try { return (await stat(accelerationDevelopmentDirectory(options.dataDirectory))).isDirectory() }
    catch (error) {
      // Only a missing directory proves this machine never took a proxy lease.
      // Any other failure falls through to the worker, which owns the real check.
      return (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT'
    }
  }

  async function request(operation: string, scope: string, mode?: string, lineId?: string, ignoreConflicts?: boolean): Promise<AccelerationState> {
    await ensureReady()
    // The service above this adapter validates and projects every returned field.
    return await rpc(operation, {
      scope, ...(mode ? { mode } : {}), ...(lineId ? { lineId } : {}), ...(ignoreConflicts ? { ignoreConflicts: true } : {}),
    }) as AccelerationState
  }

  return {
    // A crash while acceleration was on leaves the system proxy pointing at a
    // dead local port: the whole machine is offline until the worker replays
    // its journal. Recovery therefore cannot wait for an account-scoped call,
    // because signing in is exactly what the dead proxy prevents.
    async recover() {
      if (!await hasProxyRecoveryRecords()) return
      await ensureReady()
    },
    getAccelerationState: (scope) => request('get', scope),
    startAcceleration: (scope, mode, lineId, ignoreConflicts) => request('start', scope, mode, lineId, ignoreConflicts),
    stopAcceleration: (scope) => request('stop', scope),
    redeemAccelerationCode: async (scope, code) => {
      await ensureReady()
      return await rpc('redeem-code', { scope, code }) as Awaited<ReturnType<NonNullable<AccelerationApi['redeemAccelerationCode']>>>
    },
    listAccelerationLines: async (scope) => {
      await ensureReady()
      return await rpc('list-lines', { scope }) as Awaited<ReturnType<NonNullable<AccelerationApi['listAccelerationLines']>>>
    },
    pingAccelerationLine: async (scope, lineId) => {
      await ensureReady()
      return await rpc('ping-line', { scope, lineId }) as Awaited<ReturnType<NonNullable<AccelerationApi['pingAccelerationLine']>>>
    },
    dispose() {
      if (disposal) return disposal
      disposed = true
      disposal = (async () => {
        if (!child) return
        const worker = child
        try {
          await ready
          await rpc('dispose')
        } finally { disconnectWorker(worker) }
      })()
      void disposal.catch(() => { disposal = null })
      return disposal
    },
  }
}
