import type { PlatformIpcLogger } from './ipc'

// The platform handlers are registered by desktop-entry.ts, which runs before
// main.ts builds the RuntimeLogStore. A handler cannot fire that early (no
// window exists yet), but an audit trail that silently drops its first entries
// would reintroduce exactly the blind spot this bridge closes, so entries made
// before the store exists are held instead of thrown away.
const MAX_BUFFERED_ENTRIES = 50

interface BufferedEntry {
  level: Parameters<PlatformIpcLogger>[0]
  source: Parameters<PlatformIpcLogger>[1]
  event: string
  message: string
  detail: Record<string, unknown>
}

export interface PlatformLogBridge {
  readonly logger: PlatformIpcLogger
  attach(sink: PlatformIpcLogger): void
}

export function createPlatformLogBridge(
  maxBuffered: number = MAX_BUFFERED_ENTRIES,
): PlatformLogBridge {
  let sink: PlatformIpcLogger | null = null
  const pending: BufferedEntry[] = []
  let dropped = 0
  return {
    logger: (level, source, event, message, detail) => {
      if (sink) {
        sink(level, source, event, message, detail)
        return
      }
      pending.push({ level, source, event, message, detail })
      while (pending.length > maxBuffered) {
        pending.shift()
        dropped += 1
      }
    },
    attach: (next) => {
      sink = next
      const buffered = pending.splice(0, pending.length)
      const missing = dropped
      dropped = 0
      if (missing > 0)
        next('warn', 'ipc', 'platform.log.overflow', '系统设置日志缓冲已溢出', {
          droppedEntries: missing,
        })
      for (const entry of buffered)
        next(entry.level, entry.source, entry.event, entry.message, entry.detail)
    },
  }
}

const appBridge = createPlatformLogBridge()

export function platformAuditLogger(): PlatformIpcLogger {
  return appBridge.logger
}

export function attachPlatformAuditLog(sink: PlatformIpcLogger): void {
  appBridge.attach(sink)
}
