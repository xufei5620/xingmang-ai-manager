import { userFacingErrorMessage } from '../../business-common'
import { presentOperationError } from '../../operation-error'
import { tools } from '../../registry/tools'

/**
 * Key 同步失败时给人看的那半句原因（全面检测 Q31）。主进程原文可能是英文网络
 * 报错，也可能带着含用户名的配置文件路径：先脱敏（I13），能归类的说目录里的
 * 标题，认不出的中文原话本身就是写给人看的，原样留着；认不出的英文不上屏。
 */
export function keySyncFailureReason(message: string): string {
  const safe = userFacingErrorMessage(message).replace(/[。；;.\s]+$/, '')
  const hint = presentOperationError(safe)
  if (hint) return hint.title
  if (/[㐀-鿿]/.test(safe)) return safe
  return 'Key 没有写进去，点「重新同步」再试'
}

/** 一条失败带上是哪个工具的；原话已经以工具名开头的不再重复。 */
export function keySyncFailureText(provider: string, message: string): string {
  const name = tools.find((tool) => tool.id === provider)?.name ?? provider
  const reason = keySyncFailureReason(message)
  return reason.startsWith(name) ? reason : `${name}：${reason}`
}
