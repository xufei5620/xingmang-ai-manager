import type { AppSettingsV2, ProviderConfigSummary } from '../../../../electron/ipc-contract'
import type { ToolSource } from './model'

// 线路在界面上只叫线路1、线路2，不说在哪（yoyo 10-14）：默认那条（CF）是线路1，直连（洛杉矶）是线路2，以后
// 香港那条是线路3。和 tool-route-controller.ts 里按优先级排的 L1、L2、L3 不是一回事。名字里已经带「线路」，前面
// 不再加「线路：」；认不出的地址照旧说「线路：其他地址」。
const lineNames = { primary: '线路1', direct: '线路2', other: '线路：其他地址' } as const

export const managedElsewhereHint = '这份配置被别的软件改回过两次，星芒不再自动改它。'

/**
 * 首页每个工具那行小字开头的线路标签（xm 三线路 C12）：配置里实际写的是哪条线路，再加一个
 * 状态。只有主进程认出是星芒账号的地址才给 relayLine，历史账号、官方账号、别家地址都没有这一截。
 */
export function toolRouteLabel(
  config: Pick<ProviderConfigSummary, 'relayLine' | 'relayRouteState'> | undefined,
  source: ToolSource,
): { text: string; hint?: string } | null {
  const line = config?.relayLine
  if (!line) return null
  const parts: string[] = [lineNames[line]]
  if (config.relayRouteState === 'managed-elsewhere') {
    parts.push('由其他工具管理')
    return { text: parts.join(' · '), hint: managedElsewhereHint }
  }
  if (config.relayRouteState === 'restart') parts.push('需重开生效')
  else if (source === 'manual') parts.push('手动配置')
  return { text: parts.join(' · ') }
}

/** 设置快照里工具线路那几样（主进程 tool-route-status.ts 给）；渲染层只经 ipc-contract 取类型。 */
export type RelayToolRouteStatus = NonNullable<AppSettingsV2['relayToolRouteStatus']>

const outageTexts = {
  reset: '你所在的网络掐断了星芒的地址，AI 工具这会儿连不上。可以换个网络（比如手机热点）再试。',
  certificate: '你所在的网络在拦截星芒的加密连接（把证书换成了别的），AI 工具这会儿连不上。可以换个网络（比如手机热点）再试；公司或学校的网络请找网络管理员。',
  dns: '这台电脑这会儿查不到星芒的地址，AI 工具连不上。可以换个网络再试。',
  // 连不上、等不来回话：和网络掐断一样，换个网络再试。
  unreachable: '你所在的网络掐断了星芒的地址，AI 工具这会儿连不上。可以换个网络（比如手机热点）再试。',
} as const

export const toolRouteServerSwitchingText = '服务端正在切换线路，稍等几分钟'
export const toolRouteHijackText = '你所在的网络把星芒线路2的地址指到了别处，已为你改用线路1，不影响使用。星芒不会改你电脑的任何设置。'
/** 劫持提示出来以后在首页留多久（主进程那边同样只给半小时）。 */
export const toolRouteHijackShownMs = 30 * 60_000

/**
 * 首页上工具线路的几句话（xm 三线路 5.1.5、C20）：服务端正在切换时安静的一行；三条线都连不上时带「重新检测」
 * 的提示，管理工具自己能连上就先说一句；判成劫持、已改用 CF 时说一句。只有星芒账号才有这几样（主进程给）。
 */
export function toolRouteHomeTexts(status: RelayToolRouteStatus | undefined, now: number): { quiet?: string; outage?: string; hijack?: string } {
  if (!status) return {}
  const hijackAge = status.hijack ? now - status.hijack.id : -1
  return {
    ...(status.serverSwitching ? { quiet: toolRouteServerSwitchingText } : {}),
    ...(status.outage ? { outage: `${status.outage.appReachable ? '星芒管理工具能连上，但 AI 工具会连不上。' : ''}${outageTexts[status.outage.reason]}` } : {}),
    ...(hijackAge >= 0 && hijackAge < toolRouteHijackShownMs ? { hijack: toolRouteHijackText } : {}),
  }
}
