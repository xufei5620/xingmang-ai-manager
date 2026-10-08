import type { UpdateDiskShortfall } from './updater'

// 没有 Node 依赖：渲染层（更新页、首页气泡）和主进程（系统通知）读同一份说法，
// 两边各写一遍早晚会说岔。

/** 给用户看的剩余空间：到了 GB 量级说 GB，不足 1 GB 说 MB，都不出现小数点后第二位。*/
export function formatFreeSpace(bytes: number): string {
  const safe = Math.max(0, bytes)
  if (safe >= 1024 ** 3) return `${(safe / 1024 ** 3).toFixed(1)} GB`
  const megabytes = safe / 1024 ** 2
  if (megabytes >= 1) return `${Math.round(megabytes)} MB`
  return '不足 1 MB'
}

/**
 * 空间不够、这一轮没下更新时的那句话。自动更新开着时说清「清出来会自己下」，免得他
 * 清完还守着等；关着时只说现在下多半会失败，下不下由他。
 */
export function describeUpdateDiskShortfall(shortfall: UpdateDiskShortfall, autoUpdate: boolean): string {
  const free = formatFreeSpace(shortfall.freeBytes)
  const needed = formatFreeSpace(shortfall.neededBytes)
  const gap = formatFreeSpace(Math.max(0, shortfall.neededBytes - shortfall.freeBytes))
  return autoUpdate
    ? `新版本先不下载：电脑磁盘只剩 ${free}，装更新大约要 ${needed}，还要再清出 ${gap}。清出来以后会自动下载，不用你再点。`
    : `电脑磁盘只剩 ${free}，装更新大约要 ${needed}，还要再清出 ${gap}，现在下载多半会失败。`
}
