/** Ordinary library mutations have their own receipts; category versions are unrelated. */
export type AssetMutationAction = 'favorite' | 'unfavorite' | 'delete' | 'restore' | 'tags' | 'rename' | 'undo'
export type AssetMutationInput =
  | { operationId: string; action: 'favorite' | 'unfavorite' | 'delete' | 'restore'; assetIds: string[] }
  | { operationId: string; action: 'tags'; assetIds: string[]; tags: string[] }
  | { operationId: string; action: 'rename'; assetId: string; displayName: string }
  | { operationId: string; action: 'undo'; assetIds: string[]; originalOperationId: string; originalRequestDigest: string }

export interface AssetMutationOutcome {
  assetId: string
  displayName: string
  state: 'succeeded' | 'rejected'
  changed: boolean
  /** This describes the original change, not a promise that a later CAS will succeed. */
  undoable: boolean
  message: string
}
export interface AssetMutationResult {
  version: 1
  action: AssetMutationAction
  operationId: string
  requestDigest: string
  createdAt: string
  outcomes: AssetMutationOutcome[]
  undoOf?: { operationId: string; requestDigest: string }
}
export type AssetMutationInspection =
  | { status: 'missing'; operationId: string; requestDigest: string }
  | { status: 'applied'; operationId: string; requestDigest: string; result: AssetMutationResult }

export const maximumAssetMutationCount = 50
export const maximumAssetMutationRequestBytes = 32 * 1024
export const maximumAssetMutationResultBytes = 128 * 1024

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('素材操作字段不正确')
  return value
}
export function isAssetMutationOperationId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) }
function operationId(value: unknown): string {
  if (!isAssetMutationOperationId(value)) throw new Error('素材操作编号不正确')
  return value.toLowerCase()
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('原素材操作摘要不正确')
  return value
}
function assetId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('素材编号不正确')
  return value
}
function assetIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maximumAssetMutationCount) throw new Error('请一次选择1–50份素材')
  const result = value.map(assetId)
  if (new Set(result).size !== result.length) throw new Error('不能重复选择同一份素材')
  return result
}
function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}不能为空，最多${maximum}个字符，不能包含控制字符`)
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${label}包含无效字符`) }
    else if (code >= 0xdc00 && code <= 0xdfff) throw new Error(`${label}包含无效字符`)
  }
  return value.trim()
}

export function parseAssetMutationInput(value: unknown): AssetMutationInput {
  if (!object(value)) throw new Error('素材操作格式不正确')
  const id = operationId(value.operationId)
  if (['favorite', 'unfavorite', 'delete', 'restore'].includes(String(value.action))) {
    const input = fields(value, ['operationId', 'action', 'assetIds'])
    const action = input.action
    if (action !== 'favorite' && action !== 'unfavorite' && action !== 'delete' && action !== 'restore') throw new Error('素材操作不受支持')
    return { operationId: id, action, assetIds: assetIds(input.assetIds) }
  }
  if (value.action === 'tags') {
    const input = fields(value, ['operationId', 'action', 'assetIds', 'tags'])
    if (!Array.isArray(input.tags) || input.tags.length > 20) throw new Error('标签最多20个，每个最多40个字符')
    const tags = input.tags.map((tag) => text(tag, 40, '标签'))
    if (new Set(tags).size !== tags.length) throw new Error('标签不能重复')
    return { operationId: id, action: 'tags', assetIds: assetIds(input.assetIds), tags }
  }
  if (value.action === 'rename') {
    const input = fields(value, ['operationId', 'action', 'assetId', 'displayName'])
    return { operationId: id, action: 'rename', assetId: assetId(input.assetId), displayName: text(input.displayName, 160, '素材名称') }
  }
  if (value.action === 'undo') {
    const input = fields(value, ['operationId', 'action', 'assetIds', 'originalOperationId', 'originalRequestDigest'])
    const originalOperationId = operationId(input.originalOperationId)
    if (originalOperationId === id) throw new Error('撤销必须使用新的操作编号')
    return { operationId: id, action: 'undo', assetIds: assetIds(input.assetIds), originalOperationId, originalRequestDigest: digest(input.originalRequestDigest) }
  }
  throw new Error('素材操作不受支持')
}

