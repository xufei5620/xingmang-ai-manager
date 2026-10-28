import type { KeyboardEvent, PointerEvent } from 'react'

import type { LayerDocumentCropRect, LayerDocumentCropHandle } from './layer-document-crop'
export type LayerDocumentCropDrag = 'draw' | 'move' | LayerDocumentCropHandle

const handles: Array<{ id: LayerDocumentCropHandle; label: string; x: number; y: number }> = [
  { id: 'nw', label: '左上角', x: 0, y: 0 }, { id: 'n', label: '上边', x: .5, y: 0 }, { id: 'ne', label: '右上角', x: 1, y: 0 }, { id: 'e', label: '右边', x: 1, y: .5 },
  { id: 'se', label: '右下角', x: 1, y: 1 }, { id: 's', label: '下边', x: .5, y: 1 }, { id: 'sw', label: '左下角', x: 0, y: 1 }, { id: 'w', label: '左边', x: 0, y: .5 },
]

export function LayerDocumentCropOverlay({ rect, width, height, scale, onStart, onMove, onEnd, onCancel, onNudge }: { rect: LayerDocumentCropRect | null; width: number; height: number; scale: number; onStart(event: PointerEvent<SVGGElement>, mode: LayerDocumentCropDrag): void; onMove(event: PointerEvent<SVGGElement>): void; onEnd(event: PointerEvent<SVGGElement>): void; onCancel(event: PointerEvent<SVGGElement>): void; onNudge(mode: LayerDocumentCropDrag, dx: number, dy: number): void }) {
  const grip = 9 / Math.max(.0001, scale), hit = 20 / Math.max(.0001, scale)
  function start(event: PointerEvent<SVGGElement>) {
    const mode = event.target instanceof Element ? event.target.closest('[data-document-crop]')?.getAttribute('data-document-crop') : null
    if (mode && ['draw', 'move', ...handles.map((item) => item.id)].includes(mode)) onStart(event, mode as LayerDocumentCropDrag)
  }
  function keyboard(event: KeyboardEvent<SVGElement>, mode: LayerDocumentCropDrag) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault(); event.stopPropagation()
    const step = event.shiftKey ? 10 : 1
    onNudge(mode, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0)
  }
  return <g className="layer-document-crop" aria-label="文档裁剪范围" onPointerDown={start} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onCancel} onLostPointerCapture={onCancel}>
    <rect data-document-crop="draw" width={width} height={height} fill="transparent" pointerEvents="all" />
    {rect && <>
      <path className="layer-document-crop-shade" pointerEvents="none" fillRule="evenodd" d={`M0 0H${width}V${height}H0Z M${rect.x} ${rect.y}v${rect.height}h${rect.width}v${-rect.height}Z`} />
      <rect data-document-crop="move" className="layer-document-crop-boundary" role="button" tabIndex={0} aria-label="移动裁剪框，方向键微调" x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill="transparent" pointerEvents="all" onKeyDown={(event) => keyboard(event, 'move')} />
      <g className="layer-document-crop-thirds" pointerEvents="none">{[1 / 3, 2 / 3].map((part) => <g key={part}><line x1={rect.x + rect.width * part} y1={rect.y} x2={rect.x + rect.width * part} y2={rect.y + rect.height} /><line x1={rect.x} y1={rect.y + rect.height * part} x2={rect.x + rect.width} y2={rect.y + rect.height * part} /></g>)}</g>
      {handles.map((handle) => <g key={handle.id} data-document-crop={handle.id} className={`layer-document-crop-grip layer-document-crop-${handle.id}`} role="button" tabIndex={0} aria-label={`调整裁剪${handle.label}，方向键微调`} onKeyDown={(event) => keyboard(event, handle.id)} transform={`translate(${rect.x + rect.width * handle.x} ${rect.y + rect.height * handle.y})`}><rect x={-hit / 2} y={-hit / 2} width={hit} height={hit} fill="transparent" pointerEvents="all" /><rect className="layer-document-crop-grip-mark" pointerEvents="none" x={-grip / 2} y={-grip / 2} width={grip} height={grip} /></g>)}
    </>}
  </g>
}
