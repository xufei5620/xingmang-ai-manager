// 手机遥控那几条通道的入参（I5）：渠道只认 remoteChannelIds 里的，开关只认布尔，自动关时长只认 remoteIdleCloseHours 里的数或 null，
// 飞书凭据只认两个限长字符串，「用这个」「移除」的文件夹只认一个限长字符串（主进程再到单子里找，YF-19），
// 手机端使用的模型只认长得像型号名的字串或 null，权限只认 remotePermissions 里的两档，
// 「手机端的对话」只认 Codex 的对话编号（UUID）或 null（主进程再到上一次列出来的里面找，文件夹不从这里来）。
import {
  isCodexThreadId,
  isRemoteChannelId,
  isRemoteIdleCloseHours,
  isRemoteModel,
  isRemotePermission,
  type RemoteChannelId,
  type RemoteIdleCloseHours,
  type RemotePermission,
} from '../../codex-remote-channel'
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

/** null = 跟电脑上的 Codex 一样。 */
export function parseRemoteModel(value: unknown): string | null {
  if (value === null) return null
  if (!isRemoteModel(value)) throw new Error('手机端模型参数无效')
  return value
}

/** null = 新对话。 */
export function parseRemoteConversationChoice(value: unknown): string | null {
  if (value === null) return null
  if (!isCodexThreadId(value)) throw new Error('手机端对话参数无效')
  return value
}

/** 只有两档，没有「完全访问」：多出来的值一律不收。 */
export function parseRemotePermission(value: unknown): RemotePermission {
  if (!isRemotePermission(value)) throw new Error('遥控权限参数无效')
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
