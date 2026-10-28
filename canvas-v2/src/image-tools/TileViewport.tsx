import { useEffect, useRef, useState } from 'react'
import { Download, Move, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { SafeImage, isCanvasImagePreviewUrl } from '../components/MediaPreview'
import { resolveCanvasAssetDisplayUrl } from '../asset-display-url'
import type { AssetRef } from '../model'
import { imagePreviewSourceKey } from './preview-image-dimensions'
import { createTileViewportInteraction, tilePreviewDimensions } from './tile-preview-state'
import './tile-preview.css'

export interface TileViewportImage { label: string; asset: AssetRef; onLoad?(image: HTMLImageElement): void }

export function TileViewport({ image, message, onDownload }: { image?: TileViewportImage; message?: string; onDownload?(): Promise<void> }) {
  const stage = useRef<HTMLDivElement>(null), mounted = useRef(true)
  const [, redraw] = useState(0), [receipt, setReceipt] = useState<{ scope: string; width: number; height: number; failed?: boolean } | null>(null)
  const [download, setDownload] = useState<{ scope: string; busy: boolean; error?: string } | null>(null)
  const source = image?.asset.localUrl, scope = image ? imagePreviewSourceKey(image.asset) : ''
  const active = useRef(scope), downloadInFlight = useRef(false); active.current = scope
  const interaction = useRef<ReturnType<typeof createTileViewportInteraction> | null>(null)
  if (!interaction.current) interaction.current = createTileViewportInteraction(() => redraw((revision) => revision + 1))
  const loaded = receipt?.scope === scope && !receipt.failed && source && isCanvasImagePreviewUrl(source) ? receipt : null
  interaction.current.sync(scope, Boolean(loaded))
  const view = interaction.current.read(), size = tilePreviewDimensions(loaded?.width ?? 0, loaded?.height ?? 0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; interaction.current?.sync('', false) } }, [])
  useEffect(() => {
    const target = stage.current
    if (!target) return
    function wheel(event: WheelEvent) {
      if (active.current !== scope || !loaded || !target) return
      event.preventDefault(); event.stopPropagation()
      const rect = target.getBoundingClientRect()
      interaction.current?.wheel(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    target.addEventListener('wheel', wheel, { passive: false })
    return () => target.removeEventListener('wheel', wheel)
  }, [scope, Boolean(loaded)])
  function center() { const bounds = stage.current?.getBoundingClientRect(); return { x: (bounds?.width ?? 0) / 2, y: (bounds?.height ?? 0) / 2 } }
  async function downloadOriginal() {
    if (!onDownload || !loaded || downloadInFlight.current) return
    downloadInFlight.current = true
    setDownload({ scope, busy: true })
    try { await onDownload(); if (mounted.current && active.current === scope) setDownload({ scope, busy: false }) }
    catch (cause) { if (mounted.current && active.current === scope) setDownload({ scope, busy: false, error: cause instanceof Error ? cause.message : '原图下载失败，请在素材库重试' }) }
    finally { downloadInFlight.current = false }
  }
  const failed = Boolean(source && !isCanvasImagePreviewUrl(source)) || receipt?.scope === scope && receipt.failed
  return <div className="tile-viewport">
    <div className="tile-viewport-toolbar"><span><Move size={14} />拖动平移 · 滚轮缩放</span><div>
      <button type="button" aria-label="缩小平铺预览" disabled={!loaded || view.scale <= .1} onClick={() => interaction.current?.zoom(view.scale / 1.25, center())}><ZoomOut size={16} /></button>
      <output aria-label="平铺预览缩放">{Math.round(view.scale * 100)}%</output>
      <button type="button" aria-label="放大平铺预览" disabled={!loaded || view.scale >= 8} onClick={() => interaction.current?.zoom(view.scale * 1.25, center())}><ZoomIn size={16} /></button>
      <button type="button" disabled={!loaded} onClick={() => interaction.current?.reset()}><RotateCcw size={14} />重置视图</button>
      {onDownload && <button type="button" disabled={!loaded || download?.scope === scope && download.busy} onClick={() => void downloadOriginal()}><Download size={14} />{download?.scope === scope && download.busy ? '下载中…' : '下载当前原图'}</button>}
    </div></div>
    <div ref={stage} className={`tile-viewport-stage${loaded ? ' is-ready' : ''}`} tabIndex={0} role="img" aria-label={`无限平铺预览${image ? ` · ${image.label}` : ''}`} style={loaded && source ? { backgroundImage: `url(${JSON.stringify(resolveCanvasAssetDisplayUrl(source))})`, backgroundSize: `${size.width * view.scale}px ${size.height * view.scale}px`, backgroundPosition: `${view.x}px ${view.y}px` } : undefined}
      onPointerDown={(event) => { if (event.button !== 0 || event.isPrimary === false || !interaction.current?.start(event.pointerId, event.clientX, event.clientY)) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={(event) => { if (interaction.current?.pending() !== event.pointerId) return; event.preventDefault(); event.stopPropagation(); interaction.current.move(event.pointerId, event.clientX, event.clientY) }}
      onPointerUp={(event) => { interaction.current?.finish(event.pointerId); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onPointerCancel={(event) => interaction.current?.cancel(event.pointerId)} onLostPointerCapture={(event) => interaction.current?.cancel(event.pointerId)}
      onKeyDown={(event) => { if (interaction.current?.key(event.key, center())) { event.preventDefault(); event.stopPropagation() } }}>
      {source && <SafeImage key={scope} className="tile-viewport-loader" src={source} alt="" aria-hidden="true" draggable={false} onLoad={(event) => { const imageElement = event.currentTarget; if (!mounted.current || active.current !== scope) return; if (imageElement.naturalWidth <= 0 || imageElement.naturalHeight <= 0) { setReceipt({ scope, width: 0, height: 0, failed: true }); return }; image?.onLoad?.(imageElement); setReceipt({ scope, width: imageElement.naturalWidth, height: imageElement.naturalHeight }) }} onError={() => { if (mounted.current && active.current === scope) setReceipt({ scope, width: 0, height: 0, failed: true }) }} />}
      {!loaded && <p role="status">{message || (failed ? '当前贴图无法读取，请核对素材或切换其他贴图' : source ? '正在读取当前贴图…' : '连接图片后选择贴图，预览连续重复效果')}</p>}
    </div>
    <p className="tile-viewport-note">这里连续重复当前原图。行列、镜像和输出尺寸用于处理成品；平移缩放不会修改画布或提交运行。</p>
    {download?.scope === scope && download.error && <p className="image-tool-error" role="alert">{download.error}</p>}
  </div>
}
