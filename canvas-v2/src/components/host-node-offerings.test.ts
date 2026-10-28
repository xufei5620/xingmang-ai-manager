import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { relatedNodeOptions } from '../editor/related-nodes'
import { v2EquivalentCapabilities, type CanvasCapabilityProfile } from '../host-capabilities'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import { inspectSelectedNodeRun } from './node-run-actions'
import { QuickInsert } from './QuickInsert'

function quickInsert(capabilities?: CanvasCapabilityProfile): string {
  return renderToStaticMarkup(createElement(QuickInsert, {
    open: true, anchor: { x: 0, y: 0 }, hasNodes: false, hasSelection: false, canvasNodes: [], capabilities,
    onAddNode: vi.fn(), onLoadTemplate: vi.fn(), onCommand: vi.fn(), onLocateNode: vi.fn(), onClose: vi.fn(),
  }))
}

describe('what the editor offers for a host profile', () => {
  it('leaves nodes the host cannot run out of quick insert', () => {
    const textTitle = `>${builtinNodeRegistry.require('text-generate').title}<`
    expect(quickInsert()).toContain(textTitle)
    expect(quickInsert(fullCanvasCapabilityProfile)).toContain(textTitle)
    const restricted = quickInsert(v2EquivalentCapabilities)
    expect(restricted).not.toContain(textTitle)
    expect(restricted).toContain(`>${builtinNodeRegistry.require('image-generate').title}<`)
  })

  it('leaves nodes the host cannot run out of related-node choices', () => {
    const nodes = [builtinNodeRegistry.create('prompt', 'prompt', { x: 0, y: 0 })]
    expect(relatedNodeOptions('prompt', nodes, []).some((option) => option.type === 'text-generate')).toBe(true)
    const restricted = relatedNodeOptions('prompt', nodes, [], v2EquivalentCapabilities)
    expect(restricted.some((option) => option.type === 'text-generate')).toBe(false)
    expect(restricted.some((option) => option.type === 'image-generate')).toBe(true)
  })

  it('takes the run action away from a selected node the host cannot run', () => {
    const selected = { id: 'node', type: 'text-generate', data: { status: 'idle', model: 'gpt-4.1' } }
    const defaults = { connected: true, imageModels: [], videoModels: [], textModels: ['gpt-4.1'] }
    expect(inspectSelectedNodeRun(selected, defaults)).toEqual({})
    expect(inspectSelectedNodeRun(selected, defaults, fullCanvasCapabilityProfile)).toEqual({})
    expect(inspectSelectedNodeRun(selected, defaults, v2EquivalentCapabilities)).toEqual({ disabledReason: '「文字生成」节点当前客户端暂不支持' })
  })
})
