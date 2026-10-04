import type { ToolPresentation } from './model'

/**
 * 「换成星芒装的」要装哪一版（第三十一批 B）。首页的「更新到推荐版本」「更新」和新手引导
 * 都点名了版本；没点名的只有安装卸载页的「重新安装」，那时和主进程不点名的安装落在同一处
 * （resolveCliInstallVersion：钉在推荐版本上装推荐版本，否则装最新版）。确认框要写出版本号，
 * 装下去的又必须正是写出来的那一版，所以在这里定下来、安装时点名交给主进程。最新版这次
 * 没查到时退回推荐版本；两样都没有就是 null，调用方照旧走普通安装（主进程会拒，原样报错）。
 */
export function managedSwitchVersion(
  tool: Pick<ToolPresentation, 'latestVersion' | 'versionAdvice'>,
  requested?: string,
): string | null {
  if (requested) return requested
  const advice = tool.versionAdvice
  if (advice?.pinned && advice.recommendedVersion) return advice.recommendedVersion
  return tool.latestVersion ?? advice?.recommendedVersion ?? null
}

export interface ManagedSwitchConfirmation {
  title: string
  body: string
  okLabel: string
}

/**
 * 确认框里的三句话，照 yoyo 2026-10-04 点过头的原话（另一颗按钮是 Confirm 默认的「取消」）。
 * 「工具配置、账户数据和历史记录会保留」与卸载确认框是同一句：卸载只删程序本身。
 */
export function managedSwitchConfirmation(version: string): ManagedSwitchConfirmation {
  return {
    title: '换成星芒装的 Claude Code？',
    body: `这台电脑上的 Claude Code 是官方安装器装的，星芒没法直接更新它。点「换成星芒装的」，星芒会先把它卸掉，再装上 ${version}。工具配置、账户数据和历史记录会保留，以后在星芒里点一下就能更新。`,
    okLabel: '换成星芒装的',
  }
}
