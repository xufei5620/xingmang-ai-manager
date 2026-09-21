import { tools } from '../../registry/tools'
import type { ToolId } from './model'

/**
 * 首页「试试第一条命令」建议卡关掉之后就别再出现（功能清单 A6）。只是一个提示卡的
 * 已读状态，没有必要为它新开一条主进程通道，写法照 guide-progress.ts：storage 由调用方
 * 传入，所以纯函数部分不需要 DOM 就能测；读回来的内容一律当作坏数据校验一遍，
 * 用户或别的程序改过 localStorage 不该让首页整块白掉。
 */
export interface FirstRunStorage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }

export const firstRunDismissalKey = 'xingmang-ui-v2:first-run-dismissed'
const knownToolIds: readonly string[] = tools.map((tool) => tool.id)

export function getFirstRunStorage(): FirstRunStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

export function readFirstRunDismissals(storage: FirstRunStorage | null): ToolId[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(firstRunDismissalKey)
    if (!raw || raw.length > 512) return []
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is ToolId => typeof entry === 'string' && knownToolIds.includes(entry))
  } catch { return [] }
}

/** 返回写入后的完整名单；写不进去时也返回它，本次会话内关掉的卡片不会又弹回来。 */
export function dismissFirstRun(storage: FirstRunStorage | null, dismissed: readonly ToolId[], tool: ToolId): ToolId[] {
  const next = dismissed.includes(tool) ? [...dismissed] : [...dismissed, tool]
  if (!storage) return next
  try { storage.setItem(firstRunDismissalKey, JSON.stringify(next)) } catch { /* 提示卡的已读状态丢了就丢了，不值得打断用户。 */ }
  return next
}
