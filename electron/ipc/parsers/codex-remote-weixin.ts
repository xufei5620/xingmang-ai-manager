// 手机遥控 Codex 里微信扫码登录那三条通道的入参（I5）。
import { isRecord } from '../../input-guards'
import type { WeixinLoginPollInput } from '../../codex-remote-weixin-login-state'

export function parseWeixinLoginId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('扫码编号格式错误')
  }
  return value
}

export function parseWeixinLoginPollInput(value: unknown): WeixinLoginPollInput {
  if (!isRecord(value)) throw new Error('扫码查询格式错误')
  const loginId = parseWeixinLoginId(value.loginId)
  if (value.verifyCode === undefined) return { loginId }
  // 数字本身由登录控制器再认一遍（只收数字）；这里只挡类型和长度。
  if (typeof value.verifyCode !== 'string' || value.verifyCode.length > 32 || value.verifyCode.includes('\0')) {
    throw new Error('手机上的数字格式错误')
  }
  return { loginId, verifyCode: value.verifyCode }
}
