import type { UpdateSnapshot } from './updater'

/**
 * 主程序更新状态那条日志（main.ts 的 broadcastUpdate）什么时候记。
 *
 * 下载中 electron-updater 大约每秒报一次进度，每次都会广播一份新快照。以前每份都记
 * 一条「主程序更新状态：downloading」，十分钟的下载就是五百多条一模一样的记录，反馈
 * 报告附的最近 600 条被它挤满，下载之前发生了什么反倒看不到（第二十六批 B：一份
 * Windows 报告里占了 505 条）。现在只在阶段、找到的版本、错误、失败步骤变了时记；下载
 * 进度按 10% 一档，过了一档才再记一条。界面照常收到每一份快照，只是日志少记。
 */

/** 下载中按 10% 分档；还没报进度的那一刻算第 0 档，免得开头多出一条 0%。 */
function downloadProgressStep(snapshot: UpdateSnapshot): number | null {
  if (snapshot.phase !== 'downloading') return null
  const percent = Number(snapshot.progress?.percent) || 0
  return Math.floor(Math.max(0, Math.min(100, percent)) / 10)
}

/** 两份快照比较键相同＝日志里看不出区别，后一份不再记。 */
export function updateStateLogKey(snapshot: UpdateSnapshot): string {
  return JSON.stringify([
    snapshot.phase,
    snapshot.availableVersion,
    snapshot.error,
    snapshot.failedStep ?? null,
    downloadProgressStep(snapshot),
  ])
}

/** 那条日志的明细。下载中带上整数百分比：隔 10% 一条，也看得出下载快慢、停在哪。 */
export function buildUpdateStateLogDetail(snapshot: UpdateSnapshot): Record<string, unknown> {
  const percent = snapshot.phase === 'downloading' && snapshot.progress
    ? Math.floor(Math.max(0, Math.min(100, Number(snapshot.progress.percent) || 0)))
    : null
  return {
    phase: snapshot.phase,
    currentVersion: snapshot.currentVersion,
    availableVersion: snapshot.availableVersion,
    ...(percent === null ? {} : { percent }),
    error: snapshot.error,
  }
}

/** 记住上一条记下的是什么；返回的函数说这份快照要不要再记一条。 */
export function createUpdateStateLogFilter(): (snapshot: UpdateSnapshot) => boolean {
  let lastKey: string | null = null
  return (snapshot) => {
    const key = updateStateLogKey(snapshot)
    if (key === lastKey) return false
    lastKey = key
    return true
  }
}
