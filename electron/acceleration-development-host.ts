import path from 'node:path'
import { fork, spawn, type ChildProcess, type ForkOptions } from 'node:child_process'
import type { AccelerationApi, AccelerationState } from './acceleration-contract'
import { trustedCommandEnvironment } from './command-runner'
import { readSafeUtf8File } from './safe-local-data'
import { accelerationWorkerArgument } from './acceleration-worker-entry'

export interface AccelerationDevelopmentConfig {
  version: 1
  corePath: string
  coreSha256: string
  profilePath: string
  profileSha256?: string
}

export interface AccelerationDevelopmentHost extends AccelerationApi {
  dispose(): Promise<void>
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

/** The worker owns the core and proxy lease. Parent IPC loss triggers its cleanup. */
export function createAccelerationDevelopmentHost(options: {
  config: AccelerationDevelopmentConfig
  dataDirectory: string
  packaged?: boolean
  entitlementSource?: 'local-device'
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
      request.reject(new Error('本机加速进程已断开，请重新打开软件。'))
    }
    pending.clear()
  }

  function disconnectWorker(worker: ChildProcess) {
    try { if (worker.connected) worker.disconnect() } catch { /* The worker may already be closing its IPC channel. */ }
    failPending()
  }

  function rpc(operation: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!child?.connected) return Promise.reject(new Error('本机加速进程未就绪。'))
    const id = ++nextId
    const worker = child
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        // Disconnect makes the worker unwind and restore its proxy lease. Do
        // not kill it while it may be restoring the user's previous settings.
        reject(new Error('本机加速操作超时，正在恢复网络。'))
        disconnectWorker(worker)
      }, 90_000)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      const sendFailed = () => {
        const request = pending.get(id)
        if (!request) return
        clearTimeout(request.timer)
        pending.delete(id)
        request.reject(new Error('本机加速进程通信失败。'))
        disconnectWorker(worker)
      }
      try { worker.send({ id, operation, ...payload }, (error) => { if (error) sendFailed() }) }
      catch { sendFailed() }
    })
  }

  function ensureReady(): Promise<void> {
    if (disposed) return Promise.reject(new Error('本机加速服务已关闭。'))
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
    try {
      if (options.packaged) {
        const environment = trustedCommandEnvironment()
        for (const key of Object.keys(environment)) {
          if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete environment[key]
        }
        // Run the integrity-protected application entry in a detached Electron
        // main process. Unlike a utility process, it survives parent IPC loss
        // long enough to restore the proxy without enabling the RunAsNode fuse.
        child = spawn(process.execPath, [accelerationWorkerArgument], {
          detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: environment,
        })
      } else {
        child = fork(path.join(__dirname, 'acceleration-development-worker.js'), [], workerOptions)
      }
    }
    catch { return Promise.reject(new Error('本机加速进程启动失败。')) }
    const worker = child
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return
      const response = message as Record<string, unknown>
      if (typeof response.id !== 'number') return
      const request = pending.get(response.id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(response.id)
      if (response.ok === true) request.resolve(response.value)
      else request.reject(new Error('本机加速操作未完成，请重新检查线路。'))
    })
    child.on('error', () => disconnectWorker(worker))
    child.on('exit', failPending)
    child.on('disconnect', failPending)
    ready = rpc('init', { config, dataDirectory: options.dataDirectory, ...(entitlementSource ? { entitlementSource } : {}) }).then(() => undefined, () => {
      // Initialization can fail after acquiring or recovering a proxy lease.
      // Parent IPC loss tells the worker to retry its own cleanup before exit.
      disconnectWorker(worker)
      throw new Error('本机加速进程初始化未完成。')
    })
    return ready
  }

  async function request(operation: string, scope: string, mode?: string, lineId?: string): Promise<AccelerationState> {
    await ensureReady()
    // The service above this adapter validates and projects every returned field.
    return await rpc(operation, { scope, ...(mode ? { mode } : {}), ...(lineId ? { lineId } : {}) }) as AccelerationState
  }

  return {
    getAccelerationState: (scope) => request('get', scope),
    startAcceleration: (scope, mode, lineId) => request('start', scope, mode, lineId),
    stopAcceleration: (scope) => request('stop', scope),
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
        try {
          await ready
          await rpc('dispose')
        } finally { disconnectWorker(child) }
      })()
      void disposal.catch(() => { disposal = null })
      return disposal
    },
  }
}
