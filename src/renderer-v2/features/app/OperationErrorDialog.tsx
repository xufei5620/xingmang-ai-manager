import { Button, Dialog } from '../../ui'
import { operationFallbackActions, presentOperationError, type OperationAction, type OperationActionId } from '../../operation-error'

export interface OperationFailure {
  message: string
  /** retry is present only where the failed work is still re-runnable, so the dialog never offers a button that leads nowhere. */
  retry?: () => void
}

/**
 * 归不进任何一类时也要给出下一步。目录里 errors.unknown 的按钮正是为这一格
 * 写的；「重试」只有在这次失败真的可重试时才留得住，否则是个按了没反应的按钮。
 */
export function operationErrorActions(failure: OperationFailure): OperationAction[] {
  const hint = presentOperationError(failure.message)
  return (hint?.actions ?? operationFallbackActions())
    .filter((action) => action.id !== 'retry' || Boolean(failure.retry))
}

export function OperationErrorDialog({ failure, onClose, onAction }: {
  failure: OperationFailure
  onClose(): void
  onAction(action: OperationActionId): void
}) {
  const hint = presentOperationError(failure.message)
  return <Dialog open title={hint?.title ?? '操作没有完成'} onClose={onClose} testId="operation-error" footer={<>
    <Button onClick={onClose}>返回</Button>
    {operationErrorActions(failure).map((action) => <Button key={action.id} variant={action.id === 'retry' ? 'primary' : 'secondary'}
      testId={`operation-error-${action.id}`} onClick={() => onAction(action.id)}>{action.label}</Button>)}
  </>}>
    {hint && <p data-testid="operation-error-body">{hint.body}</p>}
    {/* 后端原话始终留着：客服排查时要的是它，不是被归类后的标题。 */}
    <p role="alert" className={hint ? 'v2-operation-detail' : undefined} data-testid="operation-error-detail">{failure.message}</p>
  </Dialog>
}
