import { useState } from 'react'
import { Copy } from 'lucide-react'
import { Button, Dialog } from '../../ui'
import { operationFallbackActions, presentOperationError, type OperationAction, type OperationActionId } from '../../operation-error'
import type { ToolId } from '../tools/model'

export interface OperationFailure {
  message: string
  /** retry is present only where the failed work is still re-runnable, so the dialog never offers a button that leads nowhere. */
  retry?: () => void
  /**
   * 这次失败是哪个工具的。有了它，调用方才能从快照里取出这个工具的安装目录
   * （未装时是主进程算出的首装落点）交给「复制路径」——目录本身由 App 解析，
   * 对话框只负责把它显示出来并复制。
   */
  tool?: ToolId
}

/**
 * 归不进任何一类时也要给出下一步。目录里 errors.unknown 的按钮正是为这一格
 * 写的；「重试」只有在这次失败真的可重试时才留得住，「复制路径」只有在真的
 * 知道是哪个目录时才留得住，否则都是按了没反应的按钮。
 */
export function operationErrorActions(failure: OperationFailure, installDirectory?: string | null): OperationAction[] {
  const hint = presentOperationError(failure.message)
  return (hint?.actions ?? operationFallbackActions())
    .filter((action) => action.id !== 'retry' || Boolean(failure.retry))
    .filter((action) => action.id !== 'copyPath' || Boolean(installDirectory))
}

export function OperationErrorDialog({ failure, installDirectory, onClose, onAction }: {
  failure: OperationFailure
  /** 这次失败牵涉到的安装目录；缺省或为 null 时不出「复制路径」。 */
  installDirectory?: string | null
  onClose(): void
  onAction(action: OperationActionId): void
}) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
  const hint = presentOperationError(failure.message)
  const actions = operationErrorActions(failure, installDirectory)
  const showPath = actions.some((action) => action.id === 'copyPath')
  return <Dialog open title={hint?.title ?? '操作没有完成'} onClose={onClose} testId="operation-error" footer={<>
    <Button onClick={onClose}>返回</Button>
    {actions.map((action) => action.id === 'copyPath'
      // 复制不关对话框：用户复制完路径还要回来看原文、或者再点一次重试。
      ? <Button key={action.id} icon={Copy} testId="operation-error-copyPath" onClick={() => {
        void navigator.clipboard.writeText(installDirectory ?? '')
          .then(() => setCopied('ok')).catch(() => setCopied('failed'))
      }}>{action.label}</Button>
      : <Button key={action.id} variant={action.id === 'retry' ? 'primary' : 'secondary'}
        testId={`operation-error-${action.id}`} onClick={() => onAction(action.id)}>{action.label}</Button>)}
  </>}>
    {hint && <p data-testid="operation-error-body">{hint.body}</p>}
    {/* 路径只上屏、只进剪贴板：剪贴板写不进去时用户还能自己选中它（I13 管的是日志与导出，不是这里）。 */}
    {showPath && <pre className="v2-business-code" data-testid="operation-error-path">{installDirectory}</pre>}
    {copied && <p role="status" data-testid="operation-error-copied">{copied === 'ok' ? '路径已复制' : '没能写进剪贴板，手动选中上面的路径复制就行'}</p>}
    {/* 后端原话始终留着：客服排查时要的是它，不是被归类后的标题。 */}
    <p role="alert" className={hint ? 'v2-operation-detail' : undefined} data-testid="operation-error-detail">{failure.message}</p>
  </Dialog>
}
