import type { CliLaunchResult, CodexDesktopLaunchResult } from '../../../../electron/ipc-contract'

const unverifiedChineseLocale = 'Codex 已打开，中文界面尚未确认生效，请在配置中再次启用。'

/**
 * 打开成功之后还要提醒用户的那一句。两套结果各带各的：Codex 桌面端是中文界面
 * 没确认生效，四家 CLI 是项目文件夹里的设置会盖过当前账号。都没有就返回 null，
 * 首页不弹任何东西。测试夹具与旧版主进程可能什么都不回，一并按「没有」处理。
 */
export function launchWarning(result: CodexDesktopLaunchResult | CliLaunchResult | void | undefined): string | null {
  if (!result) return null
  if ('chineseLocale' in result && result.chineseLocale && result.chineseLocale.status !== 'verified')
    return result.chineseLocale.message || unverifiedChineseLocale
  if ('configOverrideNotice' in result && result.configOverrideNotice)
    return result.configOverrideNotice
  return null
}

/**
 * 安装、卸载、打开工具在主进程排同一个队（AGENTS.md I11），前面那一项没做完，
 * 「打开」只能干等，装一个工具最长要十几分钟。工具行以前只写「正在打开工具」，
 * 用户以为卡死了（全面检测 Q15）。这里挑出排在前面、还在跑的那一项，说清在等谁。
 * 另一个工具的「打开」几秒就完，不算。
 */
export function launchWaitLabel(
  jobs: Record<string, { label: string }>,
  nameOf: (key: string) => string | undefined,
): string {
  const ahead = Object.entries(jobs).find(([key]) => !key.startsWith('launch:'))
  if (!ahead) return '正在打开工具'
  const [key, job] = ahead
  if (key === 'node' || key === 'python') return '正在等运行环境准备好，好了马上打开'
  const action = /卸载/.test(job.label) ? '卸载' : '安装'
  return `正在等 ${nameOf(key) ?? '另一个工具'} ${action}完，${action}完马上打开`
}
