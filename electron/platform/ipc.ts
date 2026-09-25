import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { isTrustedIpcSenderUrl, type ApplicationUrlPolicy } from '../security'
import { platformChannels } from './contract'
import type {
  PlatformActivityKind,
  PlatformInstallNotice,
  PlatformInstallOutcome,
  PlatformNotificationKind,
  PlatformNotificationResult,
  PlatformPrivacyPreference,
} from './contract'
import { isPlatformTheme } from './settings-store'
import type { PlatformSystemService } from './system-service'

export type PlatformIpcLogLevel = 'debug' | 'info' | 'warn' | 'error'

// Mirrors RuntimeLogStore#log so install-system-api can hand its method over
// without an adapter. Kept as a function type rather than the store itself:
// this module must stay free of node:fs so the platform layer can be unit
// tested without a log directory.
export type PlatformIpcLogger = (
  level: PlatformIpcLogLevel,
  source: 'ipc' | 'security',
  event: string,
  message: string,
  detail: Record<string, unknown>,
) => void

const platformOperationLabels: Record<string, string> = {
  [platformChannels.getState]: '读取系统设置',
  [platformChannels.getProxyStatus]: '读取代理状态',
  [platformChannels.setThemePreference]: '切换主题偏好',
  [platformChannels.setHighContrast]: '切换高对比度',
  [platformChannels.setStartup]: '切换开机自启',
  [platformChannels.setNotificationPreference]: '切换通知偏好',
  [platformChannels.setPrivacyPreference]: '切换隐私偏好',
  [platformChannels.testNotification]: '发送测试通知',
  [platformChannels.notifyActivity]: '发送活动通知',
}

const platformReadChannels: ReadonlySet<string> = new Set([
  platformChannels.getState,
  platformChannels.getProxyStatus,
])

function isActivityKind(value: unknown): value is PlatformActivityKind {
  return (
    value === 'install' ||
    value === 'balance' ||
    value === 'task' ||
    value === 'cliUpdate' ||
    value === 'announcement'
  )
}

// 偏好开关比活动通知多一类：加速那两条由主进程发出，用户仍然要能关掉它。
function isNotificationKind(value: unknown): value is PlatformNotificationKind {
  return isActivityKind(value) || value === 'acceleration'
}

function isPrivacyPreference(
  value: unknown,
): value is PlatformPrivacyPreference {
  return value === 'anonymousUsage'
}

function isActivityKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 160 &&
    /^[A-Za-z0-9:._-]+$/.test(value)
  )
}

function isInstallOutcome(value: unknown): value is PlatformInstallOutcome {
  return (
    value === 'installed' ||
    value === 'updated' ||
    value === 'installFailed' ||
    value === 'updateFailed'
  )
}

// 只认编号的字形，不认名单：名单在 notifications.ts，名单外的编号那边一律说成
//「工具」。这里挡的是把任意文字塞进通知或日志。
function isInstallTool(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value)
}

// Rebuilt field by field so nothing else the renderer attached rides along.
function readInstallNotice(value: unknown): PlatformInstallNotice | null {
  if (typeof value !== 'object' || value === null) return null
  const { tool, outcome } = value as Record<string, unknown>
  if (!isInstallTool(tool) || !isInstallOutcome(outcome)) return null
  return { tool, outcome }
}

