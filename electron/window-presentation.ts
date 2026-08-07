import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'
import type { RendererNavigationTarget } from './ipc-contract'

export interface WindowThemePalette {
  background: string
  titleBar: string
  symbol: string
}

export interface ThemeableWindow {
  setBackgroundColor(color: string): void
  setTitleBarOverlay(options: {
    color: string
    symbolColor: string
    height: number
  }): void
}

export function startupFailureMessage(error: unknown, platform: NodeJS.Platform): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (platform === 'win32') return '主程序初始化失败，Windows 未返回错误详情'
  if (platform === 'darwin') return '主程序初始化失败，macOS 未返回错误详情'
  return '主程序初始化失败，当前系统未返回错误详情'
}

export function platformWindowOptions(
  platform: NodeJS.Platform,
  palette: WindowThemePalette,
  windowsIcon: string,
): Pick<
  BrowserWindowConstructorOptions,
  'autoHideMenuBar' | 'titleBarStyle' | 'titleBarOverlay' | 'icon'
> {
  if (platform === 'darwin') {
    return {
      autoHideMenuBar: false,
      titleBarStyle: 'hiddenInset',
    }
  }
  return {
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: palette.titleBar,
      symbolColor: palette.symbol,
      height: 38,
    },
    icon: windowsIcon,
  }
}

export function applyWindowTheme(
  target: ThemeableWindow,
  palette: WindowThemePalette,
  platform: NodeJS.Platform,
): void {
  target.setBackgroundColor(palette.background)
  if (platform === 'darwin') return
  target.setTitleBarOverlay({
    color: palette.titleBar,
    symbolColor: palette.symbol,
    height: 38,
  })
}

export function buildMacApplicationMenuTemplate(
  appName: string,
  onNavigate: (target: RendererNavigationTarget) => void,
): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: '设置...',
          accelerator: 'CmdOrCtrl+,',
          click: () => onNavigate('settings'),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
}
