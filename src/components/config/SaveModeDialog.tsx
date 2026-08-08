import { ChevronRight, FileWarning, PencilLine, RotateCcw, X } from 'lucide-react'
import { DialogBackdrop } from '../Dialog'
import type { ConfigSaveMode } from '../../types'

export function SaveModeDialog({
  onSelect,
  onCancel,
}: {
  onSelect: (mode: ConfigSaveMode) => void
  onCancel: () => void
}) {
  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={onCancel}>
      <section className="save-mode-dialog" role="alertdialog" aria-modal="true" aria-labelledby="save-mode-title">
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon"><FileWarning size={20} /></div>
            <div>
              <h3 id="save-mode-title">配置文件已存在</h3>
              <p>选择本次保存方式，执行前都会创建时间戳备份。</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="取消" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>

        <div className="save-mode-options">
          <button type="button" className="save-mode-option" onClick={() => onSelect('merge')}>
            <span className="save-option-icon"><PencilLine size={19} /></span>
            <span>
              <strong>只修改 API Key 和模型</strong>
              <small>保留配置文件中的其他自定义设置</small>
            </span>
            <ChevronRight size={18} />
          </button>
          <button type="button" className="save-mode-option reset-option" onClick={() => onSelect('reset')}>
            <span className="save-option-icon"><RotateCcw size={19} /></span>
            <span>
              <strong>重置为初始配置</strong>
              <small>若只修改 API Key 和模型不能正常使用，请使用此项重置配置文件</small>
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
