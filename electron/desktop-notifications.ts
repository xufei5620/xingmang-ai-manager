import { Notification, type NotificationConstructorOptions } from 'electron'
import { describeUpdateDiskShortfall } from './disk-space-copy'
import type { UpdateSnapshot } from './updater'

export interface DesktopNotificationCapability {
  supported: boolean
  /** API availability only; the OS can independently mute notifications. */
  reason?: 'unsupported' | 'unavailable'
}

export interface DesktopNotificationHandle {
  on(event: 'click' | 'close' | 'failed', listener: (...args: unknown[]) => void): unknown
  removeAllListeners(): unknown
  show(): void
  close(): void
}

export interface DesktopNotificationRuntime {
  isSupported(): boolean
  create(options: NotificationConstructorOptions): DesktopNotificationHandle
}

const nativeRuntime: DesktopNotificationRuntime = {
  isSupported: () => Notification.isSupported(),
  create: (options) => new Notification(options),
}

export function getDesktopNotificationCapability(
  runtime: Pick<DesktopNotificationRuntime, 'isSupported'> = nativeRuntime,
): DesktopNotificationCapability {
  try { return runtime.isSupported() ? { supported: true } : { supported: false, reason: 'unsupported' } }
  catch { return { supported: false, reason: 'unavailable' } }
}

export interface DesktopNotificationControllerOptions {
  readEnabled(): boolean
  focusMainWindow(): unknown | Promise<unknown>
  onOpenUpdates?(): unknown | Promise<unknown>
  onError(error: unknown): void
  iconPath?: string
  /** 「自动更新」这时是否真的在起作用。不传＝关着，通知照旧说「可在更新页面重启安装」。 */
  readAutoUpdate?(): boolean
}

export type DesktopNotificationResult = 'ignored' | 'unsupported' | 'duplicate' | 'requested' | 'failed'

export interface DesktopNotificationController {
  getCapability(): DesktopNotificationCapability
  handleUpdate(snapshot: UpdateSnapshot): DesktopNotificationResult
  /** Reapplies the saved preference against the last observed update state. */
  refresh(): DesktopNotificationResult
  /**
   * 马上要自动装新版本时的那句预告（auto-update-install.ts 的 buildAutoInstallNotice）。
   * 不看通知开关：装的时候软件会自己关掉、Windows 还会弹授权窗口，这句话是在解释软件
   * 自己接下来要做的事，不说一声用户会以为闪退、被病毒弹窗。系统不支持通知时照样静默。
   */
  announce(notice: { title: string; body: string }): DesktopNotificationResult
  dispose(): void
}

export function updateDesktopNotification(snapshot: UpdateSnapshot, autoUpdate = false): { key: string; version: string; stage: 'available' | 'downloaded' | 'disk'; title: string; body: string } | null {
  if ((snapshot.phase !== 'available' && snapshot.phase !== 'downloaded') || snapshot.error) return null
  const version = snapshot.availableVersion?.trim()
  if (!version || version === snapshot.currentVersion || !/^[a-z0-9][a-z0-9.+_-]{0,79}$/i.test(version)) return null
  // 每个版本只说一次：之后每 3 小时量一次盘，还是不够也不再弹，免得成了骚扰。
  if (snapshot.phase === 'available' && snapshot.diskShortfall) {
    return {
      key: `${version}:disk`,
      version,
      stage: 'disk',
      title: '星芒AI更新先不下载',
      body: describeUpdateDiskShortfall(snapshot.diskShortfall, autoUpdate),
    }
  }
  return {
    key: `${version}:${snapshot.phase}`,
    version,
    stage: snapshot.phase,
    title: snapshot.phase === 'downloaded' ? '星芒AI更新已下载' : '星芒AI有可用更新',
    // 自动更新开着时后台已经在下、关掉软件就会装，再说「已可下载」「可在更新页面重启
    // 安装」就是在让用户去点一个用不着点的按钮。
    body: autoUpdate
      ? snapshot.phase === 'downloaded'
        ? `新版 ${version} 已经下好，关掉软件或下次打开时自动装上，不打断你现在用。`
        : `新版 ${version} 正在后台下载，下好后关掉软件时自动装上。`
      : snapshot.phase === 'downloaded' ? `版本 ${version} 已下载，可在更新页面重启安装。` : `版本 ${version} 已可下载。`,
  }
}

