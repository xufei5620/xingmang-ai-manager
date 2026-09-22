import type { BrowserWindow } from 'electron'
import { resolveRecoveredWindowBounds, type WindowBounds } from './window-preferences'

export type RecoverableWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isFullScreen' | 'isMaximized' | 'isMinimized' | 'getBounds' | 'getNormalBounds' | 'setBounds' | 'unmaximize' | 'maximize'
>
// Electron 的 screen 结构上满足它；这里只读显示器编号与工作区。
export interface DisplayScreen {
  getAllDisplays(): ReadonlyArray<{ id: number; workArea: WindowBounds }>
  getPrimaryDisplay(): { id: number }
}

/**
 * 窗口停在已经拔掉的显示器上时，把它挪回主屏居中；返回挪到了哪里，不用挪返回 null。
 *
 * 只在窗口马上要被看见（`show` / `restore`）或者正在被看见时调用：对隐藏窗口
 * `unmaximize()` 在 Windows 上会顺手把它显示出来。全屏窗口不动，那是系统在管。
 */
export function recoverOffscreenWindow(window: RecoverableWindow, screen: DisplayScreen): WindowBounds | null {
  if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) return null
  const displays = screen.getAllDisplays().map((display) => ({ id: display.id, workArea: display.workArea }))
  const maximized = window.isMaximized()
  const target = resolveRecoveredWindowBounds(
    window.getBounds(),
    maximized ? window.getNormalBounds() : window.getBounds(),
    displays,
    screen.getPrimaryDisplay().id,
  )
  if (!target) return null
  // 最大化的窗口要先还原才能挪；挪到主屏以后再最大化，就铺满主屏了。
  if (maximized) window.unmaximize()
  window.setBounds(target)
  if (maximized) window.maximize()
  return target
}
