import type { CliStatus, ToolStatus } from '../../../../electron/ipc-contract'
import { Pill } from '../../ui'
import { toolAvailability, updateCheckFailure } from './model'

/** 「安装卸载」页一行需要读的那几个字段，CLI、桌面端与运行环境共用。 */
export type ToolRowStatus =
  & Pick<ToolStatus, 'installed' | 'detectionFailed' | 'detectionError' | 'installSource'>
  & Pick<CliStatus, 'updateCheck' | 'updateError'>

export interface ToolStatusProps {
  status: ToolRowStatus | null | undefined
  /** 检测那一块整个没读到：这一行对「装没装」毫无根据。 */
  statusUnknown?: boolean
  testId?: string
}

/**
 * 「版本与状态」那一格。版本号缺失时的那句话由状态决定：没探到就说没读到，
 * 不说「未找到版本」——后者是一个这次并没有得出的结论。
 */
export function ToolStatusMeta({ version, status, statusUnknown = false, testId }: ToolStatusProps & { version?: string | null }) {
  const availability = toolAvailability(status, statusUnknown)
  return <>
    {version || availability.versionFallback}{' '}
    <Pill tone={availability.tone} testId={testId}>{availability.label}</Pill>
  </>
}

/**
 * 行副标题：这一行本来就有的那句话（工具行是厂商，运行环境行是它派什么用场），
 * 外加这次没能得出结论的原因。探测失败的原因优先，因为探测没成的时候更新检查
 * 必然也没成，两句一起说只是把真正的那句挤出屏幕。
 */
export function ToolStatusReason({ lead, status, statusUnknown = false, testId }: ToolStatusProps & { lead: string }) {
  const reason = toolAvailability(status, statusUnknown).reason ?? updateCheckFailure(status)
  if (!reason) return <>{lead}</>
  return <>{lead} · <span data-testid={testId}>{reason}</span></>
}
