import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasAssetReferenceReport } from '../host'
import { AssetReferenceDetails, assetReferenceScanIncomplete } from './AssetReferenceDetails'

function report(patch: Partial<CanvasAssetReferenceReport> = {}): CanvasAssetReferenceReport {
  return { assetId: 'a'.repeat(43), inUse: false, projectScanStatus: 'complete', runScanStatus: 'complete', currentProject: { projectId: 'project', projectName: '当前画布', nodeIds: [] }, projects: [], runs: [], ...patch }
}
function render(value: CanvasAssetReferenceReport): string {
  return renderToStaticMarkup(createElement(AssetReferenceDetails, { report: value, loading: false }))
}
function revision(index: number, kind: 'save' | 'restore-point' = 'save') {
  return { projectId: 'project', projectName: `历史项目 ${index}`, revisionId: String(index).padStart(32, '0'), projectVersion: index, kind, savedAt: '2026-10-14T20:00:00.000Z' }
}

describe('asset history reference details', () => {
  it('keeps older host reports compatible without inventing historical counts', () => {
    const html = render(report())
    expect(html).toContain('当前画布</dt><dd>0 个节点')
    expect(html).toContain('引用检查已完成')
    expect(html).not.toContain('历史版本与恢复点')
  })
  it('distinguishes saved versions and restore points from current project nodes', () => {
    const html = render(report({ inUse: true, versions: [revision(3), revision(4, 'restore-point')], versionReferenceCount: 2, invalidVersionCount: 0 }))
    expect(html).toContain('当前画布</dt><dd>0 个节点')
    expect(html).toContain('已保存项目</dt><dd>0 个项目')
    expect(html).toContain('历史版本与恢复点</dt><dd>2 条记录')
    expect(html).toContain('已保存历史版本')
    expect(html).toContain('恢复前版本（恢复点）')
    expect(html).toContain('<em>版本 3</em>')
    expect(html).toContain('<em>版本 4</em>')
    expect(html).not.toContain('3 个节点')
  })
  it('reports complete historical totals while bounding loaded version details', () => {
    const html = render(report({ inUse: true, versions: Array.from({ length: 52 }, (_, index) => revision(index + 1)), versionReferenceCount: 72, versionDetailsTruncated: true }))
    expect(html).toContain('72 条记录')
    expect(html).toContain('前 50 条历史版本或恢复点')
    expect(html).toContain('历史项目 50')
    expect(html).not.toContain('历史项目 51')
  })
  it('treats unreadable history as incomplete without claiming a proven reference or a safe deletion', () => {
    const value = report({ inUse: true, versions: [], versionReferenceCount: 0, invalidVersionCount: 3 })
    const html = render(value)
    expect(assetReferenceScanIncomplete(value)).toBe(true)
    expect(html).toContain('素材仍需保留，引用核查尚未完成')
    expect(html).toContain('3 条历史版本内容或素材引用索引无法完整读取')
    expect(html).not.toContain('引用检查已完成')
    expect(html).not.toContain('素材仍被画布或历史记录引用')
    expect(html).not.toContain('class="is-clear"')
  })
  it('shows a verified empty history separately from an unavailable host feature', () => {
    const html = render(report({ versions: [], versionReferenceCount: 0, versionDetailsTruncated: false, invalidVersionCount: 0 }))
    expect(html).toContain('历史版本与恢复点</dt><dd>0 条记录')
    expect(html).toContain('引用检查已完成')
  })
  it('escapes stored names and keeps existing partial run guards', () => {
    const html = render(report({ inUse: true, runScanStatus: 'partial', versions: [{ ...revision(1), projectName: '<script>alert(1)</script>' }] }))
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('引用核查尚未完成')
  })
})
