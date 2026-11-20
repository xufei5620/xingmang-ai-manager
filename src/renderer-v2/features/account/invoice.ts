// 「我的订单」里直接开发票的纯逻辑：每笔订单后面出什么、开发票框里的合计和差额、开票记录的状态。
// 金额都是「分」的十进制字符串（主进程从开票系统原样带过来），这里用 BigInt 算，不转成 JS 数字。
// 界面上的字是 2026-11-20 yoyo 回「发票改」批的原字；撤回失败那句是后加的，同一天他回「撤回改」批了。
import type {
  InvoiceOrder,
  InvoiceOrdersSnapshot,
  InvoiceProfile,
  InvoiceProfileData,
  InvoiceRequest,
} from '../../../../electron/ipc-contract'
import { shortDate } from './account-center'

const minorPattern = /^-?(0|[1-9][0-9]{0,18})$/

function minorValue(minor: string): bigint {
  return minorPattern.test(minor) ? BigInt(minor) : 0n
}

/** 「¥300.00」：开票只开人民币，金额一律两位小数。 */
export function yuanText(minor: string): string {
  const value = minorValue(minor)
  const sign = value < 0n ? '-' : ''
  const absolute = value < 0n ? -value : value
  return `${sign}¥${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`
}

export function sumMinor(values: readonly string[]): string {
  return values.reduce((total, value) => total + minorValue(value), 0n).toString()
}

/** 这一笔现在能不能勾进开发票框：还有可开金额、是人民币。 */
export function isInvoiceable(order: Pick<InvoiceOrder, 'availableMinor' | 'currency'>): boolean {
  return order.currency === 'CNY' && minorValue(order.availableMinor) > 0n
}

/** 开发票框「开哪几笔」那张表：能开的，新的在上。 */
export function invoiceableOrders(snapshot: InvoiceOrdersSnapshot | null): InvoiceOrder[] {
  if (!snapshot) return []
  return snapshot.orders
    .filter(isInvoiceable)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.originRef.localeCompare(b.originRef))
}

/** 「11月16日　充值」：管理员调额、手工登记这些也是往余额里加钱，跟充值写一样。 */
export function invoiceOrderLabel(order: Pick<InvoiceOrder, 'kind' | 'occurredAt'>, now?: Date): string {
  const day = shortDate(order.occurredAt, now)
  const kind = order.kind === 'subscription' ? '订阅' : '充值'
  return day ? `${day}　${kind}` : kind
}

export function invoiceSelectionText(count: number, totalMinor: string): string {
  return `已选 ${count} 笔，合计 ${yuanText(totalMinor)}`
}

/** 不够最低金额时那句；够了或者开票系统没设最低金额时是 null。 */
export function invoiceShortfallText(totalMinor: string, minimumMinor: string): string | null {
  const minimum = minorValue(minimumMinor)
  const short = minimum - minorValue(totalMinor)
  if (minimum <= 0n || short <= 0n) return null
  return `每次至少开 ${yuanText(minimum.toString())}，还差 ${yuanText(short.toString())}，可以再勾几笔。`
}

/**
 * 「我的订单」每笔后面出什么：还有能开的出「开发票」；正在申请里的写「开票中」；开好了、而且在
 * 最近的开票记录里找得到那张发票的出「下载发票」；别的（没到账、外币、开票系统里没有这笔）什么都不出。
 * 只认对得上这一行订单编号的那笔（kind 是 topup）：星芒账号「开通订阅」那几行跟开票系统的订阅单不是一套编号。
 */
export type InvoiceRowAction =
  | { kind: 'apply'; order: InvoiceOrder }
  | { kind: 'pending' }
  | { kind: 'download'; requestId: string }

export function invoiceRowAction(
  accountOrderId: number,
  snapshot: InvoiceOrdersSnapshot | null,
  requests: readonly InvoiceRequest[],
): InvoiceRowAction | null {
  const order = snapshot?.orders.find((entry) => entry.kind === 'topup' && entry.accountOrderId === accountOrderId)
  if (!order) return null
  if (isInvoiceable(order)) return { kind: 'apply', order }
  if (minorValue(order.heldMinor) > 0n) return { kind: 'pending' }
  if (minorValue(order.issuedMinor) <= 0n) return null
  const issued = requests.find((request) => request.status === 'issued'
    && request.lines.some((line) => line.originRef === order.originRef && !line.excluded))
  return issued ? { kind: 'download', requestId: issued.requestId } : null
}

