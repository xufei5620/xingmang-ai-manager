// 「我的订单」里开发票那几条通道的入参（I5）。客户是谁、哪个站、币种都由主进程定，这里一样不收；
// 只收抬头内容、订单编号和金额、申请编号这些开票系统本来就让客户填的东西，限长、拒绝控制字符和未知字段。
// 金额对不对、够不够最低、订单能不能开，由开票系统判，这里只管形状。
import { isRecord } from '../../input-guards'
import type {
  InvoiceProfileData,
  InvoiceProfileSaveInput,
  InvoiceRequestsQuery,
  InvoiceSubmitInput,
  InvoiceWithdrawInput,
} from '../../invoice-center-types'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// 开票系统那边每一项最多 320 个字、不许换行和 NUL（ProfileData.Validate）。
const profileFieldMaximum = 320
// 一次申请最多勾多少笔：开票系统没限，订单列表也不分页，这里只拦明显不对的数量。
const submitMaximumOrders = 500

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label}包含未知字段`)
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error(`${label}格式错误`)
  return value.toLowerCase()
}

function profileField(value: unknown, label: string, required: boolean): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || [...value].length > profileFieldMaximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label}格式错误`)
  }
  const trimmed = value.trim()
  if (required && !trimmed) throw new Error(`${label}格式错误`)
  return trimmed
}

function parseProfileData(value: unknown): InvoiceProfileData {
  if (!isRecord(value)) throw new Error('发票抬头格式错误')
  assertKnownKeys(value, ['kind', 'title', 'taxId', 'email', 'address', 'phone', 'bankName', 'bankAccount'], '发票抬头')
  if (value.kind !== 'personal' && value.kind !== 'business') throw new Error('抬头类型格式错误')
  const taxId = profileField(value.taxId, '税号', value.kind === 'business')
  const address = profileField(value.address, '地址', false)
  const phone = profileField(value.phone, '电话', false)
  const bankName = profileField(value.bankName, '开户银行', false)
  const bankAccount = profileField(value.bankAccount, '银行账号', false)
  return {
    kind: value.kind,
    title: profileField(value.title, '抬头名称', true),
    taxId,
    email: profileField(value.email, '接收邮箱', true),
    ...(address ? { address } : {}),
    ...(phone ? { phone } : {}),
    ...(bankName ? { bankName } : {}),
    ...(bankAccount ? { bankAccount } : {}),
  }
}

export function parseInvoiceRequestsQuery(value: unknown): InvoiceRequestsQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('开票记录查询格式错误')
  assertKnownKeys(value, ['cursor'], '开票记录查询')
  if (value.cursor === undefined) return {}
  if (typeof value.cursor !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(value.cursor)) throw new Error('翻页位置格式错误')
  return { cursor: value.cursor }
}

export function parseInvoiceProfileSaveInput(value: unknown): InvoiceProfileSaveInput {
  if (!isRecord(value)) throw new Error('发票抬头格式错误')
  assertKnownKeys(value, ['idempotencyKey', 'profile'], '发票抬头')
  return { idempotencyKey: uuid(value.idempotencyKey, '操作编号'), profile: parseProfileData(value.profile) }
}

export function parseInvoiceSubmitInput(value: unknown): InvoiceSubmitInput {
  if (!isRecord(value)) throw new Error('开票申请格式错误')
  assertKnownKeys(value, ['idempotencyKey', 'profileId', 'originRefs', 'amountsMinor'], '开票申请')
  const { originRefs, amountsMinor } = value
  if (!Array.isArray(originRefs) || !Array.isArray(amountsMinor) || originRefs.length === 0
    || originRefs.length > submitMaximumOrders || originRefs.length !== amountsMinor.length) throw new Error('开票订单格式错误')
  const refs = originRefs.map((ref) => {
    if (typeof ref !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(ref)) throw new Error('开票订单格式错误')
    return ref
  })
  if (new Set(refs).size !== refs.length) throw new Error('开票订单格式错误')
  const amounts = amountsMinor.map((amount) => {
    if (typeof amount !== 'string' || !/^[1-9][0-9]{0,18}$/.test(amount) || BigInt(amount) > 9223372036854775807n) throw new Error('开票金额格式错误')
    return amount
  })
  return { idempotencyKey: uuid(value.idempotencyKey, '操作编号'), profileId: uuid(value.profileId, '发票抬头'), originRefs: refs, amountsMinor: amounts }
}

export function parseInvoiceWithdrawInput(value: unknown): InvoiceWithdrawInput {
  if (!isRecord(value)) throw new Error('撤回申请格式错误')
  assertKnownKeys(value, ['idempotencyKey', 'requestId', 'expectedRevision'], '撤回申请')
  const revision = value.expectedRevision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw new Error('撤回申请格式错误')
  return { idempotencyKey: uuid(value.idempotencyKey, '操作编号'), requestId: uuid(value.requestId, '开票申请'), expectedRevision: revision }
}

export function parseInvoiceDocumentRequestId(value: unknown): string {
  return uuid(value, '开票申请')
}
