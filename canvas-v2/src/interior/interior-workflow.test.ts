import { describe, expect, it } from 'vitest'
import { parseWorkflowFile, serializeWorkflow } from '../model'
import { buildInteriorWorkflow, type InteriorWorkflowBuildInput } from './interior-workflow'
import { defaultInteriorTask } from './interior-task'

function input(): InteriorWorkflowBuildInput {
  let sequence = 0
  return { task: { ...defaultInteriorTask(), addDecor: true, filter: 'film' }, source: { assetId: 'a'.repeat(43), label: '原创房间', width: 640, height: 480 }, prompt: '保留地板纹理', model: 'gpt-image-1', size: '1024x1024', quality: 'medium', imageResolution: '1K', candidateCount: 4, createId: () => `room-${++sequence}` }
}

describe('interior workflow graph creation', () => {
  it('creates only one explicit image task and a candidate gallery without analysis or duplicated configuration', () => {
    const value = input(), original = structuredClone({ ...value, createId: undefined })
    const workflow = buildInteriorWorkflow(value)
    expect(workflow.nodes.map((node) => node.kind)).toEqual(['image-input', 'image-generate', 'gallery'])
    expect(workflow.edges).toHaveLength(2)
    const source = workflow.nodes[0], task = workflow.nodes[1]
    expect(source.data.result).toEqual({ kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, width: 640, height: 480 })
    expect(task.data).toMatchObject({ prompt: '保留地板纹理', model: value.model, imageCandidateCount: 4, status: 'idle', settings: { interiorTask: value.task, imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: workflow.edges[0].id, outputIndex: 0 }] } } })
    expect(task.data).not.toHaveProperty('group')
    expect(task.data.settings!.interiorTask).not.toBe(value.task)
    expect(task.data.settings).not.toHaveProperty('prompt')
    expect(workflow.nodes.every((node) => !node.data.result || node.kind === 'image-input')).toBe(true)
    expect(new Set([...workflow.nodes, ...workflow.edges].map((entry) => entry.id)).size).toBe(5)
    expect(parseWorkflowFile(serializeWorkflow(workflow))?.nodes[1].data.settings).toEqual(task.data.settings)
    expect({ ...value, createId: undefined }).toEqual(original)
  })
  it('allows an unconfigured model without creating a hidden model request', () => {
    const value = input(); value.model = ''
    expect(buildInteriorWorkflow(value).nodes[1].data.model).toBe('')
  })
  it.each([0, 5, 1.5, undefined, null, '2'])('rejects a nonexplicit candidate count before creating any graph identities: %j', (count) => {
    const value = input(); Reflect.set(value, 'candidateCount', count)
    let calls = 0; value.createId = () => `id-${++calls}`
    expect(() => buildInteriorWorkflow(value)).toThrow()
    expect(calls).toBe(0)
  })
  it.each([0, -1, 16385, 1.5, Number.NaN])('rejects an invalid source dimension: %j', (width) => {
    const value = input(); value.source.width = width
    expect(() => buildInteriorWorkflow(value)).toThrow('尺寸')
  })
  it.each(['same', 'bad\nid', 'x'.repeat(257)])('rejects duplicate or unsafe node and edge identities: %j', (id) => {
    const value = input(); value.createId = () => id
    expect(() => buildInteriorWorkflow(value)).toThrow('编号')
  })
  it('rejects unsupported task versions and invalid source or prompt before insertion', () => {
    const value = input(); Reflect.set(value.task, 'version', 2)
    expect(() => buildInteriorWorkflow(value)).toThrow('版本')
    for (const prompt of ['\0', 'x'.repeat(24001)]) expect(() => buildInteriorWorkflow({ ...input(), prompt })).toThrow('补充要求')
    expect(() => buildInteriorWorkflow({ ...input(), source: { assetId: 'foreign-url' } })).toThrow('本人素材')
  })
})
