import { describe, expect, it, vi } from 'vitest'
import { assertLayerGrabCutPreparedInput, encodeLayerGrabCutSelection, maximumLayerGrabCutPixels, normalizeLayerGrabCutRegion, prepareLayerGrabCutInput, type LayerGrabCutInput, type LayerGrabCutStroke } from './layer-grabcut-selection'

function fixture(width = 12, height = 10, strokes: LayerGrabCutStroke[] = []): LayerGrabCutInput {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index++) data.set([index % 251, 71, 143, 255], index * 4)
  return { width, height, data, region: { x: 2, y: 1, width: width - 3, height: height - 2 }, strokes }
}
function selected(runs: number[]): number[] { const output: number[] = []; for (let at = 0; at < runs.length; at += 2) for (let x = 0; x < runs[at + 1]; x++) output.push(runs[at] + x); return output }

describe('native GrabCut frame and seed preparation', () => {
  it('copies only the exact native region and leaves source pixels and the supplied frame untouched', async () => {
    const input = fixture(), before = input.data.slice(), prepared = await prepareLayerGrabCutInput(input)
    expect(prepared.region).toEqual(input.region)
    expect(prepared.rgba).toHaveLength(9 * 8 * 4)
    expect([...prepared.rgba.slice(0, 4)]).toEqual([...input.data.slice(14 * 4, 15 * 4)])
    expect(prepared.labels[0]).toBe(0)
    expect(prepared.labels[10]).toBe(3)
    expect(input.data).toEqual(before)
    expect(() => assertLayerGrabCutPreparedInput(prepared)).not.toThrow()
    prepared.rgba[0] = 254
    expect(input.data).toEqual(before)
  })

  it('normalizes subpixel rectangles outward without resampling or exceeding the visible frame', () => {
    expect(normalizeLayerGrabCutRegion({ x: 2.4, y: 1.8, width: 4.2, height: 3.3 }, { width: 12, height: 10 })).toEqual({ x: 2, y: 1, width: 5, height: 5 })
    expect(() => normalizeLayerGrabCutRegion({ x: -0.1, y: 0, width: 4, height: 4 }, { width: 10, height: 10 })).toThrow('画布内')
    expect(() => normalizeLayerGrabCutRegion({ x: 0, y: 0, width: 2, height: 3 }, { width: 10, height: 10 })).toThrow('3 × 3')
    expect(() => normalizeLayerGrabCutRegion({ x: 0, y: 0, width: 1000, height: 1001 }, { width: 4096, height: 4096 })).toThrow('100 万')
    expect(maximumLayerGrabCutPixels).toBe(1_000_000)
  })

  it('uses continuous round brush capsules across sparse points and applies later background corrections', async () => {
    const strokes: LayerGrabCutStroke[] = [
      { mode: 'foreground', diameter: 1, points: [{ x: 3.5, y: 4.5 }, { x: 9.5, y: 4.5 }] },
      { mode: 'background', diameter: 1, points: [{ x: 6.5, y: 4.5 }] },
    ]
    const prepared = await prepareLayerGrabCutInput(fixture(12, 10, strokes))
    const row = [...prepared.labels.slice(3 * 9, 4 * 9)]
    expect(row).toEqual([0, 1, 1, 1, 0, 1, 1, 1, 0])
    expect(prepared.labels[2 * 9 + 4]).toBe(3)
  })

  it('preserves transparent holes and the fixed background rim even under a large foreground brush', async () => {
    const input = fixture(12, 10, [{ mode: 'foreground', diameter: 512, points: [{ x: 6, y: 5 }] }])
    input.data[(5 * 12 + 6) * 4 + 3] = 0
    input.data[(5 * 12 + 7) * 4 + 3] = 1
    const prepared = await prepareLayerGrabCutInput(input)
    expect(prepared.labels[4 * 9 + 4]).toBe(0)
    expect(prepared.labels[4 * 9 + 5]).toBe(1)
    for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) if (!x || !y || x === 8 || y === 7) expect(prepared.labels[y * 9 + x]).toBe(0)
  })

  it('matches an independent point-to-segment oracle for overlapping round brushes', async () => {
    const strokes: LayerGrabCutStroke[] = [
      { mode: 'foreground', diameter: 3.8, points: [{ x: 3.2, y: 2.3 }, { x: 9.1, y: 7.2 }, { x: 4.8, y: 7.4 }] },
      { mode: 'background', diameter: 2.7, points: [{ x: 6.1, y: 3.4 }, { x: 6.1, y: 7.2 }] },
    ]
    const input = fixture(12, 10, strokes), result = await prepareLayerGrabCutInput(input)
    function distance(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) {
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      const projection = length ? Math.max(0, Math.min(length, ((px - a.x) * (b.x - a.x) + (py - a.y) * (b.y - a.y)) / length)) : 0
      return Math.hypot(px - (length ? a.x + (b.x - a.x) * projection / length : a.x), py - (length ? a.y + (b.y - a.y) * projection / length : a.y))
    }
    for (let y = 1; y < result.region.height - 1; y++) for (let x = 1; x < result.region.width - 1; x++) {
      let expected = 3
      for (const stroke of strokes) for (let at = 0; at < stroke.points.length - 1; at++) if (distance(x + 2.5, y + 1.5, stroke.points[at], stroke.points[at + 1]) <= stroke.diameter / 2) expected = stroke.mode === 'foreground' ? 1 : 0
      expect(result.labels[y * result.region.width + x]).toBe(expected)
    }
  })

  it('rejects invalid source pixels, excessive seed paths and frames with no foreground', async () => {
    await expect(prepareLayerGrabCutInput({ ...fixture(), data: new Uint8Array(3) })).rejects.toThrow('像素长度')
    await expect(prepareLayerGrabCutInput({ ...fixture(), strokes: [{ mode: 'foreground', diameter: 1, points: Array.from({ length: 4097 }, () => ({ x: 4, y: 4 })) }] })).rejects.toThrow('4096')
    await expect(prepareLayerGrabCutInput(fixture(12, 10, [{ mode: 'foreground', diameter: 513, points: [{ x: 4, y: 4 }] }]))).rejects.toThrow('笔径')
    const transparent = fixture(); transparent.data.fill(0)
    await expect(prepareLayerGrabCutInput(transparent)).rejects.toThrow('非透明前景')
    await expect(prepareLayerGrabCutInput(fixture(12, 10, [{ mode: 'background', diameter: 512, points: [{ x: 4, y: 4 }] }]))).rejects.toThrow('非透明前景')
  })

  it('cancels before work and at yielded checkpoints without returning partial labels', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(prepareLayerGrabCutInput(fixture(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const active = new AbortController(), large = fixture(256, 256)
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now += 9)
    try {
      const yieldControl = vi.fn(async () => { active.abort() })
      await expect(prepareLayerGrabCutInput(large, { signal: active.signal, yieldControl })).rejects.toMatchObject({ name: 'AbortError' })
      expect(yieldControl).toHaveBeenCalledOnce()
    } finally { clock.mockRestore() }
  })

  it('rejects forged worker labels that override transparent pixels or the frame boundary', async () => {
    const input = await prepareLayerGrabCutInput(fixture())
    input.labels[0] = 1
    expect(() => assertLayerGrabCutPreparedInput(input)).toThrow('边缘')
    input.labels[0] = 0; input.labels[10] = 4
    expect(() => assertLayerGrabCutPreparedInput(input)).toThrow('标签')
  })
})

