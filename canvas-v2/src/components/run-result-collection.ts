import type { CanvasAssetSummary, CanvasRunCandidate, CanvasRunRecord } from '../host'
import { canvasAssetContentUrlMatches } from '../asset-display-url'

export interface RunCollectionScope { accountId: string | number; projectId: string }
export interface RunCollectionReference { assetId: string; runId: string; nodeId: string; attemptId: string; candidateId: string }
export interface RunCollectionItem { reference: RunCollectionReference; nodeKind: string; ordinal: number; createdAt: string; candidate: CanvasRunCandidate; error?: string }
export interface RunCollectionVerified { reference: RunCollectionReference; item?: RunCollectionItem; asset?: CanvasAssetSummary; error?: string }
export interface RunCollectionStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface RunCollectionSnapshot {
  references: RunCollectionReference[]
  revision: number
  versionToken?: string
  source: 'current' | 'legacy' | 'empty'
  error?: string
  corrupt?: boolean
}
export interface RunCollectionReader {
  onReadRun(runId: string, signal: AbortSignal): Promise<CanvasRunRecord>
  onReadAsset(assetId: string, signal: AbortSignal): Promise<CanvasAssetSummary>
}
export const maximumRunCollectionItems = 50
const referenceKeys = ['assetId', 'runId', 'nodeId', 'attemptId', 'candidateId'] as const
const identifier = /^[A-Za-z0-9_.:-]{1,160}$/

