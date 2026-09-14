import path from 'node:path'
import fs from 'node:fs'
import { app, ipcMain, nativeTheme } from 'electron'
import { installRendererV2Platform } from './renderer-v2'
import { installPlatformSystemApi } from './install-system-api'

const requestedRenderer = process.env.XINGMANG_RENDERER?.trim()
const usesDevServer = Boolean(process.env.VITE_DEV_SERVER_URL)
const builtWithV2 = !usesDevServer && fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'renderer-v2.flag'))
// A file build must follow the renderer that was actually emitted. Only a
// live dev server can select its renderer from the current environment.
const rendererV2Enabled = usesDevServer ? requestedRenderer !== 'legacy' : builtWithV2
if (rendererV2Enabled) {
  installRendererV2Platform(app)
  installPlatformSystemApi({
    app, ipcMain, nativeTheme,
    policy: () => ({
      rendererRoot: path.join(__dirname, '..', '..', 'dist'),
      devServerUrl: app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL,
      packagedBaseUrl: 'xingmang://app/',
    }),
    onError: (error) => console.error('[renderer-v2 platform]', error instanceof Error ? error.message : 'Platform service failed'),
  })
}
require('../main')
