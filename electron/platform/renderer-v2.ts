import fs from 'node:fs'
import path from 'node:path'
import type { App, BrowserWindow } from 'electron'
import { AppSettingsStore } from '../app-settings'
import { calculatePlatformZoom } from './zoom'

export function installRendererV2Platform(app: App): void {
  const dispose = new Set<() => void>()
  app.on('browser-window-created', (_event, window: BrowserWindow) => {
    queueMicrotask(() => {
      if (window.isDestroyed()) return
      if (window.getTitle() !== '星芒AI管理工具' || window.getParentWindow()) return
      const settingsFile = path.join(app.getPath('userData'), 'settings.json')
      const store = new AppSettingsStore(settingsFile)
      function apply() {
        if (window.isDestroyed() || window.webContents.isDestroyed()) return
        const preference = store.read().uiScale ?? 'auto'
        const factor = calculatePlatformZoom(window.getContentBounds().width, preference)
        if (Math.abs(window.webContents.getZoomFactor() - factor) > 0.0001) window.webContents.setZoomFactor(factor)
        if (process.platform === 'win32') window.setTitleBarOverlay({ height: Math.round(36 * factor) })
      }
      window.on('resize', apply)
      window.webContents.on('did-finish-load', apply)
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return
        const fullscreen = process.platform === 'darwin' ? input.meta && input.control && input.key.toLowerCase() === 'f' : input.key === 'F11'
        if (fullscreen) { event.preventDefault(); window.setFullScreen(!window.isFullScreen()) }
      })
      fs.watchFile(settingsFile, { interval: 500, persistent: false }, apply)
      function cleanup() {
        fs.unwatchFile(settingsFile, apply)
        window.removeListener('resize', apply)
        dispose.delete(cleanup)
      }
      window.once('closed', cleanup)
      dispose.add(cleanup)
      apply()
    })
  })
  app.once('will-quit', () => { for (const cleanup of dispose) cleanup() })
}
