export type TemplateVariableType = 'text' | 'asset' | 'select'

export interface TemplatePosition {
  x: number
  y: number
}

export interface TemplateNode {
  id: string
  type: string
  definitionVersion: number
  position: TemplatePosition
  config: Record<string, unknown>
}

export interface TemplateEdge {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export interface TemplateVariable {
  id: string
  label: string
  type: TemplateVariableType
  required: boolean
  defaultValue?: unknown
  options?: readonly string[]
  target: { nodeId: string; path: string }
}

export interface CanvasTemplate {
  id: string
  version: number
  name: string
  description: string
  category: 'image' | 'video'
  tags: readonly string[]
  thumbnail: { kind: 'color'; value: string }
  requiredNodeTypes: readonly string[]
  workflow: {
    nodes: readonly TemplateNode[]
    edges: readonly TemplateEdge[]
  }
  variables: readonly TemplateVariable[]
  provenance: {
    kind: 'xingmang-original'
  }
}

export interface TemplateInstance {
  templateId: string
  templateVersion: number
  name: string
  nodes: TemplateNode[]
  edges: TemplateEdge[]
  autoRun: false
}

export interface InstantiateTemplateOptions {
  values?: Readonly<Record<string, unknown>>
  availableNodeTypes: ReadonlySet<string>
  createId(): string
  /** 编辑器载入模板时允许变量暂空；真正运行前仍由节点校验。 */
  draft?: boolean
}
