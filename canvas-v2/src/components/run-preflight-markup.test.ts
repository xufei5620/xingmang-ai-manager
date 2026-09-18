import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RunPreflight } from './RunPreflight'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'

describe('guided run preflight markup', () => {
  it('renders the real component without exposing internal operation names', () => {
    const preflight = buildCanvasRunPreflight({
      graph: { nodes: [{ id: 'n1', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'test', model: 'image', group: 'images' } }], edges: [] },
      scope: { kind: 'all' }, imageModels: ['image'], videoModels: [],
    })
    const markup = renderToStaticMarkup(createElement(RunPreflight, {
      preflight, onCancel: () => undefined, onConfigure: () => undefined,
      onConfirm: () => assert.fail('render must never submit a request'),
    }))
    assert.match(markup, /生成图片/)
    assert.doesNotMatch(markup, /image-generate|最多提交/)
    assert.match(markup, /aria-modal="true"/)
    assert.match(markup, /aria-label="确认运行"/)
    assert.match(markup, /<details class="preflight-plan">/)
  })

  it('shows unsupported capability guidance rather than a misleading configure button', () => {
    const preflight = buildCanvasRunPreflight({
      graph: { nodes: [{ id: 'frame', kind: 'frame-extract', definitionVersion: 1, data: { prompt: '', model: '' } }], edges: [] },
      scope: { kind: 'all' }, imageModels: [], videoModels: [],
    })
    const markup = renderToStaticMarkup(createElement(RunPreflight, {
      preflight, onCancel: () => undefined, onConfigure: () => undefined, onConfirm: () => undefined,
    }))
    assert.match(markup, /先处理这些问题/)
    assert.match(markup, /视频抽帧尚未接入/)
    assert.match(markup, /data-testid="canvas-preflight-confirm" disabled=""/)
    assert.doesNotMatch(markup, /打开生成配置/)
  })
})
