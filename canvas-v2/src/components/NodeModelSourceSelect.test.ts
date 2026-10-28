import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NodeModelSourceSelect } from './NodeModelSourceSelect'
import type { CanvasGroupSummary } from '../host'

const sources: CanvasGroupSummary[] = [
  { name: 'image-a', description: '本人图像来源', ratio: 1, purposes: ['image'], connectionStatus: 'ready' },
  { name: 'video-a', description: '本人视频来源', ratio: 1, purposes: ['video'], connectionStatus: 'ready' },
  { name: 'untested', description: '尚未检测图像', ratio: 1, purposes: ['image'], connectionStatus: 'untested' },
]
function select(group?: string) {
  const onChange = vi.fn(), element = NodeModelSourceSelect({ kind: 'image-generate', group, sources, onChange })!
  const field = (element.props.children as ReactElement<{ onChange(event: { target: { value: string } }): void; value: string }>[])[1]
  return { element, field, onChange, change(value: string) { field.props.onChange({ target: { value } }) } }
}
describe('actual node fixed-source choice control', () => {
  it('offers only owned purpose-compatible choices and an explicit clear-pin choice', () => {
    const html = renderToStaticMarkup(createElement(NodeModelSourceSelect, { kind: 'image-generate', group: 'image-a', sources, onChange: vi.fn() }))
    expect(html).toContain('使用画布默认来源'); expect(html).toContain('本人图像来源'); expect(html).not.toContain('本人视频来源'); expect(html).toContain('尚未检测')
  })
  it('only forwards an explicit available source or clear-pin event and rejects forged or untested values', () => {
    const f = select('deleted-owner-source')
    expect(f.field.props.value).toBe('deleted-owner-source')
    f.change('image-a'); f.change(''); f.change('foreign'); f.change('video-a'); f.change('untested')
    expect(f.onChange.mock.calls).toEqual([['image-a'], [undefined]])
  })
  it('keeps an invalid saved source visible until the user explicitly chooses another source', () => {
    const f = select('deleted-owner-source'), html = renderToStaticMarkup(f.element)
    expect(html).toContain('deleted-owner-source（固定来源已失效）'); expect(f.onChange).not.toHaveBeenCalled()
    expect(select().field.props.value).toBe(''); expect(select('').field.props.value).toBe('__invalid_source__')
  })
})
