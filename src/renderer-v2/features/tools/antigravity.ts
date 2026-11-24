import type { AntigravityInstallResult, AntigravityProgress, AntigravityStatus, AntigravityTarget } from '../../../../electron/ipc-contract'
import { antigravityTools, type AntigravityToolId } from '../../registry/clients'
import { spacedName } from './model'

/**
 * 首页 Antigravity 那两张卡。这台电脑用不了（Linux 先不做，主进程那边 supported 为假）或还没检测回来时
 * 一张都不摆：摆出来只是两颗点不动的按钮。
 */
export function presentAntigravity(status: AntigravityStatus | null) {
  if (!status?.supported) return []
  return antigravityTools.map((definition) => ({
    ...definition,
    installed: definition.target === 'cli' ? status.cliInstalled : status.desktopInstalled,
    configured: status.configured,
  }))
}

export type AntigravityPresentation = ReturnType<typeof presentAntigravity>[number]

/** 工具行任务的编号就是卡片的编号，主进程的进度按 target 回来，在这里换成卡片。 */
export function antigravityJobKey(target: AntigravityTarget): AntigravityToolId {
  return target === 'cli' ? 'antigravityCli' : 'antigravity'
}

function antigravityName(target: AntigravityTarget): string {
  return antigravityTools.find((tool) => tool.target === target)?.name ?? 'Antigravity'
}

/** 点了「安装」、主进程第一条进度回来之前那一句。 */
export const antigravityPreparingLabel = '正在确认安装版本…'

// 前三句和命令行工具装的时候同一套（install-stage-text.ts），只有写设置那一步是 Antigravity 自己的。
const phaseText: Record<AntigravityProgress['phase'], string> = {
  downloading: '正在下载，首次下载可能需要几分钟，请勿关闭窗口…',
  verifying: '正在校验下载文件的完整性…',
  installing: '正在装到电脑上…',
  configuring: '正在写入当前账号的连接设置…',
}

export function antigravityProgressLabel(progress: Pick<AntigravityProgress, 'phase'>): string {
  return phaseText[progress.phase]
}

/**
 * 装完那一句。设置没写成（没登录、服务暂时不可用）时程序照样装好了，只是还连不上：
 * 把主进程那句原因接在后面，用提醒的颜色。
 */
export function antigravityInstallNotice(target: AntigravityTarget, result: Pick<AntigravityInstallResult, 'configureError'>): { text: string; tone: 'ok' | 'warn' } {
  const name = spacedName(antigravityName(target))
  if (result.configureError) return { text: `${name}已安装。${result.configureError}`, tone: 'warn' }
  return { text: `${name}已安装，并已关联当前账号`, tone: 'ok' }
}

/**
 * 桌面端已经开着、开着的那一份拿不到这次写下的设置（它只认启动时带的设置，又只许开一个）：
 * 主进程这时不打开，请客户先退出再点。
 */
export const antigravityCloseFirstNotice = 'Antigravity 正在运行，新的连接设置需重新启动后生效。请先完全退出 Antigravity，再点击「打开」。'