export function assetMutationInputIds(input: AssetMutationInput): string[] { return input.action === 'rename' ? [input.assetId] : [...input.assetIds] }
export async function assetMutationRequestDigest(value: unknown): Promise<string> {
  const input = parseAssetMutationInput(value)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input))))].map((part) => part.toString(16).padStart(2, '0')).join('')
}

export function isAssetMutationResult(value: unknown): value is AssetMutationResult {
  try {
    const result = fields(value, ['version', 'action', 'operationId', 'requestDigest', 'createdAt', 'outcomes', 'undoOf'])
    if (result.version !== 1 || !['favorite', 'unfavorite', 'delete', 'restore', 'tags', 'rename', 'undo'].includes(String(result.action)) || operationId(result.operationId) !== result.operationId || digest(result.requestDigest) !== result.requestDigest || typeof result.createdAt !== 'string' || new Date(result.createdAt).toISOString() !== result.createdAt) return false
    if (!Array.isArray(result.outcomes) || !result.outcomes.length || result.outcomes.length > maximumAssetMutationCount) return false
    const ids: string[] = []
    for (const value of result.outcomes) {
      const item = fields(value, ['assetId', 'displayName', 'state', 'changed', 'undoable', 'message'])
      ids.push(assetId(item.assetId))
      if (typeof item.displayName !== 'string' || !item.displayName || item.displayName.length > 160 || typeof item.message !== 'string' || !item.message || item.message.length > 500 || !['succeeded', 'rejected'].includes(String(item.state)) || typeof item.changed !== 'boolean' || typeof item.undoable !== 'boolean') return false
      if (item.state === 'rejected' && (item.changed || item.undoable) || item.undoable && (!item.changed || result.action === 'undo') || item.state === 'succeeded' && item.changed && result.action !== 'undo' && !item.undoable) return false
    }
    if (new Set(ids).size !== ids.length || result.action === 'rename' && ids.length !== 1) return false
    if (result.action === 'undo') { const original = fields(result.undoOf, ['operationId', 'requestDigest']); if (operationId(original.operationId) !== original.operationId || original.operationId === result.operationId || digest(original.requestDigest) !== original.requestDigest) return false }
    else if (result.undoOf !== undefined) return false
    return new TextEncoder().encode(JSON.stringify(result)).byteLength <= maximumAssetMutationResultBytes
  } catch { return false }
}

export function confirmAssetMutationResult(input: AssetMutationInput, result: AssetMutationResult, expectedDigest?: string): void {
  if (!isAssetMutationResult(result) || result.operationId !== input.operationId || result.action !== input.action || expectedDigest !== undefined && result.requestDigest !== expectedDigest) throw new Error('素材回执与原操作不一致，请核对原操作')
  const ids = assetMutationInputIds(input)
  if (ids.length !== result.outcomes.length || result.outcomes.some((item, index) => item.assetId !== ids[index])) throw new Error('素材回执顺序或数量不完整，请核对原操作')
  if (input.action === 'undo' && (result.undoOf?.operationId !== input.originalOperationId || result.undoOf.requestDigest !== input.originalRequestDigest)) throw new Error('撤销回执与原操作不一致')
}

export function parseAssetMutationInspection(value: unknown, input?: AssetMutationInput, expectedDigest?: string): AssetMutationInspection {
  if (!object(value)) throw new Error('原素材操作回执格式不正确')
  const row = fields(value, value.status === 'applied' ? ['status', 'operationId', 'requestDigest', 'result'] : ['status', 'operationId', 'requestDigest'])
  const id = operationId(row.operationId), requestDigest = digest(row.requestDigest)
  if (id !== row.operationId) throw new Error('原素材操作编号不正确')
  if (input && (expectedDigest === undefined || id !== input.operationId || requestDigest !== expectedDigest)) throw new Error('核对结果与原素材操作不一致')
  if (row.status === 'missing') return { status: 'missing', operationId: id, requestDigest }
  if (row.status !== 'applied' || !isAssetMutationResult(row.result) || row.result.operationId !== id || row.result.requestDigest !== requestDigest) throw new Error('原素材操作结果未确认')
  if (input) confirmAssetMutationResult(input, row.result, expectedDigest)
  return { status: 'applied', operationId: id, requestDigest, result: row.result }
}
