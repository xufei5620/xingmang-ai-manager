import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { serializeXingCanvasProject } from '../persistence/project-package'
import { parseWorkflowFile, serializeWorkflow } from '../persistence/workflow-serializer'
import { parseProjectImport, removeMissingWorkflowAssets, workflowAssetReferences } from './workflow-import'
import { maximumProjectContentBytes, maximumProjectFileBytes, utf8ByteLength } from './canvas-limits'

const ownedId = 'o'.repeat(43)
const foreignId = 'f'.repeat(43)

function workflow(): WorkflowFile {
  return {
    ...createEmptyWorkflow('导入测试'),
    nodes: [
      { id: 'owned', kind: 'image-input', position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId: ownedId, localUrl: `xingmang-asset://image/${ownedId}` } } },
      { id: 'missing', kind: 'image-edit', position: { x: 400, y: 0 }, data: { prompt: '保留提示词', model: '', status: 'succeeded', result: { kind: 'image', assetId: foreignId, taskId: 'upstream-task' }, candidateAssetIds: [ownedId, foreignId], settings: { maskAssetId: foreignId } } },
    ],
    edges: [{ id: 'edge', source: 'owned', target: 'missing', sourceHandle: 'image-out', targetHandle: 'image-in' }],
  }
}

describe('workflow import boundaries', () => {
  it('accepts ordinary workflow and owned project packages through the same parser', () => {
    const source = workflow()
    expect(parseProjectImport(serializeWorkflow(source)).workflow.nodes).toHaveLength(2)
    expect(parseProjectImport(serializeXingCanvasProject(source)).workflow.nodes).toHaveLength(2)
  })

  it('indexes result, candidates and mask references by their real node IDs', () => {
    const refs = workflowAssetReferences(workflow())
    expect([...refs.get(ownedId) ?? []]).toEqual(['owned', 'missing'])
    expect([...refs.get(foreignId) ?? []]).toEqual(['missing'])
  })

  it('removes unavailable media while preserving graph and editable parameters', () => {
    const source = workflow()
    const cleaned = removeMissingWorkflowAssets(source, new Set([foreignId]))
    expect(cleaned.edges).toEqual(source.edges)
    expect(cleaned.nodes.map((node) => node.id)).toEqual(['owned', 'missing'])
    expect(cleaned.nodes[0].data.result?.assetId).toBe(ownedId)
    expect(cleaned.nodes[1].data.result).toBeUndefined()
    expect(cleaned.nodes[1].data.status).toBe('idle')
    expect(cleaned.nodes[1].data.prompt).toBe('保留提示词')
    expect(cleaned.nodes[1].data.candidateAssetIds).toEqual([ownedId])
    expect(cleaned.nodes[1].data.settings?.maskAssetId).toBeUndefined()
    expect(source.nodes[1].data.result?.assetId).toBe(foreignId)
    expect(parseWorkflowFile(serializeWorkflow(cleaned))).not.toBeNull()
  })

  it('does not resume task IDs from an exporting service', () => {
    const source = workflow()
    source.nodes[0].data.result = { kind: 'video', assetId: ownedId, taskId: 'external-task' }
    const cleaned = removeMissingWorkflowAssets(source, new Set())
    expect(cleaned.nodes[0].data.result?.assetId).toBe(ownedId)
    expect(cleaned.nodes[0].data.result?.taskId).toBeUndefined()
  })

  it('measures UTF-8 bytes instead of allowing multibyte content past storage bounds', () => {
    expect(utf8ByteLength('画布')).toBe(6)
    const source = createEmptyWorkflow('中文大文件')
    source.nodes = Array.from({ length: 8 }, (_, index) => ({ id: `prompt-${index}`, kind: 'prompt', position: { x: index * 100, y: 0 }, data: { prompt: '星'.repeat(90_000), model: '', status: 'idle' } }))
    const content = serializeWorkflow(source)
    expect(content.length).toBeLessThan(maximumProjectContentBytes)
    expect(utf8ByteLength(content)).toBeGreaterThan(maximumProjectFileBytes)
    expect(() => parseProjectImport(content)).toThrow('2 MB')
  })

  it('rejects excessive graph size before any database creation', () => {
    const source = createEmptyWorkflow('大型工作流')
    source.nodes = Array.from({ length: 2001 }, (_, index) => ({ id: `prompt-${index}`, kind: 'prompt', position: { x: index, y: 0 }, data: { prompt: '', model: '', status: 'idle' } }))
    expect(() => parseProjectImport(serializeWorkflow(source))).toThrow('2000')
  })
})

it('drops the complete missing LUT selection while preserving other grade settings and graph', () => {
  const source = workflow()
  source.nodes[1].data.settings = { imageTransform: { layers: [{ colorGrade: { version: 1, exposure: 2, curves: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, lut: { version: 1, enabled: true, strength: 50, source: { kind: 'asset', lutAssetId: foreignId, digest: 'd'.repeat(64), name: '自定', domainMin: [0, 0, 0], domainMax: [1, 1, 1] } } } }] } }
  const clean = removeMissingWorkflowAssets(source, new Set([foreignId]))
  const recipe = clean.nodes[1].data.settings?.imageTransform as { layers: Array<{ colorGrade: Record<string, unknown> }> }
  expect(recipe.layers[0].colorGrade).not.toHaveProperty('lut')
  expect(recipe.layers[0].colorGrade).toMatchObject({ exposure: 2, curves: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } })
  expect(clean.edges).toEqual(source.edges)
  expect(JSON.stringify(source)).toContain(foreignId)
})
