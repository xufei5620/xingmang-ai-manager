import { useState, type FormEvent } from 'react'
import { KeyRound, Pencil, X } from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../Dialog'
import type { AccountKey, AccountKeyCreateInput } from '../../types'

/**
 * Shared create/edit form for the 个人中心 Key 管理 tab (老板需求
 * 2026-08-10). Submits wire-level values (quota units / Unix seconds); the
 * USD-to-quota conversion happens here because this is where the user types
 * dollars, using the same quotaPerUnit the balance display already trusts.
 * When quotaPerUnit is unusable (undefined/0 -- balance probe failed), the
 * custom-quota option is disabled rather than risking a wrong conversion:
 * 无限额度 remains available either way.
 *
 * Edit submits the same shape plus keeps the caller responsible for the id;
 * the read-modify-write that preserves untouched server fields
 * (model_limits/group/...) lives in electron/new-api-client.ts's updateKey,
 * not here.
 */
export function KeyEditorDialog({
  mode,
  initial,
  quotaPerUnit,
  onClose,
  onSubmit,
  isSubmitting = false,
}: {
  mode: 'create' | 'edit'
  /** Present only in edit mode: the row being edited, straight from the list DTO. */
  initial?: AccountKey
  quotaPerUnit: number | undefined
  onClose: () => void
  onSubmit: (values: AccountKeyCreateInput) => void
  isSubmitting?: boolean
}) {
  const usableQuotaPerUnit = typeof quotaPerUnit === 'number' && Number.isFinite(quotaPerUnit) && quotaPerUnit > 0
    ? quotaPerUnit
    : null
  const [name, setName] = useState(initial?.name ?? '')
  const [unlimitedQuota, setUnlimitedQuota] = useState(initial?.unlimitedQuota ?? true)
  const [quotaUsd, setQuotaUsd] = useState(() => (
    initial && !initial.unlimitedQuota && usableQuotaPerUnit
      ? String(Math.round((initial.remainQuota / usableQuotaPerUnit) * 100) / 100)
      : ''
  ))
  // yyyy-MM-dd for <input type="date">; empty = 永不过期 (wire sentinel -1).
  const [expiryDate, setExpiryDate] = useState(() => (
    initial?.expiredAt ? initial.expiredAt.slice(0, 10) : ''
  ))
  const [errors, setErrors] = useState<{ name?: string; quota?: string; expiry?: string }>({})

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (isSubmitting) return
    const nextErrors: { name?: string; quota?: string; expiry?: string } = {}
    const trimmedName = name.trim()
    if (!trimmedName) nextErrors.name = '请输入 Key 名称'
    else if (trimmedName.length > 50) nextErrors.name = 'Key 名称不能超过 50 个字符'

    let remainQuota = 0
    if (!unlimitedQuota) {
      const dollars = Number(quotaUsd)
      if (!usableQuotaPerUnit) {
        nextErrors.quota = '余额换算比例未就绪，暂时只能选择无限额度'
      } else if (!quotaUsd.trim() || !Number.isFinite(dollars) || dollars <= 0) {
        nextErrors.quota = '请输入大于 0 的额度金额（美元）'
      } else {
        remainQuota = Math.round(dollars * usableQuotaPerUnit)
      }
    }

    let expiredTime = -1
    if (expiryDate) {
      const expiresAt = new Date(`${expiryDate}T23:59:59`)
      if (Number.isNaN(expiresAt.getTime())) {
        nextErrors.expiry = '过期日期格式错误'
      } else if (expiresAt.getTime() <= Date.now()) {
        nextErrors.expiry = '过期时间需晚于当前时间'
      } else {
        expiredTime = Math.floor(expiresAt.getTime() / 1000)
      }
    }

    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return
    onSubmit({ name: trimmedName, remainQuota, unlimitedQuota, expiredTime })
  }

  const title = mode === 'create' ? '添加 Key' : `编辑 Key「${initial?.name ?? ''}」`
  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={onClose}>
      <form
        className="extension-dialog compact-dialog account-dialog"
        onSubmit={submit}
        {...dialogAriaProps('key-editor-dialog-title')}
      >
        <header className="extension-dialog-head">
          <div>
            <span className="extension-dialog-icon">
              {mode === 'create' ? <KeyRound size={19} /> : <Pencil size={19} />}
            </span>
            <div>
              <h2 id="key-editor-dialog-title">{title}</h2>
              <small>{mode === 'create' ? '在星芒账号下创建一个新的 API Key' : '修改名称、额度或过期时间'}</small>
            </div>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="extension-dialog-body">
          <label className="field extension-field">
            <span>名称</span>
            <input
              value={name}
              onChange={(event) => { setName(event.target.value); setErrors((current) => ({ ...current, name: undefined })) }}
              placeholder="例如 my-api-key"
              maxLength={50}
            />
            {errors.name && <small className="field-error" role="alert">{errors.name}</small>}
          </label>

          <label className="account-agreement">
            <input
              type="checkbox"
              checked={unlimitedQuota}
              onChange={(event) => { setUnlimitedQuota(event.target.checked); setErrors((current) => ({ ...current, quota: undefined })) }}
            />
            <span>无限额度（消耗账户余额，不设单独上限）</span>
          </label>

          {!unlimitedQuota && (
            <label className="field extension-field">
              <span>额度（美元）</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={quotaUsd}
                onChange={(event) => { setQuotaUsd(event.target.value); setErrors((current) => ({ ...current, quota: undefined })) }}
                placeholder="例如 10"
                disabled={!usableQuotaPerUnit}
              />
              {errors.quota && <small className="field-error" role="alert">{errors.quota}</small>}
            </label>
          )}

          <label className="field extension-field">
            <span>过期时间（留空 = 永不过期）</span>
            <input
              type="date"
              value={expiryDate}
              onChange={(event) => { setExpiryDate(event.target.value); setErrors((current) => ({ ...current, expiry: undefined })) }}
            />
            {errors.expiry && <small className="field-error" role="alert">{errors.expiry}</small>}
          </label>
        </div>

        <footer className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? (mode === 'create' ? '创建中…' : '保存中…') : (mode === 'create' ? '创建' : '保存')}
          </button>
        </footer>
      </form>
    </DialogBackdrop>
  )
}
