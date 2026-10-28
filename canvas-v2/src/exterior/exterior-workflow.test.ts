import { describe, expect, it } from 'vitest'
import { buildExteriorWorkflow } from './exterior-workflow'
import { defaultExteriorTask } from './exterior-task'
import { exteriorTaskWorkflowFixture } from '../lib/exterior-task.test-fixture'

describe('ordinary exterior workflow construction', () => {
  it('creates no hidden executor and keeps automatic analysis as a real visible dependency', () => {
    const workflow = exteriorTaskWorkflowFixture('landscape-redesign')
    expect(workflow.nodes.map((node) => node.kind)).toEqual(['image-input', 'image-input', 'text-generate', 'image-generate', 'gallery'])
    expect(workflow.edges.filter((edge) => edge.targetHandle === 'in:images')).toHaveLength(5)
    expect(workflow.nodes.find((node) => node.data.settings?.exteriorTask)?.data.prompt).toBe('')
    expect(workflow.nodes.find((node) => node.kind === 'text-generate')?.data.prompt).toContain('分析两张')
  })
  it('keeps ordinary single-source rendering separate from reference and analysis tasks', () => {
    const workflow = exteriorTaskWorkflowFixture()
    expect(workflow.nodes.map((node) => node.kind)).toEqual(['image-input', 'image-generate', 'gallery'])
    let id = 0
    const input = { task: defaultExteriorTask('landscape-redesign'), source: { assetId: 'a'.repeat(43) }, reference: { assetId: 'b'.repeat(43) }, prompt: '', model: 'gpt-image-1', candidateCount: 1 as const, createId: () => `node-${++id}` }
    expect(() => buildExteriorWorkflow(input)).toThrow('图片分析')
    expect(() => buildExteriorWorkflow({ ...input, analysis: { model: 'unknown-model' } })).toThrow()
    expect(() => buildExteriorWorkflow({ ...input, analysis: { model: 'gpt-4.1' }, reference: input.source })).toThrow('不同')
  })
})
