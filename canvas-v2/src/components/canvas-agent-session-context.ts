import type { CanvasAgentClient, CanvasAgentSessionReference, CanvasAgentSessionReferenceSnapshot } from '../lib/canvas-agent-contract'
import { maximumCanvasAgentReferenceCharacters, maximumCanvasAgentSessionReferences } from '../lib/canvas-agent-contract'

const identifier = /^[A-Za-z0-9_-]{1,128}$/
export function agentSessionReferenceKey(reference: CanvasAgentSessionReference): string { return `${reference.sessionId}:${reference.turnId}:${reference.contentDigest}` }

/** Local drafts keep fixed selectors, never transcript bodies or private media. */
export function parseAgentDraftSessionReferences(value: unknown): CanvasAgentSessionReference[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximumCanvasAgentSessionReferences) throw new Error('历史会话引用格式已变化，请移除后重新选择')
  const seen = new Set<string>()
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('历史会话引用不完整，请重新选择')
    const raw = entry as Record<string, unknown>
    if (Object.keys(raw).some((key) => !['sessionId', 'turnId', 'contentDigest'].includes(key)) || typeof raw.sessionId !== 'string' || !identifier.test(raw.sessionId)
      || typeof raw.turnId !== 'string' || !identifier.test(raw.turnId) || typeof raw.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.contentDigest) || seen.has(raw.turnId)) throw new Error('历史会话引用不完整或重复，请重新选择')
    seen.add(raw.turnId)
    return { sessionId: raw.sessionId, turnId: raw.turnId, contentDigest: raw.contentDigest }
  })
}

export function addAgentSessionReference(current: readonly CanvasAgentSessionReference[], reference: CanvasAgentSessionReference): CanvasAgentSessionReference[] {
  return parseAgentDraftSessionReferences([...current.filter((entry) => entry.turnId !== reference.turnId), reference])
}

export function assertAgentReferenceSnapshot(snapshot: CanvasAgentSessionReferenceSnapshot, projectId: string, reference: CanvasAgentSessionReference): void {
  if (snapshot.projectId !== projectId || snapshot.sessionId !== reference.sessionId || snapshot.turnId !== reference.turnId || snapshot.contentDigest !== reference.contentDigest) throw new Error('历史消息已经变化或不属于当前工程，请移除引用后重新选择')
  if (snapshot.characterCount !== snapshot.prompt.length + snapshot.reply.length) throw new Error('历史消息正文长度不一致，请重新核对')
}

export function assertAgentReferenceBudget(snapshots: readonly CanvasAgentSessionReferenceSnapshot[]): number {
  const total = snapshots.reduce((sum, item) => sum + item.characterCount, 0)
  if (total > maximumCanvasAgentReferenceCharacters) throw new Error(`历史引用共 ${total.toLocaleString('zh-CN')} 字，超过 ${maximumCanvasAgentReferenceCharacters.toLocaleString('zh-CN')} 字上限；请减少引用，正文不会截断`)
  return total
}

export async function verifyAgentSessionReferences(client: CanvasAgentClient, projectId: string, references: readonly CanvasAgentSessionReference[], signal?: AbortSignal): Promise<CanvasAgentSessionReferenceSnapshot[]> {
  const refs = parseAgentDraftSessionReferences(references)
  const snapshots: CanvasAgentSessionReferenceSnapshot[] = []
  for (const reference of refs) {
    signal?.throwIfAborted()
    if (!client.active()) throw new Error('账户已变化，请重新进入工作区')
    const snapshot = await client.request('previewSessionReference', { projectId, ...reference }, signal)
    signal?.throwIfAborted()
    if (!client.active()) throw new Error('账户已变化，请重新进入工作区')
    assertAgentReferenceSnapshot(snapshot, projectId, reference)
    snapshots.push(snapshot)
  }
  assertAgentReferenceBudget(snapshots)
  return snapshots
}

export interface AgentReferenceEntry {
  reference: CanvasAgentSessionReference
  snapshot?: CanvasAgentSessionReferenceSnapshot
  error?: string
  loading: boolean
}

/** Native buttons remain the activation target, including Enter and screen readers. */
export function agentContextNavigationIndex(key: string, index: number, count: number): number | null {
  if (!count) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count
  if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count
  return null
}
