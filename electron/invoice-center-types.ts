// 「我的订单」里直接开发票：主进程交给界面的开票数据（invoice-center-client.ts 校验过、换成驼峰的那份）。
// 只有类型，零依赖：主窗口的通道契约 ipc-contract.ts 用 import type 引它，界面从契约那边拿。
// 金额一律是「分」的十进制整数字符串，跟开票系统一样，不换成 JS 数字（大额会丢精度）。

/** 一笔开票系统认得的订单。 */
export interface InvoiceOrder {
  /** 开票系统的订单编号（origin_ref），原样带回去提交。 */
  originRef: string
  /** 充值、订阅，或者对不上「我的订单」的那几种（管理员调额、手工登记）。 */
  kind: 'topup' | 'subscription' | 'other'
  /** 对得上「我的订单」那一行时是那一行的订单编号；对不上是 null。 */
  accountOrderId: number | null
  availableMinor: string
  heldMinor: string
  issuedMinor: string
  currency: string
  /** 到账时间（ISO）。 */
  occurredAt: string
}

export interface InvoiceOrdersSnapshot {
  orders: InvoiceOrder[]
  /** 每次至少开多少（分），开票系统后台设的。 */
  minimumRequestMinor: string
}

export type InvoiceProfileKind = 'personal' | 'business'

export interface InvoiceProfileData {
  kind: InvoiceProfileKind
  title: string
  taxId: string
  email: string
  address?: string
  phone?: string
  bankName?: string
  bankAccount?: string
}

export interface InvoiceProfile {
  profileId: string
  data: InvoiceProfileData
}

export type InvoiceRequestStatus =
  | 'pending_review'
  | 'approved'
  | 'needs_changes'
  | 'rejected'
  | 'withdrawn'
  | 'issued'
  | 'voided'
  | 'credit_noted'

export interface InvoiceRequestLine {
  originRef: string
  amountMinor: string
  /** 审核时这一笔被单独去掉了，不开票。 */
  excluded: boolean
}

export interface InvoiceRequest {
  requestId: string
  /** 认不出的状态（开票系统以后加的）原样带着，界面按「待核对」处理。 */
  status: InvoiceRequestStatus | string
  /** 撤回时要带回去的版本号。 */
  revision: number
  amountMinor: string
  currency: string
  title: string
  createdAt: string
  /** 财务退回、驳回时写给客户看的说明；没有是空串。 */
  reason: string
  invoiceNumber: string | null
  lines: InvoiceRequestLine[]
}

export interface InvoiceRequestsPage {
  requests: InvoiceRequest[]
  nextCursor: string | null
}

export interface InvoiceRequestsQuery {
  cursor?: string
}

/** 新建一个抬头。幂等键由界面生成（UUID）：同一次提交没拿到确定结果时，重试用的还是它。 */
export interface InvoiceProfileSaveInput {
  idempotencyKey: string
  profile: InvoiceProfileData
}

export interface InvoiceSubmitInput {
  idempotencyKey: string
  profileId: string
  /** 和 amountsMinor 一一对应；每一笔都得等于那笔订单现在的可开金额，开票系统不收部分金额。 */
  originRefs: string[]
  amountsMinor: string[]
}

export interface InvoiceWithdrawInput {
  idempotencyKey: string
  requestId: string
  expectedRevision: number
}

export interface InvoiceDocumentSaveResult {
  saved: boolean
}
