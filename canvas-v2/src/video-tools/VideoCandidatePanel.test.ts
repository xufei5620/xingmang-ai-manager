import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowCandidateRef } from '../model'
import { VideoCandidatePanel, videoCandidateProgressLabel, type VideoCandidatePanelProps } from './VideoCandidatePanel'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(tree: unknown): ElementShape[] {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return []
  const element = tree as ElementShape
  return [element, ...elements(element.props.children)]
}
function candidate(index: number): WorkflowCandidateRef {
  const assetId = String.fromCharCode(97 + index).repeat(43)
  return { candidateId: `candidate-${index}`, attemptId: `attempt-${index}`, createdAt: '', asset: { kind: 'video', assetId, localUrl: `xingmang-asset://video/${assetId}`, durationSeconds: 3 } }
}
function fixture(overrides: Partial<VideoCandidatePanelProps> = {}) {
  const props: VideoCandidatePanelProps = { candidates: [candidate(0), candidate(1)], selectedCandidateId: 'candidate-1', status: 'succeeded', onSelect: vi.fn(), onPreview: vi.fn(), onDownload: vi.fn(), onPlace: vi.fn(), ...overrides }
  const tree = VideoCandidatePanel(props)
  function button(label: string) { const found = elements(tree).find((element) => element.type === 'button' && element.props['aria-label'] === label); if (!found) throw new Error(`Missing ${label}`); return found }
  return { props, tree, button, html: () => renderToStaticMarkup(createElement(VideoCandidatePanel, props)) }
}
function click(element: ElementShape) { (element.props.onClick as () => void)() }

describe('video candidate panel', () => {
  it('renders owned video previews without autoplay or interactive native controls and highlights the adopted asset', () => {
    const f = fixture(), html = f.html()
    expect(html.match(/<video /g)).toHaveLength(2)
    expect(html).toContain('preload="metadata"'); expect(html).toContain('muted=""')
    expect(html).not.toContain('autoPlay'); expect(html).not.toMatch(/<video[^>]* controls/)
    expect(f.button('采用视频候选 2').props['aria-pressed']).toBe(true)
    expect(f.button('采用视频候选 1').props['aria-pressed']).toBe(false)
    expect(html).toContain('已保存 2 个视频'); expect(html).not.toContain('已完成 2/3')
  })
  it('routes adoption, preview, download and snapshot to their separate existing actions', () => {
    const f = fixture()
    click(f.button('采用视频候选 1'))
    expect(f.props.onSelect).toHaveBeenCalledExactlyOnceWith('candidate-0')
    expect(f.props.onPreview).not.toHaveBeenCalled(); expect(f.props.onPlace).not.toHaveBeenCalled()
    click(f.button('预览当前视频候选')); expect(f.props.onPreview).toHaveBeenCalledExactlyOnceWith(candidate(1).asset)
    click(f.button('下载当前视频候选')); expect(f.props.onDownload).toHaveBeenCalledOnce()
    click(f.button('另存当前视频为节点')); expect(f.props.onPlace).toHaveBeenCalledExactlyOnceWith('candidate-1')
  })
  it.each(['running', 'queued'] as const)('allows only preview and owned download while %s', (status) => {
    const f = fixture({ status, progress: { completed: 1, submitted: 2, total: 4 } })
    click(f.button('预览视频候选 1')); expect(f.props.onPreview).toHaveBeenCalledExactlyOnceWith(candidate(0).asset)
    expect(f.props.onSelect).not.toHaveBeenCalled()
    const place = f.button('另存当前视频为节点'); expect(place.props.disabled).toBe(true)
    click(place); expect(f.props.onPlace).not.toHaveBeenCalled()
    expect(f.html()).toContain('已完成 1/4 · 已提交 2')
    expect(f.html()).toContain('逐条执行')
  })
  it('keeps successful partial results adoptable and does not invent progress from saved candidates', () => {
    const f = fixture({ status: 'failed', progress: { completed: 1, submitted: 2, total: 4 } })
    click(f.button('采用视频候选 1')); expect(f.props.onSelect).toHaveBeenCalledOnce()
    expect(f.html()).toContain('已完成的视频会保留')
    expect(f.html()).toContain('已完成 1/4 · 已提交 2')
    expect(videoCandidateProgressLabel(undefined, 2, 'failed')).toBe('已保存 2 个视频')
  })
  it('respects locked nodes while preserving read-only previews and isolates canvas keyboard shortcuts', () => {
    const f = fixture({ disabledReason: '节点已锁定' }), event = { stopPropagation: vi.fn() }
    click(f.button('预览视频候选 1')); expect(f.props.onSelect).not.toHaveBeenCalled()
    click(f.button('另存当前视频为节点')); expect(f.props.onPlace).not.toHaveBeenCalled()
    ;(f.tree.props.onKeyDown as (event: unknown) => void)(event)
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })
  it('never loads a remote preview and omits actions without a known selected video', () => {
    const remote = { ...candidate(0), asset: { ...candidate(0).asset, localUrl: 'https://example.com/private.mp4' } }
    const f = fixture({ candidates: [remote], selectedCandidateId: 'gone', onDownload: undefined, onPlace: undefined })
    expect(f.html()).not.toContain('<video'); expect(f.html()).not.toContain('https://example.com')
    expect(f.html()).not.toContain('当前视频候选操作')
  })
  it('validates runtime progress and shows a bounded fallback without equating duration and requests', () => {
    expect(videoCandidateProgressLabel({ completed: 1, submitted: 0, total: 4 }, 1, 'running')).toBe('已保存 1 个视频')
    expect(videoCandidateProgressLabel({ completed: 2, submitted: 2, total: 20 }, 0, 'queued')).toBe('正在准备视频任务')
    expect(videoCandidateProgressLabel(undefined, 0, 'idle')).toBe('暂无已保存的视频')
  })
})