describe('GrabCut result encoding', () => {
  it('retains exact holes and disjoint runs with full-document native offsets', async () => {
    const result = await encodeLayerGrabCutSelection({ width: 10, height: 8, region: { x: 3, y: 2, width: 4, height: 3 } }, new Uint8Array([0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0]))
    expect(result).toEqual({ width: 10, height: 8, runs: [24, 2, 33, 1, 35, 2, 44, 2] })
    expect(selected(result.runs)).toEqual([24, 25, 33, 35, 36, 44, 45])
  })

  it('rejects nonbinary or fragmented results without truncation or downsampling', async () => {
    await expect(encodeLayerGrabCutSelection({ width: 3, height: 3, region: { x: 0, y: 0, width: 3, height: 3 } }, new Uint8Array(9).fill(3))).rejects.toThrow('二值')
    const width = 256, height = 256, mask = new Uint8Array(width * height)
    for (let index = 0; index < mask.length; index++) mask[index] = index % 2
    await expect(encodeLayerGrabCutSelection({ width, height, region: { x: 0, y: 0, width, height } }, mask)).rejects.toMatchObject({ code: 'too-complex' })
  })

  it('enforces the existing serialized byte limit even when the run count fits', async () => {
    const mask = new Uint8Array(256 * 64)
    for (let index = 0; index < mask.length; index++) mask[index] = index % 2
    await expect(encodeLayerGrabCutSelection({ width: 4096, height: 4096, region: { x: 100, y: 3000, width: 256, height: 64 } }, mask)).rejects.toThrow('保存容量')
  })
})
