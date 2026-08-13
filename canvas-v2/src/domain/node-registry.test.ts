import { describe, expect, it } from 'vitest'
import { builtinNodeDefinitions, builtinNodeRegistry, resolveLegacyDefinitionType } from './builtin-node-definitions'
import { createNodeRegistry } from './node-registry'

describe('node registry', () => {
  it('contains ten orthogonal media definitions and structural primitives', () => {
    const types = builtinNodeRegistry.list().map((entry) => entry.type)
    expect(types).toEqual(expect.arrayContaining([
      'prompt', 'image-input', 'video-input', 'image-generate', 'image-edit',
      'video-generate', 'frame-extract', 'router', 'gallery', 'output', 'group', 'note', 'unknown',
    ]))
  })

  it('creates independent default data', () => {
    const first = builtinNodeRegistry.create('image-generate', 'a', { x: 1, y: 2 })
    const second = builtinNodeRegistry.create('image-generate', 'b', { x: 3, y: 4 })
    first.data.prompt = 'changed'
    expect(second.data.prompt).toBe('')
  })

  it('rejects duplicate types and duplicate port ids', () => {
    expect(() => createNodeRegistry([builtinNodeDefinitions[0], builtinNodeDefinitions[0]])).toThrow('节点类型重复')
    expect(() => createNodeRegistry([{
      ...builtinNodeDefinitions[0],
      type: 'bad-ports',
      ports: [builtinNodeDefinitions[0].ports[0], builtinNodeDefinitions[0].ports[0]],
    }])).toThrow('节点端口重复')
  })

  it('resolves legacy node aliases without removing legacy definitions', () => {
    expect(resolveLegacyDefinitionType('text')).toBe('prompt')
    expect(resolveLegacyDefinitionType('image')).toBe('image-generate')
    expect(resolveLegacyDefinitionType('video')).toBe('video-generate')
    expect(builtinNodeRegistry.require('image').executorKind).toBe('image')
  })

  it('keeps group, note, and unknown non-executable', () => {
    for (const type of ['group', 'note', 'unknown']) {
      expect(builtinNodeRegistry.require(type)).toMatchObject({ executable: false, structural: true })
    }
  })
})
