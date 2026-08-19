import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function componentSource(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, name), 'utf8')
}

describe('canvas asset card markup', () => {
  it('keeps preview and action buttons as siblings in the asset tray', () => {
    const source = componentSource('AssetTray.tsx')
    expect(source).toContain('className={`asset-tray-item asset-tray-item-${asset.mediaType}')
    expect(source).toContain('className="asset-tray-item-preview"')
    expect(source).toContain('className="asset-tray-item-tools"')
    expect(source).toContain('className="asset-quick-views"')
    expect(source).toContain("view: 'favorites'")
    expect(source).toContain("view: 'recent'")
    expect(source).toContain('aria-label="\u7d20\u6750\u6765\u6e90"')
    expect(source).toContain('aria-label="\u7d20\u6750\u6392\u5e8f"')
    expect(source).toContain('onDoubleClick={() => setPreviewAsset(asset)}')
    expect(source).toContain('className="asset-tray-item-detail-head"')
    expect(source).toContain('<dt>分辨率</dt>')
    expect(source).toContain('<dt>时长</dt>')
    expect(source).toContain('<dt>原文件</dt>')
    expect(source).toContain('<dt>资产 ID</dt>')
    expect(source).not.toMatch(/<button[^>]*className="asset-tray-item"/)
  })

  it('never lets pointer movement over the grid change selection or focus', () => {
    // Tiles used to collapse on `onMouseLeave`, which also called `blur()` on
    // whatever inside them held focus. A pointer crossing the grid therefore
    // stole the keyboard focus of someone operating a tile without a mouse.
    // Selection transitions now live in asset-selection.ts and are driven only
    // by deliberate activation.
    const source = componentSource('AssetTray.tsx')
    expect(source).not.toContain('onMouseLeave')
    expect(source).not.toContain('.blur()')
    expect(source).toContain('assetSelectionAfterKey(')
    expect(source).toContain('assetSelectionForActivation(')
    expect(source).toContain('aria-expanded={expanded}')
  })

  it('supports the selection gestures a file grid is expected to have', () => {
    const source = componentSource('AssetTray.tsx')
    expect(source).toContain('toggle: event.ctrlKey || event.metaKey, range: event.shiftKey')
    expect(source).toContain('assetSelectionSelectAll(visibleAssetIds)')
    expect(source).toContain('assetSelectionForContextMenu(value, asset.assetId)')
    expect(source).toContain('aria-multiselectable="true"')
  })

  it('renders derived stills and keeps at most one live media element in the grid', () => {
    // Every video tile used to mount its own <video>, so a page of two dozen
    // decoded the full source media just to paint previews a few hundred pixels
    // wide. Players now live only in the docked detail panel, of which there is
    // one, so the grid itself holds no live media at all.
    const tray = componentSource('AssetTray.tsx')
    const gridMarkup = tray.slice(tray.indexOf('className="asset-tray-grid"'), tray.indexOf('className="asset-tray-detail"'))
    const detailMarkup = tray.slice(tray.indexOf('className="asset-tray-detail"'))
    expect(gridMarkup).not.toContain('<ViewportVideo')
    expect(gridMarkup).not.toContain('<AudioPreview')
    expect(detailMarkup).toContain("isLocalCanvasAssetUrl(asset.localUrl, 'video')")
    expect(detailMarkup).toContain("isLocalCanvasAssetUrl(asset.localUrl, 'audio')")
    expect(tray).not.toMatch(/controls=\{(selected|expanded)\}/)
    const library = componentSource('NodeLibrary.tsx')
    expect(library).not.toContain('<ViewportVideo')
    expect(library).toContain('src={asset.thumbnailUrl}')
  })

  it('wires logical rename through the asset tray and preview', () => {
    const tray = componentSource('AssetTray.tsx')
    const preview = componentSource('MediaPreview.tsx')
    expect(tray).toContain('onRename?(assetId: string, displayName: string): void | Promise<void>')
    expect(tray).toContain('className="asset-rename-dialog"')
    expect(tray).toContain('await onRename(renamingAsset.assetId, displayName)')
    expect(preview).toContain('onRename?(assetId: string): void')
  })

  it('persists favorites and tags through host callbacks', () => {
    const source = componentSource('AssetTray.tsx')
    expect(source).toContain('onUpdateMetadata?(assetId: string, input: { favorite?: boolean; tags?: string[] })')
    expect(source).toContain("{ favorite: !asset.favorite }")
    expect(source).toContain('await onUpdateMetadata(taggingAsset.assetId, { tags })')
  })

  it('records recent use where the drop lands, not where the drag begins', () => {
    // The tray used to mark the asset used in onDragStart, so a drag that was
    // cancelled, dropped on empty space or rejected for the wrong media type
    // still jumped to the front of the recent view and of used-desc sorting.
    const tray = componentSource('AssetTray.tsx')
    expect(tray).not.toContain('onMarkUsed')
    const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'App.tsx'), 'utf8')
    const dragStart = app.slice(app.indexOf("getData('application/x-xingmang-asset-id')"))
    expect(dragStart).toContain('addAssetNode(assetId, position)')
    // Both accept paths: a new node on the pane, and binding onto an existing
    // media node, which is also the one that can still refuse the asset.
    expect(app).toContain('void markCanvasAssetUsed(assetId)')
    expect(app).toContain('void markCanvasAssetUsed(asset.assetId)')
  })

  it('uses an article with sibling preview and menu controls in the content library', () => {
    const source = componentSource('NodeLibrary.tsx')
    expect(source).toContain('className="library-asset-item"')
    expect(source).toContain('className="library-asset-preview"')
    expect(source).toContain('<footer>')
    expect(source).not.toMatch(/<button[^>]*className="library-asset-item"/)
  })
})
