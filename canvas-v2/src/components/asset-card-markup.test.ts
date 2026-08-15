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
    expect(source).toContain('onDoubleClick={() => setPreviewAsset(asset)}')
    expect(source).toContain('onMouseLeave={(event) => {')
    expect(source).toContain('event.currentTarget.contains(focused)')
    expect(source).toContain('className="asset-tray-item-detail-head"')
    expect(source).toContain('<dt>分辨率</dt>')
    expect(source).toContain('<dt>时长</dt>')
    expect(source).toContain('<dt>原文件</dt>')
    expect(source).toContain('<dt>资产 ID</dt>')
    expect(source).not.toMatch(/<button[^>]*className="asset-tray-item"/)
  })

  it('wires logical rename through the asset tray and preview', () => {
    const tray = componentSource('AssetTray.tsx')
    const preview = componentSource('MediaPreview.tsx')
    expect(tray).toContain('onRename?(assetId: string, displayName: string): void | Promise<void>')
    expect(tray).toContain('className="asset-rename-dialog"')
    expect(tray).toContain('await onRename(renamingAsset.assetId, displayName)')
    expect(preview).toContain('onRename?(assetId: string): void')
  })

  it('uses an article with sibling preview and menu controls in the content library', () => {
    const source = componentSource('NodeLibrary.tsx')
    expect(source).toContain('className="library-asset-item"')
    expect(source).toContain('className="library-asset-preview"')
    expect(source).toContain('<footer>')
    expect(source).not.toMatch(/<button[^>]*className="library-asset-item"/)
  })
})
