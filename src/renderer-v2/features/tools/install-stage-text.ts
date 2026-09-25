import type { InstallProgress, InstallProgressStage } from '../../../../electron/ipc-contract'

/**
 * 装工具时进度那一行只说这几句白话。主进程的原话里有源名、SHA-512、包名、网址，
 * 还有 npm 自己的英文输出，小白看了只会以为出错了；原话照旧进任务日志和运行日志。
 */
const stageText: Record<Exclude<InstallProgressStage, 'raw-output'>, string> = {
  version: '正在确认要装的版本…',
  download: '正在下载，第一次可能要几分钟，请别关窗口…',
  'switch-route': '这条下载线路不太顺，已经换了一条接着装…',
  verify: '正在检查下载的文件是否完整、有没有被改过…',
  install: '正在装到电脑上…',
  'final-check': '装好了，正在最后检查一遍…',
}

export function formatWaitedDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const rest = seconds % 60
  return rest === 0 ? `${Math.floor(seconds / 60)} 分钟` : `${Math.floor(seconds / 60)} 分 ${rest} 秒`
}

/**
 * 进度那一行该换成哪句话。返回 null 表示这条只进日志、那一行保持不变
 * （npm 自己的输出）。没带阶段的消息是旧行为：原样显示。
 */
export function installProgressLabel(event: Pick<InstallProgress, 'message' | 'stage' | 'elapsedMs'>): string | null {
  if (!event.stage) return event.message
  if (event.stage === 'raw-output') return null
  if (event.stage === 'download' && typeof event.elapsedMs === 'number') {
    return `还在下载，已经等了 ${formatWaitedDuration(event.elapsedMs)}。网慢时会久一点，不用管它。`
  }
  return stageText[event.stage]
}
