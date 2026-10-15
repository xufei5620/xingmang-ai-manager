/**
 * 窗口在后台（失焦，或被最小化、挡住）时在根节点挂 data-window-idle="true"，
 * components.css 据此暂停转圈、骨架屏这类循环动画；后面各批新加的循环动画也挂这一条，
 * 不用各自再听一遍焦点。只暂停不移除：回到前台接着动，不会从头闪一下。
 * 低配电脑（data-low-end）和「减少动画」是另外两条，照旧全停。
 */
interface IdleDocument {
  readonly hidden: boolean
  hasFocus(): boolean
  readonly documentElement: { dataset: DOMStringMap }
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}
interface IdleWindow {
  addEventListener(type: 'focus' | 'blur', listener: () => void): void
  removeEventListener(type: 'focus' | 'blur', listener: () => void): void
}

export function isWindowIdle(hidden: boolean, focused: boolean): boolean {
  return hidden || !focused
}

export function attachWindowIdleMarker(target: IdleDocument, view: IdleWindow): () => void {
  function sync() { target.documentElement.dataset.windowIdle = String(isWindowIdle(target.hidden, target.hasFocus())) }
  view.addEventListener('focus', sync)
  view.addEventListener('blur', sync)
  target.addEventListener('visibilitychange', sync)
  sync()
  return () => {
    view.removeEventListener('focus', sync)
    view.removeEventListener('blur', sync)
    target.removeEventListener('visibilitychange', sync)
  }
}
