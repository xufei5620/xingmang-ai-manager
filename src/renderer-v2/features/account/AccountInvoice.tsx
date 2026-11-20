// 「我的订单」里直接开发票（2026-11-20 yoyo 定的「免登录」）：每笔订单后面的「开发票 / 开票中 / 下载发票」、
// 「开发票」框和「开票记录」框。开票系统是哪个、以谁的身份去，都由主进程按当前登录定（electron/invoice-center-client.ts），
// 这里只给订单编号、金额、抬头内容这些客户本来就要填的东西；发票文件由主进程问客户存哪、直接写盘，不经过这里。
import { useCallback, useEffect, useRef, useState } from 'react'
import { HelpCircle, ReceiptText } from 'lucide-react'
import { Button, Confirm, Dialog, Empty, Input, Pill, Segment, Select } from '../../ui'
import { ClockTime, errorMessage, FailureReason, ListReadFailure, PlaceholderBar, useResource } from '../../business-common'
import { useLatestRequest } from '../../latest-request'
import type { V2Bridge } from '../../types'
import type { InvoiceOrder, InvoiceOrdersSnapshot, InvoiceProfile, InvoiceRequest } from '../../../../electron/ipc-contract'
import {
  buildInvoiceProfileData,
  canWithdrawInvoice,
  defaultInvoiceProfileChoice,
  emptyInvoiceProfileDraft,
  invoiceableOrders,
  invoiceFootnote,
  invoiceMoreFieldsLabel,
  invoiceNumberSuffix,
  invoiceOrderLabel,
  invoiceProfileDraftComplete,
  invoiceProfileLabel,
  invoiceRequestState,
  invoiceReviewNote,
  invoiceSelectionText,
  invoiceShortfallText,
  invoiceSubmitFailed,
  invoiceWithdrawFailed,
  newInvoiceProfile,
  rememberIdempotencyKey,
  sumMinor,
  yuanText,
  type IdempotencyKeyMemo,
  type InvoiceProfileDraft,
  type InvoiceRowAction,
} from './invoice'

function createIdempotencyKey(): string {
  return crypto.randomUUID()
}

interface InvoiceFailureState {
  text: string
  /** 开票系统没给原因、落到兜底那句时才出「联系客服」。 */
  support: boolean
}

/** 开票系统给了原因照原话说（主进程只放行一行、不太长的中文），没给就说兜底那句。 */
function invoiceFailure(error: unknown, fallback: string): InvoiceFailureState {
  const text = errorMessage(error, fallback)
  return { text, support: text === fallback }
}

function InvoiceFailure({ failure, onSupport, testId }: { failure: InvoiceFailureState | null; onSupport?: () => void; testId: string }) {
  if (!failure) return null
  return (
    <div className="v2-business-notice is-error" role="alert" data-testid={testId}>
      <Pill tone="bad">未完成</Pill>
      <span>{failure.text}</span>
      {failure.support && onSupport && (
        <Button size="sm" icon={HelpCircle} onClick={onSupport} testId={`${testId}-support`}>联系客服</Button>
      )}
    </div>
  )
}

/**
 * 「我的订单」要的开票数据：哪些订单能开、开了多少，和最近一页开票记录（找「下载发票」那张）。
 * 读不到不在订单页报错：订单照常列着，只是后面不出开票的按钮；「开票记录」框里会说读不到。
 */
export function useInvoiceOverview(api: V2Bridge, enabled: boolean) {
  const latest = useLatestRequest()
  const [snapshot, setSnapshot] = useState<InvoiceOrdersSnapshot | null>(null)
  const [requests, setRequests] = useState<InvoiceRequest[]>([])
  const reload = useCallback(async () => {
    if (!enabled) {
      latest.invalidate()
      setSnapshot(null)
      setRequests([])
      return
    }
    const current = latest.begin()
    const [orders, page] = await Promise.allSettled([api.getAccountInvoiceOrders(), api.getAccountInvoiceRequests()])
    if (!current()) return
    setSnapshot(orders.status === 'fulfilled' ? orders.value : null)
    setRequests(page.status === 'fulfilled' ? page.value.requests : [])
  }, [api, enabled, latest])
  useEffect(() => {
    void reload()
  }, [reload])
  return { snapshot, requests, reload }
}

/** 「下载发票」：保存框和保存失败的提示框都由主进程弹，这里只管按钮转圈、一次只下一张。 */
export function useInvoiceDownload(api: V2Bridge) {
  const [downloading, setDownloading] = useState<string | null>(null)
  const busy = useRef(false)
  const download = useCallback(async (requestId: string) => {
    if (busy.current) return
    busy.current = true
    setDownloading(requestId)
    try {
      await api.saveAccountInvoiceDocument(requestId)
    } catch {
      // 取文件、存文件哪一步没成，主进程都已经弹过「发票没保存下来」；走到这里的只有通道本身被拒，界面不再多说。
    } finally {
      busy.current = false
      setDownloading(null)
    }
  }, [api])
  return { downloading, download }
}

