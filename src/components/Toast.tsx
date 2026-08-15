import { AlertCircle, Check, ClipboardCopy, Info, X } from 'lucide-react'

export interface ToastMessage {
  type: 'success' | 'error' | 'info'
  message: string
}

export function Toast({
  toast,
  onDismiss,
  onCopy,
}: {
  toast: ToastMessage
  onDismiss?: () => void
  onCopy?: () => void
}) {
  return (
    <div className={`toast ${toast.type}`} role="alert">
      {toast.type === 'success'
        ? <Check size={17} />
        : toast.type === 'info'
          ? <Info size={17} />
          : <AlertCircle size={17} />}
      <span>{toast.message}</span>
      {toast.type === 'error' && onCopy && (
        <button type="button" className="toast-action" title="复制错误信息" aria-label="复制错误信息" onClick={onCopy}>
          <ClipboardCopy size={15} />
        </button>
      )}
      {onDismiss && (
        <button type="button" className="toast-action" title="关闭提示" aria-label="关闭提示" onClick={onDismiss}>
          <X size={15} />
        </button>
      )}
    </div>
  )
}
