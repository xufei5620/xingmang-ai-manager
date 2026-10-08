import type { CliStatus, ToolStatus } from '../../../../electron/ipc-contract'
import { Pill, type Tone } from '../../ui'
import { toolAvailability, updateCheckFailure } from './model'

/** 「安装卸载」页一行需要读的那几个字段，CLI、桌面端与运行环境共用。 */
export type ToolRowStatus =
  & Pick<ToolStatus, 'installed' | 'detectionFailed' | 'detectionError' | 'installSource'>
  & Pick<CliStatus, 'updateCheck' | 'updateError'>

/** 这一行此刻的事：正在装，或者刚才没装上。缺省 = 只看检测结果。 */
export type ToolRowActivity = 'installing' | 'failed'

export interface ToolStatusView {
  /** 版本号那几个字；整页没读到时就是「暂未读到」那一句。 */
  version: string
  /** 状态标签；整页没读到时不放。 */
  pill: { label: string; tone: Tone } | null
  /** 下一行：这次没得出结论的原因。 */
  reason: string | null
}

/**
 * 「版本与状态」那一格写什么。版本号缺失时的那句话由状态决定：没探到就说没读到，
 * 不说「未找到版本」——后者是一个这次并没有得出的结论；确实没装的写「—」，旁边的
 * 「未安装」已经说了，不再说一遍「未找到版本」。整页都没读到时只写一句「暂未读到」，
 * 每行再挂一个标签只是把同一件事说七遍。
 */
export function toolStatusView(
  status: ToolRowStatus | null | undefined,
  statusUnknown: boolean,
  version: string | null | undefined,
  activity?: ToolRowActivity | null,
): ToolStatusView {
  const availability = toolAvailability(status, statusUnknown)
  const fallback = availability.state === 'missing' ? '—' : availability.versionFallback
  if (activity === 'installing') return { version: version || fallback, pill: { label: '安装中', tone: 'accent' }, reason: null }
  if (activity === 'failed') return { version: version || '—', pill: { label: '安装失败', tone: 'bad' }, reason: null }
  if (availability.state === 'unknown') return { version: '暂未读到', pill: null, reason: null }
  return {
    version: version || fallback,
    pill: { label: availability.label, tone: availability.tone },
    // 探测失败的原因优先：探测没成的时候更新检查必然也没成，两句一起说只是把真正的那句挤出去。
    reason: availability.reason ?? updateCheckFailure(status),
  }
}

/** 「版本与状态」那一格：先版本号再标签，没得出结论的原因放在下一行。 */
export function ToolStatusMeta({ view, testId, reasonTestId }: { view: ToolStatusView; testId?: string; reasonTestId?: string }) {
  if (!view.pill) return <span className="v2-tool-status" data-testid={testId}>{view.version}</span>
  return <>
    <span className="v2-tool-status">{view.version} <Pill tone={view.pill.tone} testId={testId}>{view.pill.label}</Pill></span>
    {view.reason && <span className="v2-tool-status-reason" data-testid={reasonTestId}>{view.reason}</span>}
  </>
}
