import { useEffect, useRef, useState } from 'react'
import { SafeImage } from '../components/MediaPreview'
import { createPanoramaViewInteraction, initialPanoramaView, normalizePanoramaView, panoramaKeyView, panoramaRenderSize, type PanoramaView } from './panorama-view-state'
import './panorama-preview.css'
import { capturePanoramaPng, downloadPanoramaPng } from './panorama-download'

interface PanoramaPreviewProps {
  src: string
  sourceKey?: string
  view: PanoramaView
  onChange(view: PanoramaView): void
  onCommit(view: PanoramaView): void
  disabled?: boolean
  compact?: boolean
  /** False when the host blocks page downloads. */
  allowDownload?: boolean
}
interface PanoramaRenderer { scope: string; draw(view: PanoramaView): void; dispose(): void }
interface PanoramaLoadState { scope: string; status: 'loading' | 'ready' | 'error'; error?: string; width?: number; height?: number }

/** Projection of a host-owned image. Camera changes never alter its pixels. */
export function PanoramaPreview({ src, sourceKey = src, view, onChange, onCommit, disabled = false, compact = false, allowDownload = true }: PanoramaPreviewProps) {
  const identity = JSON.stringify([sourceKey, src])
  const generation = useRef({ identity, revision: 0 })
  if (generation.current.identity !== identity) generation.current = { identity, revision: generation.current.revision + 1 }
  const scope = JSON.stringify([identity, generation.current.revision])
  const current = useRef({ scope, sourceKey, view, onChange, onCommit, disabled })
  current.current = { scope, sourceKey, view, onChange, onCommit, disabled }
  const canvas = useRef<HTMLCanvasElement>(null)
  const loadedImage = useRef<{ scope: string; image: HTMLImageElement } | null>(null)
  const renderer = useRef<PanoramaRenderer | null>(null)
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [load, setLoad] = useState<PanoramaLoadState>({ scope, status: 'loading' })
  const [retry, setRetry] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const exportPending = useRef(false)
  const alive = useRef(true)
  const ready = load.scope === scope && load.status === 'ready'
  const error = load.scope === scope && load.status === 'error' ? load.error : ''
  const interaction = useRef<ReturnType<typeof createPanoramaViewInteraction> | null>(null)
  if (!interaction.current) interaction.current = createPanoramaViewInteraction({
    onChange(next) { if (!current.current.disabled) current.current.onChange(next) },
    onCommit(next) { if (!current.current.disabled) current.current.onCommit(next) },
  })
  interaction.current.sync(view, sourceKey, !disabled && ready)

  useEffect(() => { if (renderer.current?.scope === scope) renderer.current.draw(normalizePanoramaView(view)) }, [scope, view])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    // Hide the previous projection during render; cleanup must not dispose a
    // newly loaded image when a cached image fires before passive effects.
    if (renderer.current && renderer.current.scope !== scope) { renderer.current.dispose(); renderer.current = null }
    if (loadedImage.current?.scope !== scope) loadedImage.current = null
    if (loadedImage.current?.scope === scope && !renderer.current) prepare(loadedImage.current.image)
    setExportError('')
    if (wheelTimer.current !== null) clearTimeout(wheelTimer.current)
    wheelTimer.current = null
    return () => {
      if (renderer.current?.scope === scope) { renderer.current.dispose(); renderer.current = null }
      if (wheelTimer.current !== null) clearTimeout(wheelTimer.current)
      wheelTimer.current = null
      interaction.current?.discard()
    }
  }, [scope])
  useEffect(() => {
    const target = canvas.current
    if (!target) return
    function wheel(event: WheelEvent) {
      if (current.current.scope !== scope || current.current.disabled) return
      event.preventDefault()
      event.stopPropagation()
      if (!interaction.current?.wheel(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 200 : 1))) return
      if (wheelTimer.current !== null) clearTimeout(wheelTimer.current)
      wheelTimer.current = setTimeout(() => {
        wheelTimer.current = null
        if (current.current.scope === scope) interaction.current?.finishWheel()
      }, 180)
    }
    function lost(event: Event) {
      if (current.current.scope !== scope) return
      event.preventDefault()
      interaction.current?.cancel()
      renderer.current?.dispose()
      renderer.current = null
      setLoad({ scope, status: 'error', error: '全景显示连接已中断，正在等待设备恢复；也可查看下方原图' })
    }
    function restored() {
      const loaded = loadedImage.current
      if (current.current.scope === scope && loaded?.scope === scope) prepare(loaded.image)
    }
    target.addEventListener('wheel', wheel, { passive: false })
    target.addEventListener('webglcontextlost', lost)
    target.addEventListener('webglcontextrestored', restored)
    return () => {
      target.removeEventListener('wheel', wheel)
      target.removeEventListener('webglcontextlost', lost)
      target.removeEventListener('webglcontextrestored', restored)
    }
  }, [scope])

  function prepare(image: HTMLImageElement) {
    if (current.current.scope !== scope) return
    loadedImage.current = { scope, image }
    renderer.current?.dispose()
    renderer.current = null
    const target = canvas.current
    const gl = target?.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false })
    if (!target || !gl) { setLoad({ scope, status: 'error', error: '当前浏览器不支持全景投影，请使用下方原图预览' }); return }
    const shaders: WebGLShader[] = []
    let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null, texture: WebGLTexture | null = null
    let observer: ResizeObserver | null = null
    let disposed = false
    function release() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      shaders.forEach((shader) => gl?.deleteShader(shader))
      if (program) gl?.deleteProgram(program)
      if (buffer) gl?.deleteBuffer(buffer)
      if (texture) gl?.deleteTexture(texture)
    }
    try {
      const maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE)
      if (image.naturalWidth < 1 || image.naturalHeight < 1) throw new Error('全景图片尺寸无效')
      if (image.naturalWidth > maximum || image.naturalHeight > maximum) throw new Error('图片尺寸超过设备的全景纹理上限，请先缩小图片')
      function shader(type: number, source: string) {
        const result = gl!.createShader(type)
        if (!result) throw new Error('全景渲染器初始化失败')
        shaders.push(result)
        gl!.shaderSource(result, source)
        gl!.compileShader(result)
        if (!gl!.getShaderParameter(result, gl!.COMPILE_STATUS)) throw new Error('设备无法编译全景投影，请使用原图预览')
        return result
      }
      const vertex = shader(gl.VERTEX_SHADER, 'attribute vec2 point; varying vec2 uv; void main(){uv=point;gl_Position=vec4(point,0.0,1.0);}')
      const fragment = shader(gl.FRAGMENT_SHADER, `precision highp float;
        varying vec2 uv; uniform sampler2D photo; uniform vec4 camera;
        void main(){
          vec3 ray=normalize(vec3(uv.x*camera.w*tan(camera.z/2.0),uv.y*tan(camera.z/2.0),-1.0));
          float cp=cos(camera.y),sp=sin(camera.y),cy=cos(camera.x),sy=sin(camera.x);
          vec3 p=vec3(ray.x,ray.y*cp-ray.z*sp,ray.y*sp+ray.z*cp);
          vec3 d=vec3(p.x*cy-p.z*sy,p.y,p.x*sy+p.z*cy);
          vec2 sphere=vec2(atan(d.x,-d.z)/6.28318530718+0.5,0.5-asin(clamp(d.y,-1.0,1.0))/3.14159265359);
          gl_FragColor=texture2D(photo,vec2(fract(sphere.x),sphere.y));
        }`)
      program = gl.createProgram()
      if (!program) throw new Error('全景渲染器初始化失败')
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('设备无法初始化全景投影')
      gl.useProgram(program)
      buffer = gl.createBuffer()
      if (!buffer) throw new Error('设备无法分配全景预览内存')
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      const point = gl.getAttribLocation(program, 'point')
      gl.enableVertexAttribArray(point); gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0)
      texture = gl.createTexture()
      if (!texture) throw new Error('设备无法分配全景图片纹理')
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('设备无法读取全景图片纹理，请使用原图预览')
      const camera = gl.getUniformLocation(program, 'camera')
      function draw(next: PanoramaView) {
        if (disposed || !target || !gl || current.current.scope !== scope) return
        const bounds = target.getBoundingClientRect()
        const { width, height } = panoramaRenderSize(bounds.width, bounds.height, window.devicePixelRatio || 1)
        if (target.width !== width) target.width = width
        if (target.height !== height) target.height = height
        gl.viewport(0, 0, width, height)
        gl.uniform4f(camera, next.yaw * Math.PI / 180, next.pitch * Math.PI / 180, next.fov * Math.PI / 180, width / height)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      observer = new ResizeObserver(() => draw(normalizePanoramaView(current.current.view)))
      observer.observe(target)
      renderer.current = { scope, draw, dispose: release }
      draw(normalizePanoramaView(current.current.view))
      setLoad({ scope, status: 'ready', width: image.naturalWidth, height: image.naturalHeight })
    } catch (cause) { release(); setLoad({ scope, status: 'error', error: cause instanceof Error ? cause.message : '全景预览不可用' }) }
  }

  function active() { return current.current.scope === scope && !current.current.disabled }
  function commit(next: PanoramaView) { if (active()) interaction.current?.commit(next) }
  async function exportView() {
    const target = canvas.current
    const projection = renderer.current
    if (!active() || !ready || !target || projection?.scope !== scope || exportPending.current) return
    exportPending.current = true
    setExporting(true)
    setExportError('')
    try {
      // A WebGL default framebuffer may be discarded after presentation.
      // Redraw and request its PNG in the same task, at the displayed view.
      projection.draw(normalizePanoramaView(current.current.view))
      const blob = await capturePanoramaPng(target)
      if (alive.current && active()) downloadPanoramaPng(blob)
    } catch (cause) {
      if (alive.current && active()) setExportError(cause instanceof Error ? cause.message : '当前视角下载失败，请重试')
    } finally {
      exportPending.current = false
      if (alive.current) setExporting(false)
    }
  }
  return <div className={`image-tool-panorama nodrag nopan nowheel${compact ? ' is-compact' : ''}`}>
    <SafeImage key={`${scope}:${retry}`} className={error ? 'image-tool-panorama-fallback' : 'image-tool-panorama-source'} src={src} alt="全景原图" onLoad={(event) => prepare(event.currentTarget)} onError={() => {
      if (current.current.scope !== scope) return
      interaction.current?.cancel()
      renderer.current?.dispose(); renderer.current = null
      setLoad({ scope, status: 'error', error: '全景原图无法读取，请检查素材是否仍可用' })
    }} />
    <canvas ref={canvas} tabIndex={ready && !disabled ? 0 : -1} aria-hidden={!ready} aria-disabled={disabled || !ready} className={ready ? '' : 'is-unavailable'} aria-label="360 度全景预览，拖动或用方向键转动，滚轮或加减键缩放，Home 复位，Escape 取消本次调整"
      onPointerDown={(event) => {
        if (!active() || event.button !== 0 || event.isPrimary === false || !interaction.current?.startPointer(event.pointerId, event.clientX, event.clientY)) return
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus()
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { interaction.current.cancel(event.pointerId) }
      }}
      onPointerMove={(event) => { if (active()) interaction.current?.movePointer(event.pointerId, event.clientX, event.clientY) }}
      onPointerUp={(event) => { if (active()) interaction.current?.finishPointer(event.pointerId) }}
      onPointerCancel={(event) => { if (active()) interaction.current?.cancel(event.pointerId) }}
      onLostPointerCapture={(event) => { if (active()) interaction.current?.cancel(event.pointerId) }}
      onKeyDown={(event) => {
        if (!active() || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
        if (event.key === 'Escape' && interaction.current?.pending()) { event.preventDefault(); event.stopPropagation(); interaction.current.cancel(); return }
        if (interaction.current?.key(event.key)) { event.preventDefault(); event.stopPropagation() }
      }}
      onKeyUp={(event) => { if (active() && panoramaKeyView(view, event.key)) { event.preventDefault(); event.stopPropagation(); interaction.current?.finishKeyboard() } }}
      onBlur={() => { if (active()) { interaction.current?.finishKeyboard(); interaction.current?.cancel() } }} />
    {!ready && !error && <p className="panorama-load-notice" role="status">正在加载全景图片…</p>}
    {error && <p className="panorama-load-notice" role="status">{error} <button type="button" disabled={disabled} onClick={() => { if (!active()) return; setLoad({ scope, status: 'loading' }); setRetry((value) => value + 1) }}>重新加载</button></p>}
    <div className="image-tool-inline-actions"><button type="button" onClick={() => commit({ ...view, fov: view.fov - 10 })} disabled={disabled || !ready || view.fov <= 30}>放大</button><button type="button" onClick={() => commit({ ...view, fov: view.fov + 10 })} disabled={disabled || !ready || view.fov >= 110}>缩小</button><button type="button" onClick={() => commit({ ...initialPanoramaView })} disabled={disabled || !ready}>复位视角</button><span>视场 {Math.round(view.fov)}°</span></div>
    {!compact && allowDownload && <div className="image-tool-inline-actions"><button type="button" disabled={disabled || !ready || exporting} onClick={() => { void exportView() }}>{exporting ? '正在导出视角…' : '下载当前视角'}</button><span>PNG · 仅当前取景</span></div>}
    {exportError && <p role="alert" className="image-tool-error">{exportError}</p>}
    <p className="panorama-view-hint">拖动转动 · 滚轮缩放 · 方向键微调{!compact && ' · Home 复位 · Esc 取消本次调整'}</p>
    <p className="panorama-format-hint">适用于 2:1 等距柱状全景；普通照片可能拉伸。{ready && load.width !== undefined && load.height !== undefined && Math.abs(load.width / load.height - 2) > .02 ? ` 当前图片为 ${load.width} × ${load.height}。` : ''}</p>
  </div>
}
