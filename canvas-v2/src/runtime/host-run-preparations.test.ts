import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasFramePreparation, CanvasImagePreparation, CanvasRunPreparationCompletion } from '../host'
import { defaultImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { parseColorLutCube } from '../image-tools/layer-color-lut'
import type { ImageTransformRecipe } from '../image-tools/recipe'
import type { BrowserFrameOptions, BrowserFrameResult } from '../library/browser-frame'
import type { BrowserImageTransformInput, BrowserImageTransformOutput } from '../library/browser-image-transform'
import { imageTransformProcessorRevision } from '../lib/image-transform-contract'
import { createHostRunPreparations } from './host-run-preparations'

function preparation(attemptId = 'attempt-1', timestampSeconds = 2.5): CanvasFramePreparation {
  return { operationId: attemptId, nodeId: 'frame', attemptId, sourceAssetId: 'V'.repeat(43), timestampSeconds }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function harness() {
  const video = new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' })
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
  const completions: CanvasRunPreparationCompletion[] = []
  const host = {
    readVideoForFramePreview: vi.fn<(assetId: string, signal?: AbortSignal) => Promise<Blob>>(async () => video),
    completeRunPreparation: vi.fn(async (input: CanvasRunPreparationCompletion) => { completions.push(input) }),
  }
  const extract = vi.fn<(blob: Blob, options: BrowserFrameOptions) => Promise<BrowserFrameResult>>(async () => ({ blob: png, width: 320, height: 180, requestedTimestampSeconds: 2.5, decodedTimestampSeconds: 2.48 }))
  return { video, png, completions, host, extract }
}

describe('host run preparations', () => {
  it('does nothing for a host that decodes frames itself', () => {
    expect(createHostRunPreparations(undefined)).toBeNull()
    expect(createHostRunPreparations({ readVideoForFramePreview: async () => new Blob() })).toBeNull()
    expect(createHostRunPreparations({ completeRunPreparation: async () => undefined })).toBeNull()
    expect(createHostRunPreparations({ readImageForRunPreparation: async () => new Blob() })).toBeNull()
  })

  it('decodes each listed frame once and hands back the PNG with the ids the host gave', async () => {
    const { video, png, completions, host, extract } = harness()
    const preparations = createHostRunPreparations(host, { extract })!
    preparations.update('run-1', [preparation()])
    // The same list again, from the event and from a record read back: still one decode.
    preparations.update('run-1', [preparation()])
    preparations.resume('run-1', [preparation()])
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    expect(host.readVideoForFramePreview).toHaveBeenCalledTimes(1)
    expect(host.readVideoForFramePreview.mock.calls[0][0]).toBe('V'.repeat(43))
    expect(extract).toHaveBeenCalledWith(video, { timestampSeconds: 2.5, signal: expect.any(AbortSignal) })
    expect(completions[0]).toEqual({ runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png, decodedTimestampSeconds: 2.48 })
  })

  it('hands back a bare failure at once when the video cannot be read or decoded', async () => {
    const { completions, host, extract } = harness()
    const preparations = createHostRunPreparations(host, { extract })!
    host.readVideoForFramePreview.mockRejectedValueOnce(new Error('视频读不出来，请确认素材还在'))
    preparations.update('run-1', [preparation('attempt-1')])
    extract.mockRejectedValueOnce(new Error('抽帧时间点超出视频长度'))
    preparations.update('run-2', [preparation('attempt-2', 99)])
    // An operation that is not its attempt is refused before anything is read.
    preparations.update('run-3', [{ ...preparation('attempt-3'), operationId: 'other' }])
    await vi.waitFor(() => expect(completions).toHaveLength(3))
    expect(completions).toEqual(expect.arrayContaining([
      { runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'failed' },
      { runId: 'run-2', operationId: 'attempt-2', kind: 'frame', outcome: 'failed' },
      { runId: 'run-3', operationId: 'other', kind: 'frame', outcome: 'failed' },
    ]))
    expect(host.readVideoForFramePreview).toHaveBeenCalledTimes(2)
  })

  it('tries a bare failure when the host refuses the picture, and survives that being refused too', async () => {
    const { completions, host, extract } = harness()
    host.completeRunPreparation.mockRejectedValueOnce(new Error('视频帧必须是 PNG 图片，没有保存'))
    host.completeRunPreparation.mockRejectedValueOnce(new Error('这一帧已经交过了'))
    const preparations = createHostRunPreparations(host, { extract })!
    preparations.update('run-1', [preparation()])
    await vi.waitFor(() => expect(host.completeRunPreparation).toHaveBeenCalledTimes(2))
    expect(host.completeRunPreparation.mock.calls[1][0]).toEqual({ runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'failed' })
    expect(completions).toEqual([])
  })

  it('leaves out a decoded time the host would refuse', async () => {
    const { completions, host, extract } = harness()
    extract.mockImplementation(async () => ({ blob: new Blob([new Uint8Array([1])]), width: 1, height: 1, requestedTimestampSeconds: 0 }))
    const preparations = createHostRunPreparations(host, { extract })!
    preparations.update('run-1', [preparation('attempt-1', 0)])
    extract.mockImplementationOnce(async () => ({ blob: new Blob([new Uint8Array([1])]), width: 1, height: 1, requestedTimestampSeconds: 0, decodedTimestampSeconds: -0.01 }))
    preparations.update('run-2', [preparation('attempt-2', 0)])
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    for (const completion of completions) expect(completion).not.toHaveProperty('decodedTimestampSeconds')
  })

  it('stops a frame the host no longer lists, a finished run and a closed project, handing back nothing', async () => {
    const { completions, host, extract } = harness()
    const pending = new Map<string, ReturnType<typeof deferred<BrowserFrameResult>>>()
    const signals = new Map<string, AbortSignal>()
    extract.mockImplementation((_blob, options) => {
      const key = `${options.timestampSeconds}`
      const entry = deferred<BrowserFrameResult>()
      pending.set(key, entry)
      signals.set(key, options.signal!)
      options.signal!.addEventListener('abort', () => entry.reject(new Error('aborted')), { once: true })
      return entry.promise
    })
    const preparations = createHostRunPreparations(host, { extract })!
    preparations.update('run-1', [preparation('attempt-1', 1)])
    preparations.update('run-2', [preparation('attempt-2', 2)])
    preparations.update('run-3', [preparation('attempt-3', 3)])
    await vi.waitFor(() => expect(pending.size).toBe(3))

    // A record read back without the frame never stops it; only the host's events do.
    preparations.resume('run-1', [])
    expect(signals.get('1')!.aborted).toBe(false)
    preparations.update('run-1', [])
    expect(signals.get('1')!.aborted).toBe(true)
    preparations.finish('run-2')
    expect(signals.get('2')!.aborted).toBe(true)
    expect(signals.get('3')!.aborted).toBe(false)
    preparations.stopAll()
    expect(signals.get('3')!.aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completions).toEqual([])

    // A stopped frame is not decoded again if the host lists it once more.
    preparations.update('run-1', [preparation('attempt-1', 1)])
    expect(extract).toHaveBeenCalledTimes(3)
  })
})

const projectId = '569d5c2e-5e9c-446b-8a2e-cf12357179a3'
const crop: ImageTransformRecipe = { kind: 'crop', x: 0, y: 0, width: 0.5, height: 0.5, outputWidth: 640, outputHeight: 480, rotation: 0, flipX: false, flipY: false }

function imagePreparation(attemptId = 'attempt-1', recipe: ImageTransformRecipe = crop, sourceAssetIds = ['S'.repeat(43)]): CanvasImagePreparation {
  return { operationId: attemptId, attemptId, runId: 'run-1', projectId, nodeId: 'tool', sourceAssetIds, recipe, processorRevision: imageTransformProcessorRevision }
}

function picture(width = 640, height = 480): BrowserImageTransformOutput {
  return { blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], { type: 'image/png' }), width, height }
}

