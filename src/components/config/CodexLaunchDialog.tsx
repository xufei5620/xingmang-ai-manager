import { useEffect } from 'react'
import { AppWindow, ChevronRight, RotateCcw, X } from 'lucide-react'
import { DialogBackdrop } from '../Dialog'
import type { CodexDesktopLaunchMode } from '../../types'

export function CodexLaunchDialog({
  onSelect,
  onCancel,
}: {
  onSelect: (mode: CodexDesktopLaunchMode) => void
  onCancel: () => void
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onCancel])

  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={onCancel}>
      <section className="save-mode-dialog" role="alertdialog" aria-modal="true" aria-labelledby="codex-launch-title">
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon"><AppWindow size={20} /></div>
            <div>
              <h3 id="codex-launch-title">Codex 桌面端已运行</h3>
              <p>修改了配置请选择重启 Codex，若无修改直接打开即可。</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="取消" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>

        <div className="save-mode-options">
          <button type="button" className="save-mode-option" onClick={() => onSelect('open')}>
            <span className="save-option-icon"><AppWindow size={19} /></span>
            <span>
              <strong>直接打开</strong>
              <small>未修改配置，保留当前进程并唤起窗口</small>
            </span>
            <ChevronRight size={18} />
          </button>
          <button type="button" className="save-mode-option reset-option" onClick={() => onSelect('restart')}>
            <span className="save-option-icon"><RotateCcw size={19} /></span>
            <span>
              <strong>重启 Codex</strong>
              <small>退出当前进程，重新加载刚保存的配置</small>
            </span>
            <ChevronRight size={18} />
          </button>
        </div>

        <footer className="save-mode-footer">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}
