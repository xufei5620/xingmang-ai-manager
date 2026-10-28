import { describe, expect, it } from 'vitest'
import { buildCanvasAgentProposalWorkflow, canvasAgentGraphDigest } from './canvas-agent-patch'
import type { CanvasAgentProposal } from './canvas-agent-contract'
import type { WorkflowFile, WorkflowNode } from '../model'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import type { CanvasDocumentState } from '../store/canvas-state'

function node(id: string, kind: WorkflowNode['kind'] = 'prompt'): WorkflowNode {
  return { id, kind, position: { x: 20, y: 40 }, data: { prompt: '原始提示词', model: '', status: 'idle', settings: { title: id } } }
}
function base(): WorkflowFile {
  return {
    schemaVersion: 2, name: '原项目',
    nodes: [node('source'), {
      ...node('image', 'image-input'), position: { x: 500, y: 80 },
      data: { ...node('image').data, result: { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` } },
    }],
    edges: [], mediaGroups: { text: 'private-source', textModel: 'text-model' }, viewport: { x: 100, y: 200, zoom: 0.8 },
  }
}
function proposal(): CanvasAgentProposal {
  return { id: 'proposal-a', digest: 'a'.repeat(64), baseProjectVersion: 1, baseGraphDigest: 'b'.repeat(64), expectedResultGraphDigest: 'c'.repeat(64), summary: '新增主图与文本说明', nodes: [{ ...node('agent-a', 'text-generate'), position: { x: 800, y: 40 } }], edges: [{ id: 'agent-edge', source: 'source', sourceHandle: 'out:text', target: 'agent-a', targetHandle: 'in:text' }], updates: [{ nodeId: 'source', title: '产品方向', data: { prompt: '为咖啡产品整理主图文案' } }] }
}
function document(workflow: WorkflowFile): CanvasDocumentState {
  return { name: workflow.name, mediaGroups: workflow.mediaGroups ?? {}, viewport: workflow.viewport ?? { x: 0, y: 0, zoom: 1 }, revision: 0, nodes: workflow.nodes.map(({ kind, ...entry }) => ({ ...entry, type: kind, definitionVersion: 1, data: { ...entry.data } })), edges: workflow.edges }
}

describe('canvas agent reviewed graph application', () => {
  it('preserves original assets, layout, source configuration and input objects', () => {
    const original = base(), before = structuredClone(original), plan = proposal()
    const next = buildCanvasAgentProposalWorkflow(original, plan)
    expect(original).toEqual(before)
    expect(next.name).toBe(original.name)
    expect(next.viewport).toEqual(original.viewport)
    expect(next.mediaGroups).toEqual(original.mediaGroups)
    expect(next.nodes[1]).toEqual(original.nodes[1])
    expect(next.nodes[0].data).toMatchObject({ prompt: '为咖啡产品整理主图文案', settings: { title: '产品方向' }, dirty: true })
    expect(next.nodes[0].position).toEqual(original.nodes[0].position)
    expect(next.nodes[2].id).toBe('agent-a')
    expect(next.edges).toHaveLength(1)
  })

  it('keeps a previously adopted output while marking changed inputs dirty', () => {
    const original = base()
    original.nodes[0].data.outputText = '之前生成的文案'
    expect(buildCanvasAgentProposalWorkflow(original, proposal()).nodes[0].data).toMatchObject({ outputText: '之前生成的文案', dirty: true })
  })

  it('preserves the exact legacy reviewed graph digest including original downstream dirty flags', async () => {
    const original = base(), plan = proposal()
    original.nodes.push(node('old-child', 'text-generate'))
    original.edges.push({ id: 'old-edge', source: 'source', sourceHandle: 'out:text', target: 'old-child', targetHandle: 'in:text' })
    const expected = structuredClone(original)
    expected.nodes[0].data.prompt = plan.updates[0].data!.prompt!
    expected.nodes[0].data.settings = { ...expected.nodes[0].data.settings, title: plan.updates[0].title }
    expected.nodes[0].data.dirty = true
    expected.nodes.push(...structuredClone(plan.nodes))
    expected.edges.push(...structuredClone(plan.edges))
    const actual = buildCanvasAgentProposalWorkflow(original, plan)
    expect(actual).toEqual(expected)
    expect(actual.nodes.find((node) => node.id === 'old-child')!.data.dirty).toBeUndefined()
    expect(await canvasAgentGraphDigest(actual)).toBe(await canvasAgentGraphDigest(expected))
  })

  it('propagates a v2 edge-only change through existing local nodes without replacing their results', () => {
    const original = base()
    original.nodes.push(node('crop', 'image-crop'), node('output', 'output'))
    original.nodes[2].data.result = structuredClone(original.nodes[1].data.result)
    original.nodes[2].data.dirty = false; original.nodes[3].data.dirty = false
    original.edges.push({ id: 'existing', source: 'crop', sourceHandle: 'out:image', target: 'output', targetHandle: 'in:image' })
    const plan = { ...proposal(), nodes: [], updates: [], edges: [{ id: 'input', source: 'image', sourceHandle: 'out:image', target: 'crop', targetHandle: 'in:image' }] }
    const before = structuredClone(original)
    const actual = buildCanvasAgentProposalWorkflow(original, plan, { planningVersion: 2 })
    expect(actual.nodes[2].data).toMatchObject({ dirty: true, result: original.nodes[2].data.result })
    expect(actual.nodes[3].data.dirty).toBe(true)
    expect(actual.nodes.slice(0, 2)).toEqual(original.nodes.slice(0, 2))
    expect(original).toEqual(before)
    expect(buildCanvasAgentProposalWorkflow(original, plan).nodes.slice(2).map((node) => node.data.dirty)).toEqual([false, false])
  })

  it('propagates v2 scalar-only edits even when the proposal contains no advanced kinds or settings', () => {
    const original = base()
    original.nodes.push(node('writer', 'text-generate'), node('output', 'output'))
    original.edges.push({ id: 'write', source: 'source', sourceHandle: 'out:text', target: 'writer', targetHandle: 'in:text' }, { id: 'output', source: 'writer', sourceHandle: 'out:text', target: 'output', targetHandle: 'in:text' })
    const plan = { ...proposal(), nodes: [], edges: [] }
    expect(buildCanvasAgentProposalWorkflow(original, plan, { planningVersion: 2 }).nodes.map((node) => node.data.dirty)).toEqual([true, undefined, true, true])
    const titleOnly = { ...plan, updates: [{ nodeId: 'source', title: '仅改名字' }] }
    expect(buildCanvasAgentProposalWorkflow(original, titleOnly, { planningVersion: 2 }).nodes.every((node) => !node.data.dirty)).toBe(true)
  })

  it('rejects unknown application versions before constructing a graph', () => {
    // @ts-expect-error Test runtime input from an unsupported future client.
    expect(() => buildCanvasAgentProposalWorkflow(base(), proposal(), { planningVersion: 4 })).toThrow('版本不受支持')
  })

  it('applies a proposal as one undoable document command', () => {
    const original = document(base()), next = document(buildCanvasAgentProposalWorkflow(base(), proposal()))
    const changed = applyCanvasCommand(createCanvasHistory(original), { type: 'replace-document', document: next })
    expect(changed.past).toHaveLength(1)
    const undone = undoCanvasHistory(changed)
    expect(undone.present.nodes).toEqual(original.nodes)
    expect(undone.present.edges).toEqual(original.edges)
    expect(redoCanvasHistory(undone).present.nodes).toEqual(next.nodes)
  })

  it('rejects duplicate application and duplicate patch targets', () => {
    const original = base(), plan = proposal()
    expect(() => buildCanvasAgentProposalWorkflow(buildCanvasAgentProposalWorkflow(original, plan), plan)).toThrow('重复应用')
    plan.updates.push(plan.updates[0])
    expect(() => buildCanvasAgentProposalWorkflow(original, plan)).toThrow('重复修改')
  })

  it('rejects edits to a locked node or a descendant of a locked group', () => {
    const original = base()
    original.nodes[0].locked = true
    expect(() => buildCanvasAgentProposalWorkflow(original, proposal())).toThrow('被锁定')
    original.nodes[0].locked = false
    original.nodes[0].parentId = 'group'
    original.nodes.unshift({ ...node('group', 'group'), locked: true })
    expect(() => buildCanvasAgentProposalWorkflow(original, proposal())).toThrow('被锁定')
  })

  it.each(['asset', 'provider', 'parent', 'unsupported'] as const)('rejects unsafe new-node payload: %s', (field) => {
    const plan = proposal()
    if (field === 'asset') plan.nodes[0].data.result = { kind: 'image', assetId: 'a'.repeat(43) }
    if (field === 'provider') plan.nodes[0].data.group = 'another-source'
    if (field === 'parent') plan.nodes[0].parentId = 'source'
    if (field === 'unsupported') plan.nodes[0].kind = 'image-input'
    expect(() => buildCanvasAgentProposalWorkflow(base(), plan)).toThrow()
  })

  it('rejects invalid ports and cycles without changing any input', () => {
    const original = base(), before = structuredClone(original), plan = proposal()
    plan.edges[0].sourceHandle = 'out:image'
    expect(() => buildCanvasAgentProposalWorkflow(original, plan)).toThrow('端口')
    expect(original).toEqual(before)
    const cycle = proposal()
    cycle.nodes.push(node('agent-b', 'text-generate'))
    cycle.edges.push({ id: 'ab', source: 'agent-a', sourceHandle: 'out:text', target: 'agent-b', targetHandle: 'in:text' }, { id: 'ba', source: 'agent-b', sourceHandle: 'out:text', target: 'agent-a', targetHandle: 'in:text' })
    expect(() => buildCanvasAgentProposalWorkflow(original, cycle)).toThrow('循环')
  })

  it('rejects proposals that exceed editor limits instead of silently dropping changes', () => {
    const plan = proposal()
    plan.nodes[0].position.x = Number.POSITIVE_INFINITY
    expect(() => buildCanvasAgentProposalWorkflow(base(), plan)).toThrow('无法保存')
    const empty = { ...proposal(), nodes: [], edges: [], updates: [] }
    expect(() => buildCanvasAgentProposalWorkflow(base(), empty)).toThrow('为空')
  })

  it('ignores viewport, project title and transient run data when hashing the same graph', async () => {
    const original = base(), changed = structuredClone(original)
    changed.viewport = { x: 10, y: 20, zoom: 1.4 }
    changed.name = '项目改名'
    changed.nodes[0].data.status = 'running'
    changed.nodes[0].data.runProgress = 40
    expect(await canvasAgentGraphDigest(changed)).toBe(await canvasAgentGraphDigest(original))
  })

  it('detects changed content, assets, geometry or model-source selection', async () => {
    const original = base(), digest = await canvasAgentGraphDigest(original)
    for (const change of [
      (value: WorkflowFile) => { value.nodes[0].data.prompt = '新的用户草稿' },
      (value: WorkflowFile) => { value.nodes[1].data.result!.assetId = 'b'.repeat(43) },
      (value: WorkflowFile) => { value.nodes[0].position.x++ },
      (value: WorkflowFile) => { value.mediaGroups!.text = 'different-source' },
    ]) {
      const next = structuredClone(original)
      change(next)
      expect(await canvasAgentGraphDigest(next)).not.toBe(digest)
    }
  })
})
