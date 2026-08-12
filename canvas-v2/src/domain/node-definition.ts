import type { PortKind, WorkflowNodeData } from '../model'

export type NodeCategory = 'input' | 'generation' | 'transform' | 'flow' | 'output' | 'structural'
export type PortDirection = 'input' | 'output'
export type PortCardinality = 'one' | 'many'
export type NodeExecutorKind = 'prompt' | 'image' | 'video' | 'transform' | 'flow' | 'output'

export interface NodePortDefinition {
  id: string
  label: string
  direction: PortDirection
  kind: PortKind
  cardinality: PortCardinality
  required?: boolean
}

export interface NodeDimensions {
  width: number
  height: number
}

export interface NodeCapabilityRequirement {
  media: 'text' | 'image' | 'video'
  operation: 'input' | 'generate' | 'edit' | 'extract' | 'route' | 'collect' | 'output'
}

export interface NodeDataValidation {
  valid: boolean
  errors: string[]
}

export interface NodeDefinition<TData extends Record<string, unknown> = Record<string, unknown>> {
  type: string
  version: number
  title: string
  description: string
  category: NodeCategory
  ports: readonly NodePortDefinition[]
  dimensions: NodeDimensions
  defaultData: TData
  executable: boolean
  structural: boolean
  executorKind?: NodeExecutorKind
  capabilities?: readonly NodeCapabilityRequirement[]
  validate(data: unknown): NodeDataValidation
  migrate?(data: unknown, fromVersion: number): TData | null
}

export interface EditorNodeRecord<TData extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  type: string
  definitionVersion: number
  position: { x: number; y: number }
  data: TData
  parentId?: string
  width?: number
  height?: number
  locked?: boolean
  disabled?: boolean
  unknownKind?: string
  selected?: boolean
}

export interface EditorEdgeRecord {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
  selected?: boolean
}

export interface LegacyNodeAdapter {
  legacyType: 'text' | 'image' | 'video'
  definitionType: 'prompt' | 'image-generate' | 'video-generate'
  toDefinitionData(data: WorkflowNodeData): Record<string, unknown>
}

export function validNodeData(): NodeDataValidation {
  return { valid: true, errors: [] }
}

export function invalidNodeData(...errors: string[]): NodeDataValidation {
  return { valid: false, errors }
}
