import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCanvasClipboard, serializeCanvasClipboard, type CanvasClipboardPayload } from './clipboard'

function payload(): CanvasClipboardPayload {
  return { version: 1, nodes: [{ id: 'a', type: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '正文', model: '', status: 'idle' } }], edges: [] }
}

describe('external canvas clipboard boundary', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it.each(['foreign-kind', 'unknown'])('rejects unsupported executable node kind %s instead of inserting it', (kind) => {
    const value = payload(); value.nodes[0].type = kind
    expect(parseCanvasClipboard(JSON.stringify(value))).toBeNull()
  })
  it.each(['parent-missing', 'self-parent', 'non-group-parent', 'cycle', 'bad-handle', 'duplicate-edge', 'external-edge', 'far-coordinate'])('rejects the complete malformed graph (%s)', (kind) => {
    const value = payload()
    value.nodes.push({ ...structuredClone(value.nodes[0]), id: 'b' })
    if (kind === 'parent-missing') value.nodes[0].parentId = 'missing'
    if (kind === 'self-parent') value.nodes[0].parentId = 'a'
    if (kind === 'non-group-parent') value.nodes[0].parentId = 'b'
    if (kind === 'cycle') { value.nodes.forEach((node) => { node.type = 'group' }); value.nodes[0].parentId = 'b'; value.nodes[1].parentId = 'a' }
    if (kind === 'far-coordinate') value.nodes[0].position.x = 10_000_001
    if (kind.includes('edge') || kind === 'bad-handle') value.edges = [{ id: 'e', source: 'a', target: kind === 'external-edge' ? 'missing' : 'b', sourceHandle: kind === 'bad-handle' ? 'bogus' : 'out:text', targetHandle: 'in:text' }]
    if (kind === 'duplicate-edge') value.edges.push({ ...value.edges[0] })
    expect(parseCanvasClipboard(JSON.stringify(value))).toBeNull()
  })
  it('bounds UTF-8 bytes rather than JavaScript character count', () => {
    const value = payload(); value.nodes = Array.from({ length: 30 }, (_, index) => ({ ...value.nodes[0], id: `n${index}`, data: { prompt: '中'.repeat(70_000) } }))
    const text = JSON.stringify(value)
    expect(text.length).toBeLessThan(5 * 1024 * 1024)
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(5 * 1024 * 1024)
    expect(parseCanvasClipboard(text)).toBeNull()
  })
  it('projects credentials, runtime attempts and remote job identities away while keeping owner media and candidate configuration', () => {
    const value = payload(); value.nodes[0].type = 'image-generate'
    value.nodes[0].data = { prompt: '正文', model: 'model-a', group: 'provider-a', imageCandidateCount: 2, candidateAssetIds: ['a'.repeat(43)], status: 'running', runStartedAt: 'today', attemptCount: 2, requestId: 'old-request', result: { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, taskId: 'old-job' }, settings: { apiKey: 'sk-secret', token: 'secret', nested: { authorization: 'Bearer secret', taskId: 'old-task' }, safe: true } }
    const text = serializeCanvasClipboard(value), parsed = parseCanvasClipboard(text)!
    expect(text).not.toMatch(/sk-secret|Bearer|old-job|old-request|old-task|runStartedAt|attemptCount/)
    expect(parsed.nodes[0].data).toMatchObject({ model: 'model-a', group: 'provider-a', imageCandidateCount: 2, candidateAssetIds: ['a'.repeat(43)], result: { assetId: 'a'.repeat(43) } })
    expect(parsed.nodes[0].data.status).toBe('succeeded')
  })
  it('rejects remote media URLs and malformed result metadata without silently losing the reference', () => {
    const value = payload(); value.nodes[0].type = 'image-input'; value.nodes[0].data.result = { kind: 'image', localUrl: 'https://private.example/image.png' }
    expect(parseCanvasClipboard(JSON.stringify(value))).toBeNull()
  })
  it.each([`/api/assets/${'a'.repeat(43)}/content`, `/api/projects/11111111-1111-4111-8111-111111111111/assets/${'a'.repeat(43)}/content`])('normalizes a same-origin media result URL %s without losing its registered ID', (localUrl) => {
    const value = payload(); value.nodes[0].type = 'image-input'; value.nodes[0].data.result = { kind: 'image', assetId: 'a'.repeat(43), localUrl }
    // Only a host that handed out these addresses recognises them; the kernel itself knows only the protocol address.
    expect(parseCanvasClipboard(JSON.stringify(value))).toBeNull()
    const project = /^\/api\/projects\/([0-9a-f-]{36})\/assets\/([A-Za-z0-9_-]{43})\/content$/.exec(localUrl)
    vi.stubGlobal('window', { xingmangCanvasHost: { resolveHostAssetUrl: (url: string) => url !== localUrl ? undefined : project ? { assetId: project[2], projectId: project[1] } : { assetId: 'a'.repeat(43) } } })
    expect(parseCanvasClipboard(JSON.stringify(value))?.nodes[0].data.result).toEqual({ kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` })
    value.nodes[0].data.result = { kind: 'image', assetId: 'b'.repeat(43), localUrl }
    expect(parseCanvasClipboard(JSON.stringify(value))).toBeNull()
  })
  it('copies a completed node with live candidate receipts while retaining only durable candidate IDs and configuration', () => {
    const value = payload(); value.nodes[0].type = 'image-generate'
    value.nodes[0].data = { prompt: 'product', model: 'image-model', imageCandidateCount: 2, candidateAssetIds: ['a'.repeat(43)], candidates: [{ candidateId: 'old-candidate', attemptId: 'old-attempt', asset: { assetId: 'b'.repeat(43), kind: 'image' } }], selectedCandidateId: 'old-candidate', adoptedCandidateId: 'old-adopted', status: 'running' }
    const text = serializeCanvasClipboard(value)
    expect(text).not.toMatch(/old-candidate|old-attempt|old-adopted/)
    expect(parseCanvasClipboard(text)?.nodes[0].data).toMatchObject({ imageCandidateCount: 2, candidateAssetIds: ['a'.repeat(43)], status: 'idle' })
    expect(text).not.toContain('b'.repeat(43))
  })
  it('retains every persisted unadopted candidate in order and the adopted original across runtime receipt cleanup', () => {
    const value = payload(); value.nodes[0].type = 'image-generate'
    const candidateAssetIds = ['c'.repeat(43), 'a'.repeat(43), 'b'.repeat(43)]
    value.nodes[0].data = { prompt: 'product', model: 'image-model', imageCandidateCount: 4, candidateAssetIds, result: { kind: 'image', assetId: candidateAssetIds[1], localUrl: `xingmang-asset://image/${candidateAssetIds[1]}`, taskId: 'old-provider-task' }, candidates: candidateAssetIds.map((assetId, index) => ({ candidateId: `old-candidate-${index}`, attemptId: 'old-attempt', asset: { assetId, kind: 'image' } })), adoptedCandidateId: 'old-candidate-1', status: 'succeeded' }
    const result = parseCanvasClipboard(serializeCanvasClipboard(value))!
    expect(result.nodes[0].data.candidateAssetIds).toEqual(candidateAssetIds)
    expect(result.nodes[0].data.result).toEqual({ kind: 'image', assetId: candidateAssetIds[1], localUrl: `xingmang-asset://image/${candidateAssetIds[1]}` })
    expect(result.nodes[0].data.imageCandidateCount).toBe(4)
    expect(serializeCanvasClipboard(value)).not.toMatch(/old-attempt|old-provider-task|old-candidate/)
  })
  it('continues accepting safe legacy v1 selections with compatible input handle normalization', () => {
    const value = payload(); value.nodes.push({ ...structuredClone(value.nodes[0]), id: 'b', type: 'text-generate' })
    value.edges = [{ id: 'e', source: 'a', target: 'b', sourceHandle: 'out:text', targetHandle: 'in:text' }]
    expect(parseCanvasClipboard(JSON.stringify(value))?.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(parseCanvasClipboard(JSON.stringify(value))?.edges).toEqual(value.edges)
  })
})
