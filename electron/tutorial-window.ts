import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
} from 'electron'
import path from 'node:path'
import { tutorialDocumentUrl } from './relay-sites'
import type { RuntimeLogStore } from './runtime-log'

const tutorialWindowTitle = '教程文档 - 星芒AI管理工具'
const allowedTutorialHosts = new Set([
  's4621e8xzb.feishu.cn',
  'accounts.feishu.cn',
])

export interface TutorialWindowControllerOptions {
  runtimeLog: Pick<RuntimeLogStore, 'log' | 'exception'>
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow
}

export interface TutorialWindowController {
  open(parent?: BrowserWindow): Promise<void>
  closeIfOpen(): void
  dispose(): void
}

export function isAllowedTutorialNavigationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && allowedTutorialHosts.has(url.hostname)
  } catch {
    return false
  }
}

export function safeTutorialDownloadFilename(value: string): string {
  const baseName = path.posix.basename(value.replaceAll('\\', '/'))
  const cleaned = baseName
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180)
  if (!cleaned || cleaned === '.' || cleaned === '..') return '教程附件'
  const stem = cleaned.split('.')[0]?.toUpperCase() ?? ''
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) ? `_${cleaned}` : cleaned
}

export function createTutorialWindowController(
  options: TutorialWindowControllerOptions,
): TutorialWindowController {
  const createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions))
  let tutorialWindow: BrowserWindow | null = null
  let pendingOpen: Promise<void> | null = null
  let tutorialSessionHardened = false

  async function create(parent?: BrowserWindow): Promise<void> {
    const window = createWindow({
      parent,
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#f5f6f7',
      title: tutorialWindowTitle,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: !app.isPackaged,
        webviewTag: false,
        navigateOnDragDrop: false,
        partition: 'xingmang-tutorial-docs',
        spellcheck: false,
        safeDialogs: true,
      },
    })
    tutorialWindow = window

    if (!tutorialSessionHardened) {
      tutorialSessionHardened = true
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      window.webContents.session.setPermissionCheckHandler(() => false)
      window.webContents.session.setDevicePermissionHandler(() => false)
      window.webContents.session.on('will-download', (event, item, sourceContents) => {
        if (
          !item.hasUserGesture()
          || !tutorialWindow
          || tutorialWindow.isDestroyed()
          || sourceContents !== tutorialWindow.webContents
        ) {
          event.preventDefault()
          options.runtimeLog.log('warn', 'tutorial', 'download.blocked', '已阻止非用户触发的教程附件下载')
          return
        }
        const filename = safeTutorialDownloadFilename(item.getFilename())
        item.setSaveDialogOptions({
          title: '保存教程附件',
          defaultPath: filename,
          buttonLabel: '保存',
          properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
        })
        options.runtimeLog.log('info', 'tutorial', 'download.started', '教程附件下载已由用户确认', {
          filename,
        })
        item.once('done', (_doneEvent, state) => {
          options.runtimeLog.log(
            state === 'completed' ? 'info' : state === 'cancelled' ? 'warn' : 'error',
            'tutorial',
            `download.${state}`,
            state === 'completed' ? '教程附件下载完成' : state === 'cancelled' ? '教程附件下载已取消' : '教程附件下载中断',
            { filename },
          )
        })
      })
    }

    window.once('ready-to-show', () => {
      if (window.isDestroyed()) return
      window.center()
      window.show()
      window.focus()
    })
    window.on('closed', () => {
      if (tutorialWindow === window) tutorialWindow = null
    })
    window.on('page-title-updated', (event) => {
      event.preventDefault()
      if (!window.isDestroyed()) window.setTitle(tutorialWindowTitle)
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, targetUrl) => {
      if (!isAllowedTutorialNavigationUrl(targetUrl)) event.preventDefault()
    })
    // 服务端 302 也要过同一道门:只拦 will-navigate 时,一次重定向就能把
    // 这个挂着"教程文档"标题的窗口带去任意 https 站(合并审查项)。
    window.webContents.on('will-redirect', (event, targetUrl) => {
      if (!isAllowedTutorialNavigationUrl(targetUrl)) event.preventDefault()
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      options.runtimeLog.log('error', 'tutorial', 'process.gone', '教程文档渲染进程异常退出', {
        reason: details.reason,
        exitCode: details.exitCode,
      })
    })
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      options.runtimeLog.log('error', 'tutorial', 'page.load.failed', '教程文档加载失败', {
        errorCode,
        errorDescription,
        url: validatedUrl,
      })
    })

    try {
      await window.loadURL(tutorialDocumentUrl)
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      options.runtimeLog.exception('tutorial', 'window.open.failed', error)
      throw new Error('教程文档加载失败，请检查网络后重试')
    }
  }

  return {
    async open(parent) {
      if (tutorialWindow && !tutorialWindow.isDestroyed()) {
        if (tutorialWindow.isMinimized()) tutorialWindow.restore()
        tutorialWindow.show()
        tutorialWindow.focus()
        return
      }
      if (!pendingOpen) {
        pendingOpen = create(parent).finally(() => {
          pendingOpen = null
        })
      }
      await pendingOpen
    },
    closeIfOpen() {
      if (tutorialWindow && !tutorialWindow.isDestroyed()) tutorialWindow.close()
    },
    dispose() {
      if (tutorialWindow && !tutorialWindow.isDestroyed()) tutorialWindow.close()
      tutorialWindow = null
    },
  }
}
