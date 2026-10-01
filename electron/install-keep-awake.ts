import { MAX_KEEP_AWAKE_MS, type SleepBlocker } from './cli-keep-awake'
import type { InstallationQueueSnapshot } from './installation-queue'
import type { UpdateSnapshot } from './updater'

// 装工具、装 Codex 桌面端、准备 Node.js / Python / Git、后台下载星芒新版本的时候，挡住
// 系统自动睡眠：小白点完「安装」最容易走开，笔记本用电池十来分钟就睡，网断了下载就停在
// 半路。做完、失败、取消都放开。和终端里干活时的防睡（cli-keep-awake.ts）是同一种挡法，
// 只挡「自动睡眠」，屏幕照样按用户的设置关，合盖照样睡；不改任何系统电源设置。

export type InstallKeepAwakeReason = 'install' | 'update-download'

const EXPIRY_CHECK_MS = 60_000

const holdingInstallKeys = new Set(['runtime:node', 'runtime:python', 'runtime:git', 'desktop:codex:install'])
const holdingInstallPrefixes = ['cli:install:', 'external-client:install:']

/**
 * 只有要下载、要装的才挡：打开工具、卸载、清理残留几秒就完，挡了也白挡。
 */
export function isKeepAwakeInstallKey(key: string): boolean {
  return holdingInstallKeys.has(key) || holdingInstallPrefixes.some((prefix) => key.startsWith(prefix))
}

export function resolveInstallQueueKeepAwake(snapshot: InstallationQueueSnapshot): boolean {
  if (snapshot.activeKey && isKeepAwakeInstallKey(snapshot.activeKey)) return true
  return snapshot.pendingKeys.some(isKeepAwakeInstallKey)
}

export function resolveUpdateKeepAwake(snapshot: Pick<UpdateSnapshot, 'phase'>): boolean {
  return snapshot.phase === 'downloading'
}

export interface InstallKeepAwakeOptions {
  blocker: SleepBlocker
  now?: () => number
  maxHoldMs?: number
  log?: (level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>) => void
}

export function createInstallKeepAwake(options: InstallKeepAwakeOptions) {
  const now = options.now ?? Date.now
  const maxHoldMs = options.maxHoldMs ?? MAX_KEEP_AWAKE_MS
  // 每个原因从什么时候开始挡。同一个原因一直报「还在」不会刷新起点，所以卡死的安装
  // 最多挡两小时，之后交还给系统自己的睡眠计时，直到它真的结束再开始算下一回。
  const active = new Map<InstallKeepAwakeReason, number>()
  const expired = new Set<InstallKeepAwakeReason>()
  let blockerId: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let disposed = false

  function release(): void {
    if (blockerId !== null) {
      try {
        options.blocker.stop(blockerId)
      } catch (error) {
        options.log?.('warn', 'install.keep-awake.stop-failed', '放开睡眠失败', { reason: error instanceof Error ? error.message : String(error) })
      }
      blockerId = null
      options.log?.('info', 'install.keep-awake.released', '安装和下载都结束了，电脑可以照常睡眠')
    }
    if (timer) clearInterval(timer)
    timer = null
  }

  function update(): void {
    const current = now()
    for (const [reason, since] of active) {
      if (current - since >= maxHoldMs) {
        active.delete(reason)
        expired.add(reason)
        options.log?.('warn', 'install.keep-awake.expired', '挡睡眠超过两小时，先交还给系统', { reason })
      }
    }
    if (disposed || active.size === 0) {
      release()
      return
    }
    if (blockerId === null) {
      try {
        blockerId = options.blocker.start('prevent-app-suspension')
        options.log?.('info', 'install.keep-awake.held', '正在安装或下载，先不让电脑自动睡眠', { reasons: [...active.keys()] })
      } catch (error) {
        options.log?.('warn', 'install.keep-awake.start-failed', '挡住睡眠失败，安装照常', { reason: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    if (!timer) {
      timer = setInterval(update, EXPIRY_CHECK_MS)
      timer.unref?.()
    }
  }

  function set(reason: InstallKeepAwakeReason, running: boolean): void {
    if (disposed) return
    if (!running) {
      active.delete(reason)
      expired.delete(reason)
    } else if (!active.has(reason) && !expired.has(reason)) {
      active.set(reason, now())
    }
    update()
  }

  return {
    observeQueue(snapshot: InstallationQueueSnapshot): void {
      set('install', resolveInstallQueueKeepAwake(snapshot))
    },
    observeUpdate(snapshot: Pick<UpdateSnapshot, 'phase'>): void {
      set('update-download', resolveUpdateKeepAwake(snapshot))
    },
    /** 现在是不是正挡着睡眠；测试与日志用。 */
    holding(): boolean {
      return blockerId !== null
    },
    dispose(): void {
      disposed = true
      active.clear()
      expired.clear()
      release()
    },
  }
}
