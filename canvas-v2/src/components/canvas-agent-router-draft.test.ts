import { describe, expect, it } from 'vitest'
import { canvasAgentPendingMatchesTurn, readCanvasAgentDraft, writeCanvasAgentDraft, type CanvasAgentDraft, type CanvasAgentPendingAction } from './canvas-agent-panel-state'
import type { CanvasAgentTurn } from '../lib/canvas-agent-contract'

const scope = { ownerId: 'owner', projectId: 'project' }, sessionId = 'session'
const input = { projectId: scope.projectId, sessionId, operationId: '11111111-1111-4111-8111-111111111111', expectedSessionVersion: 1, baseProjectVersion: 1, prompt: '原需求', providerId: 'source', model: 'planner', selectedNodeIds: [] }
function key(version: number) { return `xingmang.canvas.agent.v${version}.owner.project.session` }
function storageFixture() { const values = new Map<string, string>(); return { values, getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value) } } }
function draft(pending?: CanvasAgentPendingAction): CanvasAgentDraft { return { text: '下一条未发送的需求', model: 'planner', selectedNodeIds: [], ...(pending ? { pending } : {}) } }
function pending(): CanvasAgentPendingAction { return { kind: 'start', draftRevision: 3, input: { ...input, routerStrategyVersion: 1 } } }

