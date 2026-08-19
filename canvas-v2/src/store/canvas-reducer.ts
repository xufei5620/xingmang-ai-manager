import type { CanvasCommand } from './canvas-command'
import type { CanvasDocumentState } from './canvas-state'

function nextRevision(document: CanvasDocumentState): number {
  return document.revision + 1
}

function samePosition(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return left.x === right.x && left.y === right.y
}

export function reduceCanvasDocument(document: CanvasDocumentState, command: CanvasCommand): CanvasDocumentState {
  switch (command.type) {
    case 'add-nodes': {
      const existingNodeIds = new Set(document.nodes.map((node) => node.id))
      const existingEdgeIds = new Set(document.edges.map((edge) => edge.id))
      if (command.nodes.some((node) => existingNodeIds.has(node.id))) throw new Error('新增节点标识已存在')
      if ((command.edges ?? []).some((edge) => existingEdgeIds.has(edge.id))) throw new Error('新增连线标识已存在')
      const nextNodeIds = new Set([...existingNodeIds, ...command.nodes.map((node) => node.id)])
      if ((command.edges ?? []).some((edge) => !nextNodeIds.has(edge.source) || !nextNodeIds.has(edge.target))) {
        throw new Error('新增连线指向不存在的节点')
      }
      return {
        ...document,
        nodes: [...document.nodes, ...command.nodes.map((node) => structuredClone(node))],
        edges: [...document.edges, ...(command.edges ?? []).map((edge) => ({ ...edge }))],
        revision: nextRevision(document),
      }
    }
    case 'update-node-data': {
      let changed = false
      const nodes = document.nodes.map((node) => {
        if (node.id !== command.nodeId) return node
        changed = true
        return { ...node, data: { ...node.data, ...command.patch } }
      })
      return changed ? { ...document, nodes, revision: nextRevision(document) } : document
    }
    case 'move-nodes': {
      let changed = false
      const nodes = document.nodes.map((node) => {
        const position = command.positions[node.id]
        if (node.locked || !position || samePosition(node.position, position)) return node
        changed = true
        return { ...node, position: { ...position } }
      })
      return changed ? { ...document, nodes, revision: nextRevision(document) } : document
    }
    case 'resize-nodes': {
      // Dimensions are document state, not transient view state: a resize has
      // to survive undo/redo and a project reload the same way a move does.
      let changed = false
      const nodes = document.nodes.map((node) => {
        const size = command.dimensions[node.id]
        if (node.locked || !size) return node
        if (node.width === size.width && node.height === size.height) return node
        changed = true
        return { ...node, width: size.width, height: size.height }
      })
      return changed ? { ...document, nodes, revision: nextRevision(document) } : document
    }
    case 'set-node-flags': {
      const nodeIds = new Set(command.nodeIds)
      let changed = false
      const nodes = document.nodes.map((node) => {
        if (!nodeIds.has(node.id)) return node
        const locked = command.locked ?? Boolean(node.locked)
        const cannotEnable = Boolean(node.unknownKind) || node.type === 'unknown'
        const disabled = command.disabled === undefined
          ? Boolean(node.disabled)
          : cannotEnable && command.disabled === false
            ? true
            : command.disabled
        if (locked === Boolean(node.locked) && disabled === Boolean(node.disabled)) return node
        changed = true
        return {
          ...node,
          ...(locked ? { locked: true } : { locked: undefined }),
          ...(disabled ? { disabled: true } : { disabled: undefined }),
        }
      })
      return changed ? { ...document, nodes, revision: nextRevision(document) } : document
    }
    case 'replace-nodes': {
      const ids = new Set(command.nodes.map((node) => node.id))
      if (ids.size !== command.nodes.length) throw new Error('替换节点包含重复标识')
      const edges = document.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      return { ...document, nodes: structuredClone(command.nodes), edges, revision: nextRevision(document) }
    }
    case 'insert-node-on-edge': {
      if (document.nodes.some((node) => node.id === command.node.id)) throw new Error('插入节点标识已存在')
      const edgeIndex = document.edges.findIndex((edge) => edge.id === command.edgeId)
      if (edgeIndex < 0) throw new Error('待插入的连线不存在')
      const original = document.edges[edgeIndex]
      if (command.before.source !== original.source || command.before.target !== command.node.id
        || command.after.source !== command.node.id || command.after.target !== original.target) {
        throw new Error('插入节点连线关系无效')
      }
      const edgeIds = new Set(document.edges.map((edge) => edge.id))
      if (command.before.id === command.after.id || edgeIds.has(command.before.id) || edgeIds.has(command.after.id)) {
        throw new Error('插入节点连线标识已存在')
      }
      return {
        ...document,
        nodes: [...document.nodes, structuredClone(command.node)],
        edges: [...document.edges.slice(0, edgeIndex), { ...command.before }, { ...command.after }, ...document.edges.slice(edgeIndex + 1)],
        revision: nextRevision(document),
      }
    }
    case 'delete-elements': {
      const nodeIds = new Set(command.nodeIds)
      const edgeIds = new Set(command.edgeIds ?? [])
      const nodes = document.nodes.filter((node) => !nodeIds.has(node.id))
      const edges = document.edges.filter((edge) => (
        !edgeIds.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target)
      ))
      if (nodes.length === document.nodes.length && edges.length === document.edges.length) return document
      // Bridges heal the chain the removal broke. They are part of the same
      // command so one undo restores both the node and its original wiring.
      const surviving = new Set(nodes.map((node) => node.id))
      const bridged = (command.bridges ?? []).filter((edge) => (
        surviving.has(edge.source)
        && surviving.has(edge.target)
        && !edges.some((entry) => entry.id === edge.id)
      ))
      return { ...document, nodes, edges: [...edges, ...bridged.map((edge) => ({ ...edge }))], revision: nextRevision(document) }
    }
    case 'connect': {
      if (document.edges.some((edge) => edge.id === command.edge.id)) throw new Error('连线标识已存在')
      const nodeIds = new Set(document.nodes.map((node) => node.id))
      if (!nodeIds.has(command.edge.source) || !nodeIds.has(command.edge.target)) throw new Error('连线指向不存在的节点')
      return { ...document, edges: [...document.edges, { ...command.edge }], revision: nextRevision(document) }
    }
    case 'disconnect': {
      const ids = new Set(command.edgeIds)
      const edges = document.edges.filter((edge) => !ids.has(edge.id))
      return edges.length === document.edges.length ? document : { ...document, edges, revision: nextRevision(document) }
    }
    case 'reconnect-edge': {
      // Retargeting is one user gesture, so it must be one history entry
      // rather than a disconnect the user has to undo twice.
      const index = document.edges.findIndex((edge) => edge.id === command.edgeId)
      if (index < 0) throw new Error('要改接的连线不存在')
      const nodeIds = new Set(document.nodes.map((node) => node.id))
      if (!nodeIds.has(command.edge.source) || !nodeIds.has(command.edge.target)) throw new Error('连线指向不存在的节点')
      if (command.edge.id !== command.edgeId && document.edges.some((edge) => edge.id === command.edge.id)) {
        throw new Error('连线标识已存在')
      }
      const edges = [...document.edges]
      edges[index] = { ...command.edge }
      return { ...document, edges, revision: nextRevision(document) }
    }
    case 'set-viewport':
      return { ...document, viewport: { ...command.viewport }, revision: nextRevision(document) }
    case 'set-media-groups': {
      const current = document.mediaGroups ?? {}
      if (current.image === command.mediaGroups.image && current.video === command.mediaGroups.video) return document
      return { ...document, mediaGroups: { ...command.mediaGroups }, revision: nextRevision(document) }
    }
    case 'replace-document':
      return { ...structuredClone(command.document), revision: nextRevision(document) }
    case 'rename-document':
      return command.name === document.name ? document : { ...document, name: command.name, revision: nextRevision(document) }
  }
}
