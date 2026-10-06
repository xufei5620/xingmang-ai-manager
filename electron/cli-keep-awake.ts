import type { CliHookEvent } from './cli-hook-events'

// 终端里的 Claude Code / Gemini CLI / Grok 正在跑一轮时，挡住系统自动睡眠；这一轮做完、
// 出错、被打断或工具退出了就放开。信号就是弹通知用的那套钩子记录（cli-hook-events.ts），
// 这里只多记一张「哪些会话还在干活」的表。Codex 不走这里：它自己有防睡开关
// （config-files.ts 写的 features.prevent_idle_sleep）。
//
// 只挡「自动睡眠」，屏幕照样按用户的设置关；不改任何系统电源设置，星芒退出时系统
// 自己就放开了。

// 只要还有一轮没报结束就一直挡着，但总得有个头：终端窗口被直接关掉、Gemini 这一轮
// 接口出错（它不报结束，只在退出时报）都不会有下文。两小时够覆盖绝大多数长任务，
// 过了就当它已经不在跑了，交还给系统自己的睡眠计时。
export const MAX_KEEP_AWAKE_MS = 2 * 60 * 60_000
const EXPIRY_CHECK_MS = 60_000
// 开着一堆终端从不收尾时也只记这么多。
const MAX_TRACKED_TURNS = 50

export interface SleepBlocker {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}

interface ActiveTurn {
  since: number
  turn?: string
}

export interface CliKeepAwakeOptions {
  blocker: SleepBlocker
  now?: () => number
  maxHoldMs?: number
  log?: (level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>) => void
  /** 挡着的工具变了（开始挡、换了一批、放开）：托盘那行「暂不让电脑自动睡眠」跟着换。 */
  onChange?: () => void
}

export function createCliKeepAwake(options: CliKeepAwakeOptions) {
  const now = options.now ?? Date.now
  const maxHoldMs = options.maxHoldMs ?? MAX_KEEP_AWAKE_MS
  const active = new Map<string, ActiveTurn>()
  let blockerId: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let disposed = false
  let announced = ''

  function release(): void {
    if (blockerId !== null) {
      try {
        options.blocker.stop(blockerId)
      } catch (error) {
        options.log?.('warn', 'cli-keep-awake.stop-failed', '放开睡眠失败', { reason: error instanceof Error ? error.message : String(error) })
      }
      blockerId = null
      options.log?.('info', 'cli-keep-awake.released', '终端里的工具都不在干活了，电脑可以照常睡眠')
    }
    if (timer) clearInterval(timer)
    timer = null
  }

  // 真挡着时才算：挡不上（start 抛错）的时候托盘不能说「暂不让电脑睡眠」。
  function heldTools(): string[] {
    if (blockerId === null) return []
    return [...new Set([...active.keys()].map((key) => key.split(':')[0]))].sort()
  }

  function announce(): void {
    const current = heldTools().join(',')
    if (current === announced) return
    announced = current
    try {
      options.onChange?.()
    } catch (error) {
      options.log?.('warn', 'cli-keep-awake.notify-failed', '托盘没跟上防睡状态', { reason: error instanceof Error ? error.message : String(error) })
    }
  }

  function update(): void {
    refresh()
    announce()
  }

  function refresh(): void {
    const current = now()
    for (const [key, entry] of active) {
      if (current - entry.since >= maxHoldMs) active.delete(key)
    }
    if (disposed || active.size === 0) {
      release()
      return
    }
    if (blockerId === null) {
      try {
        blockerId = options.blocker.start('prevent-app-suspension')
        options.log?.('info', 'cli-keep-awake.held', '终端里的工具在干活，先不让电脑自动睡眠', { tools: [...new Set([...active.keys()].map((key) => key.split(':')[0]))] })
      } catch (error) {
        options.log?.('warn', 'cli-keep-awake.start-failed', '挡住睡眠失败，这一轮照常', { reason: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    if (!timer) {
      timer = setInterval(update, EXPIRY_CHECK_MS)
      timer.unref?.()
    }
  }

  return {
    observe(event: CliHookEvent): void {
      if (disposed || event.tool === 'codex') return
      const key = `${event.tool}:${event.session}`
      switch (event.event) {
        case 'started':
          active.delete(key)
          active.set(key, event.turn ? { since: event.at, turn: event.turn } : { since: event.at })
          while (active.size > MAX_TRACKED_TURNS) active.delete(active.keys().next().value!)
          break
        // 停下来等人点确认时照样挡着：点完它接着干，却不会再报一次开始。
        case 'waiting':
          return
        case 'finished':
        case 'failed':
        case 'cancelled': {
          const entry = active.get(key)
          // 上一轮的结束报告晚到了，这时候跑着的是新的一轮。没带编号的报告是
          // 会话层面的收尾，一律放开。
          if (entry?.turn && event.turn && entry.turn !== event.turn) return
          active.delete(key)
          break
        }
        case 'ended':
          active.delete(key)
          break
      }
      update()
    },
    /** 现在是不是正挡着睡眠；测试与日志用。 */
    holding(): boolean {
      return blockerId !== null
    },
    /** 正挡着睡眠时，是哪几个工具在干活（claude、gemini、grok）；没在挡时为空。 */
    tools(): string[] {
      return heldTools()
    },
    dispose(): void {
      disposed = true
      active.clear()
      release()
    },
  }
}
