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
 * 主进程在「这个文件夹不建议打开」那一问里被用户拒了，工具没有启动（全面检测
 * Q39）。只认明说的 declined：测试夹具和旧版主进程什么都不回时仍按「打开了」算。
 */
export function launchDeclined(result: CodexDesktopLaunchResult | CliLaunchResult | void | undefined): boolean {
  return Boolean(result && 'declined' in result && result.declined === true)
}

/**
 * 记录页「接着聊」成功后那句话。用户选了「先不打开」就什么都不说，
 * 不能再说「已打开」。
 */
export function resumeSessionNotice(result: CliLaunchResult | void | undefined, toolName: string, cwd: string): string | null {
  if (launchDeclined(result)) return null
  const opened = `已打开${toolName}，接着 ${cwd} 里最近的一条对话`
  const warning = launchWarning(result)
  return warning ? `${opened}。${warning}` : opened
}

// 这几类任务不拿来说在等谁：另一个工具的「打开」几秒就完；「改用当前账号」「修提醒设置」
// 只改配置、不进安装队列，「打开」根本不等它们，以前却会说成「正在等 另一个工具 安装完」。
const notWaitedOn = ['launch:', 'switch:', 'repair-hooks:']

/**
 * 安装、卸载、打开工具在主进程排同一个队（AGENTS.md I11），前面那一项没做完，
 * 「打开」只能干等，装一个工具最长要十几分钟。工具行以前只写「正在打开工具」，
 * 用户以为卡死了（全面检测 Q15）。这里挑出排在前面、还在跑的那一项，说清在等谁。
 * WorkBuddy、Claude Desktop、OpenCode 的「打开」排的是同一个队，前面没人时说
 * 「正在打开客户端」，由 idle 传进来（第三十九批 C）。
 */
export function launchWaitLabel(
  jobs: Record<string, { label: string }>,
  nameOf: (key: string) => string | undefined,
  idle = '正在打开工具',
): string {
  const ahead = Object.entries(jobs).find(([key]) => !notWaitedOn.some((prefix) => key.startsWith(prefix)))
  if (!ahead) return idle
  const [key, job] = ahead
  // Git 不在工具表里，和 Node.js、Python 一样摆在首页「运行环境」那张卡上。
  if (key === 'node' || key === 'python' || key === 'git') return '正在等运行环境准备好，好了马上打开'
  const action = /卸载/.test(job.label) ? '卸载' : '安装'
  return `正在等 ${nameOf(key) ?? '另一个工具'} ${action}完，${action}完马上打开`
}
