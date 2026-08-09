import { useState, type FormEvent } from 'react'
import { Check, KeyRound, X } from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../Dialog'
import { filterProvisioningTargets } from '../../account-provisioning'
import { normalizePastedApiKey, validatePastedApiKey } from './paste-key'
import { providers } from '../../provider-meta'
import type { ProviderId } from '../../types'

/**
 * Manual-key entry point for a site whose accountBackend is 'manual-key'
 * (relay-sites.ts, W3 -- sub2api today). Structurally this mirrors
 * ProvisioningConfirmDialog.tsx exactly (same target-list checkbox pattern,
 * same footer/backdrop/dialog chrome) with one addition up top: a masked
 * input for the key itself, since there is no logged-in account service here
 * to mint one. onConfirm hands the parent (App.tsx) the *trimmed* key plus
 * the checked subset of targets; the parent is the one that actually calls
 * writeCliKeyForInstalledClis (account-provisioning.ts) against the existing
 * config:save write path -- this component never touches window.xingmang
 * itself, and never logs the key (I13).
 */
export function PasteKeyDialog({
  targets,
  keysPageUrl,
  busy = false,
  onConfirm,
  onOpenKeysPage,
  onCancel,
}: {
  targets: readonly ProviderId[]
  /** Page a user can open to obtain/manage a key for the active site (relay-sites.ts's RelaySite.keysPageUrl). */
  keysPageUrl: string
  busy?: boolean
  onConfirm: (key: string, selected: ProviderId[]) => void
  onOpenKeysPage: (url: string) => void
  onCancel: () => void
}) {
  const [key, setKey] = useState('')
  const [touched, setTouched] = useState(false)
  // Default all-checked, same reasoning as ProvisioningConfirmDialog: a user
  // who changes nothing gets the key written into every installed CLI.
  const [selected, setSelected] = useState<Set<ProviderId>>(() => new Set(targets))

  const keyError = validatePastedApiKey(key)
  const selectedCount = targets.filter((provider) => selected.has(provider)).length

  const toggle = (provider: ProviderId) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (busy || keyError || selectedCount === 0) return
    onConfirm(normalizePastedApiKey(key), filterProvisioningTargets(targets, selected))
  }

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={busy ? () => undefined : onCancel}>
      <form
        className="extension-dialog compact-dialog account-dialog"
        onSubmit={submit}
        {...dialogAriaProps('paste-key-title')}
      >
        <header className="extension-dialog-head">
          <div>
            <span className="extension-dialog-icon"><KeyRound size={19} /></span>
            <div>
              <h2 id="paste-key-title">粘贴 Key</h2>
              <small>手动填入 Key，写入下方勾选的 CLI</small>
            </div>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onCancel} disabled={busy}>
            <X size={17} />
          </button>
        </header>

        <div className="extension-dialog-body">
          <label className="field extension-field">
            <span>Key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              disabled={busy}
              onChange={(event) => setKey(event.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && Boolean(keyError)}
              aria-describedby={touched && keyError ? 'paste-key-error' : undefined}
              placeholder="粘贴该站点签发的 Key"
            />
            {touched && keyError && <small id="paste-key-error" className="field-error" role="alert">{keyError}</small>}
          </label>
          <p className="account-dialog-switch">
            还没有 Key？
            <button type="button" onClick={() => onOpenKeysPage(keysPageUrl)}>去获取</button>
          </p>

          <p>检测到 {targets.length} 个已安装的 AI 工具，Key 将写入下方勾选的 CLI：</p>
          <div className="operations-list" role="list">
            {targets.map((provider) => {
              const meta = providers[provider]
              return (
                <label className="operation-row provisioning-target-row" key={provider}>
                  <div className="provider-icon" style={{ color: meta.color, backgroundColor: meta.tint }}>
                    <img src={meta.icon} alt="" aria-hidden="true" />
                  </div>
                  <span className="operation-row-copy">
                    <strong>{meta.name}</strong>
                    <p>{meta.company}</p>
                  </span>
                  <span className="setting-switch-control">
                    <input
                      type="checkbox"
                      checked={selected.has(provider)}
                      disabled={busy}
                      onChange={() => toggle(provider)}
                      aria-label={`写入 ${meta.name}`}
                    />
                    <span aria-hidden="true"><Check size={12} /></span>
                  </span>
                </label>
              )
            })}
          </div>
        </div>

        <footer className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="primary-button" type="submit" disabled={busy || Boolean(keyError) || selectedCount === 0}>
            {busy ? '写入中…' : '写入所选 CLI'}
          </button>
        </footer>
      </form>
    </DialogBackdrop>
  )
}
