import { describe, expect, it, vi } from 'vitest'
import { canvasHostEntryPoints, withoutUnavailableNodeEntries } from './host-entry-points'
import { resolveCanvasCapabilities, v2EquivalentCapabilities } from './host-capabilities'
import { fullCanvasCapabilities, fullCanvasCapabilityProfile } from './host-capabilities.test-fixture'

async function method() { return undefined as never }

const allMethods = {
  getAssetDetail: method, downloadAssets: method, readAssetOrigin: method, listRunHistory: method,
  readRunHistory: method, renderImageAnnotation: method, readVideoForFramePreview: method,
  listProjectHistory: method, readProjectRevision: method, restoreProjectRevision: method, inspectProjectRestore: method,
  previewProjectExport: method, exportProjectPackage: method, cancelProjectExport: method,
}

describe('canvas host entry points', () => {
  it('offers none of them to a desktop without the methods or the switches', () => {
    // The 000f913 desktop bridge has none of these methods and declares nothing.
    expect(Object.values(canvasHostEntryPoints({}, v2EquivalentCapabilities))).toEqual(Array(10).fill(false))
  })

  it('offers all of them to a host with every method and switch', () => {
    expect(Object.values(canvasHostEntryPoints(allMethods, fullCanvasCapabilityProfile))).toEqual(Array(10).fill(true))
  })

  it('turns off every entry that reads complete asset records when that method is missing', () => {
    const { getAssetDetail: _missing, ...rest } = allMethods
    expect(canvasHostEntryPoints(rest, fullCanvasCapabilityProfile)).toEqual({
      batchAdd: false, batchDownload: true, assetOrigin: true, runResultCollection: false,
      imageAnnotation: false, videoFrames: false, menuPaste: true, pageDownload: true, projectHistory: true, projectPackageExport: true,
    })
  })

  it('offers frame selection only where frame extraction can run', () => {
    expect(canvasHostEntryPoints(allMethods, v2EquivalentCapabilities).videoFrames).toBe(false)
    const noFrames = resolveCanvasCapabilities({ ...fullCanvasCapabilities, features: { ...fullCanvasCapabilities.features, frameExtract: false } })
    expect(canvasHostEntryPoints(allMethods, noFrames).videoFrames).toBe(false)
  })

  it('follows the declared clipboard and download switches, which desktop v1 leaves out', () => {
    const { fileDownload: _download, clipboardRead: _clipboard, ...v1Features } = fullCanvasCapabilities.features
    const v1 = resolveCanvasCapabilities({ ...fullCanvasCapabilities, features: v1Features })
    expect(canvasHostEntryPoints(allMethods, v1)).toMatchObject({ menuPaste: false, pageDownload: false, batchDownload: true })
  })

  it('needs every revision method for version history and every package method for the package export', () => {
    for (const name of ['listProjectHistory', 'readProjectRevision', 'restoreProjectRevision', 'inspectProjectRestore'] as const) {
      const { [name]: _missing, ...rest } = allMethods
      expect(canvasHostEntryPoints(rest, fullCanvasCapabilityProfile)).toMatchObject({ projectHistory: false, projectPackageExport: true })
    }
    for (const name of ['previewProjectExport', 'exportProjectPackage', 'cancelProjectExport'] as const) {
      const { [name]: _missing, ...rest } = allMethods
      expect(canvasHostEntryPoints(rest, fullCanvasCapabilityProfile)).toMatchObject({ projectHistory: true, projectPackageExport: false })
    }
  })

  it('drops the node annotation and frame selection handlers the host cannot serve and keeps the rest', () => {
    const handlers = { onAnnotateImage: vi.fn(), onSelectVideoFrame: vi.fn(), onRename: vi.fn() }
    expect(withoutUnavailableNodeEntries(handlers, { imageAnnotation: false, videoFrames: false })).toEqual({ onAnnotateImage: undefined, onSelectVideoFrame: undefined, onRename: handlers.onRename })
    expect(withoutUnavailableNodeEntries(handlers, { imageAnnotation: true, videoFrames: false })).toEqual({ ...handlers, onSelectVideoFrame: undefined })
    expect(withoutUnavailableNodeEntries(handlers, { imageAnnotation: true, videoFrames: true })).toEqual(handlers)
  })
})
