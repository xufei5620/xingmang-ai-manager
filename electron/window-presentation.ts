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

// A role item without a label shows Electron's built-in English name ("Undo",
// "Quit …", "Bring All to Front"). Labels keep the role, so accelerators and
// system behaviour stay the native ones; togglefullscreen's label is fixed
// (Electron never swaps it on state change), so it names the toggle.
export function buildMacApplicationMenuTemplate(
  appName: string,
  onNavigate: (target: RendererNavigationTarget) => void,
): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `关于${appName}` },
        { type: 'separator' },
        {
          label: '设置...',
          accelerator: 'CmdOrCtrl+,',
          click: () => onNavigate('settings'),
        },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出${appName}` },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
  ]
}
