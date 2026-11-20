import type { ActiveProviderId } from '../../../../electron/catalog'
import type { ExtensionsView } from '../../registry/pages'

/**
 * 从一页扩展跳到另一页时要先选好的工具：技能页选着 Codex CLI 点「去看插件」，插件页要落在 Codex CLI 上，
 * 而不是按「第一个装好的」又挑回 Claude Code。页面切换只传页面名，要选的工具先放在这里，那一页挂上
 * 或已经挂着（去过的页只藏不卸）时取走（同 row-focus）。
 */
export type ExtensionToolPage = 'mcp' | 'skills' | 'plugins'

let pending: { page: ExtensionToolPage; tool: ActiveProviderId } | null = null
const listeners = new Set<() => void>()

export function requestExtensionTool(page: ExtensionToolPage, tool: ActiveProviderId): void {
  pending = { page, tool }
  for (const listener of listeners) listener()
}

/** 取走这一页待选的工具；别的页的不动，取走即清空。 */
export function takeExtensionTool(page: ExtensionToolPage): ActiveProviderId | null {
  if (pending?.page !== page) return null
  const tool = pending.tool
  pending = null
  return tool
}

/** 页面已经挂着时靠它接住后来的请求；返回值是退订。 */
export function subscribeExtensionTool(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 「插件」页要落在哪一栏（「插件」或「技能」）：老页面名（精选、外接工具、技能、插件）跳过来时先放在这里，
 * 页面挂上或已经挂着时取走，同上面那份。取走即清空。
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
