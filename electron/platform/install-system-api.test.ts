import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type {
  App,
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
  NativeTheme,
} from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPlatformSystemApi } from './install-system-api'
import { platformChannels } from './contract'
import { hostNotifier } from './host-notification-bridge'
import { attachRendererDelivery, detachRendererDelivery } from './renderer-delivery-bridge'
import { ipcEventChannels } from '../ipc-contract'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function notificationRuntimeFixture() {
  const created: { title: string; body: string; click?: () => void }[] = []
  return {
    created,
    runtime: {
      supported: () => true,
      create: (options: { title: string; body: string; silent: boolean }) => {
        const entry: { title: string; body: string; click?: () => void } = { title: options.title, body: options.body }
        created.push(entry)
        return {
          on: (event: string, listener: (...args: unknown[]) => void) => { if (event === 'click') entry.click = () => listener() },
          show: () => undefined,
          close: () => undefined,
          removeAllListeners: () => undefined,
        }
      },
    },
  }
}

function installFixture(notificationRuntime?: ReturnType<typeof notificationRuntimeFixture>['runtime']) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'xingmang-platform-install-'),
  )
  roots.push(root)
  const app = Object.assign(new EventEmitter(), {
    getPath: vi.fn(() => root),
    isPackaged: false,
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
  })
  const nativeTheme = Object.assign(new EventEmitter(), {
    themeSource: 'system',
    shouldUseDarkColors: false,
    shouldUseHighContrastColors: false,
  })
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  >()
  const ipcMain = {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  }
  const session = {
    registerPreloadScript: vi.fn(() => 'preload-id'),
    unregisterPreloadScript: vi.fn(),
    resolveProxy: vi.fn(async () => 'DIRECT'),
  }
  const frame = { url: 'http://127.0.0.1:5174/index.html' }
  const contents = {
    getType: () => 'window',
    isDestroyed: () => false,
    mainFrame: frame,
    getURL: () => frame.url,
    session,
    send: vi.fn(),
  }
  const windowTitle = { value: '星芒AI管理工具' }
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    getTitle: () => windowTitle.value,
    isDestroyed: () => false,
    getParentWindow: () => null,
  })
  const onError = vi.fn()
  const dispose = installPlatformSystemApi({
    app: app as unknown as App,
    nativeTheme: nativeTheme as unknown as NativeTheme,
    ipcMain: ipcMain as unknown as IpcMain,
    policy: () => ({
      rendererRoot: root,
      devServerUrl: 'http://127.0.0.1:5174',
    }),
    platformPreloadPath: path.join(root, 'platform-preload.js'),
    onError,
    ...(notificationRuntime ? { notificationRuntime } : {}),
  })
  return { root, app, handlers, session, frame, contents, window, windowTitle, onError, dispose }
}

describe('additional sandbox preload registration', () => {
  it('registers before navigation, exposes handlers only to the captured owner, and disposes cleanly', async () => {
    const { root, app, handlers, session, frame, contents, window, onError, dispose } = installFixture()
    expect(session.registerPreloadScript).not.toHaveBeenCalled()
    app.emit('browser-window-created', {}, window as unknown as BrowserWindow)
    await Promise.resolve()
    expect(session.registerPreloadScript).toHaveBeenCalledWith({
      type: 'frame',
      filePath: path.join(root, 'platform-preload.js'),
    })
    const event = {
      sender: contents,
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent
    expect(handlers.get(platformChannels.getState)!(event)).toMatchObject({
      startup: { supported: false },
    })
    await expect(
      handlers.get(platformChannels.setHighContrast)!(event, true),
    ).resolves.toMatchObject({ preferences: { highContrast: true } })
    expect(contents.send).toHaveBeenCalledWith(
      platformChannels.stateChanged,
      expect.objectContaining({
        appearance: expect.objectContaining({ highContrast: true }),
      }),
    )
    expect(app.getLoginItemSettings).not.toHaveBeenCalled()
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(session.resolveProxy).not.toHaveBeenCalled()
    window.emit('closed')
    expect(() => handlers.get(platformChannels.getState)!(event)).toThrow(
      '非主应用窗口',
    )
    dispose()
    expect(handlers.size).toBe(0)
    expect(session.unregisterPreloadScript).toHaveBeenCalledWith('preload-id')
    expect(onError).not.toHaveBeenCalled()
  })
  it('captures a main window whose title is applied after the creation event, as on macOS', async () => {
    const { root, app, session, window, windowTitle, onError, dispose } = installFixture()
    windowTitle.value = ''
    app.emit('browser-window-created', {}, window as unknown as BrowserWindow)
    // NativeWindowMac takes the constructor's title only after Electron has
    // emitted browser-window-created, still inside the same constructor call.
    windowTitle.value = '星芒AI管理工具'
    await Promise.resolve()
    expect(session.registerPreloadScript).toHaveBeenCalledWith({
      type: 'frame',
      filePath: path.join(root, 'platform-preload.js'),
    })
    dispose()
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores a window that is not titled as the main window once constructed', async () => {
    const { app, session, window, windowTitle, dispose } = installFixture()
    windowTitle.value = '图片预览'
    app.emit('browser-window-created', {}, window as unknown as BrowserWindow)
    await Promise.resolve()
    expect(session.registerPreloadScript).not.toHaveBeenCalled()
    dispose()
  })
})

describe('host activity notifications', () => {
  it('shows the main process balance alert with the renderer wording and holds its click-through page until the renderer is ready', async () => {
    const notifications = notificationRuntimeFixture()
    const { app, window, contents, dispose } = installFixture(notifications.runtime)
    const shown = vi.fn()
    Object.assign(window, { isMinimized: () => false, restore: vi.fn(), show: shown, focus: vi.fn() })
    app.emit('browser-window-created', {}, window as unknown as BrowserWindow)
    await Promise.resolve()
    const held: (() => void)[] = []
    const holdUntilReady = (_key: string, send: () => void) => { held.push(send) }
    attachRendererDelivery(holdUntilReady)
    try {
      expect(hostNotifier()({ activity: 'balance', eventKey: 'balance:7:1' })).toBe('requested')
      expect(notifications.created).toEqual([expect.objectContaining({ title: '余额需要留意' })])
      notifications.created[0]!.click!()
      expect(shown).toHaveBeenCalledOnce()
      expect(contents.send).not.toHaveBeenCalledWith(ipcEventChannels.onNavigate, 'topup')
      for (const send of held) send()
      expect(contents.send).toHaveBeenCalledWith(ipcEventChannels.onNavigate, 'topup')
      expect(hostNotifier()({ activity: 'spend', eventKey: 'spend:7:2', detail: { cents: 1234, multiple: 6 } })).toBe('requested')
      expect(notifications.created[1]).toMatchObject({ body: expect.stringContaining('$12.34') })
    } finally {
      detachRendererDelivery(holdUntilReady)
      dispose()
    }
  })
})
