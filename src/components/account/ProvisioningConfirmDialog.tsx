import { useState, type FormEvent } from 'react'
import { Check, KeyRound, X } from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../Dialog'
import { filterProvisioningTargets } from '../../account-provisioning'
import { providers } from '../../provider-meta'
import type { ProviderId } from '../../types'

/**
 * Shown right after a successful login/register whenever
 * buildProvisioningTargets(snapshot) finds at least one already-installed
 * CLI (see App.tsx's offerCliProvisioning). Replaces the old silent
 * "write the fresh 星芒 Key into every installed CLI" behavior with an
 * explicit, per-session confirmation: every installed CLI starts checked
 * (same net effect as before for a user who changes nothing), but the user
 * can untick any of them -- e.g. Grok -- before the write happens.
 *
 * This never *permanently* excludes a CLI: nothing here is persisted, so the
 * next login/register re-offers every installed CLI checked again, keeping
 * the product's "一个账号四家通用" intent intact. The actual write
 * (provisionCliKeyForInstalledClis, I3/I9) is unchanged -- this dialog only
 * narrows the provider list handed to it.
 */
export function ProvisioningConfirmDialog({
  targets,
  busy = false,
  onConfirm,
  onSkip,
}: {
  targets: readonly ProviderId[]
  busy?: boolean
  onConfirm: (selected: ProviderId[]) => void
  onSkip: () => void
}) {
  // Default all-checked: seeded once from the targets this dialog opened
  // with, matching the previous silent-write-to-everyone behavior when the
  // user changes nothing.
  const [selected, setSelected] = useState<Set<ProviderId>>(() => new Set(targets))

  const toggle = (provider: ProviderId) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  const selectedCount = targets.filter((provider) => selected.has(provider)).length

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || selectedCount === 0) return
    onConfirm(filterProvisioningTargets(targets, selected))
  }

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={busy ? () => undefined : onSkip}>
      <form
        className="extension-dialog compact-dialog account-dialog"
        onSubmit={submit}
        {...dialogAriaProps('provisioning-confirm-title')}
      >
        <header className="extension-dialog-head">
          <div>
            <span className="extension-dialog-icon"><KeyRound size={19} /></span>
            <div>
              <h2 id="provisioning-confirm-title">写入星芒 Key</h2>
              <small>选择需要自动配置的 CLI，可随时取消勾选</small>
            </div>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onSkip} disabled={busy}>
            <X size={17} />
          </button>
        </header>

        <div className="extension-dialog-body">
          <p>检测到 {targets.length} 个已安装的 AI 工具，星芒 Key 将写入下方勾选的 CLI：</p>
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
          <button className="secondary-button" type="button" onClick={onSkip} disabled={busy}>跳过</button>
          <button className="primary-button" type="submit" disabled={busy || selectedCount === 0}>
            {busy ? '写入中…' : '写入所选 CLI'}
          </button>
        </footer>
      </form>
    </DialogBackdrop>
  )
}