/** 每笔订单后面那一格。 */
export function InvoiceRowControl({
  action,
  orderId,
  disabled,
  downloading,
  onApply,
  onDownload,
}: {
  action: InvoiceRowAction | null
  orderId: number
  disabled?: boolean
  downloading: string | null
  onApply: (order: InvoiceOrder) => void
  onDownload: (requestId: string) => void
}) {
  if (!action) return null
  if (action.kind === 'apply') {
    return (
      <Button size="sm" disabled={disabled} onClick={() => onApply(action.order)} testId={`account-order-invoice-${orderId}`}>
        开发票
      </Button>
    )
  }
  if (action.kind === 'pending') {
    return <span className="v2-invoice-pending" data-testid={`account-order-invoice-pending-${orderId}`}>开票中</span>
  }
  return (
    <Button
      size="sm"
      loading={downloading === action.requestId}
      disabled={disabled || Boolean(downloading)}
      onClick={() => onDownload(action.requestId)}
      testId={`account-order-invoice-download-${orderId}`}
    >
      下载发票
    </Button>
  )
}

const profileKinds = [
  { value: 'personal', label: '个人' },
  { value: 'business', label: '单位' },
]
// 跟开票系统一样，每一项最多 320 个字（electron/ipc/parsers/account-invoice.ts）。
const profileFieldMaxLength = 320

function ProfileDraftFields({ draft, disabled, onChange }: { draft: InvoiceProfileDraft; disabled: boolean; onChange: (draft: InvoiceProfileDraft) => void }) {
  const [more, setMore] = useState(false)
  const field = (key: Exclude<keyof InvoiceProfileDraft, 'kind'>) => ({
    value: draft[key],
    disabled,
    maxLength: profileFieldMaxLength,
    autoComplete: 'off',
    onChange: (event: { target: { value: string } }) => onChange({ ...draft, [key]: event.target.value }),
  })
  return (
    <div className="v2-invoice-fields">
      <Segment
        label="类型"
        options={profileKinds}
        value={draft.kind}
        onChange={(kind) => onChange({ ...draft, kind: kind === 'personal' ? 'personal' : 'business' })}
        testId="account-invoice-profile-kind"
      />
      <Input label="抬头名称" placeholder="单位填公司全称" {...field('title')} testId="account-invoice-profile-title" />
      <Input label="税号" placeholder="单位必填" {...field('taxId')} testId="account-invoice-profile-tax-id" />
      <Input label="接收邮箱" type="email" {...field('email')} testId="account-invoice-profile-email" />
      {more ? (
        <>
          <Input label="地址" {...field('address')} testId="account-invoice-profile-address" />
          <Input label="电话" {...field('phone')} testId="account-invoice-profile-phone" />
          <Input label="开户银行" {...field('bankName')} testId="account-invoice-profile-bank-name" />
          <Input label="银行账号" {...field('bankAccount')} testId="account-invoice-profile-bank-account" />
        </>
      ) : (
        <button
          type="button"
          className="v2-acct-more v2-invoice-more"
          aria-expanded={false}
          disabled={disabled}
          onClick={() => setMore(true)}
          data-testid="account-invoice-profile-more"
        >
          {invoiceMoreFieldsLabel}
        </button>
      )}
    </div>
  )
}

/**
 * 「开发票」框：从哪一笔点进来，就先勾上那一笔；能开的都列着，可以再勾几笔凑够最低金额。
 * 抬头选已有的，或者当场新建一个（先建抬头、再提交申请）。两步都带幂等键：没拿到确定结果再点一次，
 * 开票系统认得是同一次，不会多建一个抬头、多提一份申请。
 */
