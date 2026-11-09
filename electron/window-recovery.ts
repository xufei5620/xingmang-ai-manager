import type { BrowserWindow } from 'electron'
import { resolveFittedWindowBounds, resolveRecoveredWindowBounds, type WindowBounds } from './window-preferences'

export type RecoverableWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isFullScreen' | 'isMaximized' | 'isMinimized' | 'getBounds' | 'getNormalBounds' | 'setBounds' | 'unmaximize' | 'maximize'
>
export type FittableWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isFullScreen' | 'isMaximized' | 'isMinimized' | 'getBounds' | 'getMinimumSize' | 'setBounds'
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

/**
 * 窗口还在屏幕上、但比它所在那块屏的工作区大（拔掉外接屏、改了系统缩放以后），
 * 收小并挪进那块屏；返回新位置，不用动返回 null。判断规则见 `resolveFittedWindowBounds`。
 *
 * 最大化、全屏的不动：最大化窗口本来就铺满工作区，为了改它的还原尺寸先还原再最大化
 * 会闪一下。调用时机跟 `recoverOffscreenWindow` 一样，只在窗口正被看见或马上要被看见时。
 */
export function fitOversizedWindow(window: FittableWindow, screen: Pick<DisplayScreen, 'getAllDisplays'>): WindowBounds | null {
  if (window.isDestroyed() || window.isFullScreen() || window.isMinimized() || window.isMaximized()) return null
  const displays = screen.getAllDisplays().map((display) => ({ id: display.id, workArea: display.workArea }))
  const [minimumWidth = 0, minimumHeight = 0] = window.getMinimumSize()
  const target = resolveFittedWindowBounds(window.getBounds(), { width: minimumWidth, height: minimumHeight }, displays)
  if (!target) return null
  window.setBounds(target)
  return target
}
