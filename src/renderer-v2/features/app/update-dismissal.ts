/**
 * 右下角更新气泡点了 × 以后记下的那一笔：关掉的是哪一句（key）、什么时候关的（at）。
 *
 * 原来关掉一次就到退出星芒前都不再出。配好工具以后一直缩在托盘、几周不退出的电脑，客户关掉
 * 一次就再也看不到这条；所以关掉满一天再出一次（yoyo 2026-10-27「侧栏改」第 4 条），字不变。
 * 换了一句话（下好了、空间不够、换了版本）照旧马上出，跟原来一样。
 */
export const updateBubbleRepeatMs = 24 * 60 * 60 * 1000

export interface UpdateDismissal {
  key: string
  at: number
}

export function buildUpdateDismissal(key: string, now: number): string {
  return JSON.stringify({ key, at: now })
}

/** 读不懂的（别的版本写的、被改坏的）当没关过：多出一次气泡，好过一直不出。 */
export function parseUpdateDismissal(value: string | null): UpdateDismissal | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || !('key' in parsed) || !('at' in parsed)) return null
    const { key, at } = parsed
    return typeof key === 'string' && typeof at === 'number' && Number.isFinite(at) ? { key, at } : null
  } catch {
    return null
  }
}

/**
 * 这句话现在还压着不出要再等多少毫秒；0 = 该出了（没关过、关的是别的话、或者已经满一天）。
 * 钟被往回拨过（关的时间在「现在」之后）也算满了，免得一拨就压上好几天。
 */
export function updateDismissalRemainingMs(dismissal: UpdateDismissal | null, key: string, now: number): number {
  if (!dismissal || dismissal.key !== key || dismissal.at > now) return 0
  return Math.max(0, dismissal.at + updateBubbleRepeatMs - now)
}