describe('frozen router semantics in browser pending drafts', () => {
  it('writes a separate version-11 draft and denial markers for every prior reader', () => {
    const storage = storageFixture(), original = draft(pending())
    expect(writeCanvasAgentDraft(scope, sessionId, original, storage)).toBe(true)
    expect(JSON.parse(storage.getItem(key(11))!).pending).toEqual(original.pending)
    for (let version = 1; version <= 10; version++) expect(JSON.parse(storage.getItem(key(version))!)).toEqual({ version: 11 })
    expect(readCanvasAgentDraft(scope, sessionId, storage)).toEqual(original)
    expect(readCanvasAgentDraft({ ...scope, ownerId: 'other' }, sessionId, storage).pending).toBeUndefined()
  })
  it.each([6, 10])('reads original v%s pending bytes without adding a new router marker or changing the operation', (version) => {
    const storage = storageFixture(), original = draft({ kind: 'start', input: { ...input } })
    const content = JSON.stringify({ version, ...original }); storage.setItem(key(version), content)
    const read = readCanvasAgentDraft(scope, sessionId, storage)
    expect(read.pending).toEqual(original.pending); expect(read.pending?.input).not.toHaveProperty('routerStrategyVersion')
    expect(storage.getItem(key(version))).toBe(content); expect(storage.getItem(key(11))).toBeNull()
  })
  it.each(['missing', 'future', 'null'] as const)('retains a durable refusal when the new original marker is %s', (kind) => {
    const storage = storageFixture(), original = draft(pending())
    expect(writeCanvasAgentDraft(scope, sessionId, original, storage)).toBe(true)
    const raw = JSON.parse(storage.getItem(key(11))!)
    if (kind === 'missing') delete raw.pending.input.routerStrategyVersion
    else raw.pending.input.routerStrategyVersion = kind === 'future' ? 2 : null
    storage.setItem(key(11), JSON.stringify(raw))
    const read = readCanvasAgentDraft(scope, sessionId, storage)
    expect(read.pending).toBeUndefined(); expect(read.pendingRouterStrategyError).toContain('不能重新发送')
    expect(writeCanvasAgentDraft(scope, sessionId, read, storage)).toBe(true)
    expect(readCanvasAgentDraft(scope, sessionId, storage).pendingRouterStrategyError).toContain('不能重新发送')
  })
  it('rejects markers smuggled into an old carrier instead of silently dropping them', () => {
    const storage = storageFixture(); storage.setItem(key(10), JSON.stringify({ version: 10, ...draft(pending()) }))
    const read = readCanvasAgentDraft(scope, sessionId, storage)
    expect(read.pending).toBeUndefined(); expect(read.pendingRouterStrategyError).toContain('不能重新发送')
  })
  it.each(['project', 'session', 'operation', 'kind'] as const)('refuses a damaged original %s identity without creating a replacement request', (field) => {
    const storage = storageFixture(); writeCanvasAgentDraft(scope, sessionId, draft(pending()), storage)
    const raw = JSON.parse(storage.getItem(key(11))!)
    if (field === 'project') raw.pending.input.projectId = 'another-project'
    if (field === 'session') raw.pending.input.sessionId = 'another-session'
    if (field === 'operation') raw.pending.input.operationId = 'not-an-operation'
    if (field === 'kind') raw.pending.kind = 'unknown'
    storage.setItem(key(11), JSON.stringify(raw))
    const read = readCanvasAgentDraft(scope, sessionId, storage)
    expect(read.pending).toBeUndefined(); expect(read.pendingRouterStrategyError).toContain('不能重新发送')
  })
  it('uses the complete new draft even if writing old-reader markers was interrupted', () => {
    const storage = storageFixture(), original = draft(pending())
    const interrupted = { getItem: storage.getItem, setItem(name: string, value: string) { if (name === key(10)) throw new Error('quota'); storage.setItem(name, value) } }
    expect(writeCanvasAgentDraft(scope, sessionId, original, interrupted)).toBe(false)
    expect(readCanvasAgentDraft(scope, sessionId, storage)).toEqual(original)
  })
  it('refuses to read stale payloads after the authoritative new draft was lost or damaged', () => {
    const storage = storageFixture(); writeCanvasAgentDraft(scope, sessionId, draft(pending()), storage)
    storage.setItem(key(6), JSON.stringify({ version: 6, ...draft({ kind: 'start', input: { ...input } }) }))
    storage.values.delete(key(11))
    expect(readCanvasAgentDraft(scope, sessionId, storage).pending).toBeUndefined()
    expect(readCanvasAgentDraft(scope, sessionId, storage)).toMatchObject({ pendingRouterStrategyError: expect.stringContaining('完整草稿缺失') })
    storage.setItem(key(11), '{broken')
    expect(readCanvasAgentDraft(scope, sessionId, storage).pending).toBeUndefined()
    expect(readCanvasAgentDraft(scope, sessionId, storage)).toMatchObject({ pendingRouterStrategyError: expect.stringContaining('无法完整读取') })
  })
  it('keeps the new authoritative operation despite an old page overwriting its old storage key', () => {
    const storage = storageFixture(), original = draft(pending()); writeCanvasAgentDraft(scope, sessionId, original, storage)
    storage.setItem(key(10), JSON.stringify({ version: 10, ...draft({ kind: 'start', input: { ...input, prompt: '旧页面的请求' } }) }))
    expect(readCanvasAgentDraft(scope, sessionId, storage).pending).toEqual(original.pending)
  })
  it('matches the original semantic marker as well as its operation receipt', () => {
    const turn: CanvasAgentTurn = { id: 'turn', ...input, sessionVersion: 2, state: 'queued', baseGraphDigest: 'a'.repeat(64), cancelRequested: false, mayStillComplete: false, createdAt: '', updatedAt: '' }
    const current = pending()
    expect(canvasAgentPendingMatchesTurn(current, turn)).toBe(false)
    expect(canvasAgentPendingMatchesTurn(current, { ...turn, routerStrategyVersion: 1 })).toBe(true)
    expect(canvasAgentPendingMatchesTurn({ kind: 'start', input }, { ...turn, routerStrategyVersion: 1 })).toBe(false)
    expect(canvasAgentPendingMatchesTurn({ kind: 'start', input }, turn)).toBe(true)
  })
  it('rejects writing an invalid original or a legacy pending operation into a marked draft', () => {
    const storage = storageFixture(); writeCanvasAgentDraft(scope, sessionId, draft(pending()), storage)
    const before = storage.getItem(key(11))
    expect(writeCanvasAgentDraft(scope, sessionId, draft({ kind: 'start', input }), storage)).toBe(false)
    expect(storage.getItem(key(11))).toBe(before)
  })
})
