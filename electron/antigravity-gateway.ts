import { isCliModelName } from './cli-model-defaults'
import { relayEndpointForUrl } from './relay-sites'

// Antigravity（谷歌的 agy 命令行和 Antigravity 桌面端）接中转，走的是它没写进文档的「企业网关」模式：启动时
// 环境里带着下面四个变量，它就不要谷歌登录，把请求发到 `<地址>/v1beta/models/<型号>:streamGenerateContent?alt=sse`，
// 密钥放在 `Authorization: Bearer` 里。命令行和桌面端认同一套（桌面端把它交给自带的 language_server），而且只认
// 环境变量：admin_settings.json 管的是整台电脑，不写。2026-11-23 在 GitHub 的临时机器上对本机假接口实测过
// （agy 1.5.15、桌面端 2.34.0），没有碰中转；中转那边 /v1beta 认 Bearer、思考强度原样转发，是服务端查出来的。

/** 写给 Antigravity 的四个变量，次序就是写入的次序。 */
export const antigravityGatewayVariableNames = [
  'AGY_LLM_GATEWAY_URL',
  'AGY_LLM_GATEWAY_API_KEY',
  'AGY_LLM_GATEWAY_WIRE_PROTOCOL',
  'AGY_LLM_GATEWAY_MODELS',
] as const

export type AntigravityGatewayVariableName = typeof antigravityGatewayVariableNames[number]

export type AntigravityGatewayEnvironment = Readonly<Record<AntigravityGatewayVariableName, string>>

/** 写设置那一步的结果：四个都已经是这个值时什么都不写、也不通知系统，答 unchanged。 */
export type AntigravityEnvironmentWriteOutcome = 'written' | 'unchanged'

/** 读回来的设置：只有是字符串的那几个，没有的不出现。值里有密钥，只在主进程里用，不进日志、不过 IPC（I3）。 */
export type AntigravityEnvironmentValues = Partial<Record<AntigravityGatewayVariableName, string>>

/** yoyo 11-23 定的默认型号：菜单里有它就排第一，Antigravity 拿第一个当默认。 */
export const antigravityDefaultModel = 'gemini-3.8-flash'

// genai 是 Gemini 原生接口，中转的 Gemini 分组走的就是它。另一种 openai 打 /v1/chat/completions，思考强度
// 换成 reasoning_effort，型号名照样会被改写（第八轮实测），没有好处。
const antigravityWireProtocol = 'genai'

// 远程地址 Antigravity 只认 https（http 只许本机），后面的 /v1beta 它自己接，所以这里只收站点的裸域。
const invalidGatewayUrlMessage = '连接地址无效，未修改 Antigravity 的设置'

/**
 * 型号菜单就是 AGY_LLM_GATEWAY_MODELS：逗号隔开，整份就是菜单，第一个是默认。yoyo 11-23 定：这把密钥当时能用的
 * 型号全部放进去，不按能不能用筛，用了报错另说；默认 gemini-3.8-flash 排第一，列表里没有它就照列表原来的先后。
 *
 * 名字原样进一份逗号分隔的列表，所以照 isCliModelName 收窄（I5）：带逗号、空白、引号的那一个丢掉。
 * Antigravity 认得的名字它自己会改写：-low/-medium/-high/-xhigh 拆成不带后缀的型号加思考强度，
 * gemini-3.1-pro-preview 发成 gemini-3.1-pro 等（第七到十轮实测，五种写法都绕不开）。这里不替它改名，菜单照列表写。
 */
export function buildAntigravityModelMenu(models: readonly string[]): string[] {
  const usable = [...new Set(models.map((model) => model.trim()))].filter(isCliModelName)
  if (!usable.includes(antigravityDefaultModel)) return usable
  return [antigravityDefaultModel, ...usable.filter((model) => model !== antigravityDefaultModel)]
}

/**
 * 站点 Gemini 那一项的地址，收成 Antigravity 要的样子：https、只有域名、是中转某条线路自己的地址。
 * 密钥跟着这个地址走，所以别名、路径、查询串、账号密码一律不收，不认识的主机也不收。
 */
export function normalizeAntigravityGatewayUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(invalidGatewayUrlMessage)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/' || !relayEndpointForUrl(parsed.origin)) {
    throw new Error(invalidGatewayUrlMessage)
  }
  return parsed.origin
}

export interface AntigravityGatewayInput {
  /** 当前账号站点、当前线路上 Gemini 那一项的地址（relayProviderBaseUrls 的 gemini）。 */
  baseUrl: string
  /** Gemini 分组的密钥。 */
  apiKey: string
  /** 这把密钥 /v1/models 当时列出的型号。 */
  models: readonly string[]
}

/**
 * 要写给 Antigravity 的四个变量。地址、密钥、型号有一样不对就整份不给，调用方什么都不写，
 * 免得留下一半新一半旧的设置。
 */
export function buildAntigravityGatewayEnvironment(input: AntigravityGatewayInput): AntigravityGatewayEnvironment {
  const url = normalizeAntigravityGatewayUrl(input.baseUrl)
  const apiKey = input.apiKey.trim()
  // 密钥会进注册表和 shell 的 export 一行：不许空白、引号、反斜杠、%、$ 和控制字符。
  if (!/^[A-Za-z0-9._~+/=-]{8,256}$/.test(apiKey)) throw new Error('密钥格式无效，未修改 Antigravity 的设置')
  const menu = buildAntigravityModelMenu(input.models)
  if (!menu.length) throw new Error('当前密钥没有可用的模型，未修改 Antigravity 的设置')
  return {
    AGY_LLM_GATEWAY_URL: url,
    AGY_LLM_GATEWAY_API_KEY: apiKey,
    AGY_LLM_GATEWAY_WIRE_PROTOCOL: antigravityWireProtocol,
    AGY_LLM_GATEWAY_MODELS: menu.join(','),
  }
}

/**
 * 写之前再核一遍整份：四个都在、都不空、都不跨行。调用方本该只拿 buildAntigravityGatewayEnvironment 的结果来，
 * 这里挡的是别的路子拼出来的半份，免得留下一半新一半旧的设置。
 */
export function assertCompleteAntigravityEnvironment(environment: AntigravityGatewayEnvironment): void {
  for (const name of antigravityGatewayVariableNames) {
    const value: unknown = environment[name]
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) {
      throw new Error('Antigravity 的连接设置不完整，未作任何修改')
    }
  }
}
