import type {
  CanvasTemplate,
  InstantiateTemplateOptions,
  TemplateInstance,
} from './template-types'
import { validateCanvasTemplate, validateTemplateVariablePath } from './validate-template'
const assetIdPattern = /^[A-Za-z0-9_-]{43}$/

function setPath(config: Record<string, unknown>, path: string, value: unknown): void {
  const segments = validateTemplateVariablePath(path)
  let target = config
  for (const segment of segments.slice(0, -1)) {
    const current = target[segment]
    if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
      throw new Error(`模板变量路径冲突：${path}`)
    }
    if (current === undefined) target[segment] = Object.create(null) as Record<string, unknown>
    target = target[segment] as Record<string, unknown>
  }
  target[segments[segments.length - 1]] = structuredClone(value)
}

export function instantiateTemplate(template: CanvasTemplate, options: InstantiateTemplateOptions): TemplateInstance {
  validateCanvasTemplate(template, { availableNodeTypes: options.availableNodeTypes })
  const idMap = new Map<string, string>()
  const issued = new Set<string>()
  function nextId(): string {
    const id = options.createId()
    if (!id || issued.has(id)) throw new Error('无法为模板生成唯一 ID')
    issued.add(id)
    return id
  }
  const nodes = template.workflow.nodes.map((node) => {
    const id = nextId()
    idMap.set(node.id, id)
    return { ...structuredClone(node), id }
  })
  const nodeByOriginalId = new Map(template.workflow.nodes.map((node, index) => [node.id, nodes[index]]))
  for (const variable of template.variables) {
    const value = options.values?.[variable.id] ?? variable.defaultValue
    if (!options.draft && variable.required && (value === undefined || value === null || value === '')) {
      throw new Error(`请填写模板变量：${variable.label}`)
    }
    if (value === undefined) continue
    if (variable.type === 'select' && variable.options && !variable.options.includes(String(value))) {
      throw new Error(`模板变量 ${variable.label} 的选项无效`)
    }
    if (variable.type === 'asset' && (typeof value !== 'string' || !assetIdPattern.test(value))) {
      throw new Error(`模板变量 ${variable.label} 的素材标识无效`)
    }
    const node = nodeByOriginalId.get(variable.target.nodeId)
    if (!node) throw new Error(`模板变量引用了不存在的节点：${variable.target.nodeId}`)
    setPath(node.config, variable.target.path, value)
  }
  const edges = template.workflow.edges.map((edge) => ({
    ...structuredClone(edge),
    id: nextId(),
    source: idMap.get(edge.source) as string,
    target: idMap.get(edge.target) as string,
  }))
  return {
    templateId: template.id,
    templateVersion: template.version,
    name: template.name,
    nodes,
    edges,
    autoRun: false,
  }
}

export function placeTemplateInstance(
  instance: TemplateInstance,
  existingNodes: ReadonlyArray<{ position: { x: number; y: number }; height?: number }>,
): TemplateInstance {
  if (existingNodes.length === 0 || instance.nodes.length === 0) return structuredClone(instance)
  const templateMinX = Math.min(...instance.nodes.map((node) => node.position.x))
  const templateMinY = Math.min(...instance.nodes.map((node) => node.position.y))
  const existingMinX = Math.min(...existingNodes.map((node) => node.position.x))
  const existingBottom = Math.max(...existingNodes.map((node) => node.position.y + (node.height ?? 220)))
  const offset = { x: existingMinX - templateMinX, y: existingBottom + 80 - templateMinY }
  return {
    ...structuredClone(instance),
    nodes: instance.nodes.map((node) => ({
      ...structuredClone(node),
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
    })),
  }
}