export const invoiceRequestStates: Readonly<Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'accent' | 'neutral' }>> = {
  pending_review: { label: '待审核', tone: 'warn' },
  approved: { label: '待开具', tone: 'accent' },
  needs_changes: { label: '待修改', tone: 'warn' },
  rejected: { label: '已驳回', tone: 'bad' },
  withdrawn: { label: '已撤回', tone: 'neutral' },
  issued: { label: '已开具', tone: 'ok' },
  voided: { label: '已作废', tone: 'neutral' },
  credit_noted: { label: '已红冲', tone: 'neutral' },
}

/** 开票系统以后加的状态不把英文放上去，写「待确认」（跟订单、订阅的状态一个做法）。 */
export function invoiceRequestState(status: string): { label: string; tone: 'ok' | 'warn' | 'bad' | 'accent' | 'neutral' } {
  return Object.hasOwn(invoiceRequestStates, status) ? invoiceRequestStates[status] : { label: '待确认', tone: 'neutral' }
}

/** 开票系统只许撤回还没开出来的：待审核、待开具。 */
export function canWithdrawInvoice(request: Pick<InvoiceRequest, 'status'>): boolean {
  return request.status === 'pending_review' || request.status === 'approved'
}

/** 「财务说明：……」只在退回、驳回时出，财务没写就不出。 */
export function invoiceReviewNote(request: Pick<InvoiceRequest, 'status' | 'reason'>): string | null {
  if (request.status !== 'needs_changes' && request.status !== 'rejected') return null
  const reason = request.reason.trim()
  return reason ? `财务说明：${reason}` : null
}

export function invoiceNumberSuffix(request: Pick<InvoiceRequest, 'invoiceNumber'>): string {
  return request.invoiceNumber ? `，发票号码 ${request.invoiceNumber}` : ''
}

/** 抬头下拉里一项：「杭州某某科技有限公司（单位）」。 */
export function invoiceProfileLabel(profile: InvoiceProfile): string {
  return `${profile.data.title}（${profile.data.kind === 'business' ? '单位' : '个人'}）`
}

export const newInvoiceProfile = 'new'

/** 抬头下拉默认选哪个：有抬头就选第一个，没有就是新建。 */
export function defaultInvoiceProfileChoice(profiles: readonly InvoiceProfile[]): string {
  return profiles[0]?.profileId ?? newInvoiceProfile
}

export interface InvoiceProfileDraft {
  kind: 'personal' | 'business'
  title: string
  taxId: string
  email: string
  address: string
  phone: string
  bankName: string
  bankAccount: string
}

export const emptyInvoiceProfileDraft: InvoiceProfileDraft = {
  kind: 'business', title: '', taxId: '', email: '', address: '', phone: '', bankName: '', bankAccount: '',
}

/**
 * 新建抬头填够了没有：抬头名称、接收邮箱必填，单位还要税号。格式对不对由开票系统判，
 * 它回的原因照原话显示；这里只管空着的时候「提交申请」点不了。
 */
export function invoiceProfileDraftComplete(draft: InvoiceProfileDraft): boolean {
  return Boolean(draft.title.trim() && draft.email.trim() && (draft.kind === 'personal' || draft.taxId.trim()))
}

export function buildInvoiceProfileData(draft: InvoiceProfileDraft): InvoiceProfileData {
  const optional = (value: string) => value.trim() || undefined
  const data: InvoiceProfileData = { kind: draft.kind, title: draft.title.trim(), taxId: draft.taxId.trim(), email: draft.email.trim() }
  const address = optional(draft.address)
  const phone = optional(draft.phone)
  const bankName = optional(draft.bankName)
  const bankAccount = optional(draft.bankAccount)
  return { ...data, ...(address ? { address } : {}), ...(phone ? { phone } : {}), ...(bankName ? { bankName } : {}), ...(bankAccount ? { bankAccount } : {}) }
}

/**
 * 幂等键：同样的内容没拿到确定结果再点一次，用的还是上一次那个键，开票系统就不会重复建；
 * 内容改了（勾的订单、抬头变了）才换一个新的。
 */
export interface IdempotencyKeyMemo {
  signature: string
  key: string
}

export function rememberIdempotencyKey(previous: IdempotencyKeyMemo | null, signature: string, create: () => string): IdempotencyKeyMemo {
  return previous?.signature === signature ? previous : { signature, key: create() }
}

export const invoiceSubmittedText = '已提交开票申请，财务审核后开具。'
export const invoiceSubmitFailed = '没提交成功，请稍后再试；还不行请找客服。'
// 撤回失败那句是照「没提交成功」那句的样子新写的，2026-11-20 yoyo 回「撤回改」。
export const invoiceWithdrawFailed = '没撤回成功，请稍后再试；还不行请找客服。'
export const invoiceFootnote = '只开人民币普通发票。财务审核后开具，开好以后在「开票记录」里下载。'
export const invoiceMoreFieldsLabel = '更多（选填）：地址、电话、开户银行、银行账号'
