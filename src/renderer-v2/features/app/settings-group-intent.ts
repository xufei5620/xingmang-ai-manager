import type { settingsGroups } from '../../registry/business'

export type SettingsGroupId = (typeof settingsGroups)[number]['value']

/**
 * 从别的页跳进「设置」时要直接落在某一组（检查页的网络项要落「网络」，不是默认的
 * 「外观」）。页面切换只传页面名，所以把想去的那一组先放在这里，设置页挂载后取走。
 * 取走即清空：下一次从侧栏点「设置」仍从「外观」开始。
 */
let pendingGroup: SettingsGroupId | null = null

export function requestSettingsGroup(group: SettingsGroupId): void {
  pendingGroup = group
}

export function takeSettingsGroup(): SettingsGroupId | null {
  const group = pendingGroup
  pendingGroup = null
  return group
}

/**
 * 设置页挂上之后只是隐藏，不会重新挂载，只在挂载时取一次的那一组第二次就接不住了。
 * 外壳跳进设置前看一眼有没有待取的分组，有就让设置页重新挂一次（全面检测 Q48）。
 */
export function hasPendingSettingsGroup(): boolean {
  return pendingGroup !== null
}
