import { accelerationExpiryWarningSeconds } from '../acceleration-contract'
import type {
  PlatformActivityKind,
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
/** 主进程自己发的通知；渲染层没有通道能请求它们。 */
export type PlatformHostNotification =
  | 'accelerationExpiring'
  | 'accelerationExhausted'
  | 'accelerationInterrupted'
  | 'accelerationInterruptedUnrestored'

interface NotificationMessage {
  title: string
  body: string
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
  // 具体是哪几个工具、更到哪个版本，界面上的「你的工具」已经逐行写着；
  // 通知只负责把人叫回来，不重复那份清单，也不带版本号。
  cliUpdate: {
    title: '命令行工具有新版本',
    body: '你装的工具出了新版本，回到星芒的「你的工具」就能逐个更新。',
  },
} as const satisfies Record<PlatformActivityKind | 'test', NotificationMessage>

// 一条只说「还剩多久」，一条只说「已经断开了」：用户在游戏里看到的就这一行，
// 多一个字的引导都会把它变成广告。免费时长怎么卖不是这里的事，所以不写价格、
// 不写充值入口。主语是「当前账号」，不出现站点名。
const hostMessages: Record<
  PlatformHostNotification,
  NotificationMessage & { kind: PlatformNotificationKind }
> = {
  accelerationExpiring: {
    kind: 'acceleration',
    title: `加速还剩 ${accelerationExpiryWarningSeconds / 60} 分钟`,
    body: '当前账号的免费加速时长快用完了，用完会自动断开。',
  },
  accelerationExhausted: {
    kind: 'acceleration',
    title: '加速已断开',
    body: '当前账号的免费加速时长已用完，加速已自动断开。',
  },
  // 不是用户点的断开。先说网络的现状，因为那是他此刻最关心的：浏览器、微信还
  // 能不能用。「已恢复正常」只在确实读到会话停了之后才说。
  accelerationInterrupted: {
    kind: 'acceleration',
    title: '加速意外断开了',
    body: '网络已恢复正常，可以回到加速页重新连接。',
  },
  accelerationInterruptedUnrestored: {
    kind: 'acceleration',
    title: '加速意外断开了',
    body: '网络可能暂时连不上，点这里回到加速页，星芒会再试着恢复。',
  },
}

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
  const present = (
    kind: PlatformNotificationKind | 'test',
    key: string,
    message: NotificationMessage,
    onClick?: () => void,
  ): PlatformNotificationResult => {
    if (
      !options.readEnabled() ||
      (kind !== 'test' && !options.readPreferences()[kind])
    )
      return 'disabled'
    if (!runtime.supported()) return 'unsupported'
    if (kind !== 'test' && seen.has(key)) return 'duplicate'
    const notification = runtime.create({ ...message, silent: true })
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
        onClick?.()
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
    notify: (kind: PlatformActivityKind | 'test', eventKey: string) =>
      present(kind, `${kind}:${eventKey}`, messages[kind]),
    notifyHost: (
      event: PlatformHostNotification,
      eventKey: string,
      onClick?: () => void,
    ) => {
      // 只把标题与正文交给系统通知：kind 是偏好开关的键，不该出现在通知参数里。
      const { kind, title, body } = hostMessages[event]
      return present(kind, `${event}:${eventKey}`, { title, body }, onClick)
    },
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
