import { useMemo } from 'react'
import type { UpdateSnapshot } from '../../../../electron/ipc-contract'
import type { AccountTabValue } from '../../registry/business'
import type { PageId } from '../../registry/pages'
import { Button, Notice } from '../../ui'
import { useWindowSessionString } from '../../window-session'

type KnownIssue = NonNullable<UpdateSnapshot['knownIssues']>[number]
type KnownIssueAction = NonNullable<KnownIssue['action']>

export interface KnownIssuePlace {
  page: PageId
  /** 个人中心实际摆着的页签；充值那一条只在「充值订阅」页签上出。 */
  accountTab?: AccountTabValue
}

function shownOn(issue: KnownIssue, place: KnownIssuePlace): boolean {
  if (issue.page === 'recharge') return place.page === 'account' && place.accountTab === 'recharge'
  return issue.page === place.page
}

/** 关掉的是这一页上的这句话：发布者改了说法（比如换了绕过去的办法）会再出现，同维护提示。 */
export function knownIssueKey(issue: KnownIssue): string {
  return `known-issue:${issue.page}:${issue.message}`
}

/**
 * 这一页摆哪一条：先挑只挂在这一页的，再挑每页都挂的，关掉的跳过。一次只摆一条：角落里还有维护提示和
 * 启动检查的卡，同时摊开几条就挤出屏幕了。
 */
export function knownIssueFor(issues: readonly KnownIssue[] | undefined, place: KnownIssuePlace, dismissed: readonly string[]): KnownIssue | null {
  const open = (issues ?? []).filter((issue) => !dismissed.includes(knownIssueKey(issue)))
  return open.find((issue) => shownOn(issue, place)) ?? open.find((issue) => issue.page === 'all') ?? null
}

/**
 * 客户看到一件事一直不成，会去重装、重登、改设置，再去找客服；所以跟维护提示一样，发布者那句话后面
 * 固定补一句「不是你这边的问题」。
 */
export function knownIssueBody(issue: KnownIssue): string {
  return `${issue.message} 这不是你这边的问题，修好以后这条提示会自己消失。`
}

const knownIssueActionLabels: Record<KnownIssueAction, string> = { update: '查看更新', support: '找客服' }

// 一份状态文件最多八条（service-status.ts），记再多也只是这次打开软件关过的那些。
const maxDismissedKnownIssues = 16

function parseDismissed(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/** 角落里那条已知问题提示：这一页摆哪条、关掉以后记在窗口的 sessionStorage 里（同维护提示）。 */
export function useKnownIssue(update: UpdateSnapshot | null, place: KnownIssuePlace) {
  const [stored, setStored] = useWindowSessionString('xingmang-v2-dismissed-known-issues')
  const dismissed = useMemo(() => parseDismissed(stored), [stored])
  const issue = knownIssueFor(update?.knownIssues, place, dismissed)
  function dismiss() {
    if (!issue) return
    setStored(JSON.stringify([...dismissed.filter((key) => key !== knownIssueKey(issue)), knownIssueKey(issue)].slice(-maxDismissedKnownIssues)))
  }
  return { issue, dismiss }
}

export function KnownIssueNotice({ issue, onDismiss, onAction }: {
  issue: KnownIssue
  onDismiss: () => void
  onAction: (action: KnownIssueAction) => void
}) {
  const action = issue.action
  return <Notice tone="warn" title="我们已经知道这个问题" body={knownIssueBody(issue)} onDismiss={onDismiss} testId="known-issue-notice"
    actions={action ? <Button size="sm" testId={`known-issue-notice-${action}`} onClick={() => onAction(action)}>{knownIssueActionLabels[action]}</Button> : undefined} />
}