export function InvoiceApplyDialog({
  api,
  snapshot,
  initialOriginRef,
  onClose,
  onSubmitted,
  onSupport,
}: {
  api: V2Bridge
  snapshot: InvoiceOrdersSnapshot | null
  initialOriginRef: string
  onClose: () => void
  onSubmitted: () => void
  /** 「联系客服」：先关掉这个框再去帮助页。缺省 = 不出这个按钮。 */
  onSupport?: () => void
}) {
  const latest = useLatestRequest()
  const orders = invoiceableOrders(snapshot)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set([initialOriginRef]))
  const [profiles, setProfiles] = useState<InvoiceProfile[] | null>(null)
  const [profileChoice, setProfileChoice] = useState('')
  const [draft, setDraft] = useState<InvoiceProfileDraft>(emptyInvoiceProfileDraft)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<InvoiceFailureState | null>(null)
  const profileKey = useRef<IdempotencyKeyMemo | null>(null)
  const submitKey = useRef<IdempotencyKeyMemo | null>(null)

  useEffect(() => {
    let current = true
    // 抬头读不到时当作还没有抬头：客户照样能当场新建一个，不卡在这一步。
    api.getAccountInvoiceProfiles().then((list) => {
      if (!current) return
      setProfiles(list)
      setProfileChoice(defaultInvoiceProfileChoice(list))
    }, () => {
      if (!current) return
      setProfiles([])
      setProfileChoice(newInvoiceProfile)
    })
    return () => {
      current = false
    }
  }, [api])

  const chosen = orders.filter((order) => selected.has(order.originRef))
  const total = sumMinor(chosen.map((order) => order.availableMinor))
  const shortfall = invoiceShortfallText(total, snapshot?.minimumRequestMinor ?? '0')
  const creating = profileChoice === newInvoiceProfile
  const ready = chosen.length > 0 && !shortfall && profiles !== null && Boolean(profileChoice)
    && (!creating || invoiceProfileDraftComplete(draft))

  function toggle(originRef: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (checked) next.add(originRef)
      else next.delete(originRef)
      return next
    })
  }

  async function submit() {
    if (busy || !ready) return
    const current = latest.begin()
    setBusy(true)
    setFailure(null)
    try {
      let profileId = profileChoice
      if (creating) {
        const profile = buildInvoiceProfileData(draft)
        profileKey.current = rememberIdempotencyKey(profileKey.current, JSON.stringify(profile), createIdempotencyKey)
        const saved = await api.saveAccountInvoiceProfile({ idempotencyKey: profileKey.current.key, profile })
        if (!current()) return
        // 抬头建好了就换成选中它：申请这一步没成再点一次，不会又建一个一样的抬头。
        profileKey.current = null
        profileId = saved.profileId
        setProfiles((list) => [saved, ...(list ?? []).filter((entry) => entry.profileId !== saved.profileId)])
        setProfileChoice(saved.profileId)
        setDraft(emptyInvoiceProfileDraft)
      }
      const input = {
        profileId,
        originRefs: chosen.map((order) => order.originRef),
        // 开票系统不收部分金额：每一笔都按它现在的可开金额整笔开。
        amountsMinor: chosen.map((order) => order.availableMinor),
      }
      submitKey.current = rememberIdempotencyKey(submitKey.current, JSON.stringify(input), createIdempotencyKey)
      await api.submitAccountInvoiceRequest({ idempotencyKey: submitKey.current.key, ...input })
      if (!current()) return
      submitKey.current = null
      onSubmitted()
    } catch (error) {
      if (current()) setFailure(invoiceFailure(error, invoiceSubmitFailed))
    } finally {
      if (current()) setBusy(false)
    }
  }

  const profileOptions = [
    ...(profiles ?? []).map((profile) => ({ value: profile.profileId, label: invoiceProfileLabel(profile) })),
    { value: newInvoiceProfile, label: '新建抬头' },
  ]

  return (
    <Dialog
      open
      width={640}
      title="开发票"
      onClose={onClose}
      busy={busy}
      testId="account-invoice-apply"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void submit()} testId="account-invoice-apply-submit">
            提交申请
          </Button>
        </>
      }
    >
      <div className="v2-invoice-body">
        <div className="v2-invoice-section">
          <strong className="v2-invoice-heading">开哪几笔</strong>
          <div className="v2-invoice-list">
            {orders.map((order) => (
              <label className="v2-invoice-order" key={order.originRef}>
                <input
                  type="checkbox"
                  checked={selected.has(order.originRef)}
                  disabled={busy}
                  onChange={(event) => toggle(order.originRef, event.target.checked)}
                />
                <span>{invoiceOrderLabel(order)}</span>
                <b>{yuanText(order.availableMinor)}</b>
              </label>
            ))}
          </div>
          <p className="v2-invoice-total" data-testid="account-invoice-apply-total">{invoiceSelectionText(chosen.length, total)}</p>
          {shortfall && <p className="v2-invoice-shortfall" data-testid="account-invoice-apply-shortfall">{shortfall}</p>}
        </div>
        <div className="v2-invoice-section">
          <strong className="v2-invoice-heading">发票抬头</strong>
          {profiles === null ? (
            <PlaceholderBar width="60%" />
          ) : (
            <>
              {profiles.length > 0 && (
                <Select
                  label="选一个抬头"
                  options={profileOptions}
                  value={profileChoice}
                  disabled={busy}
                  onChange={(event) => setProfileChoice(event.target.value)}
                  testId="account-invoice-profile"
                />
              )}
              {creating && <ProfileDraftFields draft={draft} disabled={busy} onChange={setDraft} />}
            </>
          )}
        </div>
        <p className="v2-invoice-footnote">{invoiceFootnote}</p>
        <InvoiceFailure
          failure={failure}
          onSupport={onSupport && (() => {
            onClose()
            onSupport()
          })}
          testId="account-invoice-apply-failure"
        />
      </div>
    </Dialog>
  )
}

