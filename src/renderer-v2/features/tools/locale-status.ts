import type { CodexDesktopLocaleResult, CodexDesktopLocaleStatus } from '../../../../electron/ipc-contract'
import type { WindowOs } from '../app/window-os'

// Mac 上星芒不会替人重开 Codex（主进程拒绝重启），新设置要等 Codex 完全退出、再从星芒打开才读得到；
// 只关窗口它还在后台跑，照样读不到（第二十九批 A）。
const macQuitThenOpen = '先在 Codex 窗口里按 Command + Q 完全退出，再回星芒点「打开」。'

/**
 * 配置里「界面语言与文件夹权限」那段说明的 Mac 版：Mac 上不开那条本机通道，也不会替人重开 Codex。
 * Mac 上的中文全靠星芒打开前连上的加速让 Codex 拿到开关，从程序坞或启动台直接打开拿不到，所以先说这一句。
 */
export const macLocaleNote = `中文界面只在从星芒打开 Codex 时生效，直接点程序坞或启动台里的 ChatGPT 打开还是英文。点「启用中文界面」只是把设置改好，不会替你重开 Codex。Codex 开着的话，${macQuitThenOpen}`

export function describeChineseLocale(status: CodexDesktopLocaleStatus, os: WindowOs): string {
  if (!status.installed) return 'Codex 桌面端尚未安装'
  if (!status.chineseResources.available) return '当前安装版本缺少完整中文资源，请更新 Codex 桌面端后重试。'
  const locale = status.configuredLocale === 'zh-CN' ? '简体中文' : !status.configuredLocale || status.configuredLocale === 'system' ? '跟随系统' : status.configuredLocale
  const retry = os === 'mac' ? macQuitThenOpen : '可再次启用中文界面。'
  return `已保存的语言设置：${locale}。${status.configuredLocale === 'zh-CN' ? `如果仍显示英文，${retry}` : '可启用中文界面并重新打开 Codex。'}`
}

export function describeChineseLocaleResult(result: CodexDesktopLocaleResult, os: WindowOs): string {
  if (result.warning) return result.warning
  // Switching back to the system language also turns off the local debugging
  // port the Chinese runtime patch needs, so say what actually changed instead
  // of reusing the "设置已保存" wording written for the Chinese direction.
  if (result.configuredLocale !== 'zh-CN') {
    if (result.restarted) return '已改为跟随系统语言，Codex 已重新打开，那条本机通道也不再开启。'
    return os === 'mac' && result.running && result.needsRestart
      ? `已改为跟随系统语言。${macQuitThenOpen}`
      : '已改为跟随系统语言，下次从星芒打开 Codex 时生效。'
  }
  if (result.runtimeVerified) return result.restarted ? '中文界面已启用，Codex 已重新打开。' : '中文界面已启用。'
  // Mac 上没有确认中文生效的那条路，needsRestart 恒为真；按 Codex 开没开着说下一步该做什么。
  if (os === 'mac') return result.running ? `中文设置已保存。${macQuitThenOpen}` : '中文设置已保存，下次从星芒打开 Codex 时生效。'
  if (result.needsRestart) return '中文设置已保存，请从星芒重新打开 Codex 桌面端以应用。'
  return '中文设置已保存。'
}

/**
 * 点「信任当前文件夹」之后那句。Windows 上主进程会替人重开开着的 Codex，Mac 上不会，
 * 所以只在 Mac 上、而且这次真的新加了信任时，才说怎么让开着的 Codex 读到（第二十九批 A 的后续）。
 */
export function describeWorkspaceTrustResult(changed: boolean, os: WindowOs): string {
  return os === 'mac' && changed ? `文件夹信任已保存。Codex 开着的话，${macQuitThenOpen}` : '文件夹信任已保存'
}
