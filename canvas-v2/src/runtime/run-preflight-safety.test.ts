import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { buildCanvasRunPreflight, canvasMediaConfigurationErrors } from './run-preflight'
import type { CanvasRunGraph } from '../host'
import type { CanvasRunPreflightInput } from './run-preflight'

function node(id: string, kind = 'image-generate'): CanvasRunGraph['nodes'][number] {
  return { id, kind, definitionVersion: 1, data: { prompt: 'test', model: kind === 'drama-parse' ? 'text-model' : kind === 'video-generate' ? 'video-model' : 'image-model', group: 'creative' } }
}

function input(nodes: CanvasRunGraph['nodes'], edges: CanvasRunGraph['edges'] = []): CanvasRunPreflightInput {
  return { graph: { nodes, edges }, scope: { kind: 'all' }, imageModels: ['image-model'], videoModels: ['video-model'] }
}

describe('canvas preflight capability and cost safety', () => {
  it('blocks unsupported frame extraction before submitting any part of the chain', () => {
    const result = buildCanvasRunPreflight(input([node('video', 'video-generate'), node('frame', 'frame-extract')], [
      { id: 'link', source: 'video', sourceHandle: 'out:video', target: 'frame', targetHandle: 'in:video' },
    ]))
    assert.equal(result.canStart, false)
    assert.equal(result.items.find((item) => item.nodeId === 'frame')?.reasonCode, 'unsupported-node')
  })

  it('does not let an optimistic cache hint enable the unsupported executor', () => {
    const result = buildCanvasRunPreflight({ ...input([node('frame', 'frame-extract')]), cachedNodeIds: ['frame'] })
    assert.equal(result.canStart, false)
    assert.equal(result.cacheHitCount, 0)
  })

  it('preserves disabled-node skip semantics', () => {
    const disabled = { ...node('frame', 'frame-extract'), disabled: true }
    const result = buildCanvasRunPreflight(input([disabled]))
    assert.equal(result.canStart, true)
    assert.equal(result.items[0].action, 'skip')
    assert.equal(result.paidRequestCount, 0)
  })

  it('does not block an unsupported step outside the selected scope', () => {
    const result = buildCanvasRunPreflight({ ...input([node('image'), node('frame', 'frame-extract')]), scope: { kind: 'to-node', nodeId: 'image' } })
    assert.equal(result.canStart, true)
    assert.deepEqual(result.selectedNodeIds, ['image'])
  })

  it('does not revive unsupported downstream work after an upstream skip', () => {
    const result = buildCanvasRunPreflight(input([{ ...node('source'), disabled: true }, node('frame', 'frame-extract')], [
      { id: 'link', source: 'source', sourceHandle: 'out:image', target: 'frame', targetHandle: 'in:video' },
    ]))
    assert.equal(result.items[1].reasonCode, 'upstream-skip')
    assert.equal(result.blockedCount, 0)
  })

  it('counts script parsing as model work rather than local processing', () => {
    const result = buildCanvasRunPreflight(input([node('script', 'drama-parse')]))
    assert.equal(result.paidRequestCount, 1)
    assert.equal(result.textRequestCount, 1)
    assert.equal(result.items[0].paid, true)
    assert.equal(result.risk, 'warning')
  })

  it('counts text, image and video generation independently', () => {
    const video = node('video', 'video-generate')
    video.data.model = 'video-model'
    const result = buildCanvasRunPreflight(input([node('image'), video, node('script', 'drama-parse')]))
    assert.deepEqual([result.imageRequestCount, result.videoRequestCount, result.textRequestCount, result.paidRequestCount], [1, 1, 1, 3])
  })

  it('discounts a reusable script result without promising a zero-price run', () => {
    const result = buildCanvasRunPreflight({ ...input([node('script', 'drama-parse')]), cachedNodeIds: ['script'] })
    assert.equal(result.textRequestCount, 0)
    assert.equal(result.paidRequestCount, 0)
    assert.equal(result.items[0].paid, true)
    assert.equal(result.items[0].action, 'cached')
  })

  it('requires the text group used by the production executor', () => {
    const script = node('script', 'drama-parse')
    delete script.data.group
    const result = buildCanvasRunPreflight(input([script]))
    assert.equal(result.canStart, false)
    assert.equal(result.items[0].reason, '缺少文字分组')
  })

  it('accepts an explicitly supplied fallback text group', () => {
    const script = node('script', 'drama-parse')
    delete script.data.group
    const result = buildCanvasRunPreflight({ ...input([script]), textGroup: 'text-service' })
    assert.equal(result.items[0].group, 'text-service')
    assert.equal(result.canStart, true)
  })

  it('blocks an empty text model even when no catalog was supplied', () => {
    const script = node('script', 'drama-parse')
    script.data.model = ' '
    assert.equal(buildCanvasRunPreflight(input([script])).canStart, false)
  })

  it('uses the text catalog when the caller supplies one', () => {
    assert.equal(buildCanvasRunPreflight({ ...input([node('script', 'drama-parse')]), textModels: [] }).canStart, false)
    assert.equal(buildCanvasRunPreflight({ ...input([node('script', 'drama-parse')]), textModels: ['text-model'] }).canStart, true)
  })

  it('keeps existing callers without a text catalog compatible', () => {
    assert.equal(buildCanvasRunPreflight(input([node('script', 'drama-parse')])).canStart, true)
  })

  it('does not claim an exact request upper bound or a retry policy', () => {
    const result = buildCanvasRunPreflight(input([node('script', 'drama-parse')]))
    const warning = result.warnings.join('\n')
    assert.match(warning, /步骤数不等于实际请求次数/)
    assert.match(warning, /可能再次调用文字模型/)
    assert.doesNotMatch(warning, /最多提交|不会自动重试/)
  })

  it('does not imply ordinary prompt input invokes a model', () => {
    const result = buildCanvasRunPreflight(input([node('prompt', 'prompt')]))
    assert.equal(result.paidRequestCount, 0)
    assert.equal(result.items[0].paid, false)
  })

  it('returns a usable configuration error for missing text setup', () => {
    const script = node('script', 'drama-parse')
    script.data.group = ''
    const options = input([script])
    assert.deepEqual(canvasMediaConfigurationErrors(options.graph, options.scope, options), ['请选择文字分组'])
  })

  it('does not mutate a project while inspecting it', () => {
    const options = input([node('image'), node('frame', 'frame-extract')])
    const before = structuredClone(options)
    buildCanvasRunPreflight(options)
    assert.deepEqual(options, before)
  })
})
