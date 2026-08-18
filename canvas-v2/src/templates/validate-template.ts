import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { NodeRegistry } from '../domain/node-registry'
import type { CanvasTemplate, TemplateEdge, TemplateNode } from './template-types'

const maximumTemplateNodes = 100
const maximumTemplateEdges = 400
const boundedIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const credentialKeyPattern = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)/i
const forbiddenPathSegments = new Set(['__proto__', 'prototype', 'constructor'])

function assertSecretFree(value: unknown, path = 'config', visited = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return
  if (visited.has(value)) throw new Error(`模板配置不能包含循环引用：${path}`)
  visited.add(value)
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`
    if (credentialKeyPattern.test(key)) throw new Error(`模板禁止包含凭据字段：${childPath}`)
    if (forbiddenPathSegments.has(key)) throw new Error(`模板配置字段无效：${childPath}`)
    assertSecretFree(child, childPath, visited)
  }
  visited.delete(value)
}

function assertAcyclic(nodes: readonly TemplateNode[], edges: readonly TemplateEdge[]): void {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id)
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

function assertNoNodeOverlap(nodes: readonly TemplateNode[], registry: NodeRegistry): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const left = nodes[index]
    const leftSize = registry.require(left.type).dimensions
    for (let otherIndex = index + 1; otherIndex < nodes.length; otherIndex += 1) {
      const right = nodes[otherIndex]
      const rightSize = registry.require(right.type).dimensions
      const separated = left.position.x + leftSize.width <= right.position.x
        || right.position.x + rightSize.width <= left.position.x
        || left.position.y + leftSize.height <= right.position.y
        || right.position.y + rightSize.height <= left.position.y
      if (!separated) throw new Error(`模板节点发生重叠：${left.id}、${right.id}`)
    }
  }
}

function assertBoundedId(id: string, label: string): void {
  if (!boundedIdPattern.test(id)) throw new Error(`${label}格式无效：${id}`)
}

export function validateTemplateVariablePath(path: string): readonly string[] {
  const segments = path.split('.')
  if (segments.length === 0 || segments.some((segment) => (
    !segment || credentialKeyPattern.test(segment) || forbiddenPathSegments.has(segment)
  ))) throw new Error(`模板变量路径无效：${path}`)
  return segments
}

export interface ValidateCanvasTemplateOptions {
  registry?: NodeRegistry
  availableNodeTypes?: ReadonlySet<string>
}

export function validateCanvasTemplate(
  template: CanvasTemplate,
  options: ValidateCanvasTemplateOptions = {},
): void {
  const registry = options.registry ?? builtinNodeRegistry
  const availableNodeTypes = options.availableNodeTypes ?? new Set(registry.list().map((entry) => entry.type))
  assertBoundedId(template.id, '模板 ID ')
  if (!Number.isInteger(template.version) || template.version < 1) throw new Error('模板版本无效')
  if (!template.name.trim() || !template.description.trim()) throw new Error('模板名称或描述为空')
  if (template.workflow.nodes.length === 0 || template.workflow.nodes.length > maximumTemplateNodes) throw new Error('模板节点数量无效')
  if (template.workflow.edges.length > maximumTemplateEdges) throw new Error('模板连线数量过多')
  if (template.provenance.kind !== 'xingmang-original') throw new Error('内置模板来源无效')

  const nodeTypeSet = new Set(template.workflow.nodes.map((node) => node.type))
  const requiredTypeSet = new Set(template.requiredNodeTypes)
  if (requiredTypeSet.size !== template.requiredNodeTypes.length) throw new Error('模板所需节点类型重复')
  const missingDeclarations = [...nodeTypeSet].filter((type) => !requiredTypeSet.has(type))
  if (missingDeclarations.length > 0) throw new Error(`模板所需节点类型声明不完整：${missingDeclarations.join('、')}`)
  const missing = template.requiredNodeTypes.filter((type) => !availableNodeTypes.has(type))
  if (missing.length > 0) throw new Error(`当前版本缺少模板所需节点：${missing.join('、')}`)

  const nodeById = new Map<string, TemplateNode>()
  for (const node of template.workflow.nodes) {
    assertBoundedId(node.id, '模板节点 ID ')
    if (nodeById.has(node.id)) throw new Error(`模板节点 ID 重复：${node.id}`)
    const definition = registry.resolve(node.type)
    if (!definition || !availableNodeTypes.has(node.type)) throw new Error(`模板包含未知节点：${node.type}`)
    if (node.definitionVersion !== definition.version) throw new Error(`模板节点版本已过期：${node.id}`)
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)
      || Math.abs(node.position.x) > 10_000 || Math.abs(node.position.y) > 10_000) {
      throw new Error(`模板节点坐标无效：${node.id}`)
    }
    assertSecretFree(node.config)
    nodeById.set(node.id, node)
  }

  const edgeIds = new Set<string>()
  const onePortIncoming = new Map<string, string>()
  for (const edge of template.workflow.edges) {
    assertBoundedId(edge.id, '模板连线 ID ')
    if (edgeIds.has(edge.id)) throw new Error(`模板连线 ID 重复：${edge.id}`)
    edgeIds.add(edge.id)
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (!source || !target) throw new Error(`模板连线引用了不存在的节点：${edge.id}`)
    if (edge.source === edge.target) throw new Error(`模板连线不能自环：${edge.id}`)
    const sourcePort = registry.port(source.type, edge.sourceHandle, 'output')
    const targetPort = registry.port(target.type, edge.targetHandle, 'input')
    if (!sourcePort) throw new Error(`模板连线源端口无效：${edge.id}`)
    if (!targetPort) throw new Error(`模板连线目标端口无效：${edge.id}`)
    if (sourcePort.kind !== targetPort.kind) throw new Error(`模板连线媒体类型不匹配：${edge.id}`)
    if (targetPort.cardinality === 'one') {
      const key = `${edge.target}/${edge.targetHandle}`
      if (onePortIncoming.has(key)) throw new Error(`模板单输入端口存在多条连线：${edge.id}`)
      onePortIncoming.set(key, edge.id)
    }
  }
  assertAcyclic(template.workflow.nodes, template.workflow.edges)

  const variableIds = new Set<string>()
  for (const variable of template.variables) {
    assertBoundedId(variable.id, '模板变量 ID ')
    if (variableIds.has(variable.id)) throw new Error(`模板变量 ID 重复：${variable.id}`)
    variableIds.add(variable.id)
    if (!variable.label.trim()) throw new Error(`模板变量标签为空：${variable.id}`)
    if (!nodeById.has(variable.target.nodeId)) throw new Error(`模板变量引用了不存在的节点：${variable.target.nodeId}`)
    validateTemplateVariablePath(variable.target.path)
    if (variable.type === 'select') {
      if (!variable.options || variable.options.length === 0) throw new Error(`模板选项为空：${variable.id}`)
      const options = variable.options.map(String)
      if (new Set(options).size !== options.length) throw new Error(`模板选项重复：${variable.id}`)
      if (variable.defaultValue !== undefined && !options.includes(String(variable.defaultValue))) {
        throw new Error(`模板默认选项无效：${variable.id}`)
      }
    }
  }
  assertNoNodeOverlap(template.workflow.nodes, registry)
}
