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