export function runCollectionScopeKey(scope: RunCollectionScope): string { return `xingmang.canvas.run-collection.v2.${encodeURIComponent(String(scope.accountId))}.${encodeURIComponent(scope.projectId)}` }
export function legacyRunCollectionScopeKey(scope: RunCollectionScope): string { return `xingmang.canvas.run-collection.v1.${encodeURIComponent(String(scope.accountId))}.${encodeURIComponent(scope.projectId)}` }
export function runCollectionReferenceKey(reference: RunCollectionReference): string { return JSON.stringify(referenceKeys.map((key) => reference[key])) }
export function parseRunCollectionReferences(value: unknown): RunCollectionReference[] {
  if (!Array.isArray(value) || value.length > maximumRunCollectionItems) throw new Error('收集篮格式或数量已损坏，请明确清空后重新收集')
  const seen = new Set<string>()
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('收集篮来源记录已损坏')
    const raw = item as Record<string, unknown>
    if (Object.keys(raw).length !== referenceKeys.length || Object.keys(raw).some((key) => !referenceKeys.includes(key as typeof referenceKeys[number])) || referenceKeys.some((key) => typeof raw[key] !== 'string' || !identifier.test(raw[key] as string)) || !/^[A-Za-z0-9_-]{43}$/.test(String(raw.assetId)) || seen.has(String(raw.assetId))) throw new Error('收集篮来源记录已损坏，不能直接使用')
    seen.add(String(raw.assetId))
    return { assetId: raw.assetId as string, runId: raw.runId as string, nodeId: raw.nodeId as string, attemptId: raw.attemptId as string, candidateId: raw.candidateId as string }
  })
}
export function readRunCollection(scope: RunCollectionScope, storage: RunCollectionStorage): RunCollectionSnapshot {
  let versionToken: string | undefined, source: RunCollectionSnapshot['source'] = 'empty'
  try {
    const current = storage.getItem(runCollectionScopeKey(scope))
    // The new key isolates already-open old clients, which cannot honor our lock.
    // Once it exists, even a damaged current archive must never fall back to v1.
    const legacy = current === null ? storage.getItem(legacyRunCollectionScopeKey(scope)) : null
    versionToken = JSON.stringify([current, legacy])
    const raw = current ?? legacy
    source = current !== null ? 'current' : legacy !== null ? 'legacy' : 'empty'
    if (raw === null) return { references: [], revision: 0, versionToken, source }
    if (raw.length > 64 * 1024) throw new Error('收集篮存档超过容量上限')
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('version' in value) || !('references' in value)) throw new Error('收集篮版本或格式无法读取')
    const expected = source === 'current' ? 2 : 1
    if (value.version !== expected || Object.keys(value).some((key) => !(expected === 2 ? ['version', 'revision', 'references'] : ['version', 'references']).includes(key))) throw new Error('收集篮版本或格式无法读取')
    let revision = 0
    if (expected === 2) {
      if (!('revision' in value) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('收集篮版本记录已损坏')
      revision = value.revision
    }
    return { references: parseRunCollectionReferences(value.references), revision, versionToken, source }
  } catch (cause) { return { references: [], revision: 0, versionToken, source, error: `${cause instanceof Error ? cause.message : '收集篮无法读取'}；不会自动覆盖原存档。可重试读取或明确清空。`, corrupt: true } }
}
export class RunCollectionStorageConflict extends Error {
  constructor(readonly snapshot: RunCollectionSnapshot) { super('其他页面已更新收集篮，本页修改尚未保存；请采用最新收集篮，或明确按最新内容重试。'); this.name = 'RunCollectionStorageConflict' }
}
/** The caller must hold the scoped Web Lock across this synchronous read/write. */
export function writeRunCollection(scope: RunCollectionScope, references: readonly RunCollectionReference[], storage: RunCollectionStorage, expectedVersion?: string, allowCorrupt = false): RunCollectionSnapshot {
  const before = readRunCollection(scope, storage)
  if (expectedVersion !== undefined && before.versionToken !== expectedVersion) throw new RunCollectionStorageConflict(before)
  if (before.versionToken === undefined) throw new Error(before.error || '浏览器存储不可用')
  if (before.corrupt && !allowCorrupt) throw new Error(before.error)
  if (before.revision >= Number.MAX_SAFE_INTEGER) throw new Error('收集篮版本已达上限，请导出需要的结果后联系维护者')
  const checked = parseRunCollectionReferences(references), revision = before.revision + 1
  const content = JSON.stringify({ version: 2, revision, references: checked })
  storage.setItem(runCollectionScopeKey(scope), content)
  if (storage.getItem(runCollectionScopeKey(scope)) !== content) throw new Error('收集篮存档未能确认，当前选择仅保留在本次窗口')
  return { references: checked, revision, versionToken: JSON.stringify([content, null]), source: 'current' }
}
export function addRunCollectionReferences(current: readonly RunCollectionReference[], additions: readonly RunCollectionReference[]): RunCollectionReference[] {
  const next = current.map((item) => ({ ...item })), seen = new Set(next.map((item) => item.assetId))
  for (const reference of additions) if (!seen.has(reference.assetId)) { seen.add(reference.assetId); next.push({ ...reference }) }
  if (next.length > maximumRunCollectionItems) throw new Error(`收集篮最多 ${maximumRunCollectionItems} 项；本次整批未加入，请减少选择或先移除部分素材`)
  return parseRunCollectionReferences(next)
}
export function moveRunCollectionReference(references: readonly RunCollectionReference[], assetId: string, direction: -1 | 1): RunCollectionReference[] {
  const result = references.map((item) => ({ ...item })), index = result.findIndex((item) => item.assetId === assetId), next = index + direction
  if (index < 0 || next < 0 || next >= result.length) return result
  const item = result[index]; result[index] = result[next]; result[next] = item
  return result
}
export type RunCollectionMutation = { kind: 'add'; references: RunCollectionReference[] } | { kind: 'remove'; assetId: string } | { kind: 'move'; assetId: string; direction: -1 | 1 } | { kind: 'clear' }
export function applyRunCollectionMutation(references: readonly RunCollectionReference[], mutation: RunCollectionMutation): RunCollectionReference[] {
  if (mutation.kind === 'add') return addRunCollectionReferences(references, mutation.references)
  if (mutation.kind === 'remove') return references.filter((reference) => reference.assetId !== mutation.assetId).map((reference) => ({ ...reference }))
  if (mutation.kind === 'move') return moveRunCollectionReference(references, mutation.assetId, mutation.direction)
  return []
}
export function runCollectionItems(record: CanvasRunRecord, projectId: string): RunCollectionItem[] {
  if (record.projectId !== projectId || !identifier.test(record.runId)) throw new Error('运行记录不属于当前工程，请重新读取')
  const result: RunCollectionItem[] = []
  for (const node of record.nodes) for (const attempt of node.attempts) for (const [index, candidate] of attempt.candidates.entries()) {
    const reference = { runId: record.runId, nodeId: node.nodeId, attemptId: attempt.attemptId, candidateId: candidate.candidateId, assetId: candidate.asset.assetId }
    let error: string | undefined
    try { parseRunCollectionReferences([reference]) } catch { error = '候选身份记录不完整，不能收集' }
    if (candidate.attemptId !== attempt.attemptId) error = '候选尝试身份不一致，不能收集'
    if (!['image', 'video', 'audio'].includes(candidate.asset.kind) || candidate.asset.localUrl !== `xingmang-asset://${candidate.asset.kind}/${candidate.asset.assetId}`) error = '原候选尚无可核对的本人媒体文件'
    result.push({ reference, nodeKind: node.kind, ordinal: (candidate.outputIndex ?? index) + 1, createdAt: candidate.createdAt, candidate, ...(error ? { error } : {}) })
  }
  return result
}
export function resolveRunCollectionReference(record: CanvasRunRecord, reference: RunCollectionReference, projectId: string): RunCollectionItem {
  if (record.runId !== reference.runId) throw new Error('原运行身份不一致')
  const matches = runCollectionItems(record, projectId).filter((item) => runCollectionReferenceKey(item.reference) === runCollectionReferenceKey(reference))
  if (matches.length !== 1 || matches[0].error) throw new Error(matches[0]?.error || '原运行中的节点、尝试或候选已不存在，请移除后重新选择')
  return matches[0]
}
function checkedAsset(asset: CanvasAssetSummary, item: RunCollectionItem): CanvasAssetSummary {
  if (asset.assetId !== item.reference.assetId || asset.mediaType !== item.candidate.asset.kind || asset.deletedAt || !['image', 'video', 'audio'].includes(asset.mediaType) || !canvasAssetContentUrlMatches(asset.localUrl, asset.mediaType, asset.assetId)) throw new Error('素材已回收、缺失或身份不一致，请恢复素材或移除此项')
  return { ...asset, localUrl: `xingmang-asset://${asset.mediaType}/${asset.assetId}` }
}
/** Each verification gets fresh original-run records and owner asset details. */
export async function verifyRunCollection(references: readonly RunCollectionReference[], projectId: string, reader: RunCollectionReader, signal: AbortSignal): Promise<RunCollectionVerified[]> {
  const frozen = parseRunCollectionReferences(references), records = new Map<string, Promise<CanvasRunRecord>>()
  const output: RunCollectionVerified[] = new Array(frozen.length)
  let cursor = 0
  function check() { if (signal.aborted) throw new DOMException('只读核对已取消', 'AbortError') }
  async function worker() {
    while (cursor < frozen.length) {
      check(); const index = cursor++, reference = frozen[index]
      try {
        let record = records.get(reference.runId)
        if (!record) { record = reader.onReadRun(reference.runId, signal); records.set(reference.runId, record) }
        const item = resolveRunCollectionReference(await record, reference, projectId)
        check(); const asset = checkedAsset(await reader.onReadAsset(reference.assetId, signal), item)
        check(); output[index] = { reference, item, asset }
      } catch (cause) { check(); output[index] = { reference, error: cause instanceof Error ? cause.message : '原结果无法核对，请重试' } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, frozen.length) }, worker))
  check(); return output
}
