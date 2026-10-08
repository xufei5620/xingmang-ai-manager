import { speaksChinese, userFacingErrorMessage } from '../../business-common'
import { presentOperationError } from '../../operation-error'
import { tools } from '../../registry/tools'
import { redactSecretPatterns } from '../../../../electron/redaction-patterns'

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
 * 是不是中文按 speaksChinese 判：脱完路径的占位词「本地配置文件」本身是汉字，
 * 只看有没有汉字的话带路径的英文会原样上屏（第三十批 A）。
 */
export function keySyncFailureReason(message: string): string {
  const safe = userFacingErrorMessage(message).replace(/[。；;.\s]+$/, '')
  if (isAccountNotEnabledFailure(safe)) return '当前账号还不能用，需要的话请联系客服开通'
  // 写 Key 就是写工具的配置文件：没权限时说「写不进配置文件」，不说安装目录（已知29）。
  const hint = presentOperationError(safe, 'config')
  if (hint) return hint.title
  if (speaksChinese(safe)) return redactSecretPatterns(safe)
  return 'Key 没有写进去，点「重新同步」再试'
}

/** 这条失败是不是「账号没开通这个工具」：重新同步、重新写入都救不了，只能找客服。 */
export function isAccountNotEnabledFailure(message: string): boolean {
  return unavailableGroupPatterns.some((pattern) => pattern.test(message))
}

/**
 * 一条失败带上是哪个工具的；原话已经以工具名开头的不再重复。Codex 桌面端和
 * Codex CLI 共用一份配置，失败记在 codex 名下，原话点的是桌面端也算点过名，
 * 不然会念成「Codex CLI：Codex 桌面端还开着……」（第四十三批 C）。
 */
export function keySyncFailureText(provider: string, message: string): string {
  const name = tools.find((tool) => tool.id === provider)?.name ?? provider
  const reason = keySyncFailureReason(message)
  const names = provider === 'codex' ? [name, ...tools.filter((tool) => tool.id === 'codexDesktop').map((tool) => tool.name)] : [name]
  return names.some((named) => reason.startsWith(named)) ? reason : `${name}：${reason}`
}
