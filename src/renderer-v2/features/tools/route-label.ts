import type { ProviderConfigSummary } from '../../../../electron/ipc-contract'
import type { ToolSource } from './model'

const lineNames = { direct: '洛杉矶', primary: 'CF', other: '其他地址' } as const

export const managedElsewhereHint = '这份配置被别的软件改回过两次，星芒不再自动改它。'

/**
 * 首页每个工具那行小字后面接的线路标签（xm 三线路 C12）：配置里实际写的是哪条线路，再加一个
 * 状态。只有主进程认出是星芒账号的地址才给 relayLine，历史账号、官方账号、别家地址都没有这一截。
 */
export function toolRouteLabel(
  config: Pick<ProviderConfigSummary, 'relayLine' | 'relayRouteState'> | undefined,
  source: ToolSource,
): { text: string; hint?: string } | null {
  const line = config?.relayLine
  if (!line) return null
  const parts = [`线路：${lineNames[line]}`]
  if (config.relayRouteState === 'managed-elsewhere') {
    parts.push('由其他工具管理')
    return { text: parts.join(' · '), hint: managedElsewhereHint }
  }
  if (config.relayRouteState === 'restart') parts.push('需重开生效')
  else if (source === 'manual') parts.push('手动配置')
  return { text: parts.join(' · ') }
}
