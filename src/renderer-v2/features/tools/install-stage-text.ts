import type { InstallProgress, InstallProgressStage } from '../../../../electron/ipc-contract'

/**
 * 装工具时进度那一行只说这几句白话。主进程的原话里有源名、SHA-512、包名、网址，
 * 还有 npm 自己的英文输出，小白看了只会以为出错了；原话照旧进任务日志和运行日志。
 */
const stageText: Record<Exclude<InstallProgressStage, 'raw-output'>, string> = {
  version: '正在确认安装版本…',
  download: '正在下载，首次下载可能需要几分钟，请勿关闭窗口…',
  'switch-route': '当前下载线路不稳定，已切换线路继续安装…',
  verify: '正在校验下载文件的完整性…',
  install: '正在装到电脑上…',
  'final-check': '安装完成，正在进行最终检查…',
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
    return `仍在下载，已等待 ${formatWaitedDuration(event.elapsedMs)}。网络较慢时耗时会更长，请耐心等待。`
  }
  return stageText[event.stage]
}
