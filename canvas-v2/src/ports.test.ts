import { describe, expect, it } from 'vitest'
import { isValidWorkflowConnection, type ConnectionGraphView } from './ports'

function graph(types: Record<string, string>, edges: ConnectionGraphView['edges'] = []): ConnectionGraphView {
  return { nodeKindOf: (id) => types[id] ?? null, edges }
}

describe('registry driven ports', () => {
  it('accepts ports declared by new definitions', () => {
    expect(isValidWorkflowConnection(
      { source: 'prompt', sourceHandle: 'out:text', target: 'edit', targetHandle: 'in:text' },
      graph({ prompt: 'prompt', edit: 'image-edit' }),
    )).toBe(true)
  })

  it('rejects mismatched and undeclared handles', () => {
    expect(isValidWorkflowConnection(
      { source: 'image', sourceHandle: 'out:image', target: 'video', targetHandle: 'in:text' },
      graph({ image: 'image-input', video: 'video-generate' }),
    )).toBe(false)
    expect(isValidWorkflowConnection(
      { source: 'image', sourceHandle: 'out:missing', target: 'video', targetHandle: 'in:image' },
      graph({ image: 'image-input', video: 'video-generate' }),
    )).toBe(false)
  })

  it('enforces scalar input cardinality', () => {
    const existing = [{ source: 'image-a', target: 'video', targetHandle: 'in:image' }]
    expect(isValidWorkflowConnection(
      { source: 'image-b', sourceHandle: 'out:image', target: 'video', targetHandle: 'in:image' },
      graph({ 'image-a': 'image-input', 'image-b': 'image-input', video: 'video-generate' }, existing),
    )).toBe(false)
  })

  it('keeps legacy text, image, and video aliases compatible', () => {
    expect(isValidWorkflowConnection(
      { source: 'text', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' },
      graph({ text: 'text', image: 'image' }),
    )).toBe(true)
  })
})
