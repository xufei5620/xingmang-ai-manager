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
export function createNodeRendererRegistry<TNode extends Node = RegistryCanvasNode>(
  registry: NodeRegistry,
  renderers: Readonly<Record<string, ComponentType<NodeProps<TNode>>>>,
  unknownRenderer: ComponentType<NodeProps<TNode>>,
): Record<string, ComponentType<NodeProps<TNode>>> {
  const resolved: Record<string, ComponentType<NodeProps<TNode>>> = {}
  for (const definition of registry.list()) {
    resolved[definition.type] = renderers[definition.type] ?? unknownRenderer
  }
  return resolved
}
