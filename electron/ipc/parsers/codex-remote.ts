// 手机遥控那几条通道的入参（I5）：渠道只认 remoteChannelIds 里的，开关只认布尔，自动关时长只认 remoteIdleCloseHours 里的数或 null，
// 飞书凭据只认两个限长字符串，「用这个」「移除」的文件夹只认一个限长字符串（主进程再到单子里找，YF-19）。
import { isRemoteChannelId, isRemoteIdleCloseHours, type RemoteChannelId, type RemoteIdleCloseHours } from '../../codex-remote-channel'
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

/** null = 不自动关。 */
export function parseRemoteIdleClose(value: unknown): RemoteIdleCloseHours | null {
  if (value === null) return null
  if (!isRemoteIdleCloseHours(value)) throw new Error('遥控自动关时长参数无效')
  return value
}

/** 界面上显示的文件夹那串字（主目录写 ~）。不当路径用：主进程只拿它跟电脑上加过的单子比。 */
export function parseRemoteWorkspaceChoice(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) throw new Error('文件夹参数无效')
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
