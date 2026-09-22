import type { PlatformNotificationResult } from './contract'
import type { PlatformHostNotification } from './notifications'

// 系统通知那套由 desktop-entry.ts 建起来（install-system-api.ts），main.ts 拿不到
// 它的句柄——两边在同一个进程里，却谁也不 import 谁。加速的两条通知恰恰是从
// main.ts 那一侧发出的，所以这里按 runtime-log-bridge.ts 的做法留一个转接口。
//
// 与日志那个桥的差别：**这里不缓冲**。一条「加速还剩 5 分钟」晚几分钟送到，比
// 不送更糟——用户看到它的时候时长早就用完了。没接上就如实返回 unsupported。
export interface HostNotificationRequest {
  event: PlatformHostNotification
  /** 同一会话重复请求只出现一次；通知层按 `事件:编号` 去重。 */
  eventKey: string
  /** 点通知时在「叫回主窗口」之后再做一步，例如切到加速页。 */
  onClick?: () => void
}

export type HostNotifier = (
  request: HostNotificationRequest,
) => PlatformNotificationResult

export interface HostNotificationBridge {
  readonly notify: HostNotifier
  attach(sink: HostNotifier): void
  detach(sink: HostNotifier): void
}

export function createHostNotificationBridge(): HostNotificationBridge {
  let sink: HostNotifier | null = null
  return {
    notify: (request) => (sink ? sink(request) : 'unsupported'),
    attach: (next) => {
      sink = next
    },
    detach: (previous) => {
      // 只有当前这一个才能摘掉自己：窗口重建时新的已经接上，旧的 dispose 不该
      // 把它摘走。
      if (sink === previous) sink = null
    },
  }
}

const appBridge = createHostNotificationBridge()

export function hostNotifier(): HostNotifier {
  return appBridge.notify
}

export function attachHostNotifier(sink: HostNotifier): void {
  appBridge.attach(sink)
}

export function detachHostNotifier(sink: HostNotifier): void {
  appBridge.detach(sink)
}
