import { describe, expect, it, vi } from 'vitest'
import type { CanvasAgentClient, CanvasAgentSessionReference, CanvasAgentSessionReferenceSnapshot } from '../lib/canvas-agent-contract'
import { addAgentSessionReference, agentContextNavigationIndex, assertAgentReferenceBudget, assertAgentReferenceSnapshot, parseAgentDraftSessionReferences, verifyAgentSessionReferences } from './canvas-agent-session-context'

function reference(index = 1): CanvasAgentSessionReference { return { sessionId: `source-${index}`, turnId: `turn-${index}`, contentDigest: String(index).repeat(64) } }
function snapshot(index = 1): CanvasAgentSessionReferenceSnapshot { return { ...reference(index), projectId: 'project-a', sessionTitle: '产品简报', createdAt: '2026-10-15T00:00:00Z', prompt: '保留完整需求', reply: '完整答复'.repeat(400) + '尾部标记', characterCount: 7 + 1604 } }
function exactSnapshot(index = 1): CanvasAgentSessionReferenceSnapshot { const value = snapshot(index); return { ...value, characterCount: value.prompt.length + value.reply.length } }
function client(request = vi.fn()): CanvasAgentClient { return { active: () => true, request } }

describe('Agent fixed historical message references', () => {
  it('accepts only bounded selectors without transcript text or untrusted extra fields', () => {
    expect(parseAgentDraftSessionReferences(undefined)).toEqual([])
    expect(parseAgentDraftSessionReferences([reference()])).toEqual([reference()])
    for (const value of [null, {}, [reference(), reference()], [exactSnapshot()], [{ ...reference(), contentDigest: 'bad' }], [{ ...reference(), sessionId: '../other' }], Array.from({ length: 5 }, (_, i) => reference(i + 1))]) expect(() => parseAgentDraftSessionReferences(value)).toThrow()
  })
  it('retains four explicit choices and only replaces the same message after deliberate reselection', () => {
    const existing = [1, 2, 3, 4].map(reference)
    expect(() => addAgentSessionReference(existing, reference(5))).toThrow()
    const changed = { ...reference(2), contentDigest: 'f'.repeat(64) }
    expect(addAgentSessionReference(existing, changed)).toEqual([reference(1), reference(3), reference(4), changed])
    expect(existing[1]).toEqual(reference(2))
  })
  it('verifies exact project message and digest and never silently accepts shorter text', () => {
    const actual = exactSnapshot()
    expect(() => assertAgentReferenceSnapshot(actual, 'project-a', reference())).not.toThrow()
    for (const change of [{ projectId: 'other' }, { sessionId: 'other' }, { turnId: 'other' }, { contentDigest: 'e'.repeat(64) }, { characterCount: actual.characterCount - 1 }]) expect(() => assertAgentReferenceSnapshot({ ...actual, ...change }, 'project-a', reference())).toThrow()
  })
  it('allows the complete aggregate boundary and rejects overflow instead of truncating', () => {
    expect(assertAgentReferenceBudget([{ ...exactSnapshot(), characterCount: 12000 }, { ...exactSnapshot(2), characterCount: 12000 }])).toBe(24000)
    expect(() => assertAgentReferenceBudget([{ ...exactSnapshot(), characterCount: 24001 }])).toThrow(/24,001.*24,000.*不会截断/)
  })
  it('revalidates exact full text through read-only previews without reading or changing a session', async () => {
    const request = vi.fn().mockResolvedValueOnce(exactSnapshot()).mockResolvedValueOnce(exactSnapshot(2))
    const result = await verifyAgentSessionReferences(client(request), 'project-a', [reference(), reference(2)])
    expect(result[0].reply.endsWith('尾部标记')).toBe(true)
    expect(request.mock.calls).toEqual([['previewSessionReference', { projectId: 'project-a', ...reference() }, undefined], ['previewSessionReference', { projectId: 'project-a', ...reference(2) }, undefined]])
  })
  it('fails closed for stale source text and stops further reads after abort or account change', async () => {
    const request = vi.fn().mockResolvedValue({ ...exactSnapshot(), contentDigest: 'f'.repeat(64) })
    await expect(verifyAgentSessionReferences(client(request), 'project-a', [reference()])).rejects.toThrow('已经变化')
    const controller = new AbortController(), active = { value: true }
    request.mockImplementation(async () => { controller.abort(); return exactSnapshot() })
    await expect(verifyAgentSessionReferences(client(request), 'project-a', [reference(), reference(2)], controller.signal)).rejects.toThrow()
    request.mockImplementation(async () => { active.value = false; return exactSnapshot() })
    await expect(verifyAgentSessionReferences({ request, active: () => active.value }, 'project-a', [reference(), reference(2)])).rejects.toThrow('账户已变化')
  })
  it('supports predictable keyboard wrapping without inventing an option for empty lists', () => {
    expect(agentContextNavigationIndex('ArrowDown', -1, 3)).toBe(0)
    expect(agentContextNavigationIndex('ArrowUp', -1, 3)).toBe(2)
    expect(agentContextNavigationIndex('ArrowDown', 2, 3)).toBe(0)
    expect(agentContextNavigationIndex('ArrowUp', 0, 3)).toBe(2)
    expect(agentContextNavigationIndex('Home', 2, 3)).toBe(0)
    expect(agentContextNavigationIndex('End', 0, 3)).toBe(2)
    expect(agentContextNavigationIndex('Enter', 1, 3)).toBeNull()
    expect(agentContextNavigationIndex('ArrowDown', -1, 0)).toBeNull()
  })
})
