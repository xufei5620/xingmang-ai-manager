import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { isTrustedIpcSenderUrl, type ApplicationUrlPolicy } from '../security'
import { platformChannels } from './contract'
import type {
  PlatformNotificationKind,
  PlatformPrivacyPreference,
} from './contract'
import { isPlatformTheme } from './settings-store'
import type { PlatformSystemService } from './system-service'

export function assertPlatformOwner(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  owner: WebContents | null,
  policy: ApplicationUrlPolicy,
): void {
  if (
    !owner ||
    owner.isDestroyed() ||
    event.sender !== owner ||
    !event.senderFrame ||
    event.senderFrame !== owner.mainFrame ||
    !isTrustedIpcSenderUrl(event.senderFrame.url, policy) ||
    event.senderFrame.url !== owner.getURL()
  )
    throw new Error('已拒绝非主应用窗口的系统设置请求。')
}

export function registerPlatformHandlers(options: {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  owner: () => WebContents | null
  policy: () => ApplicationUrlPolicy
  service: () => PlatformSystemService
}) {
  const registered: string[] = []
  const handle = (
    channel: string,
    count: number,
    action: (...args: unknown[]) => unknown,
  ) => {
    options.ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertPlatformOwner(event, options.owner(), options.policy())
      if (args.length !== count) throw new Error('系统设置请求参数不正确。')
      return action(...args)
    })
    registered.push(channel)
  }
  const boolean = (value: unknown) => {
    if (typeof value !== 'boolean') throw new Error('系统设置开关值无效。')
    return value
  }
  handle(platformChannels.getState, 0, () => options.service().getState())
  handle(platformChannels.getProxyStatus, 0, () =>
    options.service().getProxyStatus(),
  )
  handle(platformChannels.setThemePreference, 1, (value) => {
    if (!isPlatformTheme(value)) throw new Error('未知的主题偏好。')
    return options.service().setThemePreference(value)
  })
  handle(platformChannels.setHighContrast, 1, (value) =>
    options.service().setHighContrast(boolean(value)),
  )
  handle(platformChannels.setStartup, 1, (value) =>
    options.service().setStartup(boolean(value)),
  )
  const notificationKind = (value: unknown): PlatformNotificationKind => {
    if (value !== 'install' && value !== 'balance' && value !== 'task')
      throw new Error('未知的通知类型。')
    return value
  }
  handle(platformChannels.setNotificationPreference, 2, (kind, value) =>
    options
      .service()
      .setNotificationPreference(notificationKind(kind), boolean(value)),
  )
  handle(platformChannels.setPrivacyPreference, 2, (kind, value) => {
    if (kind !== 'crashReports' && kind !== 'anonymousUsage')
      throw new Error('未知的隐私偏好。')
    return options.service().setPrivacyPreference(kind, boolean(value))
  })
  handle(platformChannels.testNotification, 0, () =>
    options.service().testNotification(),
  )
  handle(platformChannels.notifyActivity, 2, (kind, key) => {
    const category = notificationKind(kind)
    if (
      typeof key !== 'string' ||
      key.length < 1 ||
      key.length > 160 ||
      !/^[A-Za-z0-9:._-]+$/.test(key)
    )
      throw new Error('通知事件编号无效。')
    return options.service().notifyActivity(category, key)
  })
  return () => {
    for (const channel of registered) options.ipcMain.removeHandler(channel)
  }
}
