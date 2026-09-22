/**
 * 下载期间的临时加速。
 *
 * 加速只接管系统代理，用户不点「连接」就什么都不接管，于是装 CLI / 下 Node
 * 这条最需要它的链路默认是直连的（见 download-proxy.ts 顶部那段）。这个模块
 * 把加速换成「下载专用」的用法：下载开始前把内核悄悄拉起来，只拿到它的本机
 * 回环端口，**不写系统代理、不动整机网络**，下载结束再停掉。
 *
 * 三条硬约束：
 * - 用户自己正在游戏加速时什么都不做。他的线路和系统代理归他，下载跟着走。
 * - 起不来就按没加速继续。加速是加分项，不能变成安装的前置条件，所以这里的
 *   每一处失败都收敛成「没有线路」而不是抛错。
 * - 只接受回环端点。跨提权边界的 npm 子进程会拿到这个地址（download-proxy.ts
 *   的 subprocessDownloadProxyEnvironment 里写明了为什么），远端地址一律丢弃。
 *
 * 不含任何 Electron 依赖：真正的 fetch 路由与系统代理无关的那半边在 main.ts。
 */
import { isLoopbackDownloadProxy, type DownloadProxyEndpoint } from './download-proxy'

export type AccelerationDownloadRouteResult =
  | { status: 'ready'; port: number }
  /** 用户自己开着加速：系统代理已经指过去了，这里不该插手。 */
  | { status: 'system-proxy-active' }
  | { status: 'unavailable' }

export interface DownloadAccelerationLease {
  /** 本次下载要用的回环代理；null = 没有临时线路要用。 */
  endpoint: DownloadProxyEndpoint | null
  /** 下载是否确实走在加速线路上——安装源顺序据此切成官方优先。 */
  accelerated: boolean
  release(): Promise<void>
}

export interface DownloadAccelerationCoordinatorOptions {
  getAccountScope(): string | null
  startRoute(scope: string): Promise<AccelerationDownloadRouteResult>
  stopRoute(scope: string): Promise<void>
  /**
   * 起内核要做完整性校验（十几 MB 的 SHA-256）、写临时配置、拉起进程，再由
   * 内核自己探一次线路，实测是几秒。预算给 12 秒：比正常值宽出一截，又不至于
   * 让一台起不来的机器在安装开始前干等半分钟。超时按没加速继续。
   */
  timeoutMs?: number
  /** 路由变化时同步给宿主（Electron 那侧要据此切下载用的 session 代理）。 */
  onRouteChanged?(endpoint: DownloadProxyEndpoint | null): Promise<void>
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface DownloadAccelerationCoordinator {
  acquire(): Promise<DownloadAccelerationLease>
  /** 当前生效的回环端点，供宿主决定这一次下载走哪条网络栈。 */
  currentEndpoint(): DownloadProxyEndpoint | null
}

const idleLease: DownloadAccelerationLease = {
  endpoint: null,
  accelerated: false,
  release: () => Promise.resolve(),
}

export function isAccelerationDownloadPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

/** 只认回环。远端端点即便来自本进程内的组件也不接受（见文件头）。 */
export function downloadRouteEndpoint(port: unknown): DownloadProxyEndpoint | null {
  if (!isAccelerationDownloadPort(port)) return null
  const endpoint: DownloadProxyEndpoint = { scheme: 'http', host: '127.0.0.1', port }
  return isLoopbackDownloadProxy(endpoint) ? endpoint : null
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('下载加速准备超时。')), milliseconds)
    timer.unref?.()
    operation.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

export function createDownloadAccelerationCoordinator(
  options: DownloadAccelerationCoordinatorOptions,
): DownloadAccelerationCoordinator {
  const timeoutMs = options.timeoutMs ?? 12_000
  let queue: Promise<unknown> = Promise.resolve()
  let holders = 0
  let active: { scope: string; endpoint: DownloadProxyEndpoint | null } | null = null

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不能反过来影响下载。 */ }
  }

  function grant(): DownloadAccelerationLease {
    const current = active!
    let released = false
    return {
      endpoint: current.endpoint,
      accelerated: true,
      release: () => enqueue(async () => {
        if (released) return
        released = true
        holders -= 1
        if (holders > 0 || active !== current) return
        active = null
        // system-proxy-active 这一支什么都没起，也就没什么要停。
        if (current.endpoint) {
          try { await options.onRouteChanged?.(null) }
          catch { /* 端点已经作废，下载通道最迟在下一次启用时被重设。 */ }
          try { await options.stopRoute(current.scope) }
          catch (error) {
            log('warn', 'acceleration.download.stop.failed', '下载临时加速停止未完成，下一次下载或退出时会再试',
              { reason: error instanceof Error ? error.message : String(error) })
          }
        }
      }),
    }
  }

  return {
    currentEndpoint: () => active?.endpoint ?? null,
    acquire() {
      return enqueue(async () => {
        if (active) {
          holders += 1
          return grant()
        }
        const scope = options.getAccountScope()
        if (!scope) return idleLease
        const started = options.startRoute(scope)
        let result: AccelerationDownloadRouteResult
        try { result = await withTimeout(started, timeoutMs) }
        catch (error) {
          // 超时不等于没起来。让这次请求自己收尾，否则内核会留在机器上没人停。
          // 后端对 start/stop 是一一配对计数的，这条迟到的 stop 不会误伤别人。
          void started.then(
            (late) => (late.status === 'ready' ? options.stopRoute(scope) : undefined),
            () => undefined,
          ).catch(() => undefined)
          log('warn', 'acceleration.download.start.failed', '下载临时加速未能启用，按现有下载源顺序继续',
            { reason: error instanceof Error ? error.message : String(error) })
          return idleLease
        }
        if (result.status === 'system-proxy-active') {
          active = { scope, endpoint: null }
          holders = 1
          log('info', 'acceleration.download.reused', '本次下载沿用已连接的加速线路')
          return grant()
        }
        if (result.status !== 'ready') return idleLease
        const endpoint = downloadRouteEndpoint(result.port)
        if (!endpoint) {
          try { await options.stopRoute(scope) } catch { /* 无效端口已经没有可用之处，停不掉就交给退出时的清理。 */ }
          log('warn', 'acceleration.download.start.failed', '下载临时加速返回的端口无效，按现有下载源顺序继续')
          return idleLease
        }
        try { await options.onRouteChanged?.(endpoint) }
        catch (error) {
          try { await options.stopRoute(scope) } catch { /* 同上。 */ }
          log('warn', 'acceleration.download.start.failed', '下载加速线路未能接入下载通道，按现有下载源顺序继续',
            { reason: error instanceof Error ? error.message : String(error) })
          return idleLease
        }
        active = { scope, endpoint }
        holders = 1
        log('info', 'acceleration.download.started', '已为本次下载临时启用加速线路（未改动系统代理）')
        return grant()
      })
    },
  }
}
