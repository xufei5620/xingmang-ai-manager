import type { UpdateSnapshot } from '../../../../electron/ipc-contract'

export interface ReleaseNotesSection {
  title: string
  /** 随包带的本版改动，逐条显示；为 null 时显示 `text`。 */
  items: readonly string[] | null
  text: string
}

/**
 * 更新页右边那张卡片说哪一版。有待下载的新版本时说新版本（更新清单带下来的说明，
 * 原有行为）；没有时说正在用的这一版，内容来自随包带的说明——更新装完之后用户
 * 最想知道的就是「这版改了什么」，而原来这里只会写「暂无更新说明」。
 */
export function releaseNotesSection(update: Pick<UpdateSnapshot, 'availableVersion' | 'currentVersion' | 'releaseNotesText' | 'installedRelease'> | null | undefined): ReleaseNotesSection {
  if (update?.availableVersion) {
    return { title: `${update.availableVersion} 更新内容`, items: null, text: update.releaseNotesText || '暂无更新说明。' }
  }
  const items = update?.installedRelease?.notes
  if (update?.currentVersion && items?.length) {
    return { title: `当前版本 ${update.currentVersion} 更新内容`, items, text: '' }
  }
  return { title: '更新内容', items: null, text: update?.releaseNotesText || '暂无更新说明。' }
}
