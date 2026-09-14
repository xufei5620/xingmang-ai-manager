import type { CodexDesktopLocaleResult, CodexDesktopLocaleStatus } from '../../../../electron/ipc-contract'

export function describeChineseLocale(status: CodexDesktopLocaleStatus): string {
  if (!status.installed) return 'Codex 桌面端尚未安装'
  if (!status.chineseResources.available) return '当前安装版本缺少完整中文资源，请更新 Codex 桌面端后重试。'
  const locale = status.configuredLocale === 'zh-CN' ? '简体中文' : !status.configuredLocale || status.configuredLocale === 'system' ? '跟随系统' : status.configuredLocale
  return `已保存的语言设置：${locale}。${status.configuredLocale === 'zh-CN' ? '如果仍显示英文，可再次启用中文界面。' : '可启用中文界面并重新打开 Codex。'}`
}

export function describeChineseLocaleResult(result: CodexDesktopLocaleResult): string {
  if (result.warning) return result.warning
  if (result.runtimeVerified) return result.restarted ? '中文界面已启用，Codex 已重新打开。' : '中文界面已启用。'
  if (result.needsRestart) return '中文设置已保存，请从星芒重新打开 Codex 桌面端以应用。'
  return '中文设置已保存。'
}
