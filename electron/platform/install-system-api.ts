import path from 'node:path'
import type {
  App,
  BrowserWindow,
  IpcMain,
  NativeTheme,
  Session,
  WebContents,
} from 'electron'
import { AppSettingsStore } from '../app-settings'
import { isTrustedIpcSenderUrl, type ApplicationUrlPolicy } from '../security'
import { platformChannels } from './contract'
import { registerPlatformHandlers } from './ipc'
import { PlatformSettingsStore } from './settings-store'
import { PlatformSystemService } from './system-service'
import {
  createPlatformNotifications,
  type PlatformNotificationRuntime,
} from './notifications'

export interface InstallPlatformApiOptions {
  app: App
  ipcMain: IpcMain
  nativeTheme: NativeTheme
  policy: () => ApplicationUrlPolicy
  isMainWindow?: (window: BrowserWindow) => boolean
  platformPreloadPath?: string
  onError?: (error: unknown) => void
  notificationRuntime?: PlatformNotificationRuntime
}

export function installPlatformSystemApi(
  options: InstallPlatformApiOptions,
): () => void {
  let owner: WebContents | null = null
  let mainWindow: BrowserWindow | null = null
  let service: PlatformSystemService | null = null
  let unsubscribe: (() => void) | null = null
  let notifications: ReturnType<typeof createPlatformNotifications> | null =
    null
  const registrations = new Map<Session, string>()
  const extraPreload = path.resolve(
    options.platformPreloadPath ?? path.join(__dirname, 'preload.js'),
  )
  const unregisterHandlers = registerPlatformHandlers({
    ipcMain: options.ipcMain,
    owner: () => owner,
    policy: options.policy,
    service: () => {
      if (!service) throw new Error('系统设置尚未准备好。')
      return service
    },
  })

  const onWindowCreated = (_event: Electron.Event, window: BrowserWindow) => {
    const contents = window.webContents
    if (owner && !owner.isDestroyed()) return
    // Observe the native creation event before any page can change its title.
    const isMainWindow =
      options.isMainWindow ??
      ((candidate: BrowserWindow) =>
        candidate.getTitle() === '星芒AI管理工具' &&
        candidate.getParentWindow() === null)
    if (contents.getType() !== 'window' || !isMainWindow(window)) return
    owner = contents
    mainWindow = window
    try {
      if (!registrations.has(contents.session))
        registrations.set(
          contents.session,
          contents.session.registerPreloadScript({
            type: 'frame',
            filePath: extraPreload,
          }),
        )
      if (!service) {
        const existing = new AppSettingsStore(
          path.join(options.app.getPath('userData'), 'settings.json'),
        )
        const store = new PlatformSettingsStore(
          path.join(options.app.getPath('userData'), 'platform-settings.json'),
          existing.read().theme,
        )
        const notificationRuntime = options.notificationRuntime ?? {
          supported: () =>
            (
              require('electron')
                .Notification as typeof import('electron').Notification
            ).isSupported(),
          create: (configuration) =>
            new (
              require('electron')
                .Notification as typeof import('electron').Notification
            )(configuration),
        }
        notifications = createPlatformNotifications(
          {
            readEnabled: () => existing.read().desktopNotifications === true,
            readPreferences: () => ({
              install: true,
              balance: true,
              task: true,
              ...store.read().notifications,
            }),
            focusMainWindow: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                if (mainWindow.isMinimized()) mainWindow.restore()
                mainWindow.show()
                mainWindow.focus()
              }
            },
            onError: (error) => options.onError?.(error),
          },
          notificationRuntime,
        )
        service = new PlatformSystemService({
          app: options.app,
          nativeTheme: options.nativeTheme,
          store,
          platform: process.platform,
          packaged: options.app.isPackaged,
          executablePath: process.execPath,
          relaySiteId: () => existing.read().relaySiteId,
          resolveProxy: (url) => {
            if (!owner || owner.isDestroyed()) throw new Error('主窗口已关闭。')
            return owner.session.resolveProxy(url)
          },
          onError: options.onError,
          notify: (kind, key) =>
            notifications?.notify(kind, key) ?? 'unsupported',
        })
        unsubscribe = service.subscribe((state) => {
          if (
            !owner ||
            owner.isDestroyed() ||
            !isTrustedIpcSenderUrl(owner.getURL(), options.policy())
          )
            return
          owner.send(platformChannels.stateChanged, state)
        })
      }
      window.once('closed', () => {
        if (owner === contents) {
          owner = null
          mainWindow = null
        }
      })
    } catch (error) {
      options.onError?.(error)
    }
  }
  options.app.on('browser-window-created', onWindowCreated)
  const dispose = () => {
    options.app.removeListener('browser-window-created', onWindowCreated)
    options.app.removeListener('will-quit', dispose)
    unregisterHandlers()
    unsubscribe?.()
    service?.dispose()
    notifications?.dispose()
    for (const [session, id] of registrations) {
      try {
        session.unregisterPreloadScript(id)
      } catch (error) {
        options.onError?.(error)
      }
    }
    registrations.clear()
    owner = null
    mainWindow = null
  }
  options.app.once('will-quit', dispose)
  return dispose
}
