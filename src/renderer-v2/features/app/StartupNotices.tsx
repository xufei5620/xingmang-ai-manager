import { useState, type ReactNode } from 'react'
import { Button, Notice } from '../../ui'
import type { StartupCheckId, StartupNotice, StartupNoticeAction } from './startup-notice'

/**
 * 角落里同时摊开几张。升级后第一次开机，「已更新」「设置已补齐」「环境检查」「维护」
 * 能一起来，全摊开时 1366×768 的屏幕第四张就出了底边，最后那张的按钮点不到；
 * 卡片还正好盖住首页右上角那排按钮。多出来的折成一行，想看再点开。
 */
export const STARTUP_NOTICE_VISIBLE_LIMIT = 2

/**
 * 只能摊开两张时先给哪两张：要用户二选一的排最前（不选就一直挂着、也关不掉），
 * 然后是出了事要他知道的，再是有空看一眼的，最后是纯告知、「知道了」就完的。
 * 写成无缺省的 Record：新增一种提示时编译器会逼着给它排个位置。
 */
const startupNoticeRank: Record<StartupCheckId, number> = {
  'display-compat': 0,
  'display-relaunch': 0,
  'crash-reporting': 0,
  'unexpected-exit': 1,
  'vault-recovered': 1,
  'settings-save': 1,
  diagnostics: 2,
  update: 2,
  appearance: 2,
  updated: 3,
  'template-filled': 3,
}

/** 按上面的先后排；同一档里保持先来后到。 */
export function orderStartupNotices(notices: readonly StartupNotice[]): StartupNotice[] {
  return notices.map((notice, index) => ({ notice, index }))
    .sort((a, b) => startupNoticeRank[a.notice.id] - startupNoticeRank[b.notice.id] || a.index - b.index)
    .map((entry) => entry.notice)
}

/**
 * 启动期后台检查的坏消息挂在角落，不抢焦点、不吃点击、随手能关掉。容器本身
 * 不接收指针事件，否则它会挡住底下那一片按钮——这条提示存在的意义恰恰是不挡路。
 */
export function StartupNotices({ notices, onDismiss, onOpen, leading }: {
  notices: readonly StartupNotice[]
  onDismiss(id: StartupCheckId): void
  onOpen(id: StartupCheckId, action: StartupNoticeAction): void
  /** 排在最前的一条（维护提示）：它和启动检查一样不该挡路，所以共用这个角落。 */
  leading?: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  if (!notices.length && !leading) return null
  const ordered = orderStartupNotices(notices)
  // 维护提示也占一个位置：它和卡片挤的是同一块屏幕。
  const room = Math.max(0, STARTUP_NOTICE_VISIBLE_LIMIT - (leading ? 1 : 0))
  const hidden = Math.max(0, ordered.length - room)
  const shown = expanded || hidden === 0 ? ordered : ordered.slice(0, room)
  return <div className="v2-startup-notices" data-testid="startup-notices">
    <div className="v2-startup-notices-list" data-testid="startup-notices-list">
      {leading}
      {shown.map((notice) => {
        const action = notice.action
        const secondary = notice.secondaryAction
        const body = notice.items?.length
          ? <>{notice.body}<ul className="v2-startup-notice-items">{notice.items.map((item, index) => <li key={index}>{item}</li>)}</ul></>
          : notice.body
        return <Notice key={notice.id} tone={notice.tone} title={notice.title} body={body}
          testId={`startup-notice-${notice.id}`}
          // 按钮本身就是「知道了」时不再放一个关闭叉：两颗做同一件事的按钮只会让人犹豫点哪个。
          // 二选一的提示也不放：关掉等于没选。
          onDismiss={secondary || (action && 'dismiss' in action) ? undefined : () => onDismiss(notice.id)}
          actions={action ? <>
            <Button size="sm" variant={secondary ? 'primary' : undefined} testId={secondary ? `startup-notice-${notice.id}-primary` : undefined} onClick={() => onOpen(notice.id, action)}>{action.label}</Button>
            {secondary && <Button size="sm" testId={`startup-notice-${notice.id}-secondary`} onClick={() => onOpen(notice.id, secondary)}>{secondary.label}</Button>}
          </> : undefined} />
      })}
    </div>
    {hidden > 0 && <Button size="sm" variant="ghost" testId="startup-notices-toggle" aria-expanded={expanded}
      onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : `还有 ${hidden} 条提示`}</Button>}
  </div>
}
