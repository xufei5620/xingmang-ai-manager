import { describe, expect, it } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { parseWorkflowFile, serializeWorkflow } from './workflow-serializer'
import { sanitizeWorkflowV2 } from './workflow-sanitizer'
import { toPersistedWorkflowV2 } from './workflow-schema'
import { inspectCanvasWorkflowSnapshot } from './workflow-snapshot'

function workflow(settings?: Record<string, unknown>): WorkflowFile {
  return { ...createEmptyWorkflow('路由工程'), nodes: [{ id: 'router', kind: 'router', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '保留原节点文字', model: '', status: 'idle', ...(settings ? { settings } : {}) } }] }
}

describe('versioned router strategy persistence', () => {
  it('uses first-per-media defaults only for a newly created registry node', () => {
    const created = builtinNodeRegistry.create('router', 'new-router', { x: 0, y: 0 })
    expect(created.data).toEqual({ routerStrategy: { version: 1, strategy: 'first-available' } })
    expect(builtinNodeRegistry.create('router', 'next-router', { x: 1, y: 2 }).data).toEqual(created.data)
    expect(created.data).not.toHaveProperty('strategy')
  })
  it.each([undefined, { strategy: 'first-available' }, { strategy: 'all' }])('preserves old settings %j through parse and save without adding a strategy marker', (settings) => {
    const original = workflow(settings), before = structuredClone(original)
    const restored = parseWorkflowFile(serializeWorkflow(original))
    expect(restored?.nodes[0].data.settings).toEqual(settings)
    expect(restored?.nodes[0].data.settings ?? {}).not.toHaveProperty('routerStrategy')
    expect(restored?.nodes[0].data.prompt).toBe('保留原节点文字'); expect(original).toEqual(before)
  })
  it.each(['first-available', 'all'])('roundtrips exact versioned %s settings alongside independent valid legacy fields', (strategy) => {
    const settings = { title: '路由名称', strategy: 'all', routerStrategy: { version: 1, strategy } }, original = workflow(settings)
    const restored = parseWorkflowFile(serializeWorkflow(original))
    expect(restored?.nodes[0].data.settings).toEqual(settings)
  })
  it.each([null, undefined, 'all', { version: 2, strategy: 'all' }, { version: 1, strategy: 'future' }, { version: 1, strategy: 'all', secret: 'filtered' }])('rejects invalid own markers %j before sanitization and preserves the editable original', (routerStrategy) => {
    const original = workflow({ routerStrategy }), before = structuredClone(original)
    const wire = { ...original, nodes: original.nodes.map((node) => ({ ...node })) }
    expect(sanitizeWorkflowV2(wire)).toBeNull()
    expect(() => toPersistedWorkflowV2(original)).toThrow()
    const snapshot = inspectCanvasWorkflowSnapshot(original)
    expect(snapshot.content).toBeNull(); expect(snapshot.errorMessage).toContain('路由策略'); expect(original).toEqual(before)
  })
  it.each(['prompt', 'output', 'image-generate'] as const)('rejects strategy markers on the wrong %s node kind without dropping them', (kind) => {
    const original = workflow({ routerStrategy: { version: 1, strategy: 'all' } }); original.nodes[0].kind = kind
    expect(sanitizeWorkflowV2(original)).toBeNull(); expect(() => serializeWorkflow(original)).toThrow()
  })
  it.each(['workflow', 'workflow-settings', 'node', 'node-settings', 'node-data'] as const)('rejects a reserved marker at the wrong %s placement before unknown fields are removed', (placement) => {
    const original = workflow(), routerStrategy = { version: 1, strategy: 'all' }
    if (placement === 'workflow') Object.assign(original, { routerStrategy })
    if (placement === 'workflow-settings') Object.assign(original, { settings: { routerStrategy } })
    if (placement === 'node') Object.assign(original.nodes[0], { routerStrategy })
    if (placement === 'node-settings') Object.assign(original.nodes[0], { settings: { routerStrategy } })
    if (placement === 'node-data') Object.assign(original.nodes[0].data, { routerStrategy })
    const before = structuredClone(original)
    expect(sanitizeWorkflowV2(original)).toBeNull(); expect(() => serializeWorkflow(original)).toThrow('位置')
    expect(original).toEqual(before)
  })
  it('requires explicit repair of an invalid historical field even beside a valid current marker', () => {
    const original = workflow({ strategy: 'future-legacy', routerStrategy: { version: 1, strategy: 'all' } })
    expect(sanitizeWorkflowV2(original)).toBeNull(); expect(() => serializeWorkflow(original)).toThrow('旧版路由策略')
    original.nodes[0].data.settings!.strategy = 'all'
    expect(parseWorkflowFile(serializeWorkflow(original))?.nodes[0].data.settings).toEqual(original.nodes[0].data.settings)
  })
})