/**
 * 「开票记录」框：最近一页申请（开票系统一页 100 条），开好的可以下载，还没开出来的可以撤回。
 * 撤回带着读到时的版本号：财务那边刚好动过，开票系统会拒，重读一遍看到的就是新状态。
 */
export function InvoiceRecordsDialog({
  api,
  downloading,
  onDownload,
  onChanged,
  onClose,
  onSupport,
}: {
  api: V2Bridge
  downloading: string | null
  onDownload: (requestId: string) => void
  /** 撤回成功以后，「我的订单」那边跟着重读（订单又能开了）。 */
  onChanged: () => void
  onClose: () => void
  onSupport?: () => void
}) {
  const load = useCallback(() => api.getAccountInvoiceRequests(), [api])
  const resource = useResource(load)
  const latest = useLatestRequest()
  const [withdrawing, setWithdrawing] = useState<InvoiceRequest | null>(null)
  const [withdrawBusy, setWithdrawBusy] = useState(false)
  const [failure, setFailure] = useState<InvoiceFailureState | null>(null)
  const withdrawKey = useRef<IdempotencyKeyMemo | null>(null)
  const requests = resource.data?.requests ?? []
  const failed = Boolean(resource.error) && !resource.loading

  async function withdraw() {
    const request = withdrawing
    if (!request || withdrawBusy) return
    const current = latest.begin()
    setWithdrawBusy(true)
    setFailure(null)
    const input = { requestId: request.requestId, expectedRevision: request.revision }
    withdrawKey.current = rememberIdempotencyKey(withdrawKey.current, JSON.stringify(input), createIdempotencyKey)
    try {
      await api.withdrawAccountInvoiceRequest({ idempotencyKey: withdrawKey.current.key, ...input })
      if (!current()) return
      withdrawKey.current = null
      onChanged()
    } catch (error) {
      if (current()) setFailure(invoiceFailure(error, invoiceWithdrawFailed))
    } finally {
      if (current()) {
        setWithdrawBusy(false)
        setWithdrawing(null)
        void resource.reload()
      }
    }
  }

  return (
    <>
      <Dialog
        open
        width={640}
        title="开票记录"
        onClose={onClose}
        testId="account-invoice-records"
        footer={<Button onClick={onClose}>关闭</Button>}
      >
        <InvoiceFailure
          failure={failure}
          onSupport={onSupport && (() => {
            onClose()
            onSupport()
          })}
          testId="account-invoice-records-failure"
        />
        {failed ? (
          <ListReadFailure
            page="account-invoice-records"
            noun="开票记录"
            description={<FailureReason error={resource.error} detail={resource.detail} />}
            retry={() => void resource.reload()}
          />
        ) : requests.length ? (
          <div className="v2-invoice-list" role="list" aria-label="开票记录">
            {requests.map((request) => {
              const state = invoiceRequestState(request.status)
              const note = invoiceReviewNote(request)
              return (
                <div className="v2-invoice-record" role="listitem" key={request.requestId} data-testid={`account-invoice-record-${request.requestId}`}>
                  <div className="v2-invoice-record-copy">
                    <strong>{request.title}　{yuanText(request.amountMinor)}</strong>
                    <p><ClockTime value={request.createdAt} /> 申请{invoiceNumberSuffix(request)}</p>
                    {note && <p>{note}</p>}
                  </div>
                  <Pill tone={state.tone}>{state.label}</Pill>
                  {request.status === 'issued' && (
                    <Button
                      size="sm"
                      loading={downloading === request.requestId}
                      disabled={Boolean(downloading)}
                      onClick={() => onDownload(request.requestId)}
                    >
                      下载发票
                    </Button>
                  )}
                  {canWithdrawInvoice(request) && (
                    <Button size="sm" variant="ghost" disabled={withdrawBusy} onClick={() => setWithdrawing(request)}>
                      撤回
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        ) : resource.loading ? (
          <div className="v2-invoice-loading"><PlaceholderBar width="70%" /><PlaceholderBar width="45%" /></div>
        ) : (
          <Empty icon={ReceiptText} title="还没有开过发票" description="" />
        )}
      </Dialog>
      <Confirm
        open={Boolean(withdrawing)}
        title="撤回这次开票申请？"
        body="撤回后这些订单可以重新申请。"
        okLabel="撤回"
        cancelLabel="不撤回"
        danger
        loading={withdrawBusy}
        onOk={() => void withdraw()}
        onClose={() => setWithdrawing(null)}
        testId="account-invoice-withdraw-confirm"
      />
    </>
  )
}
