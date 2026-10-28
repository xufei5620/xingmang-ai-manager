import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile } from '../model'
import { editorNodeToCanvasNode, toCanvasNode, toCanvasRunGraph, toWorkflowNode } from '../App'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { officialPromptSnapshot, projectPrompt, promptDocument } from '../library/prompt-references'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'

function workflow(): WorkflowFile {
  const snapshot = officialPromptSnapshot('xingmang-product-studio')!
  const prompt = `前文 ${snapshot.prompt} 追加自然光`
  return { ...createEmptyWorkflow('Official reference'), nodes: [{ id: 'prompt', kind: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt, promptReferences: [{ start: 3, end: 3 + snapshot.prompt.length, ...snapshot }], model: '', status: 'idle' } }] }
}

describe('official prompt persistence and execution boundary', () => {
  it('preserves the body and versioned chip after actual editor save, reopen and undo record hydration', () => {
    const original = workflow()
    const live = toCanvasNode(original.nodes[0])
    const hydrated = editorNodeToCanvasNode(canvasNodeDocumentRecord(live))
    const saved = serializeWorkflow({ ...original, nodes: [toWorkflowNode(hydrated)] })
    const restored = parseWorkflowFile(saved)!
    expect(restored.nodes[0].data.prompt).toBe(original.nodes[0].data.prompt)
    expect(restored.nodes[0].data.promptReferences).toEqual(original.nodes[0].data.promptReferences)
    expect(projectPrompt(promptDocument(restored.nodes[0].data.prompt, restored.nodes[0].data.promptReferences)).text).toBe('前文 #商品棚拍 官方 追加自然光')
  })

  it('retains snapshots in personal node and group configurations without forwarding private runtime state', () => {
    for (const kind of ['node', 'group'] as const) {
      const original = workflow()
      const saved = sanitizeWorkshopWorkflow(original, kind, 'Reusable official prompt')
      const inserted = instantiateWorkshopGraph(saved, () => 'fresh-node')
      expect(inserted.nodes[0].data.promptReferences).toEqual(original.nodes[0].data.promptReferences)
      expect(inserted.nodes[0].data.prompt).toBe(original.nodes[0].data.prompt)
      expect(parseWorkflowFile(serializeWorkflow(inserted))?.nodes[0].data.promptReferences).toEqual(original.nodes[0].data.promptReferences)
    }
  })

  it('roundtrips a downloaded workshop node file through its actual canonical import sanitizer', () => {
    const original = workflow()
    const file = buildWorkshopTransferFile({ kind: 'node', name: 'Official snapshot', description: '', category: 'general', tags: [], nodeCount: 1, edgeCount: 0, nodeKinds: ['prompt'], workflow: original }, { kind: 'personal' })
    const imported = parseWorkshopTransferFile(serializeWorkshopTransferFile(file))
    expect(imported.snapshot.workflow?.nodes[0].data.prompt).toBe(original.nodes[0].data.prompt)
    expect(imported.snapshot.workflow?.nodes[0].data.promptReferences).toEqual(original.nodes[0].data.promptReferences)
  })

  it('preserves whitespace and reference offsets while safely degrading metadata when redaction changes preceding prose', () => {
    const original = workflow()
    const data = original.nodes[0].data
    data.prompt = '   ' + data.prompt + '  '
    data.promptReferences = data.promptReferences!.map((reference) => ({ ...reference, start: reference.start + 3, end: reference.end + 3 }))
    const saved = sanitizeWorkshopWorkflow(original, 'node', 'Whitespace preserved')
    expect(saved.nodes[0].data.prompt).toBe(data.prompt)
    expect(saved.nodes[0].data.promptReferences).toEqual(data.promptReferences)
    expect(saved.nodes[0].data.promptReferences?.[0].start).toBe(6)
    expect(parseWorkflowFile(serializeWorkflow(saved))?.nodes[0].data).toMatchObject({ prompt: data.prompt, promptReferences: data.promptReferences })
    const secret = workflow()
    const prefix = ' \tpassword=x '
    secret.nodes[0].data.prompt = prefix + secret.nodes[0].data.prompt + '\n\n'
    secret.nodes[0].data.promptReferences = secret.nodes[0].data.promptReferences!.map((reference) => ({ ...reference, start: reference.start + prefix.length, end: reference.end + prefix.length }))
    const redacted = sanitizeWorkshopWorkflow(secret, 'node', 'Redacted')
    expect(redacted.nodes[0].data.prompt).toBe(' \tpassword=[已隐藏密钥] ' + workflow().nodes[0].data.prompt + '\n\n')
    expect(redacted.nodes[0].data.prompt).toContain(officialPromptSnapshot('xingmang-product-studio')!.prompt)
    expect(JSON.stringify(redacted)).not.toContain('password=x')
    expect(redacted.nodes[0].data.promptReferences).toBeUndefined()
    expect(secret.nodes[0].data.prompt).toContain('password=x')
  })

  it('sends only fully expanded prose in a real canvas run graph and keeps internal IDs out of the request', () => {
    const original = workflow()
    const graph = toCanvasRunGraph(original.nodes.map(toCanvasNode), [], { image: '', video: '' })
    expect(graph.nodes[0].data.prompt).toBe(original.nodes[0].data.prompt)
    expect(JSON.stringify(graph)).not.toContain('promptReferences')
    expect(JSON.stringify(graph)).not.toContain('xingmang-product-studio')
    expect(JSON.stringify(graph)).not.toContain('#商品棚拍 官方')
  })

  it('keeps legacy prompt strings unchanged and preserves prose if a new snapshot cannot be verified', () => {
    const original = workflow()
    delete original.nodes[0].data.promptReferences
    expect(parseWorkflowFile(serializeWorkflow(original))?.nodes[0].data.prompt).toBe(original.nodes[0].data.prompt)
    const raw = JSON.parse(serializeWorkflow(workflow()))
    raw.nodes[0].data.promptReferences[0].version = 999
    const restored = parseWorkflowFile(JSON.stringify(raw))!
    expect(restored.nodes[0].data.prompt).toBe(workflow().nodes[0].data.prompt)
    expect(restored.nodes[0].data.promptReferences).toBeUndefined()
  })
})
