import type {
  PlatformNotificationKind,
  PlatformNotificationPreferences,
  PlatformNotificationResult,
} from './contract'

export interface PlatformNotificationHandle {
  on(
    event: 'click' | 'close' | 'failed',
    listener: (...args: unknown[]) => void,
  ): unknown
  show(): void
  close(): void
  removeAllListeners(): unknown
}
export interface PlatformNotificationRuntime {
  supported(): boolean
  create(options: {
    title: string
    body: string
    silent: boolean
  }): PlatformNotificationHandle
}
const messages = {
  test: { title: '星芒测试通知', body: '这是一条测试通知，可在设置中关闭。' },
  install: {
    title: '工具已准备好',
    body: '安装或更新已经完成，可以回到星芒工具箱查看。',
  },
  balance: {
    title: '余额需要留意',
    body: '星芒余额不足 $5，可以在个人中心查看和充值。',
  },
  task: {
    title: '异步任务已完成',
    body: '任务结果已经更新，可以回到星芒工具箱查看。',
  },
} as const

export function createPlatformNotifications(
  options: {
    readEnabled: () => boolean
    readPreferences: () => PlatformNotificationPreferences
    focusMainWindow: () => void
    onError: (error: unknown) => void
  },
  runtime: PlatformNotificationRuntime,
) {
  const seen = new Set<string>()
  const active = new Set<PlatformNotificationHandle>()
  const report = (error: unknown) => {
    try {
      options.onError(error)
    } catch {
      /* Native events must not throw. */
    }
  }
  const notify = (
    kind: PlatformNotificationKind | 'test',
    eventKey: string,
  ): PlatformNotificationResult => {
    if (
      !options.readEnabled() ||
      (kind !== 'test' && !options.readPreferences()[kind])
    )
      return 'disabled'
    if (!runtime.supported()) return 'unsupported'
    const key = `${kind}:${eventKey}`
    if (kind !== 'test' && seen.has(key)) return 'duplicate'
    const notification = runtime.create({ ...messages[kind], silent: true })
    while (active.size >= 4) {
      const oldest = active.values().next().value!
      active.delete(oldest)
      oldest.removeAllListeners()
      oldest.close()
    }
    const release = () => {
      active.delete(notification)
      notification.removeAllListeners()
    }
    notification.on('click', () => {
      try {
        options.focusMainWindow()
      } catch (error) {
        report(error)
      }
    })
    notification.on('close', release)
    notification.on('failed', (_event, reason) => {
      seen.delete(key)
      release()
      report(
        new Error(
          typeof reason === 'string'
            ? reason.slice(0, 200)
            : '系统通知没有显示。',
        ),
      )
    })
    active.add(notification)
    if (kind !== 'test') {
      seen.add(key)
      while (seen.size > 64) seen.delete(seen.values().next().value!)
    }
    try {
      notification.show()
    } catch (error) {
      seen.delete(key)
      release()
      throw error
    }
    return 'requested'
  }
  return {
    notify,
    dispose: () => {
      for (const notification of active) {
        notification.removeAllListeners()
        notification.close()
      }
      active.clear()
      seen.clear()
    },
  }
}
