import type { ComponentType } from 'react'
import type { NodeProps, Node } from '@xyflow/react'
import type { NodeRegistry } from '../domain/node-registry'

export type RegistryCanvasNode = Node<Record<string, unknown>, string>
export type RegistryNodeRenderer = ComponentType<NodeProps<RegistryCanvasNode>>

/**
 * Renderer registration stays separate from the framework-free domain registry.
 * Definitions may exist before their UI ships; those entries deliberately use
 * the disabled placeholder instead of making the whole document unreadable.
 */
export function createNodeRendererRegistry(
  registry: NodeRegistry,
  renderers: Readonly<Record<string, RegistryNodeRenderer>>,
  unknownRenderer: RegistryNodeRenderer,
): Record<string, RegistryNodeRenderer> {
  const resolved: Record<string, RegistryNodeRenderer> = {}
  for (const definition of registry.list()) {
    resolved[definition.type] = renderers[definition.type] ?? unknownRenderer
  }
  return resolved
}
