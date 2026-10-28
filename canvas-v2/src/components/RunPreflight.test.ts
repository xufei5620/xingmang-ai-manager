import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { buildCanvasRunPreflight, type CanvasRunPreflight } from '../runtime/run-preflight'
import { RunPreflight } from './RunPreflight'

function inspect(graph: CanvasRunGraph): CanvasRunPreflight {
  return buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: ['gpt-image-1'], videoModels: [] })
}
function localGraph(kind: 'collage' | 'tile'): CanvasRunGraph {
  return { nodes: [
    { id: 'source', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'source-image' } },
    { id: 'grid', kind: 'image-grid-split', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: { kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 } } },
    { id: 'tool', kind: `image-${kind}`, definitionVersion: 1, data: { prompt: '', model: '', imageTransform: defaultImageTransformRecipe(kind) } },
  ], edges: [
    { id: 'source-grid', source: 'source', sourceHandle: 'out:image', target: 'grid', targetHandle: 'in:image' },
    { id: 'grid-tool', source: 'grid', sourceHandle: 'out:images', target: 'tool', targetHandle: kind === 'tile' ? 'in:image' : 'in:images' },
  ] }
}
function markup(preflight: CanvasRunPreflight): string {
  return renderToStaticMarkup(createElement(RunPreflight, { preflight, onCancel: vi.fn(), onConfigure: vi.fn(), onLocateNode: vi.fn(), onConfirm: vi.fn() }))
}
function appPreflightHandler<T>(name: string, environment: Record<string, unknown>): T {
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'RunPreflight') {
      const attribute = node.attributes.properties.find((entry) => ts.isJsxAttribute(entry) && entry.name.getText(source) === name)
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) expression = attribute.initializer.expression?.getText(source) ?? ''
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing RunPreflight ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

describe('run preflight recovery actions', () => {
  it.each(['collage', 'tile'] as const)('locates the local %s parameter blocker without offering model configuration', (kind) => {
    const graph = localGraph(kind)
    if (kind === 'tile') graph.nodes[2].data.tileInput = { missing: true }
    const preflight = inspect(graph)
    expect(preflight.items.find((item) => item.nodeId === 'tool')).toMatchObject({ action: 'blocked', reasonCode: 'invalid-parameters', paid: false })
    const html = markup(preflight)
    expect(html).toContain('data-node-id="tool"')
    expect(html).toContain('定位并检查参数与输入')
    expect(html).toContain(kind === 'collage' ? '9 张输入需至少 9 格' : '已选平铺贴图已移除')
    expect(html).not.toContain('打开生成配置')
    expect(html).toContain('disabled="">确认运行')
  })

  it('allows a valid selected tile batch slot without a corrective action', () => {
    const graph = localGraph('tile')
    graph.nodes[2].data.tileInput = { edgeId: 'grid-tool', outputIndex: 8 }
    const preflight = inspect(graph), html = markup(preflight)
    expect(preflight).toMatchObject({ canStart: true, paidRequestCount: 0 })
    expect(html).not.toContain('定位并检查参数与输入')
    expect(html).not.toContain('disabled="">确认运行')
    graph.nodes[2].data.tileInput = { edgeId: 'grid-tool', outputIndex: 9 }
    expect(markup(inspect(graph))).toContain('定位并检查参数与输入')
    expect(markup(inspect(graph))).toContain('当前批次')
  })

  it('points missing assets to the source node without suggesting model settings', () => {
    const graph = localGraph('collage')
    delete graph.nodes[0].data.adoptedAssetId
    const html = markup(inspect(graph))
    expect(html).toContain('data-node-id="source"')
    expect(html).toContain('定位并补充素材')
    expect(html).not.toContain('打开生成配置')
  })

  it.each(['missing-group', 'unavailable-model'] as const)('retains both recovery paths for mixed local and %s blockers', (reason) => {
    const graph = localGraph('collage')
    graph.nodes.push({ id: 'generation', kind: 'image-generate', definitionVersion: 1, data: { prompt: '产品图', model: reason === 'unavailable-model' ? 'missing-model' : 'gpt-image-1', group: reason === 'unavailable-model' ? 'provider' : undefined } })
    const preflight = inspect(graph)
    expect(preflight.items.find((item) => item.nodeId === 'generation')?.reasonCode).toBe(reason)
    const html = markup(preflight)
    expect(html.match(/打开生成配置/g)).toHaveLength(1)
    expect(html).toContain('data-node-id="tool"')
    expect(html).not.toContain('data-node-id="generation"')
  })

  it('locates an invalid AI node size instead of opening unrelated account model settings', () => {
    const preflight = inspect({ nodes: [{ id: 'generation', kind: 'image-generate', definitionVersion: 1, data: { prompt: '', group: 'provider', model: 'gpt-image-1', imageResolution: '4K', size: '1024x1024' } }], edges: [] })
    expect(preflight.items[0].reasonCode).toBe('invalid-parameters')
    const html = markup(preflight)
    expect(html).toContain('data-node-id="generation"')
    expect(html).not.toContain('打开生成配置')
  })

  it('does not show corrective actions for an executable local flow', () => {
    const graph = localGraph('collage')
    graph.edges[1].sourceHandle = 'out:image'
    const preflight = inspect(graph)
    expect(preflight.canStart).toBe(true)
    const html = markup(preflight)
    expect(html).not.toContain('run-preflight-locate')
    expect(html).not.toContain('打开生成配置')
    expect(html).not.toContain('disabled="">确认运行')
  })

  it('closes the pending confirmation and locates the exact node without running or configuring anything', () => {
    const environment = { setRunPreflight: vi.fn(), setPendingCanvasRun: vi.fn(), setAgentOpen: vi.fn(), locateNode: vi.fn(), setMediaConfigOpen: vi.fn(), confirmCanvasRun: vi.fn() }
    appPreflightHandler<(nodeId: string) => void>('onLocateNode', environment)('tool')
    expect(environment.setRunPreflight).toHaveBeenCalledExactlyOnceWith(null)
    expect(environment.setPendingCanvasRun).toHaveBeenCalledExactlyOnceWith(null)
    expect(environment.setAgentOpen).toHaveBeenCalledExactlyOnceWith(false)
    expect(environment.locateNode).toHaveBeenCalledExactlyOnceWith('tool')
    expect(environment.setMediaConfigOpen).not.toHaveBeenCalled()
    expect(environment.confirmCanvasRun).not.toHaveBeenCalled()
  })
})
