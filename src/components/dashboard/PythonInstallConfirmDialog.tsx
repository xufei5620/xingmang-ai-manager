import { Download, ShieldCheck, X } from 'lucide-react'
import { DialogBackdrop } from '../Dialog'

export function PythonInstallConfirmDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={onCancel}>
      <section
        className="save-mode-dialog python-install-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="python-install-confirm-title"
        aria-describedby="python-install-confirm-description"
      >
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon python-install-confirm-icon"><Download size={20} /></div>
            <div>
              <h3 id="python-install-confirm-title">安装 Python 3.12？</h3>
              <p id="python-install-confirm-description">当前没有检测到可用的 Python。确认后将自动下载安装。</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="取消" aria-label="关闭 Python 安装确认" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <div className="python-install-confirm-details">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>仅为当前用户静默安装，包含 pip，不要求管理员权限。安装包会校验 Python Software Foundation 数字签名。</p>
        </div>
        <footer className="save-mode-footer">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
          <button className="primary-button" type="button" onClick={onConfirm}>
            <Download size={16} />确认安装
          </button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}
