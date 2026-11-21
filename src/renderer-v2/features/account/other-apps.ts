import { relayProviderBaseUrls } from '../../../../electron/relay-sites'
import type { AccountSiteId } from '../../account-context'

/**
 * 密钥管理最下面「在其他软件中使用」那张卡（Q1，yoyo 11-10「地址改」）：Cherry Studio、Chatbox、
 * 沉浸式翻译这类软件要填接口地址和密钥，密钥列表里能复制，地址以前整个软件里一个字都没写。
 *
 * 三行而不是一行，因为各家要的写法不一样（照各家的接入说明，没在真机上试过）：Cherry Studio、
 * Chatbox 和 Claude / Anthropic 格式要裸域名，自己往后拼 /v1；示例地址以 /v1 结尾的软件要带
 * /v1 的；沉浸式翻译要完整的 /v1/chat/completions。只给线路1：线路2 是星芒自己切换用的备用入口，
 * 历史账号那条只放行星芒自己要用的那几个接口，别的软件走它可能不通；地址也不会跟着线路变，
 * 客户填进去以后不用回来再改。
 */
export interface OtherAppAddress {
  id: 'host' | 'v1' | 'chat'
  url: string
  hint: string
}

export const otherAppsTitle = '在其他软件中使用'
export const otherAppsLead = '其他 AI 软件（如 Cherry Studio、Chatbox、沉浸式翻译）需要填写「接口地址」和「密钥」时：地址请从下方复制，密钥可在上方列表中任选一个复制。'
export const otherAppsFootnote = '如无法连接，通常是地址格式不匹配，请尝试另一行地址。费用从当前账号余额扣除；可用模型取决于所复制密钥的分组。'
export const otherAppsRequestText = '希望星芒直接接入某个软件？'
export const otherAppsCopied = '地址已复制'
export const otherAppsCopyFailed = '复制失败，请手动选中地址复制。'

export function otherAppAddresses(siteId: AccountSiteId): OtherAppAddress[] {
  const urls = relayProviderBaseUrls(siteId, 'primary')
  return [
    { id: 'host', url: urls.claude, hint: '适用于 Cherry Studio、Chatbox，以及选择 Claude 或 Anthropic 的软件' },
    { id: 'v1', url: urls.codex, hint: '适用于示例地址以 /v1 结尾的软件' },
    { id: 'chat', url: `${urls.codex}/chat/completions`, hint: '适用于需要填写完整地址的软件（如沉浸式翻译）' },
  ]
}

/** 复制一行地址并说一声；写不进剪贴板（没焦点、被拦）时叫客户自己选中复制，地址就摆在旁边。 */
export async function copyOtherAppAddress(
  url: string,
  copyText: (text: string) => Promise<void>,
  show: (text: string, tone: 'ok' | 'warn') => void,
): Promise<void> {
  try {
    await copyText(url)
  } catch {
    show(otherAppsCopyFailed, 'warn')
    return
  }
  show(otherAppsCopied, 'ok')
}
