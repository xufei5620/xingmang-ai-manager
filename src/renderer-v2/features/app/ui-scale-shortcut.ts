import type { AppSettingsV2Update } from '../../../../electron/ipc-contract'
import type { WindowOs } from './window-os'

type AppUiScale = NonNullable<AppSettingsV2Update['uiScale']>

export type UiScaleShortcut = 'larger' | 'smaller' | 'reset'

export interface UiScaleStep {
  /** null = 已经到头，不用保存，只提示一句。 */
  next: AppUiScale | null
  message: string
}

/**
 * Ctrl（Mac 上 ⌘）加号 / 减号 / 0。等号键就是没按 Shift 的加号，小键盘的加减
 * 号报的也是 '+' / '-'，都算上。带 Alt、正在用输入法打字时不算，留给别的用途。
 */
export function uiScaleShortcutFor(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>): UiScaleShortcut | null {
  if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return null
  if (event.key === '+' || event.key === '=') return 'larger'
  if (event.key === '-' || event.key === '_') return 'smaller'
  if (event.key === '0') return 'reset'
  return null
}

// 「自动」按窗口宽度算，本身就相当于 100%，所以放大一步到 110%、缩小一步到 90%。
const order: readonly Exclude<AppUiScale, 'auto'>[] = ['90', '100', '110']

export function nextUiScale(current: AppUiScale | undefined, shortcut: UiScaleShortcut, os: WindowOs): UiScaleStep {
  const reset = os === 'mac' ? '⌘ 0' : 'Ctrl 0'
  if (shortcut === 'reset') return { next: 'auto', message: '界面缩放已恢复为自动' }
  const index = order.indexOf(current === undefined || current === 'auto' ? '100' : current)
  const target = order[shortcut === 'larger' ? index + 1 : index - 1]
  if (target === undefined) {
    return {
      next: null,
      message: shortcut === 'larger' ? `界面已经放到最大的 110%，按 ${reset} 恢复` : `界面已经缩到最小的 90%，按 ${reset} 恢复`,
    }
  }
  return { next: target, message: `界面${shortcut === 'larger' ? '放大' : '缩小'}到 ${target}%，按 ${reset} 恢复` }
}
