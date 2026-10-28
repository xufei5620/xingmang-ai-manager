// 桌面 v2 编辑器的用例（桌面 000f9131 的 canvas-v2/src/editor/clipboard.test.ts），#4 搬进内核。
// 内核有意和 v2 不一样的地方，期望改成内核的行为或退役，改动处写了为什么，汇总见 docs/canvas-kernel-v2-tests.md。
import { describe, expect, it } from 'vitest'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import {
  buildCanvasClipboardPayload,
  parseCanvasClipboard,
  pasteCanvasClipboard,
  serializeCanvasClipboard,
} from './clipboard'

function node(id: string, parentId?: string): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, position: { x: 10, y: 20 }, data: { prompt: id }, ...(parentId ? { parentId } : {}) }
}

const edges: EditorEdgeRecord[] = [
  { id: 'ab', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' },
  { id: 'bc', source: 'b', sourceHandle: 'out:text', target: 'c', targetHandle: 'in:text' },
]

describe('canvas clipboard', () => {
  it('copies only internal edges and strips selection state', () => {
    const a = { ...node('a'), selected: true }
    const payload = buildCanvasClipboardPayload([a, node('b'), node('c')], edges, new Set(['a', 'b']))
    expect(payload.nodes.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(payload.edges.map((entry) => entry.id)).toEqual(['ab'])
    expect(payload.nodes[0].selected).toBeUndefined()
  })

  it('round trips bounded payloads and rejects dangling edges', () => {
    // 内核复制时按存工程的规则核对选区：提示词节点没有文字输入口，a→b 这条线会被当成端口不匹配，
    // 整个选区不复制。这里让 b 是有文字输入口的路由节点，节点数据也写成编辑器里实际有的样子。
    const full = (entry: EditorNodeRecord): EditorNodeRecord => ({ ...entry, data: { ...entry.data, model: '', status: 'idle' } })
    const payload = buildCanvasClipboardPayload([full(node('a')), { ...full(node('b')), type: 'router' }], edges, new Set(['a', 'b']))
    expect(parseCanvasClipboard(serializeCanvasClipboard(payload))).toEqual(payload)
    expect(parseCanvasClipboard(JSON.stringify({ ...payload, edges: [edges[1]] }))).toBeNull()
  })

  it('remaps every id and offsets only top-level nodes', () => {
    const group: EditorNodeRecord = { id: 'g', type: 'group', definitionVersion: 1, position: { x: 100, y: 100 }, data: {}, width: 400, height: 300 }
    const child = node('a', 'g')
    const result = pasteCanvasClipboard(
      { version: 1, nodes: [group, child], edges: [] },
      { offset: { x: 20, y: 30 }, createNodeId: (id) => `copy-${id}`, createEdgeId: (id) => `copy-${id}` },
    )
    expect(result.nodes[0]).toMatchObject({ id: 'copy-g', position: { x: 120, y: 130 } })
    expect(result.nodes[1]).toMatchObject({ id: 'copy-a', parentId: 'copy-g', position: { x: 10, y: 20 } })
  })
})
