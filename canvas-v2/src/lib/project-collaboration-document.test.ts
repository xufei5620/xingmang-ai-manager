import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, serializeWorkflow, type WorkflowFile } from '../model'
import { applyProjectCollaborationChanges, buildProjectCollaborationChanges, invertProjectCollaborationChanges, parseProjectCollaborationDocument, projectCollaborationEqual, projectCollaborationFootprint } from './project-collaboration-document'
import { parseProjectCollaborationJoinInput, parseProjectCollaborationMutationInput, parseProjectCollaborationSnapshot, projectCollaborationCanonicalRequest, projectCollaborationContentDigest, projectCollaborationRequestDigest } from './project-collaboration-values'

function graph(): WorkflowFile {
  const value = createEmptyWorkflow('Project')
  value.nodes = ['one', 'two'].map((id, index) => ({ id, kind: 'text', position: { x: index * 400, y: 0 }, data: { model: '', prompt: id, status: 'idle' } }))
  return value
}
const op = '11111111-1111-4111-8111-111111111111', client = '22222222-2222-4222-8222-222222222222', epoch = '33333333-3333-4333-8333-333333333333'
describe('collaboration exact document changes', () => {
  it('merges node position and data independently and restores both with the server inverse', () => {
    const initial = graph(), a = structuredClone(initial), b = structuredClone(initial)
    a.nodes[0].position.x = 88; b.nodes[0].data.prompt = 'Edited text'
    const content = serializeWorkflow(initial), move = buildProjectCollaborationChanges(content, serializeWorkflow(a)), text = buildProjectCollaborationChanges(content, serializeWorkflow(b))
    const merged = applyProjectCollaborationChanges(applyProjectCollaborationChanges(content, move), text)
    expect(parseProjectCollaborationDocument(merged).nodes[0]).toMatchObject({ position: { x: 88 }, data: { prompt: 'Edited text' } })
    expect(projectCollaborationEqual(JSON.parse(applyProjectCollaborationChanges(applyProjectCollaborationChanges(merged, invertProjectCollaborationChanges(text)), invertProjectCollaborationChanges(move))), JSON.parse(content))).toBe(true)
    expect(projectCollaborationFootprint(content, move).writeKeys).not.toEqual(projectCollaborationFootprint(content, text).writeKeys)
  })
  it('rejects same-field before mismatch and unknown raw fields without a lossy repair', () => {
    const original = serializeWorkflow(graph()), after = graph(); after.nodes[0].data.prompt = 'Updated'
    const changes = buildProjectCollaborationChanges(original, serializeWorkflow(after)), changed = applyProjectCollaborationChanges(original, changes)
    expect(() => applyProjectCollaborationChanges(changed, changes)).toThrow(/字段/)
    const unsafe = JSON.parse(original); unsafe.nodes[0].data.futureSetting = 1
    expect(() => parseProjectCollaborationDocument(JSON.stringify(unsafe))).toThrow()
    unsafe.nodes[0].data.futureSetting = undefined; unsafe.apiKey = 'synthetic-secret'
    expect(() => parseProjectCollaborationDocument(JSON.stringify(unsafe))).toThrow()
  })
  it('keeps edge array order atomic and requires explicit node order for structural inverses', () => {
    const original = graph(); original.nodes.push({ id: 'router', kind: 'router', position: { x: 800, y: 0 }, data: { model: '', prompt: '', status: 'idle', settings: { routerStrategy: { version: 1, strategy: 'all' } } } })
    original.edges = ['one', 'two'].map(id => ({ id, source: id, sourceHandle: 'out:text', target: 'router', targetHandle: 'in:text' }))
    const next = structuredClone(original); next.edges.reverse()
    const content = serializeWorkflow(original), changes = buildProjectCollaborationChanges(content, serializeWorkflow(next))
    expect(changes).toEqual([{ kind: 'edges-set', before: original.edges, after: next.edges }])
    expect(JSON.parse(applyProjectCollaborationChanges(content, changes)).edges.map((edge: { id: string }) => edge.id)).toEqual(['two', 'one'])
    expect(() => applyProjectCollaborationChanges(content, [{ kind: 'node-remove', node: parseProjectCollaborationDocument(content).nodes[0] }])).toThrow(/顺序/)
    const reduced = structuredClone(original); reduced.nodes.splice(0, 1); reduced.edges.splice(0, 1)
    const remove = buildProjectCollaborationChanges(content, serializeWorkflow(reduced)), footprint = projectCollaborationFootprint(content, remove)
    expect(footprint.readKeys).toContain('["node","one","incident"]')
    expect(projectCollaborationEqual(JSON.parse(applyProjectCollaborationChanges(applyProjectCollaborationChanges(content, remove), invertProjectCollaborationChanges(remove))), JSON.parse(content))).toBe(true)
  })
  it('keeps viewport local while detecting actual changes to project name and defaults', () => {
    const initial = graph(), next = structuredClone(initial); next.viewport = { x: 500, y: 500, zoom: 2 }
    expect(buildProjectCollaborationChanges(serializeWorkflow(initial), serializeWorkflow(next))).toEqual([])
    next.name = 'Renamed'; next.mediaGroups = { image: 'source', imageModel: 'model' }
    expect(buildProjectCollaborationChanges(serializeWorkflow(initial), serializeWorkflow(next)).map(change => change.kind)).toEqual(['document-set', 'document-set'])
  })
})
describe('strict collaboration protocol and canonical request bytes', () => {
  const join = { version: 1, action: 'join', operationId: op, clientId: client, expectedAccessVersion: 1, expectedProjectVersion: 1, contentDigest: 'a'.repeat(64) } as const
  it('binds raw canonical request bytes, project scope and array order to the digest', async () => {
    const canonical = projectCollaborationCanonicalRequest('project', join)
    expect(await projectCollaborationRequestDigest('project', join)).toBe(await projectCollaborationContentDigest(canonical))
    expect(await projectCollaborationRequestDigest('other', join)).not.toBe(await projectCollaborationRequestDigest('project', join))
    expect(await projectCollaborationRequestDigest('project', { ...join })).toBe(await projectCollaborationRequestDigest('project', join))
  })
  it.each([{ ...join, version: 2 }, { ...join, actorId: 7 }, { ...join, expectedTouches: {} }, { ...join, inverse: [] }])('rejects unrecognized authority or future fields %j', value => {
    expect(() => parseProjectCollaborationJoinInput(value)).toThrow()
  })
  it('does not accept a renderer-selected actor, inverse, future operation or missing before values', () => {
    const value = { version: 1, action: 'edit', operationId: op, clientId: client, epoch, expectedAccessVersion: 1, baseProjectVersion: 1, expectedActorSequence: 0, changes: [{ kind: 'node-set', nodeId: 'one', slot: 'position', after: { x: 5, y: 0 } }] }
    expect(() => parseProjectCollaborationMutationInput(value)).toThrow()
    expect(() => parseProjectCollaborationMutationInput({ ...value, action: 'replace-all' })).toThrow()
  })
})
