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
        if (!position || samePosition(node.position, position)) return node
        changed = true
        return { ...node, position: { ...position } }
      })
      return changed ? { ...document, nodes, revision: nextRevision(document) } : document
    }
    case 'replace-nodes': {
      const ids = new Set(command.nodes.map((node) => node.id))
      if (ids.size !== command.nodes.length) throw new Error('替换节点包含重复标识')
      const edges = document.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      return { ...document, nodes: structuredClone(command.nodes), edges, revision: nextRevision(document) }
    }
    case 'delete-elements': {
      const nodeIds = new Set(command.nodeIds)
      const edgeIds = new Set(command.edgeIds ?? [])
      const nodes = document.nodes.filter((node) => !nodeIds.has(node.id))
      const edges = document.edges.filter((edge) => (
        !edgeIds.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target)
      ))
      if (nodes.length === document.nodes.length && edges.length === document.edges.length) return document
      return { ...document, nodes, edges, revision: nextRevision(document) }
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
