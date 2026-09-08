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

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

describe('additional sandbox preload registration', () => {
  it('registers before navigation, exposes handlers only to the captured owner, and disposes cleanly', async () => {
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
    const window = Object.assign(new EventEmitter(), {
      webContents: contents,
      getTitle: () => '星芒AI管理工具',
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
    })
    expect(session.registerPreloadScript).not.toHaveBeenCalled()
    app.emit('browser-window-created', {}, window as unknown as BrowserWindow)
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
})
