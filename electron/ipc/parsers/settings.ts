// settings:save 的入参。
import { parseRelayRoutePreferences, type AppSettingsUpdate } from '../../app-settings'
import { isProviderId } from '../../catalog'
import { isRecord } from '../../input-guards'
import { relayRoutePreferenceAllowed, relaySites } from '../../relay-sites'
import { parseWindowState } from '../../window-preferences'
import { optionalBoolean, requiredString } from './common'

// settings:save carries a field-wise update since ①栏11: absent field = keep
// the persisted value (the merge itself runs inside app-settings.ts's
// serialized write queue). A field that IS present is validated exactly as
// strictly as the old whole-record parser -- partial semantics loosen which
// fields must appear, never what a present field may contain (I5).
export function parseSettingsUpdate(value: unknown): AppSettingsUpdate {
  if (!isRecord(value) || value.version !== 2) throw new Error('设置格式错误')
  if (value.theme !== undefined && value.theme !== 'light' && value.theme !== 'dark') {
    throw new Error('主题格式错误')
  }
  const workspace = value.workspace === undefined
    ? undefined
    : requiredString(value.workspace, '工作目录', 32_767)
  const checkUpdatesOnStartup = optionalBoolean(value.checkUpdatesOnStartup, '设置')
  const runDiagnosticsOnStartup = optionalBoolean(value.runDiagnosticsOnStartup, '设置')
  const sidebarMoreExpanded = optionalBoolean(value.sidebarMoreExpanded, '侧边栏展开状态')
  // Same degrade-don't-throw semantics as app-settings.ts's parseRelaySiteId:
  // an unknown/stale site id must never brick saving the rest of the
  // settings, so it is dropped here (and would be dropped again by
  // app-settings.ts's own validation at persist time -- this hop is the
  // defense-in-depth I5 copy, not the only line). Under merge semantics
  // "dropped" now means "keep the persisted site" rather than "reset to the
  // default", which is the safer degrade for a stale id.
  const relaySiteId = typeof value.relaySiteId === 'string'
    && relaySites.some((site) => site.id === value.relaySiteId)
    ? value.relaySiteId
    : undefined
  if (value.relayEndpointIds !== undefined) {
    if (!isRecord(value.relayEndpointIds)) throw new Error('连接线路设置格式错误')
    for (const [siteId, preference] of Object.entries(value.relayEndpointIds)) {
      if (!relayRoutePreferenceAllowed(siteId, preference)) throw new Error('无法使用这条连接线路，请重新选择')
    }
  }
  const relayEndpointIds = parseRelayRoutePreferences(value.relayEndpointIds)
  // Same degrade-don't-throw passthrough as relaySiteId above. 'auto' is the
  // explicit clear marker (absence means keep, so it can no longer express a
  // reset); unknown strings degrade to "keep the persisted policy".
  const mirrorPolicy = value.mirrorPolicy === 'auto'
    || value.mirrorPolicy === 'mirror-first'
    || value.mirrorPolicy === 'official-first'
    ? value.mirrorPolicy
    : undefined
  const officialProviders = value.officialProviders === undefined
    ? undefined
    : Array.isArray(value.officialProviders)
      ? value.officialProviders.filter((entry) => typeof entry === 'string' && isProviderId(entry)) as AppSettingsUpdate['officialProviders']
      : undefined
  const codexDesktopInstallDisabled = optionalBoolean(value.codexDesktopInstallDisabled, 'Codex 桌面端自动安装偏好')
  const alwaysInstallLatestCli = optionalBoolean(value.alwaysInstallLatestCli, '命令行工具版本偏好')
  const crashReporting = optionalBoolean(value.crashReporting, '崩溃上报设置')
  const crashReportingNoticeShown = optionalBoolean(value.crashReportingNoticeShown, '错误报告告知记录')
  const usageStatsNoticeShown = optionalBoolean(value.usageStatsNoticeShown, '使用统计告知记录')
  // Unlike the degrade-don't-throw fields above, an unrecognized value here is
  // rejected: this one decides whether Codex starts with a local debugging
  // port, so a typo must not quietly read as "not asked yet" (E-S3).
  if (value.codexDesktopChineseRuntimePatch !== undefined
    && value.codexDesktopChineseRuntimePatch !== 'enabled'
    && value.codexDesktopChineseRuntimePatch !== 'disabled') throw new Error('Codex 中文界面设置格式错误')
  if (value.uiSkin !== undefined && (typeof value.uiSkin !== 'string' || !['auto', 'dawn', 'obsidian', 'mist', 'aurora'].includes(value.uiSkin))) throw new Error('皮肤格式错误')
  if (value.uiScale !== undefined && (typeof value.uiScale !== 'string' || !['auto', '90', '100', '110'].includes(value.uiScale))) throw new Error('界面缩放格式错误')
  if (value.closeBehavior !== undefined && (typeof value.closeBehavior !== 'string' || !['ask', 'tray', 'quit'].includes(value.closeBehavior))) throw new Error('关闭偏好格式错误')
  const reducedMotion = optionalBoolean(value.reducedMotion, '减少动画设置')
  const desktopNotifications = optionalBoolean(value.desktopNotifications, '系统通知设置')
  const autoUpdate = optionalBoolean(value.autoUpdate, '自动更新设置')
  const hardwareAcceleration = optionalBoolean(value.hardwareAcceleration, '显卡加速显示设置')
  const largeText = optionalBoolean(value.largeText, '大字设置')
  const toolRouteRestartHints = optionalBoolean(value.toolRouteRestartHints, '换线路提醒设置')
  const windowState = value.windowState === null ? null : parseWindowState(value.windowState)
  if (value.windowState !== undefined && windowState === undefined) throw new Error('窗口位置格式错误')
  return {
    version: 2,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(value.theme !== undefined ? { theme: value.theme } : {}),
    ...(checkUpdatesOnStartup !== undefined ? { checkUpdatesOnStartup } : {}),
    ...(runDiagnosticsOnStartup !== undefined ? { runDiagnosticsOnStartup } : {}),
    ...(sidebarMoreExpanded !== undefined ? { sidebarMoreExpanded } : {}),
    ...(relaySiteId !== undefined ? { relaySiteId } : {}),
    ...(relayEndpointIds !== undefined ? { relayEndpointIds } : {}),
    ...(mirrorPolicy !== undefined ? { mirrorPolicy } : {}),
    ...(officialProviders !== undefined ? { officialProviders } : {}),
    ...(codexDesktopInstallDisabled !== undefined ? { codexDesktopInstallDisabled } : {}),
    ...(alwaysInstallLatestCli !== undefined ? { alwaysInstallLatestCli } : {}),
    ...(crashReporting !== undefined ? { crashReporting } : {}),
    ...(crashReportingNoticeShown !== undefined ? { crashReportingNoticeShown } : {}),
    ...(usageStatsNoticeShown !== undefined ? { usageStatsNoticeShown } : {}),
    ...(value.codexDesktopChineseRuntimePatch !== undefined
      ? { codexDesktopChineseRuntimePatch: value.codexDesktopChineseRuntimePatch as AppSettingsUpdate['codexDesktopChineseRuntimePatch'] }
      : {}),
    ...(value.uiSkin !== undefined ? { uiSkin: value.uiSkin as AppSettingsUpdate['uiSkin'] } : {}),
    ...(value.uiScale !== undefined ? { uiScale: value.uiScale as AppSettingsUpdate['uiScale'] } : {}),
    ...(value.closeBehavior !== undefined ? { closeBehavior: value.closeBehavior as AppSettingsUpdate['closeBehavior'] } : {}),
    ...(reducedMotion !== undefined ? { reducedMotion } : {}),
    ...(desktopNotifications !== undefined ? { desktopNotifications } : {}),
    ...(autoUpdate !== undefined ? { autoUpdate } : {}),
    ...(hardwareAcceleration !== undefined ? { hardwareAcceleration } : {}),
    ...(largeText !== undefined ? { largeText } : {}),
    ...(toolRouteRestartHints !== undefined ? { toolRouteRestartHints } : {}),
    ...(windowState !== undefined ? { windowState } : {}),
  }
}