function isNotificationResult(
  value: unknown,
): value is PlatformNotificationResult {
  return (
    value === 'requested' ||
    value === 'disabled' ||
    value === 'unsupported' ||
    value === 'duplicate'
  )
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

// Every field is re-checked against the same finite set the handler validated
// against, so nothing is spread out of the raw arguments or the service result.
// A future channel therefore cannot leak a payload into the audit trail by
// accident, and a support export keeps carrying the one thing that matters
// here: which machine-level switch the user actually flipped (I13).
export function summarizePlatformInvocation(
  channel: string,
  args: readonly unknown[],
  result: unknown,
): Record<string, unknown> {
  const detail: Record<string, unknown> = {}
  if (channel === platformChannels.setThemePreference) {
    if (isPlatformTheme(args[0])) detail.preference = args[0]
  }
  if (
    channel === platformChannels.setHighContrast ||
    channel === platformChannels.setStartup
  ) {
    if (typeof args[0] === 'boolean') detail.enabled = args[0]
  }
  if (channel === platformChannels.setNotificationPreference) {
    if (isNotificationKind(args[0])) detail.kind = args[0]
    if (typeof args[1] === 'boolean') detail.enabled = args[1]
  }
  if (channel === platformChannels.setPrivacyPreference) {
    if (isPrivacyPreference(args[0])) detail.kind = args[0]
    if (typeof args[1] === 'boolean') detail.enabled = args[1]
  }
  if (channel === platformChannels.notifyActivity) {
    if (isActivityKind(args[0])) detail.kind = args[0]
    if (isActivityKey(args[1])) detail.eventKey = args[1]
    const install = readInstallNotice(args[2])
    if (install) Object.assign(detail, install)
  }
  if (isNotificationResult(result)) detail.result = result
  return detail
}

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
  log?: PlatformIpcLogger
}) {
  const registered: string[] = []
  const log: PlatformIpcLogger = options.log ?? (() => undefined)
  const handle = (
    channel: string,
    count: number | readonly [min: number, max: number],
    action: (...args: unknown[]) => unknown,
  ) => {
    const label = platformOperationLabels[channel] ?? channel
    options.ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const startedAt = Date.now()
      const recordSuccess = (result: unknown) => {
        log(
          platformReadChannels.has(channel) ? 'debug' : 'info',
          'ipc',
          channel,
          `${label}完成`,
          {
            durationMs: Date.now() - startedAt,
            ...summarizePlatformInvocation(channel, args, result),
          },
        )
      }
      const recordFailure = (error: unknown): never => {
        const reason = error instanceof Error ? error.message : String(error)
        log('error', 'ipc', channel, `${label}失败：${reason || '未知错误'}`, {
          durationMs: Date.now() - startedAt,
          error,
        })
        throw error
      }
      try {
        assertPlatformOwner(event, options.owner(), options.policy())
      } catch (error) {
        // The rejected sender is the one fact worth keeping: which page tried.
        // Feedback exports scrub the home directory out of the URL on the way
        // out, so it is recorded here unaltered.
        log(
          'warn',
          'security',
          'platform.denied',
          '已拒绝非主应用窗口的系统设置请求',
          { channel, senderUrl: event.senderFrame?.url ?? null },
        )
        throw error
      }
      try {
        const [min, max] = typeof count === 'number' ? [count, count] : count
        if (args.length < min || args.length > max)
          throw new Error('系统设置请求参数不正确。')
        const result = action(...args)
        if (isPromiseLike(result))
          return Promise.resolve(result).then((value) => {
            recordSuccess(value)
            return value
          }, recordFailure)
        recordSuccess(result)
        return result
      } catch (error) {
        return recordFailure(error)
      }
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
    if (!isNotificationKind(value)) throw new Error('未知的通知类型。')
    return value
  }
  handle(platformChannels.setNotificationPreference, 2, (kind, value) =>
    options
      .service()
      .setNotificationPreference(notificationKind(kind), boolean(value)),
  )
  handle(platformChannels.setPrivacyPreference, 2, (kind, value) => {
    if (!isPrivacyPreference(kind)) throw new Error('未知的隐私偏好。')
    return options.service().setPrivacyPreference(kind, boolean(value))
  })
  handle(platformChannels.testNotification, 0, () =>
    options.service().testNotification(),
  )
  handle(platformChannels.notifyActivity, [2, 3], (kind, key, detail) => {
    // 加速那两条只能由主进程发：渲染层拿到这条通道也只会被拒，免得它绕过
    // 「亲眼看着连上」那层判断去弹一条「加速已断开」。
    if (!isActivityKind(kind)) throw new Error('未知的通知类型。')
    if (!isActivityKey(key)) throw new Error('通知事件编号无效。')
    if (detail === undefined) return options.service().notifyActivity(kind, key)
    const install = readInstallNotice(detail)
    if (kind !== 'install' || !install) throw new Error('通知内容无效。')
    return options.service().notifyActivity(kind, key, install)
  })
  return () => {
    for (const channel of registered) options.ipcMain.removeHandler(channel)
  }
}
