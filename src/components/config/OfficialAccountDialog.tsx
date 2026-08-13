import { AlertCircle, X } from 'lucide-react'
import { DialogBackdrop } from '../Dialog'
import { officialAccountLoginHint } from '../../account-source'
import type { ProviderId } from '../../types'

/**
 * 切回官方订阅前的确认。刻意把"会改什么、不会改什么"写全:这一步改的是
 * 用户本机的 CLI 配置文件,而"官方登录凭据不受影响"正是用户最担心的点。
 */
export function OfficialAccountDialog({
  provider,
  label,
  busy,
  onConfirm,
  onCancel,
}: {
  provider: ProviderId
  label: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={() => { if (!busy) onCancel() }}>
      <section className="save-mode-dialog" role="alertdialog" aria-modal="true" aria-labelledby="official-account-title">
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon"><AlertCircle size={20} /></div>
            <div>
              <h3 id="official-account-title">切换为你自己的{label}？</h3>
              <p>星芒会从配置里撤掉中转地址与 API Key，之后这个 CLI 走你自己的订阅额度。</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="取消" disabled={busy} onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <div className="save-mode-body">
          <ul className="official-account-points">
            <li>你的{label}登录不受影响，星芒不会读取也不会删除它</li>
            <li>{officialAccountLoginHint(provider)}</li>
            <li>改动前会自动备份配置文件，随时可以在这里切回星芒</li>
          </ul>
        </div>
        <footer className="save-mode-footer">
          <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>取消</button>
          <button className="primary-button" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? '切换中…' : '确认切换'}
          </button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}