function imageHarness() {
  const source = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
  const completions: CanvasRunPreparationCompletion[] = []
  const host = {
    readVideoForFramePreview: vi.fn(async () => new Blob()),
    readImageForRunPreparation: vi.fn<(assetId: string, signal?: AbortSignal) => Promise<Blob>>(async () => source),
    completeRunPreparation: vi.fn(async (input: CanvasRunPreparationCompletion) => { completions.push(input) }),
  }
  const outputs = [picture()]
  const process = vi.fn<(input: BrowserImageTransformInput) => Promise<BrowserImageTransformOutput[]>>(async () => outputs)
  return { source, outputs, completions, host, process }
}

describe('host run preparations for image tools', () => {
  it('processes each listed picture once from the owned sources and hands back the PNGs', async () => {
    const { source, outputs, completions, host, process } = imageHarness()
    const preparations = createHostRunPreparations(host, { process })!
    const collage: ImageTransformRecipe = { kind: 'collage', layout: 'grid', rows: 1, columns: 2, gap: 0, padding: 0, background: '#ffffff', fit: 'cover', outputWidth: 640, outputHeight: 480 }
    const sources = ['A'.repeat(43), 'B'.repeat(43)]
    preparations.update('run-1', [], [imagePreparation('attempt-1', collage, sources)])
    preparations.update('run-1', [], [imagePreparation('attempt-1', collage, sources)])
    preparations.resume('run-1', [], [imagePreparation('attempt-1', collage, sources)])
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    expect(host.readImageForRunPreparation.mock.calls.map(([assetId]) => assetId)).toEqual(sources)
    expect(process).toHaveBeenCalledTimes(1)
    expect(process.mock.calls[0][0]).toMatchObject({ sources: [source, source], recipe: { kind: 'collage', outputWidth: 640 } })
    expect(completions[0]).toEqual({ runId: 'run-1', operationId: 'attempt-1', kind: 'image', outcome: 'completed', pngs: [outputs[0].blob] })
    // A frame and a picture of the same attempt are different preparations.
    preparations.update('run-1', [preparation('attempt-1')], [imagePreparation('attempt-1', collage, sources)])
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    expect(completions[1]).toMatchObject({ kind: 'frame', outcome: 'failed' })
  })

  it('hands back a bare failure for a preparation the kernel itself would refuse, without reading anything', async () => {
    const { completions, host, process } = imageHarness()
    const preparations = createHostRunPreparations(host, { process })!
    preparations.update('run-1', [], [{ ...imagePreparation('attempt-1'), operationId: 'other' }])
    preparations.update('run-2', [], [{ ...imagePreparation('attempt-2'), runId: 'run-2', processorRevision: 'browser-image-v0' }])
    preparations.update('run-3', [], [imagePreparation('attempt-3', crop, ['A'.repeat(43), 'B'.repeat(43)])])
    // Listed under another run than its own.
    preparations.update('run-4', [], [imagePreparation('attempt-4')])
    await vi.waitFor(() => expect(completions).toHaveLength(4))
    expect(completions).toEqual(expect.arrayContaining([
      { runId: 'run-1', operationId: 'other', kind: 'image', outcome: 'failed' },
      { runId: 'run-2', operationId: 'attempt-2', kind: 'image', outcome: 'failed' },
      { runId: 'run-3', operationId: 'attempt-3', kind: 'image', outcome: 'failed' },
      { runId: 'run-4', operationId: 'attempt-4', kind: 'image', outcome: 'failed' },
    ]))
    expect(host.readImageForRunPreparation).not.toHaveBeenCalled()
    expect(process).not.toHaveBeenCalled()
  })

  it('fails at once when a source cannot be read, processing fails, or the pictures would be refused', async () => {
    const { completions, host, process } = imageHarness()
    const preparations = createHostRunPreparations(host, { process })!
    host.readImageForRunPreparation.mockRejectedValueOnce(new Error('图片读不出来，请确认素材还在'))
    preparations.update('run-1', [], [imagePreparation('attempt-1')])
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    process.mockRejectedValueOnce(new Error('输入图片结构或尺寸无效'))
    preparations.update('run-1', [], [imagePreparation('attempt-2')])
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    process.mockResolvedValueOnce([picture(320, 240)])
    preparations.update('run-1', [], [imagePreparation('attempt-3')])
    await vi.waitFor(() => expect(completions).toHaveLength(3))
    process.mockResolvedValueOnce([picture(), picture()])
    preparations.update('run-1', [], [imagePreparation('attempt-4')])
    await vi.waitFor(() => expect(completions).toHaveLength(4))
    process.mockResolvedValueOnce([{ ...picture(), blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }) }])
    preparations.update('run-1', [], [imagePreparation('attempt-5')])
    await vi.waitFor(() => expect(completions).toHaveLength(5))
    expect(completions.map((completion) => [completion.operationId, completion.outcome])).toEqual([
      ['attempt-1', 'failed'], ['attempt-2', 'failed'], ['attempt-3', 'failed'], ['attempt-4', 'failed'], ['attempt-5', 'failed'],
    ])
  })

  it('refuses a layer with an account LUT on a host without a LUT store, and reads it from one that has it', async () => {
    const { completions, host, process } = imageHarness()
    const lut = { version: 1 as const, enabled: true, strength: 100, source: { kind: 'asset' as const, lutAssetId: 'L'.repeat(43), digest: '0'.repeat(64), name: 'Owned inverse', domainMin: [0, 0, 0] as [number, number, number], domainMax: [1, 1, 1] as [number, number, number] } }
    const layer: ImageTransformRecipe = { kind: 'layer', outputWidth: 640, outputHeight: 480, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, colorGrade: { ...defaultImageLayerColorGrade(), lut } }] }
    const withoutStore = createHostRunPreparations(host, { process })!
    withoutStore.update('run-1', [], [imagePreparation('attempt-1', layer)])
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    expect(completions[0]).toEqual({ runId: 'run-1', operationId: 'attempt-1', kind: 'image', outcome: 'failed' })
    expect(process).not.toHaveBeenCalled()

    const table = parseColorLutCube('TITLE "Owned inverse"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0')
    const readColorLut = vi.fn(async () => ({ table }))
    const withStore = createHostRunPreparations({ ...host, readColorLut }, { process })!
    withStore.update('run-1', [], [imagePreparation('attempt-2', layer)])
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    expect(completions[1]).toMatchObject({ operationId: 'attempt-2', outcome: 'completed' })
    expect(readColorLut).toHaveBeenCalledTimes(1)
    expect(process.mock.calls[0][0].lutTables?.size).toBe(1)
  })

  it('fails pictures on a host that cannot read source images, and stops ones the host no longer lists', async () => {
    const { completions, host, process } = imageHarness()
    const frameOnly = createHostRunPreparations({ readVideoForFramePreview: host.readVideoForFramePreview, completeRunPreparation: host.completeRunPreparation }, { process })!
    frameOnly.update('run-1', [], [imagePreparation('attempt-1')])
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    expect(completions[0]).toMatchObject({ kind: 'image', outcome: 'failed' })

    const signals: AbortSignal[] = []
    process.mockImplementation((input) => new Promise((_resolve, reject) => {
      signals.push(input.signal!)
      input.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const preparations = createHostRunPreparations(host, { process })!
    preparations.update('run-1', [], [imagePreparation('attempt-2')])
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    // A frame-only event of the same run still lists no picture: the picture stops.
    preparations.update('run-1', [], [])
    expect(signals[0].aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completions).toHaveLength(1)
  })
})

describe('host run preparations in the editor', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

  it('feeds the frames and pictures from run-waiting events and run records, and stops them with the run or the project', () => {
    expect(app).toContain('createHostRunPreparations(window.xingmangCanvasHost)')
    expect(app).toMatch(/if \(event\.type === 'run-waiting'\) \{\n\s+runPreparationsRef\.current\?\.update\(event\.runId, event\.framePreparations, event\.imagePreparations \?\? \[\]\)/)
    expect(app).toMatch(/if \(event\.type === 'run-terminal'\) \{\n\s+forgetActiveRun\(event\.runId\)\n\s+runPreparationsRef\.current\?\.finish\(event\.runId\)/)
    expect(app).toContain("if (record.status === 'running' && record.projectId === projectId && (record.framePreparations?.length || record.imagePreparations?.length)) runPreparationsRef.current?.resume(record.runId, record.framePreparations ?? [], record.imagePreparations ?? [])")
    // Opening another project and closing this one both drop the run list, and the frames with it.
    expect(app.match(/activeRunsRef\.current\.clear\(\)\n\s+runPreparationsRef\.current\?\.stopAll\(\)/g)).toHaveLength(2)
    expect(app.match(/activeRunsRef\.current\.clear\(\)/g)).toHaveLength(2)
  })
})
