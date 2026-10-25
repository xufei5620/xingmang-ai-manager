import type { ReactNode } from 'react'
import type { CodexRemoteChannelSnapshot, CodexRemoteSnapshot, RemoteChannelId } from '../../../../../electron/ipc-contract'
import type { V2Bridge } from '../../../types'
import { FeishuRemoteSection } from './FeishuRemoteSection'
import { WeixinRemoteSection } from './WeixinRemoteSection'

/**
 * 每个渠道「登录或填凭据」那一块拿到的东西。操作一律交给 run：和卡上别的按钮共用一把锁、一条红条，
 * 返回快照的操作由卡片按新旧收下（主进程也会推 state-changed，两份谁先到都行）。
 */
export interface RemoteChannelSectionProps {
  snapshot: CodexRemoteChannelSnapshot
  api: V2Bridge
  /** 这台电脑现在不能开遥控，或者卡上别的操作正在跑。 */
  disabled: boolean
  /** 卡上正在跑的那个操作的名字；空 = 没有。 */
  busy: string
  /** 成功返回 true；失败的原因卡片自己摆在红条上。 */
  run(name: string, action: () => Promise<CodexRemoteSnapshot | void>): Promise<boolean>
}

export interface RemoteChannelSectionDefinition {
  title: string
  /** 标题旁标「实验功能」。 */
  experimental?: boolean
  /** 「打开遥控」那一行在还没填凭据时说的话。 */
  credentialHint: string
  /** 配对码旁边那句：在哪儿发这 6 位数字。 */
  pairingHint: string
  Section(props: RemoteChannelSectionProps): ReactNode
}

/**
 * 卡片按 remoteChannelIds 的次序一块块摆。主进程加了渠道这里没跟上，是编译错（Record 漏键）。
 */
export const remoteChannelSections: Record<RemoteChannelId, RemoteChannelSectionDefinition> = {
  feishu: {
    title: '飞书',
    credentialHint: '先在上面填好飞书应用。',
    pairingHint: '在飞书里打开你建的机器人，私聊发这 6 位数字。',
    Section: FeishuRemoteSection,
  },
  weixin: {
    title: '微信',
    experimental: true,
    credentialHint: '先在上面用微信扫码登录。',
    pairingHint: '在微信的 ClawBot 对话里发送这 6 位数字。',
    Section: WeixinRemoteSection,
  },
}
