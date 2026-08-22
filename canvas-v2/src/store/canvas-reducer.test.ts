import { describe, expect, it } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import { applyCanvasCommand, canvasHistoryMergeWindowMs, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from './history'
import { collectDownstreamNodeIds, createCanvasDocument } from './canvas-state'
import { canvasNodeRuntimePatch, resolveDragTransaction, updateCanvasHistoryViewport } from './use-canvas-document'
import type { CanvasNode } from '../nodes/WorkflowNodes'

function node(id: string, x = 0): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, position: { x, y: 0 }, data: { prompt: id } }
}

describe('canvas command history', () => {
  it('creates a document with explicit empty media groups', () => {
    expect(createCanvasDocument().mediaGroups).toEqual({})
  })

  it('undoes and redoes structural commands', () => {
    let history = createCanvasHistory(createCanvasDocument())
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('a')] })
    expect(history.present.nodes).toHaveLength(1)
    history = undoCanvasHistory(history)
    expect(history.present.nodes).toHaveLength(0)
    history = redoCanvasHistory(history)
    expect(history.present.nodes.map((entry) => entry.id)).toEqual(['a'])
  })

  it('records a resize as document state so it survives undo and reload', () => {
    let history = createCanvasHistory(createCanvasDocument())
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('a')] })
    history = applyCanvasCommand(history, { type: 'resize-nodes', dimensions: { a: { width: 320, height: 240 } } })
    expect(history.present.nodes[0]).toMatchObject({ width: 320, height: 240 })

    history = undoCanvasHistory(history)
    expect(history.present.nodes[0].width).toBeUndefined()
    history = redoCanvasHistory(history)
    expect(history.present.nodes[0]).toMatchObject({ width: 320, height: 240 })
  })

  it('coalesces one resize gesture into a single undo entry', () => {
    let history = createCanvasHistory(createCanvasDocument())
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('a')] })
    const depth = history.past.length
    for (const width of [260, 280, 300, 320]) {
      history = applyCanvasCommand(history, { type: 'resize-nodes', dimensions: { a: { width, height: 200 } }, mergeKey: 'resize:1:a' })
    }
    expect(history.present.nodes[0].width).toBe(320)
    expect(history.past.length).toBe(depth + 1)
    history = undoCanvasHistory(history)
    expect(history.present.nodes[0].width).toBeUndefined()
  })

  it('merges a burst of edits to one node but starts fresh after a pause', () => {
    let history = createCanvasHistory(createCanvasDocument())
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('a')] }, 50, 0)
    const depth = history.past.length

    // A burst: same node, same merge key, keystrokes close together.
    history = applyCanvasCommand(history, { type: 'update-node-data', nodeId: 'a', patch: { prompt: '一只' }, mergeKey: 'data:a' }, 50, 100)
    history = applyCanvasCommand(history, { type: 'update-node-data', nodeId: 'a', patch: { prompt: '一只猫' }, mergeKey: 'data:a' }, 50, 900)
    expect(history.past.length).toBe(depth + 1)

    // Coming back later is a separate edit, even though the key is unchanged.
    history = applyCanvasCommand(history, { type: 'update-node-data', nodeId: 'a', patch: { prompt: '一只黑猫' }, mergeKey: 'data:a' }, 50, 900 + canvasHistoryMergeWindowMs + 1)
    expect(history.past.length).toBe(depth + 2)

    history = undoCanvasHistory(history)
    expect(history.present.nodes[0].data.prompt).toBe('一只猫')
  })

  it('keeps the merge window wide enough for IME word-by-word input', () => {
    // Each committed Chinese word arrives as its own command and the gaps
    // between them are long. A short window would shatter one sentence.
    expect(canvasHistoryMergeWindowMs).toBeGreaterThanOrEqual(2_000)
  })

  it('retargets a connection as one undoable command', () => {
    let history = createCanvasHistory({
      ...createCanvasDocument(),
      nodes: [node('a'), node('b', 240), node('c', 480)],
      edges: [{ id: 'e1', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' }],
    })
    history = applyCanvasCommand(history, {
      type: 'reconnect-edge',
      edgeId: 'e1',
      edge: { id: 'e1', source: 'a', sourceHandle: 'out:text', target: 'c', targetHandle: 'in:text' },
    })
    expect(history.present.edges).toHaveLength(1)
    expect(history.present.edges[0].target).toBe('c')

    // One gesture, one undo: the old wire must come back in a single step.
    history = undoCanvasHistory(history)
    expect(history.present.edges[0].target).toBe('b')
  })

  it('splices an existing node into a wire as one undoable command', () => {
    let history = createCanvasHistory({
      ...createCanvasDocument(),
      nodes: [node('a'), node('b', 240), node('loose', 120)],
      edges: [{ id: 'e1', source: 'a', sourceHandle: 'out:image', target: 'b', targetHandle: 'in:images' }],
    })
    history = applyCanvasCommand(history, {
      type: 'splice-node-on-edge',
      nodeId: 'loose',
      edgeId: 'e1',
      before: { id: 'x1', source: 'a', sourceHandle: 'out:image', target: 'loose', targetHandle: 'in:images' },
      after: { id: 'x2', source: 'loose', sourceHandle: 'out:image', target: 'b', targetHandle: 'in:images' },
    })
    // The node already existed, so only the wiring changes.
    expect(history.present.nodes).toHaveLength(3)
    expect(history.present.edges.map((entry) => entry.id)).toEqual(['x1', 'x2'])

    history = undoCanvasHistory(history)
    expect(history.present.edges.map((entry) => entry.id)).toEqual(['e1'])
  })

  it('rejects a splice whose wiring does not actually pass through the node', () => {
    const history = createCanvasHistory({
      ...createCanvasDocument(),
      nodes: [node('a'), node('b', 240), node('loose', 120)],
      edges: [{ id: 'e1', source: 'a', sourceHandle: 'out:image', target: 'b', targetHandle: 'in:images' }],
    })
    expect(() => applyCanvasCommand(history, {
      type: 'splice-node-on-edge',
      nodeId: 'loose',
      edgeId: 'e1',
      before: { id: 'x1', source: 'a', sourceHandle: 'out:image', target: 'b', targetHandle: 'in:images' },
      after: { id: 'x2', source: 'loose', sourceHandle: 'out:image', target: 'b', targetHandle: 'in:images' },
    })).toThrow(/连线关系无效/)
  })

  it('deletes a node and its bridge in one undoable command', () => {
    let history = createCanvasHistory({
      ...createCanvasDocument(),
      nodes: [node('a'), node('b', 240), node('c', 480)],
      edges: [
        { id: 'e1', source: 'a', sourceHandle: 'out:image', target: 'b', targetHandle: 'in:images' },
        { id: 'e2', source: 'b', sourceHandle: 'out:image', target: 'c', targetHandle: 'in:images' },
      ],
    })
    history = applyCanvasCommand(history, {
      type: 'delete-elements',
      nodeIds: ['b'],
      bridges: [{ id: 'bridge', source: 'a', sourceHandle: 'out:image', target: 'c', targetHandle: 'in:images' }],
    })
    expect(history.present.nodes.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(history.present.edges).toEqual([
      { id: 'bridge', source: 'a', sourceHandle: 'out:image', target: 'c', targetHandle: 'in:images' },
    ])

    history = undoCanvasHistory(history)
    expect(history.present.nodes).toHaveLength(3)
    expect(history.present.edges.map((entry) => entry.id)).toEqual(['e1', 'e2'])
  })

  it('drops a bridge that would point at a node being removed', () => {
    const history = applyCanvasCommand(createCanvasHistory({
      ...createCanvasDocument(),
      nodes: [node('a'), node('b', 240), node('c', 480)],
      edges: [{ id: 'e1', source: 'a', sourceHandle: 'out:image', target: 'b', targetHandle: 'in:images' }],
    }), {
      type: 'delete-elements',
      nodeIds: ['b', 'c'],
      bridges: [{ id: 'bridge', source: 'a', sourceHandle: 'out:image', target: 'c', targetHandle: 'in:images' }],
    })
    expect(history.present.edges).toEqual([])
  })

  it('rejects a retarget onto a node that does not exist', () => {
    const history = createCanvasHistory({
      ...createCanvasDocument(),
      nodes: [node('a'), node('b', 240)],
      edges: [{ id: 'e1', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' }],
    })
    expect(() => applyCanvasCommand(history, {
      type: 'reconnect-edge',
      edgeId: 'e1',
      edge: { id: 'e1', source: 'a', sourceHandle: 'out:text', target: 'ghost', targetHandle: 'in:text' },
    })).toThrow(/不存在的节点/)
  })

  it('refuses to resize a locked node', () => {
    let history = createCanvasHistory(createCanvasDocument())
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [{ ...node('a'), locked: true }] })
    history = applyCanvasCommand(history, { type: 'resize-nodes', dimensions: { a: { width: 320, height: 240 } } })
    expect(history.present.nodes[0].width).toBeUndefined()
  })

  it('inserts a node on an edge as one undoable structural command', () => {
    const original = {
      ...createCanvasDocument(),
      nodes: [node('a'), node('b', 240)],
      edges: [{ id: 'edge', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' }],
    }
    const inserted = node('middle', 120)
    let history = applyCanvasCommand(createCanvasHistory(original), {
      type: 'insert-node-on-edge',
      node: inserted,
      edgeId: 'edge',
      before: { id: 'before', source: 'a', sourceHandle: 'out:text', target: 'middle', targetHandle: 'in:text' },
      after: { id: 'after', source: 'middle', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' },
    })
    expect(history.present.nodes.map((entry) => entry.id)).toEqual(['a', 'b', 'middle'])
    expect(history.present.edges.map((edge) => edge.id)).toEqual(['before', 'after'])
    history = undoCanvasHistory(history)
    expect(history.present.edges.map((edge) => edge.id)).toEqual(['edge'])
  })

  it('merges continuous drag updates into one undo step', () => {
    let history = createCanvasHistory({ ...createCanvasDocument(), nodes: [node('a')] })
    history = applyCanvasCommand(history, { type: 'move-nodes', positions: { a: { x: 10, y: 0 } }, mergeKey: 'drag:a' })
    history = applyCanvasCommand(history, { type: 'move-nodes', positions: { a: { x: 20, y: 0 } }, mergeKey: 'drag:a' })
    expect(history.past).toHaveLength(1)
    expect(undoCanvasHistory(history).present.nodes[0].position.x).toBe(0)
  })

  it('updates node flags atomically and restores them through undo and redo', () => {
    const original = {
      ...createCanvasDocument(),
      nodes: [node('a'), node('b', 240)],
      edges: [{ id: 'edge', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' }],
    }
    let history = applyCanvasCommand(createCanvasHistory(original), {
      type: 'set-node-flags', nodeIds: ['a', 'b'], locked: true, disabled: true,
    })
    expect(history.present.nodes.every((entry) => entry.locked && entry.disabled)).toBe(true)
    expect(history.present.edges).toEqual(original.edges)
    expect(history.past).toHaveLength(1)

    history = undoCanvasHistory(history)
    expect(history.present.nodes.every((entry) => !entry.locked && !entry.disabled)).toBe(true)
    history = redoCanvasHistory(history)
    expect(history.present.nodes.every((entry) => entry.locked && entry.disabled)).toBe(true)
  })

  it('does not move locked nodes and ignores flag no-ops', () => {
    const locked = { ...node('locked'), locked: true }
    let history = createCanvasHistory({ ...createCanvasDocument(), nodes: [locked, node('free', 20)] })
    const unchanged = applyCanvasCommand(history, { type: 'set-node-flags', nodeIds: ['locked'], locked: true })
    expect(unchanged).toBe(history)

    history = applyCanvasCommand(history, {
      type: 'move-nodes', positions: { locked: { x: 100, y: 0 }, free: { x: 120, y: 0 } },
    })
    expect(history.present.nodes.find((entry) => entry.id === 'locked')?.position.x).toBe(0)
    expect(history.present.nodes.find((entry) => entry.id === 'free')?.position.x).toBe(120)
  })

  it('keeps unknown placeholders disabled', () => {
    const unknown = { ...node('unknown'), type: 'unknown', disabled: true, unknownKind: 'future-node' }
    const history = applyCanvasCommand(
      createCanvasHistory({ ...createCanvasDocument(), nodes: [unknown] }),
      { type: 'set-node-flags', nodeIds: ['unknown'], disabled: false },
    )
    expect(history.present.nodes[0].disabled).toBe(true)
    expect(history.past).toHaveLength(0)
  })

  it('keeps the final drag frame in its gesture and starts a new undo step for the next drag', () => {
    const dragging = (x: number, state: boolean) => [{
      type: 'position' as const,
      id: 'a',
      position: { x, y: 0 },
      dragging: state,
    }]
    let transaction = resolveDragTransaction(dragging(10, true), null, 0)
    const firstKey = transaction.mergeKey
    expect(firstKey).toBeTruthy()
    transaction = resolveDragTransaction(dragging(20, false), transaction.active, transaction.sequence)
    expect(transaction.mergeKey).toBe(firstKey)
    expect(transaction.active).toBeNull()

    const second = resolveDragTransaction(dragging(30, true), transaction.active, transaction.sequence)
    expect(second.mergeKey).not.toBe(firstKey)

    let history = createCanvasHistory({ ...createCanvasDocument(), nodes: [node('a')] })
    history = applyCanvasCommand(history, { type: 'move-nodes', positions: { a: { x: 10, y: 0 } }, mergeKey: firstKey })
    history = applyCanvasCommand(history, { type: 'move-nodes', positions: { a: { x: 20, y: 0 } }, mergeKey: transaction.mergeKey })
    history = applyCanvasCommand(history, { type: 'move-nodes', positions: { a: { x: 30, y: 0 } }, mergeKey: second.mergeKey })
    expect(history.past).toHaveLength(2)
    history = undoCanvasHistory(history)
    expect(history.present.nodes[0].position.x).toBe(20)
    history = undoCanvasHistory(history)
    expect(history.present.nodes[0].position.x).toBe(0)
  })

  it('invalidates redo after a new branch', () => {
    let history = createCanvasHistory(createCanvasDocument())
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('a')] })
    history = undoCanvasHistory(history)
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('b')] })
    expect(history.future).toHaveLength(0)
    expect(redoCanvasHistory(history)).toBe(history)
  })

  it('keeps viewport changes out of content history and preserves redo', () => {
    let history = createCanvasHistory(createCanvasDocument())
    history = applyCanvasCommand(history, { type: 'add-nodes', nodes: [node('a')] })
    history = undoCanvasHistory(history)
    history = applyCanvasCommand(history, { type: 'set-viewport', viewport: { x: 120, y: -40, zoom: 1.5 } })
    expect(history.past).toHaveLength(0)
    expect(history.future).toHaveLength(1)

    history = redoCanvasHistory(history)
    expect(history.present.nodes.map((entry) => entry.id)).toEqual(['a'])
    expect(history.present.viewport).toEqual({ x: 120, y: -40, zoom: 1.5 })
  })

  it('updates a large document viewport without rebuilding its graph', () => {
    const nodes = Array.from({ length: 256 }, (_, index) => node(`node-${index}`, index * 20))
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes })

    expect(updateCanvasHistoryViewport(history, { x: 0, y: 0, zoom: 1 })).toBe(history)

    const updated = updateCanvasHistoryViewport(history, { x: 240, y: -120, zoom: 0.75 })
    expect(updated).not.toBe(history)
    expect(updated.present.viewport).toEqual({ x: 240, y: -120, zoom: 0.75 })
    expect(updated.present.nodes).toBe(history.present.nodes)
    expect(updated.present.edges).toBe(history.present.edges)
    expect(updated.past).toHaveLength(0)
  })

  it('preserves runtime state when a structural command keeps the same result', () => {
    const result = { kind: 'video' as const, assetId: 'asset-1', taskId: 'task-1', localUrl: 'xingmang-asset://video/asset-1' }
    const canvasNode = {
      id: 'video-1',
      type: 'video-generate',
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      data: {
        title: '视频生成',
        kind: 'video-generate' as const,
        prompt: '',
        model: 'grok-imagine-video',
        status: 'running' as const,
        errorMessage: '上一次查询失败',
        costQuota: 12,
        result,
      },
    } as CanvasNode
    const documentNode: EditorNodeRecord = {
      ...node('video-1'),
      type: 'video-generate',
      data: { title: '视频生成', kind: 'video-generate', result: { ...result } },
    }

    expect(canvasNodeRuntimePatch(canvasNode, documentNode)).toMatchObject({
      status: 'running',
      errorMessage: '上一次查询失败',
      costQuota: 12,
    })

    const changedResult = {
      ...documentNode,
      data: { ...documentNode.data, result: { ...result, assetId: 'asset-2' } },
    }
    const changedPatch = canvasNodeRuntimePatch(canvasNode, changedResult)
    expect(changedPatch).not.toHaveProperty('status')
    expect(changedPatch).not.toHaveProperty('errorMessage')
    expect(changedPatch).not.toHaveProperty('costQuota')
  })

  it('increments replacement revision from the active document', () => {
    const current = { ...createCanvasDocument(), revision: 7 }
    const imported = { ...createCanvasDocument('导入文档'), revision: 99, nodes: [node('imported')] }
    const history = applyCanvasCommand(createCanvasHistory(current), {
      type: 'replace-document',
      document: imported,
    })
    expect(history.present.revision).toBe(8)
    expect(history.present.name).toBe('导入文档')
  })

  it('replaces and restores media groups atomically through undo and redo', () => {
    const original = {
      ...createCanvasDocument('原工作流'),
      mediaGroups: { image: '原生图分组', video: '原视频分组' },
      nodes: [node('original')],
    }
    const imported = {
      ...createCanvasDocument('导入工作流'),
      mediaGroups: { image: '新生图分组', video: '新视频分组' },
      nodes: [node('imported')],
    }
    let history = applyCanvasCommand(createCanvasHistory(original), {
      type: 'replace-document',
      document: imported,
    })

    imported.mediaGroups.image = '外部突变'
    expect(history.present.mediaGroups).toEqual({ image: '新生图分组', video: '新视频分组' })
    expect(history.present.nodes.map((entry) => entry.id)).toEqual(['imported'])

    history = undoCanvasHistory(history)
    expect(history.present.mediaGroups).toEqual({ image: '原生图分组', video: '原视频分组' })
    expect(history.present.nodes.map((entry) => entry.id)).toEqual(['original'])

    history = redoCanvasHistory(history)
    expect(history.present.mediaGroups).toEqual({ image: '新生图分组', video: '新视频分组' })
    expect(history.present.nodes.map((entry) => entry.id)).toEqual(['imported'])
  })

  it('records a media group change as one undoable document command', () => {
    const original = {
      ...createCanvasDocument(),
      mediaGroups: { image: '生图分组', video: 'grok' },
    }
    let history = applyCanvasCommand(createCanvasHistory(original), {
      type: 'set-media-groups',
      mediaGroups: { image: 'openai', video: 'grok' },
    })

    expect(history.present.mediaGroups).toEqual({ image: 'openai', video: 'grok' })
    history = undoCanvasHistory(history)
    expect(history.present.mediaGroups).toEqual({ image: '生图分组', video: 'grok' })
  })

  it('records a default model change as one undoable document command', () => {
    const original = {
      ...createCanvasDocument(),
      mediaGroups: { image: '生图分组', imageModel: 'gpt-image-2' },
    }
    let history = applyCanvasCommand(createCanvasHistory(original), {
      type: 'set-media-groups',
      mediaGroups: { image: '生图分组', imageModel: 'gemini-3.1-flash-image' },
    })

    expect(history.present.mediaGroups.imageModel).toBe('gemini-3.1-flash-image')
    history = undoCanvasHistory(history)
    expect(history.present.mediaGroups.imageModel).toBe('gpt-image-2')
  })

  it('bounds history to fifty entries', () => {
    let history = createCanvasHistory(createCanvasDocument())
    for (let index = 0; index < 60; index += 1) {
      history = applyCanvasCommand(history, { type: 'rename-document', name: `name-${index}` })
    }
    expect(history.past).toHaveLength(50)
  })

  it('builds downstream reachability without repeated graph scans', () => {
    const document = {
      ...createCanvasDocument(),
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { id: 'ab', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' },
        { id: 'bc', source: 'b', sourceHandle: 'out:text', target: 'c', targetHandle: 'in:text' },
      ],
    }
    expect([...collectDownstreamNodeIds(document, ['a'])]).toEqual(['b', 'c'])
  })
})
