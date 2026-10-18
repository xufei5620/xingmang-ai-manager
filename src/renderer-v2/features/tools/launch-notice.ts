import type { CliLaunchResult, CodexDesktopLaunchResult } from '../../../../electron/ipc-contract'
import { spacedName } from './model'

const unverifiedChineseLocale = 'Codex 已打开，中文界面尚未确认生效，请在配置中再次启用。'

/**
 * 打开成功之后还要提醒用户的那一句。两套结果各带各的：Codex 桌面端是中文界面
 * 没确认生效，各家 CLI 是项目文件夹里的设置会盖过当前账号。都没有就返回 null，
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

// 这几类任务不拿来说在等谁：另一个工具的「打开」几秒就完；「改用当前账号」「修提醒设置」、
// 配置文件坏了的「修好它」只改配置、不进安装队列，「打开」根本不等它们，以前却会说成
// 「正在等 另一个工具 安装完」。
const notWaitedOn = ['launch:', 'switch:', 'repair-hooks:', 'repair-config:']

/**
 * 安装、卸载、打开工具在主进程排同一个队（AGENTS.md I11），前面那一项没做完，
 * 「打开」只能干等，装一个工具最长要十几分钟。工具行以前只写「正在打开工具」，
 * 用户以为卡死了（全面检测 Q15）。这里挑出排在前面、还在跑的那一项，说清在等谁。
 * 前面没人时说 idle（桌面客户端那几家见 clientLaunchWaitLabel）。
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

/**
 * WorkBuddy、Claude Desktop、OpenCode 的「打开」不排那条队（I11 的登记例外），只等这一家
 * 自己正在装的那一次。以前装着 Claude Code 点 Claude Desktop 要等它装完，首页别的「打开」
 * 也跟着灰掉（yoyo 2026-10-16 真机）。别家在装时照常写「正在打开客户端」，不说在等谁。
 */
export function clientLaunchWaitLabel(
  jobs: Record<string, { label: string }>,
  client: string,
  nameOf: (key: string) => string | undefined,
): string {
  const own = jobs[client]
  return launchWaitLabel(own ? { [client]: own } : {}, nameOf, '正在打开客户端')
}

// Git 不在工具表里，和 Node.js、Python 一样挂在首页「运行环境」那张卡上，名字只能在这里给。
const runtimeNames: Record<string, string> = { node: 'Node.js', python: 'Python', git: 'Git' }

/**
 * 退出登录确认框在「已配好的工具会保留。」后面补的那句（#1097 第 2 部分）。退出不打断
 * 正在装、卸的工具，装完也不会再替原来的账号写密钥（第 1 部分），说一句免得以为装了一半
 * 的会被丢掉。「打开」「改用当前账号」这类几秒就完的不算；都没有时回空串，确认框照旧只有
 * 原来那句（v4 交接包定的）。
 */
export function logoutJobsNote(
  jobs: Record<string, { kind?: 'uninstall' }>,
  nameOf: (key: string) => string | undefined,
): string {
  const installing: string[] = []
  const uninstalling: string[] = []
  for (const [key, job] of Object.entries(jobs)) {
    if (notWaitedOn.some((prefix) => key.startsWith(prefix))) continue
    const name = runtimeNames[key] ?? nameOf(key)
    if (!name) continue
    if (job.kind === 'uninstall') uninstalling.push(name)
    else installing.push(name)
  }
  const installNote = installing.length ? `正在安装的 ${spacedName(installing.join('、'))}会继续装完。` : ''
  const uninstallNote = uninstalling.length ? `正在卸载的 ${spacedName(uninstalling.join('、'))}会继续卸完。` : ''
  return installNote + uninstallNote
}
