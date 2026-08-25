import { useEffect } from 'react'
import { AppWindow, RotateCcw, X } from 'lucide-react'
import { DialogBackdrop } from '../Dialog'
import {
  codexDesktopLaunchDialogCopy,
  type ProviderAccountSource,
} from '../../account-source'
import type { CodexDesktopLaunchMode } from '../../types'

export function CodexLaunchDialog({
  accountSource,
  onSelect,
  onCancel,
}: {
  accountSource: ProviderAccountSource
  onSelect: (mode: CodexDesktopLaunchMode) => void
  onCancel: () => void
}) {
  const copy = codexDesktopLaunchDialogCopy(accountSource)

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onCancel])

  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={onCancel}>
      <section
        className="save-mode-dialog codex-launch-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="codex-launch-title"
      >
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon"><AppWindow size={20} /></div>
            <div>
              <h3 id="codex-launch-title">{copy.title}</h3>
              <p>{copy.subtitle}</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="取消" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>

        <div className="codex-launch-options">
          <button type="button" className="codex-launch-option" onClick={() => onSelect('open')}>
            <span className="codex-launch-option-icon"><AppWindow size={20} /></span>
            <span className="codex-launch-option-copy">
              <strong>打开窗口</strong>
              <small>{copy.openHint}</small>
            </span>
            <span className="codex-launch-option-action">打开</span>
          </button>
          <button
            type="button"
            className="codex-launch-option restart-option"
            onClick={() => onSelect('restart')}
          >
            <span className="codex-launch-option-icon"><RotateCcw size={20} /></span>
            <span className="codex-launch-option-copy">
              <strong>重启 Codex</strong>
              <small>{copy.restartHint}</small>
            </span>
            <span className="codex-launch-option-action">重启</span>
          </button>
        </div>

        <footer className="save-mode-footer">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}
