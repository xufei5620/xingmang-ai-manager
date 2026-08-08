import { AlertCircle, X } from 'lucide-react'
import { DialogBackdrop } from '../Dialog'

export function DiscardConfigChangesDialog({
  onDiscard,
  onCancel,
}: {
  onDiscard: () => void
  onCancel: () => void
}) {
  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={onCancel}>
      <section className="save-mode-dialog" role="alertdialog" aria-modal="true" aria-labelledby="discard-config-title">
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon"><AlertCircle size={20} /></div>
            <div>
              <h3 id="discard-config-title">放弃未保存的修改？</h3>
              <p>API Key 或模型已经更改，关闭后本次修改不会保留。</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="继续编辑" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <footer className="save-mode-footer">
          <button className="secondary-button" type="button" onClick={onCancel}>继续编辑</button>
          <button className="danger-button" type="button" onClick={onDiscard}>放弃修改</button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}
