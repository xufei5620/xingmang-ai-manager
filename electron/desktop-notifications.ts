import { Notification, type NotificationConstructorOptions } from 'electron'
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
}

export type DesktopNotificationResult = 'ignored' | 'unsupported' | 'duplicate' | 'requested' | 'failed'

export interface DesktopNotificationController {
  getCapability(): DesktopNotificationCapability
  handleUpdate(snapshot: UpdateSnapshot): DesktopNotificationResult
  /** Reapplies the saved preference against the last observed update state. */
  refresh(): DesktopNotificationResult
  dispose(): void
}

export function updateDesktopNotification(snapshot: UpdateSnapshot): { key: string; version: string; stage: 'available' | 'downloaded'; title: string; body: string } | null {
  if ((snapshot.phase !== 'available' && snapshot.phase !== 'downloaded') || snapshot.error) return null
  const version = snapshot.availableVersion?.trim()
  if (!version || version === snapshot.currentVersion || !/^[a-z0-9][a-z0-9.+_-]{0,79}$/i.test(version)) return null
  return {
    key: `${version}:${snapshot.phase}`,
    version,
    stage: snapshot.phase,
    title: snapshot.phase === 'downloaded' ? '星芒AI更新已下载' : '星芒AI有可用更新',
    body: snapshot.phase === 'downloaded' ? `版本 ${version} 已下载，可在更新页面重启安装。` : `版本 ${version} 已可下载。`,
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
      const update = updateDesktopNotification(snapshot)
      if (!update) return 'ignored'
      if (!getDesktopNotificationCapability(runtime).supported) return 'unsupported'
      if (seen.has(update.key)) return 'duplicate'
      if (update.stage === 'downloaded') close(`${update.version}:available`)
      while (active.size >= 4) close(active.keys().next().value!)
      const notification = runtime.create({ title: update.title, body: update.body, silent: true, urgency: 'normal', ...(options.iconPath ? { icon: options.iconPath } : {}) })
      const addedKeys = [update.key, ...(update.stage === 'downloaded' ? [`${update.version}:available`] : [])].filter(remember)
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
    dispose() {
      if (disposed) return
      disposed = true
      latest = null
      closeAll()
      seen.clear()
    },
  }
}
