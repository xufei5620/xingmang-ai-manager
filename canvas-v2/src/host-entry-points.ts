// 依赖宿主的入口（#4）：宿主少了哪个方法、没开哪项能力，对应的按钮就不给，免得客户点了才看到「请更新」。
// 老桌面（000f913）这些方法一个都没有，桌面 v1 的声明里也没有 fileDownload、clipboardRead；网页全有。
// 入口藏起来以后，处理函数里原来的检查照旧留着，宿主执行前也仍会自己校验。
import type { CanvasHostBridge } from './host'
import { canvasNodeKindAvailable, type CanvasCapabilityProfile } from './host-capabilities'

export interface CanvasHostEntryPoints {
  /** Batch "add to canvas" from the asset tray and run records: reads every asset's complete record first. */
  batchAdd: boolean
  /** Batch "download as one package". */
  batchDownload: boolean
  /** The "creation source" lookup in an asset's details. */
  assetOrigin: boolean
  /** "Collect results across runs" in the run records. */
  runResultCollection: boolean
  /** "Annotate image" on image results. */
  imageAnnotation: boolean
  /** Frame selection and frame sequences from a video. */
  videoFrames: boolean
  /** The menu's "paste from the system clipboard". Keyboard paste reads the paste event, not the clipboard API. */
  menuPaste: boolean
  /** Files the page builds and hands to the browser (TXT, PNG, presets). Saving an asset goes through the host instead. */
  pageDownload: boolean
  /** "Version history": listing, previewing and restoring saved revisions. */
  projectHistory: boolean
  /** "Export project with assets" and the resource tree's package export. */
  projectPackageExport: boolean
}

type EntryPointMethods = Pick<CanvasHostBridge, 'getAssetDetail' | 'downloadAssets' | 'readAssetOrigin' | 'listRunHistory' | 'readRunHistory' | 'renderImageAnnotation' | 'readVideoForFramePreview'
  | 'listProjectHistory' | 'readProjectRevision' | 'restoreProjectRevision' | 'inspectProjectRestore' | 'previewProjectExport' | 'exportProjectPackage' | 'cancelProjectExport'>

export function canvasHostEntryPoints(bridge: Partial<EntryPointMethods>, profile: CanvasCapabilityProfile): CanvasHostEntryPoints {
  const assetDetail = typeof bridge.getAssetDetail === 'function'
  return {
    batchAdd: assetDetail,
    batchDownload: typeof bridge.downloadAssets === 'function',
    assetOrigin: typeof bridge.readAssetOrigin === 'function',
    runResultCollection: assetDetail && typeof bridge.listRunHistory === 'function' && typeof bridge.readRunHistory === 'function',
    imageAnnotation: assetDetail && typeof bridge.renderImageAnnotation === 'function',
    videoFrames: assetDetail && typeof bridge.readVideoForFramePreview === 'function' && canvasNodeKindAvailable('frame-extract', profile),
    menuPaste: profile.features.clipboardRead,
    pageDownload: profile.features.fileDownload,
    projectHistory: typeof bridge.listProjectHistory === 'function' && typeof bridge.readProjectRevision === 'function'
      && typeof bridge.restoreProjectRevision === 'function' && typeof bridge.inspectProjectRestore === 'function',
    projectPackageExport: typeof bridge.previewProjectExport === 'function' && typeof bridge.exportProjectPackage === 'function' && typeof bridge.cancelProjectExport === 'function',
  }
}

interface NodeEntryHandlers {
  onAnnotateImage?(nodeId: string): void
  onSelectVideoFrame?(nodeId: string): void
}

// 节点上的「标注图片」「选择视频帧」看对应的 handler 在不在（WorkflowNodes），宿主做不到就把 handler 拿掉。
export function withoutUnavailableNodeEntries<T extends NodeEntryHandlers>(handlers: T, entries: Pick<CanvasHostEntryPoints, 'imageAnnotation' | 'videoFrames'>): T {
  return {
    ...handlers,
    onAnnotateImage: entries.imageAnnotation ? handlers.onAnnotateImage : undefined,
    onSelectVideoFrame: entries.videoFrames ? handlers.onSelectVideoFrame : undefined,
  }
}
