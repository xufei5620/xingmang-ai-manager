// 手机遥控那几条通道的入参（I5）：渠道只认 remoteChannelIds 里的，开关只认布尔，飞书凭据只认两个限长字符串。
import { isRemoteChannelId, type RemoteChannelId } from '../../codex-remote-channel'
import { isRecord } from '../../input-guards'
import type { CodexRemoteFeishuCredentialRequest } from '../../ipc-contract'

export function parseRemoteChannel(value: unknown): RemoteChannelId {
  if (!isRemoteChannelId(value)) throw new Error('遥控渠道参数无效')
  return value
}

export function parseRemoteEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('遥控开关参数无效')
  return value
}

/** 只收这两个字段、各自限长；格式对不对交给 validateFeishuCredentialInput 说成上屏的话。 */
export function parseFeishuCredentialRequest(value: unknown): CodexRemoteFeishuCredentialRequest {
  if (!isRecord(value)) throw new Error('飞书凭据格式错误')
  const { appId, appSecret } = value
  if (typeof appId !== 'string' || typeof appSecret !== 'string' || appId.length > 256 || appSecret.length > 256
    || appId.includes('\0') || appSecret.includes('\0')) {
    throw new Error('飞书凭据格式错误')
  }
  return { appId, appSecret }
}
