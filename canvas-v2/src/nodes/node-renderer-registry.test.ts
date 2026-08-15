import { describe, expect, it } from 'vitest'
import type { NodeProps } from '@xyflow/react'
import type { RegistryCanvasNode } from './node-renderer-registry'
import { createNodeRendererRegistry } from './node-renderer-registry'
import { createNodeRegistry } from '../domain/node-registry'
import { validNodeData, type NodeDefinition } from '../domain/node-definition'

function definition(type: string): NodeDefinition {
  return {
    type,
    version: 1,
    title: type,
    description: type,
    category: 'structural',
    ports: [],
    dimensions: { width: 100, height: 100 },
    defaultData: {},
    executable: false,
    structural: true,
    validate: () => validNodeData(),
  }
}

describe('node renderer registry', () => {
  it('uses the disabled placeholder when a definition has no renderer', () => {
    const Known = (_props: NodeProps<RegistryCanvasNode>) => null
    const Unknown = (_props: NodeProps<RegistryCanvasNode>) => null
    const registry = createNodeRegistry([definition('known'), definition('future')])
    const renderers = createNodeRendererRegistry(registry, { known: Known }, Unknown)

    expect(renderers.known).toBe(Known)
    expect(renderers.future).toBe(Unknown)
  })
})
