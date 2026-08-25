import { AlertCircle, X } from 'lucide-react'
import { DialogBackdrop } from '../Dialog'
import { officialAccountLoginHint } from '../../account-source'
import type { ProviderId } from '../../types'

/**
 * 账号来源切换前的确认。刻意把"会改什么、不会改什么"写全:这一步改的是
 * 用户本机的 CLI 配置文件,官方登录凭据和星芒登录互不影响。
 */
export function OfficialAccountDialog({
  provider,
  label,
  mode,
  busy,
  onConfirm,
  onCancel,
}: {
  provider: ProviderId
  label: string
  mode: 'official' | 'relay'
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const toOfficial = mode === 'official'
  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={() => { if (!busy) onCancel() }}>
      <section className="save-mode-dialog" role="alertdialog" aria-modal="true" aria-labelledby="official-account-title">
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon"><AlertCircle size={20} /></div>
            <div>
              <h3 id="official-account-title">
                {toOfficial ? `切换为你自己的${label}？` : '切换为星芒中转？'}
              </h3>
              <p>
                {toOfficial
                  ? '星芒会从配置里撤掉中转地址与 API Key，之后这个 CLI 走你自己的订阅额度。'
                  : `将把星芒 API Key 和中转地址写回这个 CLI，之后走星芒额度。你的${label}登录不会被删除。`}
              </p>
            </div>
          </div>
          <button className="icon-button" type="button" title="取消" disabled={busy} onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <div className="save-mode-body">
          <ul className="official-account-points">
            {toOfficial ? (
              <>
                <li>你的{label}登录不受影响，星芒不会读取也不会删除它</li>
                <li>会整份换回已保存的 ChatGPT config.toml 和 auth.json</li>
                <li>{officialAccountLoginHint(provider)}</li>
                <li>改动前会自动备份配置文件，随时可以在这里切回星芒</li>
                {provider === 'codex' && <li>确认后会自动重启 Codex 桌面端，才会读到新配置</li>}
              </>
            ) : (
              <>
                <li>优先使用已登录星芒账号签发的 Key，明文不会进到界面</li>
                <li>Codex 的 ChatGPT 登录和 config.toml 会各存一份，auth.json 只留下星芒 API Key</li>
                <li>未登录时需要你在上方填好星芒 API Key 并选好模型</li>
                <li>切回去时整份换回 ChatGPT 的 auth.json 和 config.toml</li>
                {provider === 'codex' && <li>确认后会自动重启 Codex 桌面端，才会读到新配置</li>}
              </>
            )}
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
