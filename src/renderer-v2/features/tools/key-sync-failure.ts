import { speaksChinese, userFacingErrorMessage } from '../../business-common'
import { presentOperationError } from '../../operation-error'
import { tools } from '../../registry/tools'
import { redactSecretPatterns } from '../../../../electron/redaction-patterns'
import type { ProviderId } from '../../../../electron/ipc-contract'
import type { AccountBootstrapResult } from './account-bootstrap'
import { isCertificateFailureText, isNetworkFailureText } from './online-resync'

// 两套账号后端给 CLI 签 Key 时找不到能用的分组，各自报的原话。客户看不到也改不了
// 分组，只有服务端给这个账号开通了对应的工具才会好，所以改成一句他能照着做的话。
const unavailableGroupPatterns: readonly RegExp[] = [
  /分组不存在、不可用或名称重复/,
  /不可使用分组/,
]

/**
 * Key 同步失败时给人看的那半句原因（全面检测 Q31）。主进程原文可能是英文网络
 * 报错，也可能带着含用户名的配置文件路径：先脱敏（I13），能归类的说目录里的
 * 标题，认不出的中文原话本身就是写给人看的，原样留着（打过码）；认不出的英文不上屏。
 * 是不是中文按 speaksChinese 判：脱完路径的占位词「本机路径」本身是汉字，
 * 只看有没有汉字的话带路径的英文会原样上屏（第三十批 A）。
 */
export function keySyncFailureReason(message: string): string {
  const safe = userFacingErrorMessage(message).replace(/[。；;.\s]+$/, '')
  if (isAccountNotEnabledFailure(safe)) return '当前账号还不能用，需要的话请联系客服开通'
  // 写 Key 就是写工具的配置文件：没权限时说「写不进配置文件」，不说安装目录（已知29）。
  const hint = presentOperationError(safe, 'config')
  if (hint) return hint.title
  if (speaksChinese(safe)) return redactSecretPatterns(safe)
  return '密钥没有写进去，点「重新同步」再试'
}

/** 这条失败是不是「账号没开通这个工具」：重新同步、重新写入都救不了，只能找客服。 */
export function isAccountNotEnabledFailure(message: string): boolean {
  return unavailableGroupPatterns.some((pattern) => pattern.test(message))
}

/**
 * 一条失败带上是哪个工具的；原话已经以工具名开头的不再重复。Codex 桌面端和
 * Codex CLI 共用一份配置，失败记在 codex 名下，原话点的是桌面端也算点过名，
 * 不然会念成「Codex CLI：Codex 桌面端还开着……」（第四十三批 C）。新手引导里选的是
 * 桌面端时 provider 传 codexDesktop，开头叫桌面端，原话点的是 Codex CLI 也一样不重复。
 */
export function keySyncFailureText(provider: string, message: string): string {
  const name = tools.find((tool) => tool.id === provider)?.name ?? provider
  const reason = keySyncFailureReason(message)
  const codex = provider === 'codex' || provider === 'codexDesktop'
  const names = codex ? [name, ...tools.filter((tool) => tool.id !== provider && (tool.id === 'codex' || tool.id === 'codexDesktop')).map((tool) => tool.name)] : [name]
  return names.some((named) => reason.startsWith(named)) ? reason : `${name}：${reason}`
}

/**
 * 断网启动时这条横幅原来会先说一句「账号 Key 已同步」，再跟上一串网络失败原文，
 * 自相矛盾且没交代下一步。网络类失败改说这一句：已装好的工具照常能用，网络回来
 * 之后客户端自己会补写，用户什么都不用做。「重新同步」按钮保留，想立刻试的照点。
 */
const offlineBootstrapNotice = '当前网络不可用，已装好的工具照常能用；联网后会自动补写密钥。'

/**
 * 拦住同步的是证书被换掉时，电脑一直联着网，等不来「联网后自动补写」，换这一句。「自动」线路下
 * 星芒约半分钟到一分钟会自己换到 CF，所以先叫客户稍等再点「重新同步」，还不行再换网络。
 */
const certificateBootstrapNotice = '连星芒时被网络上的设备拦下了，这次没写好密钥。已装好的工具照常能用；稍等一两分钟点「重新同步」，还不行就换个网络（比如手机热点）。'

/** 整轮同步没跑完（还没轮到逐个工具）时说的那句。 */
export function bootstrapErrorText(error: string): string {
  if (isCertificateFailureText(error)) return certificateBootstrapNotice
  return isNetworkFailureText(error) ? offlineBootstrapNotice : `密钥没写好：${keySyncFailureReason(error)}`
}

/** 这一轮没写完、拦住它的全是网络时，不逐个工具说原因，说这一句。 */
export function networkBlockedNotice(result: Pick<AccountBootstrapResult, 'networkBlockedByCertificate'>): string {
  return result.networkBlockedByCertificate ? certificateBootstrapNotice : offlineBootstrapNotice
}

/**
 * 最近那一轮写密钥没给这个工具写成时，给人看的那句和要不要给「重新同步」（主路卡点 F14）。
 * 跟首页横幅同一句、同一个给按钮的规矩：账号没开通的点多少次「重新同步」都一样，不给。
 * toolId 只管句子开头叫它什么：选的是 Codex 桌面端，就别说成「Codex CLI：」。
 * 那一轮还没跑完、没轮到这个工具、或者写成了，都返回 null。
 */
export function resolveToolKeySyncFailure(
  bootstrap: { result?: Pick<AccountBootstrapResult, 'failed' | 'networkBlocked' | 'networkBlockedByCertificate'>; error?: string } | null | undefined,
  provider: ProviderId,
  toolId: string = provider,
): { text: string; retry: boolean } | null {
  if (!bootstrap) return null
  const { result, error } = bootstrap
  if (!result) return error ? { text: bootstrapErrorText(error), retry: true } : null
  const entry = result.failed.find((item) => item.provider === provider)
  if (!entry) return null
  return {
    text: result.networkBlocked ? networkBlockedNotice(result) : keySyncFailureText(toolId, entry.message),
    retry: !isAccountNotEnabledFailure(entry.message),
  }
}
