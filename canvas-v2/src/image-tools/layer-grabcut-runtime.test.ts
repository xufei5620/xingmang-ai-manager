import { describe, expect, it, vi } from 'vitest'
import { isLayerGrabCutCv, resolveLayerGrabCutRuntime, runLayerGrabCutRuntime, type LayerGrabCutCv, type LayerGrabCutMat } from './layer-grabcut-runtime'
import { prepareLayerGrabCutInput } from './layer-grabcut-selection'

function fakeCv() {
  const mats: LayerGrabCutMat[] = []
  class Mat implements LayerGrabCutMat {
    data: Uint8Array
    delete = vi.fn()
    constructor(rows = 0, columns = 0, type = 1) { this.data = new Uint8Array(rows * columns * type); mats.push(this) }
  }
  class Rect { constructor(readonly x: number, readonly y: number, readonly width: number, readonly height: number) {} }
  const grabCut = vi.fn((_image: LayerGrabCutMat, mask: LayerGrabCutMat) => { for (let at = 0; at < mask.data.length; at++) if (mask.data[at] === 3) mask.data[at] = at % 2 ? 3 : 2 })
  const cv: LayerGrabCutCv = { Mat, Rect, CV_8UC3: 3, CV_8UC1: 1, GC_INIT_WITH_MASK: 1, GC_EVAL: 2, setRNGSeed: vi.fn(), grabCut }
  return { cv, mats, grabCut }
}
async function input() {
  const data = new Uint8ClampedArray(7 * 7 * 4)
  for (let at = 0; at < 49; at++) data.set([30, 80, at, 255], at * 4)
  return prepareLayerGrabCutInput({ data, width: 7, height: 7, region: { x: 0, y: 0, width: 7, height: 7 }, strokes: [{ mode: 'foreground', diameter: 1, points: [{ x: 3.5, y: 3.5 }] }] })
}

describe('local GrabCut runtime adapter', () => {
  it('initializes a self-resolving Emscripten thenable without Promise assimilation recursion', async () => {
    const f = fakeCv(), then = vi.fn((ready: (value: unknown) => void) => { ready(module) })
    const module = { ...f.cv, then }
    const { cv } = await resolveLayerGrabCutRuntime(module)
    expect(cv).toBe(module)
    expect(then).toHaveBeenCalledOnce()
    expect((await resolveLayerGrabCutRuntime(f.cv)).cv).toBe(f.cv)
    await expect(resolveLayerGrabCutRuntime({ then(ready: (value: unknown) => void) { ready({}) } })).rejects.toThrow('不完整')
  })
  it('runs three real-protocol iterations with stable RNG, preserved models and explicit mask initialization', async () => {
    const f = fakeCv(), prepared = await input(), onIteration = vi.fn(), yieldControl = vi.fn(async () => {})
    const result = await runLayerGrabCutRuntime(f.cv, prepared, onIteration, yieldControl)
    expect(f.cv.setRNGSeed).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.grabCut).toHaveBeenCalledTimes(3)
    for (let at = 0; at < 3; at++) {
      const call = f.grabCut.mock.calls[at] as unknown[]
      expect(call[0]).toBe(f.mats[0]); expect(call[1]).toBe(f.mats[1]); expect(call[3]).toBe(f.mats[2]); expect(call[4]).toBe(f.mats[3])
      expect(call[5]).toBe(1); expect(call[6]).toBe(at ? f.cv.GC_EVAL : f.cv.GC_INIT_WITH_MASK)
    }
    expect([...f.mats[0].data.slice(3 * 24, 3 * 25)]).toEqual([30, 80, 24])
    expect(result[24]).toBe(1)
    expect(result[25]).toBe(1)
    expect(result[26]).toBe(0)
    expect(onIteration.mock.calls).toEqual([[1], [2], [3]])
    expect(yieldControl).toHaveBeenCalledTimes(3)
    for (const mat of f.mats) expect(mat.delete).toHaveBeenCalledOnce()
  })

  it('releases every allocated Mat on native algorithm failure and rejects partial masks', async () => {
    const f = fakeCv(), prepared = await input()
    f.grabCut.mockImplementationOnce(() => { throw new Error('synthetic native failure') })
    await expect(runLayerGrabCutRuntime(f.cv, prepared)).rejects.toThrow('synthetic native failure')
    for (const mat of f.mats) expect(mat.delete).toHaveBeenCalledOnce()
    expect(f.grabCut).toHaveBeenCalledOnce()
  })

  it('rejects an adapter that alters hard user labels or omits required APIs', async () => {
    const f = fakeCv(), prepared = await input()
    f.grabCut.mockImplementation((_image, mask) => { mask.data[0] = 1 })
    await expect(runLayerGrabCutRuntime(f.cv, prepared, undefined, async () => {})).rejects.toThrow('未保留')
    for (const mat of f.mats) expect(mat.delete).toHaveBeenCalledOnce()
    expect(isLayerGrabCutCv({ ...f.cv, grabCut: undefined })).toBe(false)
    expect(isLayerGrabCutCv({ ...f.cv, setRNGSeed: undefined })).toBe(false)
  })
})
