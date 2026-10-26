import type { NetworkSettingsKind } from '../../../../electron/ipc-contract'

type DetailValue = boolean | number | string | null

export interface DiagnosticNetworkSettings {
  kind: Extract<NetworkSettingsKind, 'dns' | 'proxy'>
  label: string
}

/**
 * 检查页那一行要不要给「打开网络设置」「打开系统代理设置」：主进程只在这台电脑有对应的系统设置页（Windows、Mac）、
 * 这一行又真要客户去改时才往 details 里放 fix（diagnostics-dns-check.ts、diagnostics-proxy-software-check.ts）。
 * 打开哪一页由主进程按 kind 自己定，渲染层给不出网址（I12）。
 */
export function diagnosticNetworkSettings(item: { code: string; state: string; details?: Record<string, DetailValue> }): DiagnosticNetworkSettings | null {
  if (item.state === 'pass') return null
  const fix = item.details?.fix
  if (item.code === 'RELAY_DNS' && fix === 'open-dns-settings') return { kind: 'dns', label: '打开网络设置' }
  // 同首页断网横条上那一颗（OfflineBanner.tsx）。
  if (item.code === 'SYSTEM_PROXY_SOFTWARE' && fix === 'open-proxy-settings') return { kind: 'proxy', label: '打开系统代理设置' }
  return null
}

/** 系统没让打开时页头那句；代理那句同首页断网横条（useAppOnlineStatus.ts）。 */
export const networkSettingsUnavailableMessages: Readonly<Record<DiagnosticNetworkSettings['kind'], string>> = {
  dns: '没能打开网络设置，请在系统设置里找「网络」。',
  proxy: '没能打开系统代理设置，请在系统设置里找「代理」。',
}
