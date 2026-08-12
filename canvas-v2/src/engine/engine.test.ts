import { describe, expect, it } from 'vitest'
import type { WorkflowEdge, WorkflowNode } from '../model'
import { createMockExecutors, runWorkflow, topologicalOrder } from './engine'

function node(id: string, kind: WorkflowNode['kind'], prompt = ''): WorkflowNode {
  return { id, kind, position: { x: 0, y: 0 }, data: { prompt, model: '', status: 'idle' } }
}

function edge(source: string, target: string): WorkflowEdge {
  return { id: `${source}->${target}`, source, sourceHandle: 'out:text', target, targetHandle: 'in:text' }
}

describe('topologicalOrder', () => {
  it('orders a text -> image -> video pipeline upstream first', () => {
    const order = topologicalOrder(
      [node('t', 'text'), node('i', 'image'), node('v', 'video')],
      [edge('t', 'i'), edge('i', 'v')],
    )
    expect(order).toEqual(['t', 'i', 'v'])
  })

  it('returns null for a cyclic graph instead of looping forever', () => {
    const order = topologicalOrder(
      [node('a', 'text'), node('b', 'image')],
      [edge('a', 'b'), edge('b', 'a')],
    )
    expect(order).toBeNull()
  })

  it('ignores edges referencing missing nodes rather than corrupting degrees', () => {
    const order = topologicalOrder([node('a', 'text')], [edge('ghost', 'a')])
    expect(order).toEqual(['a'])
  })
})

describe('runWorkflow', () => {
  it('propagates upstream text into the image node and reports success', async () => {
    const updates: Array<{ id: string; status: string }> = []
    const outcome = await runWorkflow(
      [node('t', 'text', '一只赛博朋克风格的猫'), node('i', 'image')],
      [edge('t', 'i')],
      createMockExecutors(1),
      { onNodeUpdate: (id, update) => updates.push({ id, status: update.status }) },
      new AbortController().signal,
    )
    expect(outcome.succeeded).toEqual(expect.arrayContaining(['t', 'i']))
    expect(outcome.failed).toHaveLength(0)
    expect(updates.filter((u) => u.id === 'i').map((u) => u.status)).toEqual(['queued', 'running', 'succeeded'])
  })

  it('preserves all upstream image inputs in connection order', async () => {
    const seen: Array<string | undefined> = []
    const executors = createMockExecutors(1)
    executors['image-input'] = async (current) => ({ output: { asset: { kind: 'image', assetId: current.id } } })
    executors['image-edit'] = async (_current, inputs) => {
      seen.push(...(inputs.images ?? []).map((asset) => asset.assetId))
      return { output: { asset: inputs.image } }
    }
    await runWorkflow(
      [node('source-a', 'image-input'), node('source-b', 'image-input'), node('edit', 'image-edit')],
      [
        { id: 'a-edit', source: 'source-a', sourceHandle: 'out:image', target: 'edit', targetHandle: 'in:image' },
        { id: 'b-edit', source: 'source-b', sourceHandle: 'out:image', target: 'edit', targetHandle: 'in:image' },
      ],
      executors,
      { onNodeUpdate: () => undefined },
      new AbortController().signal,
    )
    expect(seen).toEqual(['source-a', 'source-b'])
  })

  it('skips the downstream chain when an upstream node fails, without touching independent branches', async () => {
    const outcome = await runWorkflow(
      [
        node('bad-image', 'image'),
        node('v', 'video'),
        node('lonely', 'text', '独立分支'),
      ],
      [{ id: 'e', source: 'bad-image', sourceHandle: 'out:image', target: 'v', targetHandle: 'in:image' }],
      createMockExecutors(1),
      { onNodeUpdate: () => undefined },
      new AbortController().signal,
    )
    expect(outcome.failed).toEqual(['bad-image'])
    expect(outcome.skipped).toEqual(['v'])
    expect(outcome.succeeded).toEqual(['lonely'])
  })

  it('rejects a cyclic workflow with a Chinese, screen-ready error', async () => {
    await expect(runWorkflow(
      [node('a', 'text'), node('b', 'image')],
      [edge('a', 'b'), edge('b', 'a')],
      createMockExecutors(1),
      { onNodeUpdate: () => undefined },
      new AbortController().signal,
    )).rejects.toThrow('循环连接')
  })
})
