import fs from 'node:fs'
import path from 'node:path'

/**
 * 认出 CC Switch 留在 CLI 配置里的那一份。
 *
 * CC Switch（github.com/farion1231/cc-switch）把用户选中的供应商直接写进各家 CLI
 * 自己读的配置：~/.claude/settings.json 的 env、~/.codex/config.toml 与 auth.json、
 * ~/.gemini/.env 与 settings.json、~/.grok 下的配置。它不改系统环境变量。本软件
 * 登录后不会自动改写来源没确认的配置（saveConfig 那道闸），于是这种电脑装好之后
 * 工具还连着 CC Switch 选的那家，首页只挂一个中性的「用的是别处的配置」，客户
 * 只能自己去配置里点「重置为初始状态」才生效。这里只负责认出来，改不改由用户在
 * 首页点。
 *
 * 两种痕迹：
 * - 本地代理接管：CC Switch 把密钥换成占位串 PROXY_MANAGED、地址换成它在本机
 *   起的代理（默认 127.0.0.1:15721）。这份配置只在 CC Switch 开着时能用；它退出
 *   时还会把接管前备份的那份写回去，盖掉期间别人写进来的配置。
 * - 普通切换：用户主目录下有 CC Switch 的数据目录 ~/.cc-switch，且这份配置里有一把
 *   来源没确认的 Key。数据目录卸载后通常还在，这时配置多半仍是它当年写的，一样按
 *   它处理。
 */
export type CcSwitchLeftover = 'proxy' | 'provider'

/** CC Switch 接管时写进各家配置的密钥占位（src-tauri/src/services/proxy.rs）。 */
export const ccSwitchProxyPlaceholder = 'PROXY_MANAGED'

export const ccSwitchDataDirectoryName = '.cc-switch'

/**
 * 只看数据目录在不在，不读里面的数据库：那是别人的数据，读了也不会让结论更准。
 * 符号链接、联接不算（I8），读不到当作没装。
 */
export function inspectCcSwitchInstalled(userHome: string): boolean {
  try {
    const info = fs.lstatSync(path.join(userHome, ccSwitchDataDirectoryName))
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Codex 接管时占位可能写在 config.toml 的 experimental_bearer_token 里、auth.json 里
 * 没有 Key，所以「有一份指向别处的地址」也算。
 */
export function resolveCcSwitchLeftover(
  config: { apiKey: string; hasApiKey: boolean; actualBaseUrl: string },
  ccSwitchInstalled: boolean,
): CcSwitchLeftover | null {
  if (config.apiKey.trim() === ccSwitchProxyPlaceholder) return 'proxy'
  return ccSwitchInstalled && (config.hasApiKey || Boolean(config.actualBaseUrl.trim())) ? 'provider' : null
}
