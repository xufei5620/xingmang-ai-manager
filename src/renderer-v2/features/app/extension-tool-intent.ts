import type { ExtensionsView } from '../../registry/pages'

/**
 * 「插件」页要落在哪一栏（「插件」或「技能」）：老页面名（精选、外接工具、技能、插件）跳过来时先放在这里，
 * 页面挂上或已经挂着（去过的页只藏不卸）时取走（同 row-focus）。页面切换只传页面名，所以要落的那一栏走这里。取走即清空。
 */
let pendingView: ExtensionsView | null = null
const viewListeners = new Set<() => void>()

export function requestExtensionsView(view: ExtensionsView): void {
  pendingView = view
  for (const listener of viewListeners) listener()
}

export function takeExtensionsView(): ExtensionsView | null {
  const view = pendingView
  pendingView = null
  return view
}

export function subscribeExtensionsView(listener: () => void): () => void {
  viewListeners.add(listener)
  return () => {
    viewListeners.delete(listener)
  }
}
