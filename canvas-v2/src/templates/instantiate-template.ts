import type {
  CanvasTemplate,
  InstantiateTemplateOptions,
  TemplateEdge,
  TemplateInstance,
  TemplateNode,
} from './template-types'

const maximumTemplateNodes = 100
const maximumTemplateEdges = 400
const credentialKeyPattern = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)/i
const assetIdPattern = /^[A-Za-z0-9_-]{43}$/

function setPath(config: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  if (segments.length === 0 || segments.some((segment) => !segment || credentialKeyPattern.test(segment))) {
    throw new Error(`模板变量路径无效：${path}`)
  }
  let target = config
  for (const segment of segments.slice(0, -1)) {
    const current = target[segment]
    if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
      throw new Error(`模板变量路径冲突：${path}`)
    }
    if (current === undefined) target[segment] = {}
    target = target[segment] as Record<string, unknown>
  }
  target[segments[segments.length - 1]] = structuredClone(value)
}

function assertSecretFree(value: unknown, path = 'config'): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`
    if (credentialKeyPattern.test(key)) throw new Error(`模板禁止包含凭据字段：${childPath}`)
    assertSecretFree(child, childPath)
  }
}

function assertAcyclic(nodes: readonly TemplateNode[], edges: readonly TemplateEdge[]): void {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) throw new Error(`模板连线引用了不存在的节点：${edge.id}`)
    outgoing.get(edge.source)?.push(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id)
  let visited = 0
  while (ready.length > 0) {
    const id = ready.shift() as string
    visited += 1
    for (const target of outgoing.get(id) ?? []) {
      const count = (indegree.get(target) ?? 0) - 1
      indegree.set(target, count)
      if (count === 0) ready.push(target)
    }
  }
  if (visited !== nodes.length) throw new Error('模板工作流不能包含环')
}

function validateTemplate(template: CanvasTemplate, availableNodeTypes: ReadonlySet<string>): void {
  if (template.workflow.nodes.length === 0 || template.workflow.nodes.length > maximumTemplateNodes) throw new Error('模板节点数量无效')
  if (template.workflow.edges.length > maximumTemplateEdges) throw new Error('模板连线数量过多')
  if (template.provenance.kind !== 'xingmang-original') throw new Error('内置模板来源无效')
  const missing = template.requiredNodeTypes.filter((type) => !availableNodeTypes.has(type))
  if (missing.length > 0) throw new Error(`当前版本缺少模板所需节点：${missing.join('、')}`)
  const nodeIds = new Set<string>()
  for (const node of template.workflow.nodes) {
    if (nodeIds.has(node.id)) throw new Error(`模板节点 ID 重复：${node.id}`)
    if (!availableNodeTypes.has(node.type)) throw new Error(`模板包含未知节点：${node.type}`)
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) throw new Error(`模板节点坐标无效：${node.id}`)
    assertSecretFree(node.config)
    nodeIds.add(node.id)
  }
  assertAcyclic(template.workflow.nodes, template.workflow.edges)
}

export function instantiateTemplate(template: CanvasTemplate, options: InstantiateTemplateOptions): TemplateInstance {
  validateTemplate(template, options.availableNodeTypes)
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