export function createDesktopNotificationController(
  options: DesktopNotificationControllerOptions,
  runtime: DesktopNotificationRuntime = nativeRuntime,
): DesktopNotificationController {
  let disposed = false
  let latest: UpdateSnapshot | null = null
  const seen = new Set<string>()
  const active = new Map<string, { notification: DesktopNotificationHandle; addedKeys: string[] }>()

  const report = (error: unknown) => {
    try { options.onError(error) } catch { /* Native event handlers must never create unhandled rejections. */ }
  }
  const close = (key: string) => {
    const record = active.get(key)
    if (!record) return
    active.delete(key)
    record.notification.removeAllListeners()
    try { record.notification.close() } catch (error) { report(error) }
  }
  const closeAll = () => { for (const key of active.keys()) close(key) }
  const readAutoUpdate = (): boolean => {
    try { return options.readAutoUpdate?.() === true } catch { return false }
  }
  const remember = (key: string): boolean => {
    if (seen.has(key)) return false
    seen.add(key)
    while (seen.size > 64) seen.delete(seen.values().next().value!)
    return true
  }
  const handleUpdate = (snapshot: UpdateSnapshot): DesktopNotificationResult => {
    if (disposed) return 'ignored'
    latest = { ...snapshot, error: snapshot.error ? { ...snapshot.error } : null, progress: snapshot.progress ? { ...snapshot.progress } : null }
    try {
      if (!options.readEnabled()) { closeAll(); return 'ignored' }
      const update = updateDesktopNotification(snapshot, readAutoUpdate())
      if (!update) return 'ignored'
      if (!getDesktopNotificationCapability(runtime).supported) return 'unsupported'
      if (seen.has(update.key)) return 'duplicate'
      // 前一条「正在后台下载」在量完盘之前就弹了，这时它已经不对，收掉。
      if (update.stage === 'downloaded' || update.stage === 'disk') close(`${update.version}:available`)
      while (active.size >= 4) close(active.keys().next().value!)
      const notification = runtime.create({ title: update.title, body: update.body, silent: true, urgency: 'normal', ...(options.iconPath ? { icon: options.iconPath } : {}) })
      // 空间不够那条之后，每 3 小时重新检查都会先回到「有新版本」再量盘，别让那句
      //「正在后台下载」跟着再弹一次。
      const addedKeys = [update.key, ...(update.stage !== 'available' ? [`${update.version}:available`] : [])].filter(remember)
      active.set(update.key, { notification, addedKeys })
      notification.on('click', () => {
        if (disposed) return
        void Promise.resolve().then(async () => { if (disposed) return; await options.focusMainWindow(); if (!disposed) await options.onOpenUpdates?.() }).catch(report)
      })
      notification.on('close', () => {
        if (active.get(update.key)?.notification !== notification) return
        active.delete(update.key)
        notification.removeAllListeners()
      })
      const failed = (error: unknown) => {
        if (active.get(update.key)?.notification !== notification) return
        active.delete(update.key)
        notification.removeAllListeners()
        for (const key of addedKeys) seen.delete(key)
        report(error)
      }
      notification.on('failed', (_event, message) => failed(new Error(typeof message === 'string' ? message.slice(0, 500) : '系统通知显示失败')))
      try { notification.show() } catch (error) { failed(error); return 'failed' }
      return active.has(update.key) || seen.has(update.key) ? 'requested' : 'failed'
    } catch (error) { report(error); return 'failed' }
  }
  return {
    getCapability: () => getDesktopNotificationCapability(runtime),
    handleUpdate,
    refresh: () => {
      if (disposed) return 'ignored'
      if (latest) return handleUpdate(latest)
      try { if (!options.readEnabled()) closeAll() } catch (error) { report(error); return 'failed' }
      return 'ignored'
    },
    announce(notice) {
      if (disposed) return 'ignored'
      try {
        if (!getDesktopNotificationCapability(runtime).supported) return 'unsupported'
        const notification = runtime.create({ title: notice.title.slice(0, 80), body: notice.body.slice(0, 240), silent: true, urgency: 'normal', ...(options.iconPath ? { icon: options.iconPath } : {}) })
        notification.on('failed', (_event, message) => {
          notification.removeAllListeners()
          report(new Error(typeof message === 'string' ? message.slice(0, 500) : '系统通知显示失败'))
        })
        notification.show()
        return 'requested'
      } catch (error) { report(error); return 'failed' }
    },
    dispose() {
      if (disposed) return
      disposed = true
      latest = null
      closeAll()
      seen.clear()
    },
  }
}
