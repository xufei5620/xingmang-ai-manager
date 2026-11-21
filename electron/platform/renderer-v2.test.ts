import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { App, BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAppSettings, updateAppSettings, writeAppSettings } from '../app-settings'
import { calculatePlatformZoom } from './zoom'
import { installRendererV2Platform } from './renderer-v2'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fakeMainWindow(contentWidth: number) {
  const window = new EventEmitter()
  const webContents = new EventEmitter()
  let zoom = 1
  const setZoomFactor = vi.fn((factor: number) => { zoom = factor })
  Object.assign(webContents, {
    isDestroyed: () => false,
    getZoomFactor: () => zoom,
    setZoomFactor,
  })
  Object.assign(window, {
    webContents,
    isDestroyed: () => false,
    getTitle: () => '星芒AI管理工具',
    getParentWindow: () => null,
    getContentBounds: () => ({ x: 0, y: 0, width: contentWidth, height: 800 }),
    setTitleBarOverlay: vi.fn(),
  })
  return { window: window as unknown as BrowserWindow, emitter: window, setZoomFactor }
}

async function installWithMainWindow(contentWidth: number) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-renderer-v2-platform-'))
  temporaryDirectories.push(userData)
  const settingsFile = path.join(userData, 'settings.json')
  await writeAppSettings(settingsFile, defaultAppSettings(userData))
  const app = new EventEmitter()
  Object.assign(app, { getPath: (name: string) => (name === 'userData' ? userData : os.tmpdir()) })
  installRendererV2Platform(app as unknown as App)
  const main = fakeMainWindow(contentWidth)
  app.emit('browser-window-created', {}, main.window)
  await Promise.resolve()
  return { ...main, settingsFile, userData }
}

describe('renderer-v2 platform zoom (0.2.24 性能深查 R5)', () => {
  it('follows a saved interface scale without polling settings.json', async () => {
    const watchFile = vi.spyOn(fs, 'watchFile')
    const { emitter, setZoomFactor, settingsFile } = await installWithMainWindow(1600)
    expect(watchFile).not.toHaveBeenCalled()
    setZoomFactor.mockClear()

    await updateAppSettings(settingsFile, { version: 2, uiScale: '90' })
    expect(setZoomFactor).toHaveBeenLastCalledWith(calculatePlatformZoom(1600, '90'))
    expect(watchFile).not.toHaveBeenCalled()
    emitter.emit('closed')
  })

  it('stops following settings once the main window is closed', async () => {
    const { emitter, setZoomFactor, settingsFile } = await installWithMainWindow(1600)
    emitter.emit('closed')
    setZoomFactor.mockClear()

    await updateAppSettings(settingsFile, { version: 2, uiScale: '110' })
    expect(setZoomFactor).not.toHaveBeenCalled()
  })
})
