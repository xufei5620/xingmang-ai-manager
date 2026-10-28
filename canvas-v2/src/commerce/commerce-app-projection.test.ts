import { describe, expect, it } from 'vitest'
import { toCanvasNode, toCanvasRunGraph, toWorkflowNode } from '../App'
import { buildCommerceWorkflow } from './commerce-workflow'
import { defaultCommerceTask } from './commerce-task'

function workflow() {
  let sequence = 0
  return buildCommerceWorkflow({ tasks: [defaultCommerceTask('style-reference')], source: { assetId: 'a'.repeat(43), width: 512, height: 512 }, reference: { assetId: 'b'.repeat(43), width: 512, height: 512 }, prompt: '用户补充', model: 'gpt-image-1', candidateCount: 2, createId: () => `commerce-${++sequence}` })
}
describe('commerce app projection', () => {
  it('carries exact task and ordered roles into submitted graph and saved document', () => {
    const original = workflow(), nodes = original.nodes.map(toCanvasNode)
    const graph = toCanvasRunGraph(nodes, original.edges, { image: 'owned-source', video: '' })
    const generator = graph.nodes.find((node) => node.data.commerceTask)
    expect(generator?.data.commerceTask).toEqual(defaultCommerceTask('style-reference'))
    expect(generator?.data.imageReferenceOrder).toEqual(original.nodes.find((node) => node.data.settings?.commerceTask)?.data.settings?.imageReferenceOrder)
    expect(generator?.data.prompt).toBe('用户补充')
    expect(generator?.data.group).toBe('owned-source')
    expect(nodes.map(toWorkflowNode).find((node) => node.data.settings?.commerceTask)?.data.settings).toEqual(original.nodes.find((node) => node.data.settings?.commerceTask)?.data.settings)
  })
  it('rejects unsupported semantics instead of silently stripping invalid fields', () => {
    const original = workflow(), nodes = original.nodes.map(toCanvasNode)
    const node = nodes.find((entry) => entry.data.settings?.commerceTask)!
    node.data.settings = { ...node.data.settings, commerceTask: { version: 2, kind: 'style-reference', preserve: [] } }
    expect(() => toCanvasRunGraph(nodes, original.edges, { image: '', video: '' })).toThrow(/版本/)
    node.data.settings = { imageReferenceOrder: { version: 1, slots: [{ role: 'reference', missing: true }] } }
    expect(() => toCanvasRunGraph(nodes, original.edges, { image: '', video: '' })).toThrow()
  })
  it('leaves ordinary generators on their established input behavior', () => {
    const original = workflow(), nodes = original.nodes.map(toCanvasNode)
    const node = nodes.find((entry) => entry.data.settings?.commerceTask)!
    delete node.data.settings?.commerceTask; delete node.data.settings?.imageReferenceOrder
    const data = toCanvasRunGraph(nodes, original.edges, { image: '', video: '' }).nodes.find((entry) => entry.id === node.id)!.data
    expect(data).not.toHaveProperty('commerceTask'); expect(data).not.toHaveProperty('imageReferenceOrder')
  })
})
