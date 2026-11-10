import { relayProviderBaseUrls } from '../../../../electron/relay-sites'
import type { AccountSiteId } from '../../account-context'

/**
 * 密钥管理最下面「用在别的软件里」那张卡（Q1，yoyo 11-10「地址改」）：Cherry Studio、Chatbox、
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

export const otherAppsTitle = '用在别的软件里'
export const otherAppsLead = '别的 AI 软件（比如 Cherry Studio、Chatbox、沉浸式翻译）要你填「接口地址」和「密钥」时：地址从下面复制，密钥在上面的列表里点复制，哪一把都行。'
export const otherAppsFootnote = '连不上的话，多半是地址格式不对，换另一行试试。扣的是当前账号的余额；能用哪些模型，跟你复制的那把密钥的分组走。'
export const otherAppsRequestText = '想让星芒直接接入某个软件？'
export const otherAppsCopied = '地址已复制'
export const otherAppsCopyFailed = '没复制上，请选中地址自己复制。'

export function otherAppAddresses(siteId: AccountSiteId): OtherAppAddress[] {
  const urls = relayProviderBaseUrls(siteId, 'primary')
  return [
    { id: 'host', url: urls.claude, hint: 'Cherry Studio、Chatbox 填这个；软件里选的是 Claude 或 Anthropic 时，也填这个' },
    { id: 'v1', url: urls.codex, hint: '软件给的示例地址以 /v1 结尾时，填这个' },
    { id: 'chat', url: `${urls.codex}/chat/completions`, hint: '要填完整地址的软件（比如沉浸式翻译），填这个' },
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
