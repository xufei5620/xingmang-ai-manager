import type { ReactNode } from 'react'
import { Button, Notice } from '../../ui'
import type { StartupCheckId, StartupNotice, StartupNoticeAction } from './startup-notice'

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
  if (!notices.length && !leading) return null
  return <div className="v2-startup-notices" data-testid="startup-notices">
    {leading}
    {notices.map((notice) => {
      const action = notice.action
      const body = notice.items?.length
        ? <>{notice.body}<ul className="v2-startup-notice-items">{notice.items.map((item, index) => <li key={index}>{item}</li>)}</ul></>
        : notice.body
      return <Notice key={notice.id} tone={notice.tone} title={notice.title} body={body}
        testId={`startup-notice-${notice.id}`}
        // 按钮本身就是「知道了」时不再放一个关闭叉：两颗做同一件事的按钮只会让人犹豫点哪个。
        onDismiss={action && 'dismiss' in action ? undefined : () => onDismiss(notice.id)}
        actions={action ? <Button size="sm" onClick={() => onOpen(notice.id, action)}>{action.label}</Button> : undefined} />
    })}
  </div>
}
