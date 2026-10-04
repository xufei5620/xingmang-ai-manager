import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider } from '@xyflow/react'
import { CanvasGenerationComposer, CanvasModelAvailabilityProvider, type CanvasNode } from './WorkflowNodes'

function node(patch: Partial<CanvasNode['data']> = {}, type: CanvasNode['type'] = 'image-generate'): CanvasNode {
  return { id: 'fixture', type, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '保留草稿', model: 'gpt-image-2', status: 'idle', ...patch } }
}

function render(selected?: CanvasNode, imageModels = ['gpt-image-2', 'gpt-image-1']) {
  return renderToStaticMarkup(<ReactFlowProvider><CanvasModelAvailabilityProvider connected imageModels={imageModels} videoModels={['minimax-h3-mini']}><CanvasGenerationComposer node={selected} /></CanvasModelAvailabilityProvider></ReactFlowProvider>)
}

describe('docked generation composer markup', () => {
  it('starts with one model selector and two collapsed inline disclosures', () => {
    const html = render(node({ quality: 'high', imageResolution: '2K', size: '1280x720' }))
    expect(html).toContain('role="region"')
    expect(html).not.toContain('role="dialog"')
    expect(html.match(/<select/g)).toHaveLength(1)
    expect(html).toContain('生成参数：16:9 · 2K · 极高')
    expect(html).toContain('aria-controls="composer-parameters-fixture"')
    expect(html).toContain('aria-controls="composer-tools-fixture"')
    expect(html).not.toContain('wf-composer-parameters"')
    expect(html).not.toContain('wf-composer-tools"')
    expect(html).toContain('保留草稿')
  })

  it('does not render a composer for an empty or non-generating selection', () => {
    expect(render()).toBe('')
    expect(render(node({}, 'prompt'))).toBe('')
  })

  it('makes unavailable models visible and blocks submission without fallback selection', () => {
    const html = render(node({ model: 'gpt-image-2' }), ['gpt-image-1'])
    expect(html).toContain('当前分组不可用')
    expect(html).toContain('role="status"')
    expect(html).toMatch(/aria-label="生成"[^>]*disabled=""/)
    expect(html).toContain('value="gpt-image-2" disabled="" selected=""')
  })

  it('prevents submission for disabled and running nodes', () => {
    expect(render({ ...node(), disabled: true })).toMatch(/aria-label="生成"[^>]*disabled=""/)
    expect(render(node({ status: 'running' }))).toMatch(/aria-label="正在生成"[^>]*disabled=""/)
  })

  it('keeps saved automatic quality visible in the summary', () => {
    expect(render(node({ quality: 'auto' }))).toContain('自动画质')
  })

  it('summarizes the active video configuration and keeps the current model selected', () => {
    const html = render(node({ model: 'minimax-h3-mini', seconds: '6', settings: { videoResolution: '480p', videoAspectRatio: '9:16', promptOptimization: true } }, 'video-generate'))
    expect(html).toContain('生成参数：9:16 · 480p · 6 秒 · AI 优化')
    expect(html).toContain('value="minimax-h3-mini" selected=""')
  })
})
