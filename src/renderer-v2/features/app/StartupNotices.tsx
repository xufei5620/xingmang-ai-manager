import { Button, Notice } from '../../ui'
import type { PageId } from '../../registry/pages'
import type { StartupCheckId, StartupNotice } from './startup-notice'

/**
 * 启动期后台检查的坏消息挂在角落，不抢焦点、不吃点击、随手能关掉。容器本身
 * 不接收指针事件，否则它会挡住底下那一片按钮——这条提示存在的意义恰恰是不挡路。
 */
export function StartupNotices({ notices, onDismiss, onOpen }: {
  notices: readonly StartupNotice[]
  onDismiss(id: StartupCheckId): void
  onOpen(id: StartupCheckId, page: PageId): void
}) {
  if (!notices.length) return null
  return <div className="v2-startup-notices" data-testid="startup-notices">
    {notices.map((notice) => {
      const action = notice.action
      return <Notice key={notice.id} tone={notice.tone} title={notice.title} body={notice.body}
        testId={`startup-notice-${notice.id}`} onDismiss={() => onDismiss(notice.id)}
        actions={action ? <Button size="sm" onClick={() => onOpen(notice.id, action.page)}>{action.label}</Button> : undefined} />
    })}
  </div>
}
