import { describe, expect, it } from 'vitest'
import {
  compatibleInsertionHandle,
  connectionForInsertedNode,
  isValidWorkflowConnection,
  type ConnectionGraphView,
} from './ports'
import { nodeInputKinds } from './model'

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

  it('accepts multiple image inputs for image editing and video generation', () => {
    const existing = [{ source: 'image-a', target: 'video', targetHandle: 'in:images' }]
    expect(isValidWorkflowConnection(
      { source: 'image-b', sourceHandle: 'out:image', target: 'video', targetHandle: 'in:images' },
      graph({ 'image-a': 'image-input', 'image-b': 'image-input', video: 'video-generate' }, existing),
    )).toBe(true)
    expect(isValidWorkflowConnection(
      { source: 'image-b', sourceHandle: 'out:image', target: 'edit', targetHandle: 'in:images' },
      graph({ 'image-b': 'image-input', edit: 'image-edit' }, [{ source: 'image-a', target: 'edit', targetHandle: 'in:images' }]),
    )).toBe(true)
  })

  it('accepts multiple text, image, and audio inputs for video generation', () => {
    const types = {
      'prompt-a': 'prompt', 'prompt-b': 'prompt',
      'image-a': 'image-input', 'image-b': 'image-input',
      'audio-a': 'audio-input', 'audio-b': 'audio-input',
      target: 'video-generate',
    }
    const existing = [
      { source: 'prompt-a', target: 'target', targetHandle: 'in:text' },
      { source: 'image-a', target: 'target', targetHandle: 'in:images' },
      { source: 'audio-a', target: 'target', targetHandle: 'in:audios' },
    ]
    expect(isValidWorkflowConnection(
      { source: 'prompt-b', sourceHandle: 'out:text', target: 'target', targetHandle: 'in:text' },
      graph(types, existing),
    )).toBe(true)
    expect(isValidWorkflowConnection(
      { source: 'image-b', sourceHandle: 'out:image', target: 'target', targetHandle: 'in:images' },
      graph(types, existing),
    )).toBe(true)
    expect(isValidWorkflowConnection(
      { source: 'audio-b', sourceHandle: 'out:audio', target: 'target', targetHandle: 'in:audios' },
      graph(types, existing),
    )).toBe(true)
  })

  it('keeps the legacy video alias on the same multi-input contract', () => {
    expect(nodeInputKinds.video).toEqual(['text', 'image', 'video', 'audio'])
    const existing = [
      { source: 'prompt-a', target: 'target', targetHandle: 'in:text' },
      { source: 'image-a', target: 'target', targetHandle: 'in:images' },
      { source: 'audio-a', target: 'target', targetHandle: 'in:audios' },
    ]
    expect(isValidWorkflowConnection(
      { source: 'image-b', sourceHandle: 'out:image', target: 'target', targetHandle: 'in:images' },
      graph({ 'image-b': 'image-input', target: 'video' }, existing),
    )).toBe(true)
    expect(isValidWorkflowConnection(
      { source: 'audio-b', sourceHandle: 'out:audio', target: 'target', targetHandle: 'in:audios' },
      graph({ 'audio-b': 'audio-input', target: 'video' }, existing),
    )).toBe(true)
  })

  it('does not expose video or audio inputs on image editing', () => {
    expect(nodeInputKinds['image-edit']).toEqual(['text', 'image'])
    expect(nodeInputKinds['video-generate']).toEqual(['text', 'image', 'video', 'audio'])
    expect(isValidWorkflowConnection(
      { source: 'video', sourceHandle: 'out:video', target: 'edit', targetHandle: 'in:videos' },
      graph({ video: 'video-input', edit: 'image-edit' }),
    )).toBe(false)
    expect(isValidWorkflowConnection(
      { source: 'audio', sourceHandle: 'out:audio', target: 'edit', targetHandle: 'in:audios' },
      graph({ audio: 'audio-input', edit: 'image-edit' }),
    )).toBe(false)
  })

  it('allows reference videos on video generation', () => {
    expect(isValidWorkflowConnection(
      { source: 'video', sourceHandle: 'out:video', target: 'generate', targetHandle: 'in:videos' },
      graph({ video: 'video-input', generate: 'video-generate' }),
    )).toBe(true)
  })

  it('keeps legacy text, image, and video aliases compatible', () => {
    expect(isValidWorkflowConnection(
      { source: 'text', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' },
      graph({ text: 'text', image: 'image' }),
    )).toBe(true)
  })

  it('finds only compatible nodes when a source connection ends on the pane', () => {
    const current = graph({ image: 'image-generate' })
    const pending = { nodeId: 'image', handleId: 'out:image', handleType: 'source' as const }
    expect(compatibleInsertionHandle('video-generate', pending, current)).toBe('in:images')
    expect(compatibleInsertionHandle('prompt', pending, current)).toBeNull()
    expect(connectionForInsertedNode(pending, 'video', 'in:images')).toEqual({
      source: 'image', sourceHandle: 'out:image', target: 'video', targetHandle: 'in:images',
    })
  })

  it('supports starting from a many-image target even when it already has inputs', () => {
    const pending = { nodeId: 'video', handleId: 'in:images', handleType: 'target' as const }
    expect(compatibleInsertionHandle(
      'image-generate',
      pending,
      graph({ video: 'video-generate' }),
    )).toBe('out:image')
    expect(compatibleInsertionHandle(
      'image-generate',
      pending,
      graph({ video: 'video-generate' }, [{ source: 'existing', target: 'video', targetHandle: 'in:images' }]),
    )).toBe('out:image')
  })
})
