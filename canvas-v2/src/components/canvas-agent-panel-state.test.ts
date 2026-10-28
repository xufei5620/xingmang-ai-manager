import { describe, expect, it } from 'vitest'
import type { CanvasAgentTurn } from '../lib/canvas-agent-contract'
import { canvasAgentDefiniteRejection, canvasAgentDraftModel, canvasAgentPanelWidth, canvasAgentPendingMatchesTurn, mergeCanvasAgentTurns, readCanvasAgentDraft, readCanvasAgentProjectMemory, writeCanvasAgentDraft, writeCanvasAgentProjectMemory, type CanvasAgentPendingAction } from './canvas-agent-panel-state'
const operationId = '11111111-1111-4111-8111-111111111111'
const scope = { ownerId: 'owner-a', projectId: 'project-a' }
const pending: CanvasAgentPendingAction = { kind: 'start', input: { operationId, projectId: scope.projectId, sessionId: 'session-a', expectedSessionVersion: 1, baseProjectVersion: 2, selectedNodeIds: ['node-a'], prompt: '产品照片流程', providerId: 'provider-a', model: 'model-a' } }
export function agentTurn(overrides: Partial<CanvasAgentTurn> = {}): CanvasAgentTurn { return { id: 'turn-a', projectId: 'project-a', sessionId: 'session-a', operationId, sessionVersion: 2, state: 'queued', prompt: '产品照片流程', providerId: 'provider-a', model: 'model-a', baseProjectVersion: 2, baseGraphDigest: 'a'.repeat(64), selectedNodeIds: ['node-a'], createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', cancelRequested: false, mayStillComplete: false, ...overrides } }
function memory() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
describe('canvas agent draft ownership and recovery', () => {
  it('restores exact image snapshots and the same uncertain request without resolved URLs', () => {
    const storage = memory(), imageReferences = [{ nodeId: 'node-a', assetId: 'a'.repeat(43) }]
    const original: CanvasAgentPendingAction = { kind: 'start', input: { ...pending.input, imageReferences } }
    const draft = { text: '分析当前商品', selectedNodeIds: ['node-a'], model: 'gpt-4.1-mini', imageReferences, pending: original }
    expect(writeCanvasAgentDraft(scope, 'session-a', draft, storage)).toBe(true)
    expect(readCanvasAgentDraft(scope, 'session-a', storage)).toEqual(draft)
    expect(readCanvasAgentDraft({ ...scope, ownerId: 'other' }, 'session-a', storage).imageReferences).toBeUndefined()
    expect([...storage.values.values()].join('')).not.toMatch(/localUrl|apiKey|Authorization|xingmang-asset|data:image/)
  })
  it('keeps a visible blocking reason for a corrupt image draft instead of silently sending text only', () => {
    const storage = memory()
    writeCanvasAgentDraft(scope, 'session-a', { text: '留住正文', selectedNodeIds: ['node-a'], model: '' }, storage)
    const key = [...storage.values.keys()][0], raw = JSON.parse(storage.values.get(key)!)
    raw.imageReferences = [{ nodeId: 'node-a', assetId: 'https://bad.example/image' }]
    storage.setItem(key, JSON.stringify(raw))
    const restored = readCanvasAgentDraft(scope, 'session-a', storage)
    expect(restored.text).toBe('留住正文'); expect(restored.imageReferenceError).toContain('核对')
    writeCanvasAgentDraft(scope, 'session-a', restored, storage)
    expect(readCanvasAgentDraft(scope, 'session-a', storage).imageReferenceError).toContain('核对')
  })
  it('preserves the original unknown request and separates account project and session drafts', () => {
    const storage = memory(), draft = { text: '未发送内容', selectedNodeIds: ['node-a'], model: 'model-a', pending }
    expect(writeCanvasAgentDraft(scope, 'session-a', draft, storage)).toBe(true)
    expect(readCanvasAgentDraft(scope, 'session-a', storage)).toEqual(draft)
    for (const [other, session] of [[{ ...scope, ownerId: 'owner-b' }, 'session-a'], [{ ...scope, projectId: 'project-b' }, 'session-a'], [scope, 'session-b']] as const) expect(readCanvasAgentDraft(other, session, storage).text).toBe('')
    expect([...storage.values.values()].join('')).not.toMatch(/localUrl|apiKey|Authorization/)
  })
  it('rejects pending requests that target another project session or exceed input bounds', () => {
    const storage = memory()
    writeCanvasAgentDraft(scope, 'session-a', { text: '留住草稿', selectedNodeIds: [], model: '', pending }, storage)
    const key = [...storage.values.keys()][0], good = storage.values.get(key)!
    for (const input of [{ ...pending.input, projectId: 'other' }, { ...pending.input, sessionId: 'other' }, { ...pending.input, operationId: 'not-an-operation' }, { ...pending.input, selectedNodeIds: Array.from({ length: 41 }, (_, i) => `n${i}`) }]) {
      const raw = JSON.parse(good); raw.pending.input = input; storage.setItem(key, JSON.stringify(raw))
      expect(readCanvasAgentDraft(scope, 'session-a', storage)).toMatchObject({ text: '留住草稿', pending: undefined })
    }
  })
  it('bounds draft storage and tolerates unavailable corrupt or quota-limited storage', () => {
    const storage = memory()
    writeCanvasAgentDraft(scope, 'session-a', { text: 'x'.repeat(9000), selectedNodeIds: Array.from({ length: 50 }, (_, i) => `n${i}`), model: 'a'.repeat(250) }, storage)
    const actual = readCanvasAgentDraft(scope, 'session-a', storage)
    expect(actual.text).toHaveLength(8000); expect(actual.selectedNodeIds).toHaveLength(40); expect(actual.model).toHaveLength(200)
    storage.setItem([...storage.values.keys()][0], '{broken')
    expect(readCanvasAgentDraft(scope, 'session-a', storage).text).toBe('')
    expect(writeCanvasAgentDraft(scope, 'session-a', actual, { getItem: () => null, setItem: () => { throw new Error('quota') } })).toBe(false)
  })
  it('restores only a valid stable create operation and bounded panel width', () => {
    const storage = memory()
    writeCanvasAgentProjectMemory(scope, { selectedSessionId: 'session-a', width: 10000, pendingCreate: { operationId, title: '新会话' } }, storage)
    expect(readCanvasAgentProjectMemory(scope, storage)).toEqual({ selectedSessionId: 'session-a', width: 640, pendingCreate: { operationId, title: '新会话' } })
    expect(readCanvasAgentProjectMemory({ ...scope, ownerId: 'other' }, storage)).toEqual({})
  })
})
describe('canvas agent turn presentation state', () => {
  it('orders actual timestamps and never replaces a newer result with a late older read', () => {
    const ready = agentTurn({ state: 'ready', updatedAt: '2026-10-14T00:00:05.000Z', reply: '完成' })
    const earlier = agentTurn({ id: 'turn-before', createdAt: '2026-10-13T23:00:00.000Z' })
    expect(mergeCanvasAgentTurns([ready], [agentTurn(), earlier])).toEqual([earlier, ready])
  })
  it('matches original operation or turn identity without accepting cross-session receipts', () => {
    expect(canvasAgentPendingMatchesTurn(pending, agentTurn())).toBe(true)
    expect(canvasAgentPendingMatchesTurn(pending, agentTurn({ operationId: '22222222-2222-4222-8222-222222222222' }))).toBe(false)
    expect(canvasAgentPendingMatchesTurn({ kind: 'execute', input: { projectId: 'project-a', sessionId: 'session-a', turnId: 'turn-a' } }, agentTurn({ sessionId: 'other' }))).toBe(false)
  })
  it('clamps pointer and keyboard panel widths to the available canvas', () => {
    expect(canvasAgentPanelWidth(700, 1280)).toBe(640)
    expect(canvasAgentPanelWidth(100, 1280)).toBe(320)
    expect(canvasAgentPanelWidth(380, 360)).toBe(312)
    expect(canvasAgentPanelWidth(NaN, 1280)).toBe(380)
  })
  it('retains unknown network and server failures for inspection', () => {
    expect(canvasAgentDefiniteRejection({ status: 409 })).toBe(true)
    expect(canvasAgentDefiniteRejection({ status: 503 })).toBe(false)
    expect(canvasAgentDefiniteRejection(new TypeError('network'))).toBe(false)
  })
  it('keeps a chosen model within its provider and selects the configured model after switching providers', () => {
    const draft = { text: '', selectedNodeIds: [], model: 'old-choice', providerId: 'provider-a' }
    expect(canvasAgentDraftModel(draft, 'provider-a', ['old-choice', 'other'], 'other')).toBe('old-choice')
    expect(canvasAgentDraftModel(draft, 'provider-b', ['new-default', 'alternate'], 'alternate')).toBe('alternate')
    expect(canvasAgentDraftModel(draft, 'provider-b', [], 'missing')).toBe('')
  })
})

describe('historical reference draft version isolation', () => {
  const reference = { sessionId: 'archived-source', turnId: 'completed-turn', contentDigest: 'd'.repeat(64) }
  const legacyKey = 'xingmang.canvas.agent.v1.owner-a.project-a.session-a'
  const currentKey = 'xingmang.canvas.agent.v2.owner-a.project-a.session-a'
  it('migrates the exact old text image and unknown operation before preventing an old reader reopening it', () => {
    const storage = memory(), imageReferences = [{ nodeId: 'node-a', assetId: 'a'.repeat(43) }]
    const original = { text: '尚未确认的原操作', selectedNodeIds: ['node-a'], imageReferences, model: 'gpt-4.1-mini', pending: { kind: 'start' as const, input: { ...pending.input, imageReferences } } }
    storage.setItem(legacyKey, JSON.stringify({ version: 1, ...original }))
    const restored = readCanvasAgentDraft(scope, 'session-a', storage)
    expect(restored).toEqual(original)
    expect(writeCanvasAgentDraft(scope, 'session-a', restored, storage)).toBe(true)
    expect(JSON.parse(storage.getItem(legacyKey)!)).toEqual({ version: 6 })
    expect(readCanvasAgentDraft(scope, 'session-a', storage)).toEqual(original)
    storage.setItem(legacyKey, JSON.stringify({ version: 1, text: '旧页迟到的覆盖', selectedNodeIds: [], model: '' }))
    expect(readCanvasAgentDraft(scope, 'session-a', storage)).toEqual(original)
  })
  it('persists only stable reference selectors in both current draft and original uncertain request', () => {
    const storage = memory(), sessionReferences = [reference]
    const original = { text: '根据已归档产品简报继续', selectedNodeIds: [], model: 'gpt-4.1-mini', sessionReferences, pending: { kind: 'start' as const, input: { ...pending.input, sessionReferences } } }
    writeCanvasAgentDraft(scope, 'session-a', original, storage)
    expect(readCanvasAgentDraft(scope, 'session-a', storage)).toEqual(original)
    expect(storage.getItem(currentKey)).not.toMatch(/sessionTitle|reply|characterCount/)
    expect(readCanvasAgentDraft({ ...scope, projectId: 'other' }, 'session-a', storage).sessionReferences).toBeUndefined()
  })
  it('keeps corrupt references visible and corrupted original requests blocked after clearing draft refs and reopening', () => {
    const storage = memory()
    storage.setItem(currentKey, JSON.stringify({ version: 2, text: '保留原需求', selectedNodeIds: [], model: '', sessionReferences: [{ ...reference, contentDigest: 'invalid' }], pending: { kind: 'start', input: { ...pending.input, sessionReferences: [{ ...reference, contentDigest: 'invalid' }] } } }))
    const restored = readCanvasAgentDraft(scope, 'session-a', storage)
    expect(restored.text).toBe('保留原需求'); expect(restored.sessionReferenceError).toContain('重新核对'); expect(restored.pendingReferenceError).toContain('不能作为新请求重发')
    expect(restored.pending).toBeUndefined()
    writeCanvasAgentDraft(scope, 'session-a', { ...restored, sessionReferences: [], sessionReferenceError: undefined }, storage)
    expect(readCanvasAgentDraft(scope, 'session-a', storage).pendingReferenceError).toContain('不能作为新请求重发')
  })
})


describe('Agent routed draft persistence', () => {
  it('keeps unknown or corrupt routed carriers blocked until explicit reset', () => {
    const data = new Map<string, string>(), storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
    const key = `xingmang.canvas.agent.v7.${scope.ownerId}.${scope.projectId}.session-a`
    for (const content of ['{', JSON.stringify({ version: 8, text: '不能静默丢模型' })]) {
      data.set(key, content)
      expect(readCanvasAgentDraft(scope, 'session-a', storage).mediaModelError).toContain('无法读取')
    }
  })
  it('uses isolated v7 with legacy tombstones and keeps the exact unknown request after clear or refresh', () => {
    const data = new Map<string, string>(), storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
    const models = { version: 1 as const, image: { providerId: 'private', model: 'image-alias' } }
    const draft = { text: '下一轮草稿', selectedNodeIds: [], model: 'text', mediaModels: models, pending: { ...pending, input: { ...pending.input, mediaModels: models } } }
    expect(writeCanvasAgentDraft(scope, 'session-a', draft, storage)).toBe(true)
    for (let version = 1; version <= 6; version++) expect(JSON.parse(storage.getItem(`xingmang.canvas.agent.v${version}.${scope.ownerId}.${scope.projectId}.session-a`)!)).toEqual({ version: 7 })
    const restored = readCanvasAgentDraft(scope, 'session-a', storage)
    expect(restored.mediaModels).toEqual(models); expect(restored.pending).toEqual(draft.pending)
    expect(readCanvasAgentDraft({ ...scope, ownerId: 'another' }, 'session-a', storage).mediaModels).toBeUndefined()
    expect(writeCanvasAgentDraft(scope, 'session-a', { ...restored, mediaModels: undefined }, storage)).toBe(true)
    expect(readCanvasAgentDraft(scope, 'session-a', storage).pending).toEqual(draft.pending)
    const key = `xingmang.canvas.agent.v7.${scope.ownerId}.${scope.projectId}.session-a`, raw = JSON.parse(storage.getItem(key)!)
    raw.pending.input.mediaModels.image.model = null; storage.setItem(key, JSON.stringify(raw))
    const corrupt = readCanvasAgentDraft(scope, 'session-a', storage)
    expect(corrupt.pending).toBeUndefined(); expect(corrupt.pendingMediaModelError).toContain('不能重新发送')
  })
})

describe('candidate pool draft version eight', () => {
  const pool = { version: 2 as const, image: [{ providerId: 'image-a', model: 'image-alias-a' }, { providerId: 'image-b', model: 'image-alias-b' }], video: [{ providerId: 'video-a', model: 'grok-imagine-video' }] }
  const key = `xingmang.canvas.agent.v8.${scope.ownerId}.${scope.projectId}.session-a`
  it('round-trips the exact ordered pool and original operation and fences every older draft carrier', () => {
    const storage = memory(), original: CanvasAgentPendingAction = { ...pending, input: { ...pending.input, mediaModels: pool } }
    const draft = { text: '后续草稿', selectedNodeIds: ['node-a'], model: 'text', mediaModels: pool, pending: original }
    expect(writeCanvasAgentDraft(scope, 'session-a', draft, storage)).toBe(true)
    expect(JSON.parse(storage.getItem(key)!).version).toBe(8)
    for (let version = 1; version <= 7; version++) expect(JSON.parse(storage.getItem(`xingmang.canvas.agent.v${version}.${scope.ownerId}.${scope.projectId}.session-a`)!)).toEqual({ version: 8 })
    expect(readCanvasAgentDraft(scope, 'session-a', storage)).toEqual(draft)
    for (const [ownerId, projectId, sessionId] of [['other', scope.projectId, 'session-a'], [scope.ownerId, 'other', 'session-a'], [scope.ownerId, scope.projectId, 'other']]) expect(readCanvasAgentDraft({ ownerId, projectId }, sessionId, storage).mediaModels).toBeUndefined()
  })
  it('keeps a newer pool authoritative after an old page rewrites its separate version-seven key', () => {
    const storage = memory()
    writeCanvasAgentDraft(scope, 'session-a', { text: '候选池原稿', selectedNodeIds: [], model: 'text', mediaModels: pool }, storage)
    const raw = storage.getItem(key)
    storage.setItem(`xingmang.canvas.agent.v7.${scope.ownerId}.${scope.projectId}.session-a`, JSON.stringify({ version: 7, text: '旧页', selectedNodeIds: [], model: 'text' }))
    expect(readCanvasAgentDraft(scope, 'session-a', storage).mediaModels).toEqual(pool); expect(storage.getItem(key)).toBe(raw)
    const cleared = { text: '明确清除后', selectedNodeIds: [], model: 'text' }
    expect(writeCanvasAgentDraft(scope, 'session-a', cleared, storage)).toBe(true)
    expect(JSON.parse(storage.getItem(key)!).version).toBe(8); expect(readCanvasAgentDraft(scope, 'session-a', storage)).toMatchObject(cleared)
    expect(readCanvasAgentDraft(scope, 'session-a', storage).mediaModels).toBeUndefined()
  })
  it.each([null, { version: 9, image: pool.image }, { version: 2, image: [] }, { version: 2, image: [pool.image[0], pool.image[0]] }, { version: 2, image: [{ ...pool.image[0], model: null }] }])('blocks a damaged current and pending pool without restoring canvas defaults: %j', (broken) => {
    const storage = memory()
    storage.setItem(key, JSON.stringify({ version: 8, text: '正文保留', selectedNodeIds: [], model: 'text', mediaModels: broken, pending: { ...pending, input: { ...pending.input, mediaModels: broken } } }))
    const restored = readCanvasAgentDraft(scope, 'session-a', storage)
    expect(restored.text).toBe('正文保留'); expect(restored.mediaModelError).toContain('明确清除'); expect(restored.pendingMediaModelError).toContain('原发送请求')
    expect(restored.pending).toBeUndefined()
    expect(writeCanvasAgentDraft(scope, 'session-a', { ...restored, mediaModels: undefined, mediaModelError: undefined }, storage)).toBe(true)
    expect(readCanvasAgentDraft(scope, 'session-a', storage).pendingMediaModelError).toContain('原发送请求')
  })
  it.each(['{', JSON.stringify({ version: 9 }), ' '.repeat(128 * 1024 + 1)])('does not fall through to a readable older draft when version eight is unreadable', (raw) => {
    const storage = memory()
    storage.setItem(`xingmang.canvas.agent.v7.${scope.ownerId}.${scope.projectId}.session-a`, JSON.stringify({ version: 7, text: '不应回退', selectedNodeIds: [], model: 'text' }))
    storage.setItem(key, raw)
    const restored = readCanvasAgentDraft(scope, 'session-a', storage)
    expect(restored.text).toBe(''); expect(restored.mediaModelError).toBeTruthy(); expect(restored.pendingMediaModelError).toContain('不能重新发送')
    expect(storage.getItem(key)).toBe(raw)
  })
  it('does not admit a pool in the old fixed-route draft envelope', () => {
    const storage = memory()
    storage.setItem(`xingmang.canvas.agent.v7.${scope.ownerId}.${scope.projectId}.session-a`, JSON.stringify({ version: 7, text: '保留', selectedNodeIds: [], model: 'text', mediaModels: pool, pending: { ...pending, input: { ...pending.input, mediaModels: pool } } }))
    const restored = readCanvasAgentDraft(scope, 'session-a', storage)
    expect(restored.mediaModelError).toBeTruthy(); expect(restored.pendingMediaModelError).toBeTruthy(); expect(restored.mediaModels).toBeUndefined(); expect(restored.pending).toBeUndefined()
  })
  it.each([1, 2, 3, 4, 5, 6, 7])('retains an original-operation block if only the writer-created v%i marker survives and the version-eight body is missing', (version) => {
    const storage = memory()
    writeCanvasAgentDraft(scope, 'session-a', { text: '原需求', selectedNodeIds: [], model: 'text', mediaModels: pool, pending: { ...pending, input: { ...pending.input, mediaModels: pool } } }, storage)
    const markerKey = `xingmang.canvas.agent.v${version}.${scope.ownerId}.${scope.projectId}.session-a`, marker = storage.getItem(markerKey)
    expect(marker).toBe(JSON.stringify({ version: 8 }))
    storage.values.clear(); storage.setItem(markerKey, marker!)
    const restored = readCanvasAgentDraft(scope, 'session-a', storage)
    expect(restored.mediaModelError).toBeTruthy(); expect(restored.pendingMediaModelError).toContain('原操作')
    // The UI can explicitly clear the editable selection; it cannot erase an
    // unknown submitted operation by creating another empty draft.
    expect(writeCanvasAgentDraft(scope, 'session-a', { ...restored, mediaModels: undefined, mediaModelError: undefined }, storage)).toBe(true)
    expect(readCanvasAgentDraft(scope, 'session-a', storage).pendingMediaModelError).toBeTruthy()
    expect(storage.getItem(key)).not.toBeNull()
  })
  it('matches an original receipt by every ordered route rather than just count or membership', () => {
    const original: CanvasAgentPendingAction = { ...pending, input: { ...pending.input, mediaModels: pool } }
    expect(canvasAgentPendingMatchesTurn(original, agentTurn({ mediaModels: structuredClone(pool) }))).toBe(true)
    expect(canvasAgentPendingMatchesTurn(original, agentTurn({ mediaModels: { ...pool, image: [...pool.image].reverse() } }))).toBe(false)
    expect(canvasAgentPendingMatchesTurn(original, agentTurn({ mediaModels: { ...pool, image: [{ ...pool.image[0], providerId: 'foreign' }, pool.image[1]] } }))).toBe(false)
    expect(canvasAgentPendingMatchesTurn(original, agentTurn({ mediaModels: { version: 1, image: pool.image[0] } }))).toBe(false)
  })
})
