import type {
  EditorNodeRecord,
  NodeDefinition,
  NodePortDefinition,
} from './node-definition'

export interface NodeRegistry {
  list(): readonly NodeDefinition[]
  resolve(type: string): NodeDefinition | null
  require(type: string): NodeDefinition
  create(type: string, id: string, position: { x: number; y: number }): EditorNodeRecord
  port(type: string, portId: string, direction?: NodePortDefinition['direction']): NodePortDefinition | null
}

function cloneData(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value)
}

function validateDefinition(definition: NodeDefinition): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(definition.type)) throw new Error(`节点类型格式错误：${definition.type}`)
  if (!Number.isInteger(definition.version) || definition.version < 1) throw new Error(`节点版本无效：${definition.type}`)
  if (!definition.title.trim()) throw new Error(`节点标题为空：${definition.type}`)
  if (definition.executable === definition.structural) {
    throw new Error(`节点必须明确为执行型或结构型：${definition.type}`)
  }
  if (definition.executable && !definition.executorKind) throw new Error(`执行节点缺少执行器：${definition.type}`)
  if (definition.dimensions.width < 80 || definition.dimensions.height < 40) {
    throw new Error(`节点默认尺寸无效：${definition.type}`)
  }
  const portIds = new Set<string>()
  for (const port of definition.ports) {
    if (!/^(in|out):[a-z][a-z0-9-]{0,63}$/.test(port.id)) throw new Error(`节点端口格式错误：${definition.type}/${port.id}`)
    if (port.direction === 'input' && !port.id.startsWith('in:')) throw new Error(`输入端口方向错误：${definition.type}/${port.id}`)
    if (port.direction === 'output' && !port.id.startsWith('out:')) throw new Error(`输出端口方向错误：${definition.type}/${port.id}`)
    if (portIds.has(port.id)) throw new Error(`节点端口重复：${definition.type}/${port.id}`)
    portIds.add(port.id)
  }
  const validation = definition.validate(definition.defaultData)
  if (!validation.valid) throw new Error(`节点默认数据无效：${definition.type}`)
}

export function createNodeRegistry(definitions: readonly NodeDefinition[]): NodeRegistry {
  const byType = new Map<string, NodeDefinition>()
  for (const definition of definitions) {
    validateDefinition(definition)
    if (byType.has(definition.type)) throw new Error(`节点类型重复：${definition.type}`)
    byType.set(definition.type, Object.freeze({ ...definition, ports: Object.freeze([...definition.ports]) }))
  }
  const ordered = Object.freeze([...byType.values()])
  return {
    list() {
      return ordered
    },
    resolve(type) {
      return byType.get(type) ?? null
    },
    require(type) {
      const definition = byType.get(type)
      if (!definition) throw new Error(`未知节点类型：${type}`)
      return definition
    },
    create(type, id, position) {
      const definition = this.require(type)
      return {
        id,
        type,
        definitionVersion: definition.version,
        position: { ...position },
        data: cloneData(definition.defaultData),
        width: definition.dimensions.width,
        height: definition.dimensions.height,
        ...(type === 'unknown' ? { disabled: true } : {}),
      }
    },
    port(type, portId, direction) {
      const definition = byType.get(type)
      return definition?.ports.find((entry) => entry.id === portId && (!direction || entry.direction === direction)) ?? null
    },
  }
}
