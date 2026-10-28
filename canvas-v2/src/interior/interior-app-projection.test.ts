import { describe, expect, it } from 'vitest'
import { toCanvasNode, toCanvasRunGraph, toWorkflowNode } from '../App'
import { buildInteriorWorkflow } from './interior-workflow'
import { buildInteriorTaskPrompt, defaultInteriorTask } from './interior-task'

function workflow() {
  let sequence = 0
  return buildInteriorWorkflow({ task: { ...defaultInteriorTask(), addDecor: true, exterior: 'garden', filter: 'soft-cream' }, source: { assetId: 'a'.repeat(43), width: 1200, height: 800 }, prompt: '保留木色柜体', model: 'gpt-image-1', size: '1536x1024', imageResolution: '1K', quality: 'high', candidateCount: 2, createId: () => `interior-${++sequence}` })
}

describe('interior App projection', () => {
  it('preserves the exact task source output settings and supplemental prompt in both projections', () => {
    const original = workflow(), nodes = original.nodes.map(toCanvasNode)
    const data = toCanvasRunGraph(nodes, original.edges, { image: 'other-source', video: '' }).nodes.find((node) => node.data.interiorTask)!.data
    const target = original.nodes.find((node) => node.data.settings?.interiorTask)!
    expect(data).toMatchObject({ interiorTask: target.data.settings?.interiorTask, imageReferenceOrder: target.data.settings?.imageReferenceOrder, prompt: '保留木色柜体', group: 'other-source', model: 'gpt-image-1', size: '1536x1024', imageResolution: '1K', quality: 'high', imageCandidateCount: 2 })
    expect(nodes.map(toWorkflowNode).find((node) => node.id === target.id)?.data).toMatchObject(target.data)
    expect(data.prompt).not.toContain(buildInteriorTaskPrompt(defaultInteriorTask(), ''))
    expect(data).not.toHaveProperty('commerceTask')
  })

  it.each([null, { ...defaultInteriorTask(), version: 2 }, { ...defaultInteriorTask(), exterior: 'unknown' }, { ...defaultInteriorTask(), nativeLighting: true }])('rejects unsupported task metadata without silently removing it: %j', (value) => {
    const original = workflow(), nodes = original.nodes.map(toCanvasNode)
    const target = nodes.find((node) => node.data.settings?.interiorTask)!
    target.data.settings = { ...target.data.settings, interiorTask: value }
    expect(() => toCanvasRunGraph(nodes, original.edges, { image: '', video: '' })).toThrow()
    expect(target.data.settings.interiorTask).toEqual(value)
  })

  it('keeps ordinary image nodes free of interior instructions', () => {
    const original = workflow(), nodes = original.nodes.map(toCanvasNode)
    const target = nodes.find((node) => node.data.settings?.interiorTask)!
    delete target.data.settings?.interiorTask
    const data = toCanvasRunGraph(nodes, original.edges, { image: '', video: '' }).nodes.find((node) => node.id === target.id)!.data
    expect(data).not.toHaveProperty('interiorTask')
    expect(data.prompt).toBe('保留木色柜体')
  })
})
