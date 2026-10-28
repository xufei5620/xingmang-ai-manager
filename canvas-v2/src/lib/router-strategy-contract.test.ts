import { describe, expect, it } from 'vitest'
import { assertRouterStrategyClientVersion, assertRouterStrategyRun, assertRouterStrategyWorkflow, graphHasRouterStrategy, projectHasRouterStrategy, routerStrategyRunSignature } from './router-strategy-contract'

function workflow(marker: unknown = { version: 1, strategy: 'first-available' }) {
  return { nodes: [{ id: 'route', kind: 'router', data: { settings: { routerStrategy: marker } } }], edges: [{ id: 'b', source: 'second', sourceHandle: 'out:text', target: 'route', targetHandle: 'in:text' }, { id: 'a', source: 'first', sourceHandle: 'out:text', target: 'route', targetHandle: 'in:text' }] }
}
function run(marker: unknown = { version: 1, strategy: 'first-available' }) { return { nodes: [{ id: 'route', kind: 'router', data: { routerStrategy: marker } }], edges: workflow().edges } }
function content(value: unknown = workflow()) { return JSON.stringify(value) }

describe('versioned workflow router strategy capability', () => {
  it('detects explicit nested and run markers including invalid presence', () => {
    expect(graphHasRouterStrategy(workflow())).toBe(true)
    expect(graphHasRouterStrategy(run())).toBe(true)
    expect(graphHasRouterStrategy(workflow(null))).toBe(true)
    expect(graphHasRouterStrategy({ nodes: [{ kind: 'router', data: { settings: { routerStrategy: undefined } } }] })).toBe(true)
    expect(projectHasRouterStrategy(content())).toBe(true)
    expect(graphHasRouterStrategy({ nodes: [{ kind: 'router', data: { settings: { strategy: 'first-available' } } }] })).toBe(false)
  })
  it.each([undefined, null, false, true, 0, 2, '1'])('rejects a stale capability %s when semantics are explicit', (capability) => {
    expect(() => assertRouterStrategyClientVersion(capability, true)).toThrow('刷新')
    expect(() => assertRouterStrategyWorkflow(content(), capability)).toThrow('刷新')
  })
  it('accepts current capability and preserves missing legacy semantics', () => {
    expect(() => assertRouterStrategyWorkflow(content(), 1)).not.toThrow()
    for (const strategy of ['first-available', 'all']) expect(() => assertRouterStrategyWorkflow(content({ nodes: [{ id: 'legacy', kind: 'router', data: { settings: { strategy } } }], edges: [] }), undefined)).not.toThrow()
    expect(() => assertRouterStrategyWorkflow(content({ nodes: [], edges: [] }), undefined)).not.toThrow()
  })
  it.each([null, false, [], {}, { version: 2, strategy: 'all' }, { version: 1, strategy: 'other' }, { version: 1, strategy: 'all', extra: true }])('refuses malformed marked configuration without normalization: %s', (marker) => {
    expect(() => assertRouterStrategyWorkflow(content(workflow(marker)), 1)).toThrow()
  })
  it('rejects a run placement in persisted workflow and other reserved wrong placements', () => {
    expect(() => assertRouterStrategyWorkflow(content(run()), 1)).toThrow('位置')
    const wrong = workflow(); wrong.nodes[0].kind = 'prompt'
    expect(() => assertRouterStrategyWorkflow(content(wrong), 1)).toThrow('路由')
    expect(() => assertRouterStrategyWorkflow(content({ nodes: [{ id: 'r', kind: 'router', data: { settings: { strategy: 'unknown' } } }], edges: [] }), 1)).toThrow()
  })
  it('does not recursively confuse business payload fields with router configuration', () => {
    expect(graphHasRouterStrategy({ nodes: [{ kind: 'prompt', data: { settings: { custom: { routerStrategy: { version: 2 } } } } }] })).toBe(false)
  })
  it('binds explicit selected route and saved input order without sorting by edge id', () => {
    expect(() => assertRouterStrategyRun(content(), run(), ['route'])).not.toThrow()
    const reversed = run(); reversed.edges = [...reversed.edges].reverse()
    expect(() => assertRouterStrategyRun(content(), reversed, ['route'])).toThrow('顺序')
    const missing = run(); missing.edges = missing.edges.slice(0, 1)
    expect(() => assertRouterStrategyRun(content(), missing, ['route'])).toThrow('顺序')
  })
  it('refuses stripped, switched or newly invented strategy for a selected node', () => {
    const missing = { ...run(), nodes: [{ id: 'route', kind: 'router', data: {} }] }
    expect(() => assertRouterStrategyRun(content(), missing, ['route'])).toThrow('已保存')
    expect(() => assertRouterStrategyRun(content(), run({ version: 1, strategy: 'all' }), ['route'])).toThrow('已保存')
    expect(() => assertRouterStrategyRun(content({ nodes: [{ id: 'route', kind: 'router', data: { settings: { strategy: 'all' } } }], edges: workflow().edges }), run(), ['route'])).toThrow('已保存')
  })
  it('leaves legacy-only and unrelated selected nodes unchanged', () => {
    const legacy = { nodes: [{ id: 'route', kind: 'router', data: {} }], edges: [] }
    expect(() => assertRouterStrategyRun(content(legacy), legacy, ['route'])).not.toThrow()
    expect(() => assertRouterStrategyRun(content(), { nodes: [], edges: [] }, ['other'])).not.toThrow()
  })
  it('pins scope-selected configuration and input order in the signature', () => {
    const initial = routerStrategyRunSignature(content(), ['route'])
    expect(routerStrategyRunSignature(content(), ['route'])).toBe(initial)
    expect(routerStrategyRunSignature(content(), ['other'])).toBe('[]')
    expect(routerStrategyRunSignature(content(workflow({ version: 1, strategy: 'all' })), ['route'])).not.toBe(initial)
    const reordered = workflow(); reordered.edges.reverse()
    expect(routerStrategyRunSignature(content(reordered), ['route'])).not.toBe(initial)
  })
})
