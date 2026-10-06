import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'
import { isChineseSentence } from './chinese-sentence'
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

export type AssetMenuMediaType = 'image' | 'video' | 'audio'

const assetMenuFailureText: Record<AssetMenuMediaType, { title: string; fallback: string }> = {
  image: { title: '图片操作失败', fallback: '无法完成图片操作' },
  video: { title: '视频操作失败', fallback: '无法完成视频操作' },
  audio: { title: '音频操作失败', fallback: '无法完成音频操作' },
}

// AI 图片、视频、音频的系统菜单（「更多操作」、右键，画布里右键素材也是它）先弹出来，点了某一项
// 才去读文件。文件被挪走、删掉或被别的程序占着时，Node 的原话是英文，还带着完整路径和用户名
// （ENOENT: no such file or directory, open 'C:\Users\张三\…'），以前原样当错误框正文（第三十六批 A）。
// 主进程自己抛的中文（「账号已切换，请重新打开图片菜单」）照原样，其余换成兜底句，原话由调用处记进运行日志。
export function assetMenuFailureDialog(mediaType: AssetMenuMediaType, error: unknown): { title: string; message: string } {
  const { title, fallback } = assetMenuFailureText[mediaType]
  const message = error instanceof Error ? error.message.trim() : ''
  return { title, message: message && isChineseSentence(message) ? message : fallback }
}

// Linux 的 nativeImage 解不开 .ico，给它 .ico 窗口和任务栏就只剩一个空白方块；画布窗口
// 早就用 PNG 了。macOS 不看窗口图标（Dock 另设），Windows 照旧用多尺寸的 .ico。
export function windowIconFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin' ? 'favicon.ico' : 'app-icon.png'
}

// Linux 上不一定有托盘（linux-tray-host.ts），窗口一关软件就退了；有托盘时关窗只是藏起来，
// 得先从托盘菜单退出，否则重新打开拿到的还是那个空白窗口。
export function rendererCrashRecoveryDetail(platform: NodeJS.Platform): string {
  const restart = platform === 'darwin'
    ? '从屏幕顶部菜单栏的星芒图标退出软件后重新打开'
    : platform === 'win32'
      ? '从任务栏右下角的星芒图标退出软件后重新打开'
      : '关掉窗口再从应用菜单重新打开（屏幕顶部或任务栏上有星芒图标的话，先从它的菜单里点「退出」）'
  return `可以再试一次重新加载。如果还是空白，请${restart}，并在「反馈」页把问题发给我们。正在进行的安装、下载和已保存的设置都不受影响。`
}

export function platformWindowOptions(
  platform: NodeJS.Platform,
  palette: WindowThemePalette,
  windowIcon: string,
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
    icon: windowIcon,
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
