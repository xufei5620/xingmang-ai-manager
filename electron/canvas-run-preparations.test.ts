import { describe, expect, it, vi } from 'vitest'
import type { CanvasFramePreparation, CanvasImagePreparation } from './canvas-run-contract'
import {
  assertCanvasFramePng, assertCanvasImageToolPngs, CanvasRunPreparationBroker, canvasFramePreparationTimeoutMs, createCanvasFrameExtraction,
  createCanvasImageToolProcessing, maximumCanvasFramePngBytes, maximumCanvasFrameVideoBytes, parseCanvasRunPreparationCompletion,
} from './canvas-run-preparations'

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  header[24] = 8
  header[25] = 6
  return Buffer.concat([header, Buffer.alloc(16)])
}

function jpeg(width: number, height: number): Buffer {
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from([0xff, 0xd9])])
}

const preparation: CanvasFramePreparation = { operationId: 'attempt-1', nodeId: 'frame', attemptId: 'attempt-1', sourceAssetId: 'V'.repeat(43), timestampSeconds: 2.5 }
const frameAsset = { kind: 'image' as const, assetId: 'F'.repeat(43), localUrl: `xingmang-asset://image/${'F'.repeat(43)}`, mimeType: 'image/png', width: 64, height: 32 }

function manualClock() {
  const timers: Array<{ callback: () => void; cancelled: boolean }> = []
  return {
    schedule: (callback: () => void) => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    fire: () => { for (const timer of timers) if (!timer.cancelled) timer.callback() },
  }
}

describe('canvas run preparations', () => {
  it('reads a frame receipt with only ids, the PNG bytes and the decoded time, and a failure with nothing else', () => {
    const bytes = new Uint8Array(png(64, 32))
    const parsed = parseCanvasRunPreparationCompletion({ runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: bytes, decodedTimestampSeconds: 2.48 })
    expect(parsed).toMatchObject({ runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', decodedTimestampSeconds: 2.48 })
    if (parsed.outcome !== 'completed' || parsed.kind !== 'frame') throw new Error('expected a completed frame')
    expect(Buffer.isBuffer(parsed.png)).toBe(true)
    bytes[0] = 0
    expect(parsed.png[0]).toBe(0x89)
    expect(parseCanvasRunPreparationCompletion({ runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'failed' })).toEqual({ runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'failed' })

    const base = { runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: new Uint8Array(png(1, 1)) }
    expect(() => parseCanvasRunPreparationCompletion({ ...base, path: '/tmp/frame.png' })).toThrow('画布运行准备回执格式错误')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, outcome: 'failed', message: 'page words' })).toThrow('画布运行准备回执格式错误')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, outcome: 'failed' })).toThrow('画布运行准备回执格式错误')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, kind: 'video' })).toThrow('画布运行准备类型格式错误')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, kind: 'image' })).toThrow('画布运行准备回执格式错误')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, pngs: [base.png] })).toThrow('画布运行准备回执格式错误')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, operationId: '../x' })).toThrow('画布运行准备标识格式错误')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, runId: '' })).toThrow('画布运行标识格式错误')
    for (const wrong of ['C:\\frame.png', [1, 2], { bytes: 1 }, new ArrayBuffer(4)]) {
      expect(() => parseCanvasRunPreparationCompletion({ ...base, png: wrong })).toThrow('视频帧图片内容格式错误')
    }
    expect(() => parseCanvasRunPreparationCompletion({ ...base, png: new Uint8Array(0) })).toThrow('视频帧图片内容为空')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, png: new Uint8Array(maximumCanvasFramePngBytes + 1) })).toThrow('视频帧图片超过 20 MB')
    for (const wrong of [-1, Number.NaN, 86_401, '1']) {
      expect(() => parseCanvasRunPreparationCompletion({ ...base, decodedTimestampSeconds: wrong })).toThrow('视频帧时间格式错误')
    }
  })

  it('accepts a PNG frame within the web host limits and nothing else', () => {
    expect(assertCanvasFramePng(png(4096, 4096))).toEqual({ width: 4096, height: 4096 })
    expect(() => assertCanvasFramePng(png(4097, 10))).toThrow('视频帧尺寸超过 4096')
    expect(() => assertCanvasFramePng(jpeg(64, 64))).toThrow('视频帧必须是 PNG 图片')
    expect(() => assertCanvasFramePng(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow('仅支持 PNG、JPEG 或 WebP')
  })

  it('saves the frame the page hands back for an operation it is waiting on, once, for the same account', async () => {
    const broker = new CanvasRunPreparationBroker({ schedule: manualClock().schedule })
    const store = vi.fn(async () => frameAsset)
    const waiting = broker.expect({ runId: 'run-1', userId: 7, preparation, signal: new AbortController().signal, store })
    expect(broker.size()).toBe(1)

    await expect(broker.complete(7, { runId: 'run-2', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: png(64, 32) })).rejects.toThrow('这一帧不在等待中')
    await expect(broker.complete(8, { runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: png(64, 32) })).rejects.toThrow('这一帧不在等待中')
    expect(store).not.toHaveBeenCalled()

    await broker.complete(7, { runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: png(64, 32) })
    await expect(waiting).resolves.toEqual(frameAsset)
    expect(store).toHaveBeenCalledTimes(1)
    expect(broker.size()).toBe(0)
    await expect(broker.complete(7, { runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: png(64, 32) })).rejects.toThrow('这一帧不在等待中')
  })

  it('fails the node, without saving, on a bad picture, a page that could not decode, a stop or no answer in time', async () => {
    const clock = manualClock()
    const broker = new CanvasRunPreparationBroker({ schedule: clock.schedule })
    const store = vi.fn(async () => frameAsset)
    const signal = new AbortController().signal

    const badPicture = broker.expect({ runId: 'run-1', userId: 7, preparation, signal, store })
    await expect(broker.complete(7, { runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: jpeg(8, 8) })).rejects.toThrow('视频帧必须是 PNG 图片')
    await expect(badPicture).rejects.toThrow('视频帧必须是 PNG 图片')
    // The operation is spent: a second try with a good picture is refused.
    await expect(broker.complete(7, { runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: png(8, 8) })).rejects.toThrow('这一帧不在等待中')

    const undecodable = broker.expect({ runId: 'run-2', userId: 7, preparation, signal, store })
    await broker.complete(7, { runId: 'run-2', operationId: 'attempt-1', kind: 'frame', outcome: 'failed' })
    await expect(undecodable).rejects.toThrow('视频帧没有抽出来')

    const stop = new AbortController()
    const stopped = broker.expect({ runId: 'run-3', userId: 7, preparation, signal: stop.signal, store })
    stop.abort(new Error('运行已取消'))
    await expect(stopped).rejects.toThrow('运行已取消')
    await expect(broker.complete(7, { runId: 'run-3', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: png(8, 8) })).rejects.toThrow('这一帧不在等待中')

    const unanswered = broker.expect({ runId: 'run-4', userId: 7, preparation, signal, store })
    clock.fire()
    await expect(unanswered).rejects.toThrow('视频帧没有交回来')
    expect(store).not.toHaveBeenCalled()
    expect(broker.size()).toBe(0)
    expect(canvasFramePreparationTimeoutMs).toBe(120_000)
  })

  it('refuses a frame the run is already waiting on and a saving failure reaches both sides', async () => {
    const broker = new CanvasRunPreparationBroker({ schedule: manualClock().schedule })
    const signal = new AbortController().signal
    const waiting = broker.expect({ runId: 'run-1', userId: 7, preparation, signal, store: async () => { throw new Error('磁盘写不进去') } })
    await expect(broker.expect({ runId: 'run-1', userId: 7, preparation, signal, store: async () => frameAsset })).rejects.toThrow('这一帧已经在等待中')
    await expect(broker.complete(7, { runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: png(8, 8) })).rejects.toThrow('磁盘写不进去')
    await expect(waiting).rejects.toThrow('磁盘写不进去')
    expect(() => new CanvasRunPreparationBroker({ timeoutMs: 0 })).toThrow('配置无效')
  })

  it('checks the video from its header only and stores the frame as an imported picture of the run project', async () => {
    const broker = new CanvasRunPreparationBroker({ schedule: manualClock().schedule })
    const storeLocalBytes = vi.fn(async () => ({ assetId: frameAsset.assetId, localUrl: frameAsset.localUrl, mimeType: 'image/png' as const, width: 64, height: 32, fileName: 'frame.png' }))
    const setSource = vi.fn(async () => undefined)
    const readOwnedVideoRange = vi.fn(async (_userId: number, _assetId: string, select: (total: number) => unknown) => {
      expect(select(10)).toBeNull()
      return { totalBytes: 1024 }
    })
    const forProject = vi.fn(async () => ({ images: { storeLocalBytes }, media: { setSource } }))
    const frames = createCanvasFrameExtraction({ broker, assets: { readOwnedVideoRange, forProject } })

    await expect(frames.assertDecodableVideo(7, preparation.sourceAssetId)).resolves.toBeUndefined()
    readOwnedVideoRange.mockResolvedValueOnce({ totalBytes: maximumCanvasFrameVideoBytes + 1 })
    await expect(frames.assertDecodableVideo(7, preparation.sourceAssetId)).rejects.toThrow('视频超过 32 MB')
    await expect(frames.waitForFrame({ runId: 'run-1', userId: 7, preparation, signal: new AbortController().signal })).rejects.toThrow('画布项目尚未选择')

    const projectId = '11111111-1111-4111-8111-111111111111'
    const waiting = frames.waitForFrame({ runId: 'run-1', userId: 7, projectId, preparation, signal: new AbortController().signal })
    await broker.complete(7, { runId: 'run-1', operationId: 'attempt-1', kind: 'frame', outcome: 'completed', png: png(64, 32) })
    await expect(waiting).resolves.toEqual(frameAsset)
    expect(forProject).toHaveBeenCalledWith(7, projectId)
    expect(setSource).toHaveBeenCalledWith(7, frameAsset.assetId, 'imported')
  })

  it('reads an image-tool receipt as 1-16 PNG byte arrays within the web host limits', () => {
    const base = { runId: 'run-1', operationId: 'attempt-2', kind: 'image', outcome: 'completed' }
    const first = new Uint8Array(png(64, 32))
    const parsed = parseCanvasRunPreparationCompletion({ ...base, pngs: [first, new Uint8Array(png(8, 8))] })
    if (parsed.outcome !== 'completed' || parsed.kind !== 'image') throw new Error('expected completed pictures')
    expect(parsed.pngs.map((bytes) => Buffer.isBuffer(bytes))).toEqual([true, true])
    first[0] = 0
    expect(parsed.pngs[0][0]).toBe(0x89)
    expect(parseCanvasRunPreparationCompletion({ ...base, outcome: 'failed' })).toEqual({ ...base, outcome: 'failed' })
    expect(() => parseCanvasRunPreparationCompletion({ ...base, outcome: 'failed', pngs: [first] })).toThrow('画布运行准备回执格式错误')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, pngs: [first], png: first })).toThrow('画布运行准备回执格式错误')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, pngs: [first], decodedTimestampSeconds: 1 })).toThrow('画布运行准备回执格式错误')
    for (const wrong of [undefined, [], Array.from({ length: 17 }, () => first), first]) {
      expect(() => parseCanvasRunPreparationCompletion({ ...base, pngs: wrong })).toThrow('图片处理结果必须是 1 到 16 张图片')
    }
    expect(() => parseCanvasRunPreparationCompletion({ ...base, pngs: ['C:\\picture.png'] })).toThrow('图片处理结果内容格式错误')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, pngs: [new Uint8Array(0)] })).toThrow('图片处理结果内容为空')
    expect(() => parseCanvasRunPreparationCompletion({ ...base, pngs: [new Uint8Array(20 * 1024 * 1024 + 1)] })).toThrow('图片处理结果超过 20 MB')
    const large = new Uint8Array(20 * 1024 * 1024)
    expect(() => parseCanvasRunPreparationCompletion({ ...base, pngs: [large, large, large, large] })).toThrow('图片处理结果合计超过 64 MB')
  })

  it('takes only as many PNGs as the node makes, at the size it set unless the page decides it', () => {
    expect(() => assertCanvasImageToolPngs([png(640, 480)], { count: 1, size: { width: 640, height: 480 } })).not.toThrow()
    expect(() => assertCanvasImageToolPngs([png(900, 300)], { count: 1 })).not.toThrow()
    expect(() => assertCanvasImageToolPngs([png(640, 480), png(640, 480)], { count: 1, size: { width: 640, height: 480 } })).toThrow('图片处理结果的张数跟节点设置不一致')
    expect(() => assertCanvasImageToolPngs([png(641, 480)], { count: 1, size: { width: 640, height: 480 } })).toThrow('图片处理结果的尺寸跟节点设置不一致')
    expect(() => assertCanvasImageToolPngs([jpeg(640, 480)], { count: 1 })).toThrow('图片处理结果必须是 PNG 图片')
    expect(() => assertCanvasImageToolPngs([png(4097, 8)], { count: 1 })).toThrow('图片处理结果尺寸超过 4096')
    expect(() => assertCanvasImageToolPngs([png(4096, 4096), png(4096, 4096), png(1, 1)], { count: 3 })).toThrow('图片处理结果合计像素超过上限')
  })

  it('stores the pictures of an operation it asked for in order, once, and keeps them apart from frames', async () => {
    const clock = manualClock()
    const broker = new CanvasRunPreparationBroker({ schedule: clock.schedule })
    const signal = new AbortController().signal
    const imagePreparation: CanvasImagePreparation = {
      operationId: 'attempt-2', attemptId: 'attempt-2', runId: 'run-1', projectId: '11111111-1111-4111-8111-111111111111', nodeId: 'crop',
      sourceAssetIds: ['S'.repeat(43)], recipe: { kind: 'crop', outputWidth: 64, outputHeight: 32 }, processorRevision: 'browser-image-v1',
    }
    const store = vi.fn(async (pngs: readonly Buffer[]) => pngs.map((_png, index) => ({ ...frameAsset, assetId: String(index).repeat(43) })))
    const waiting = broker.expectImages({ runId: 'run-1', userId: 7, preparation: imagePreparation, expectation: { count: 1, size: { width: 64, height: 32 } }, signal, store })
    await expect(broker.complete(7, { runId: 'run-1', operationId: 'attempt-2', kind: 'frame', outcome: 'completed', png: png(64, 32) })).rejects.toThrow('这一帧不在等待中')
    await expect(broker.complete(8, { runId: 'run-1', operationId: 'attempt-2', kind: 'image', outcome: 'completed', pngs: [png(64, 32)] })).rejects.toThrow('这次图片处理不在等待中')
    await expect(broker.complete(7, { runId: 'run-1', operationId: 'attempt-2', kind: 'image', outcome: 'completed', pngs: [png(64, 33)] })).rejects.toThrow('尺寸跟节点设置不一致')
    await expect(waiting).rejects.toThrow('尺寸跟节点设置不一致')
    await expect(broker.complete(7, { runId: 'run-1', operationId: 'attempt-2', kind: 'image', outcome: 'completed', pngs: [png(64, 32)] })).rejects.toThrow('这次图片处理不在等待中')
    expect(store).not.toHaveBeenCalled()

    const again = broker.expectImages({ runId: 'run-2', userId: 7, preparation: { ...imagePreparation, runId: 'run-2' }, expectation: { count: 1 }, signal, store })
    await expect(broker.expectImages({ runId: 'run-2', userId: 7, preparation: { ...imagePreparation, runId: 'run-2' }, expectation: { count: 1 }, signal, store })).rejects.toThrow('这次图片处理已经在等待中')
    await broker.complete(7, { runId: 'run-2', operationId: 'attempt-2', kind: 'image', outcome: 'completed', pngs: [png(64, 32)] })
    await expect(again).resolves.toEqual([{ ...frameAsset, assetId: '0'.repeat(43) }])
    expect(store).toHaveBeenCalledTimes(1)
    await expect(broker.complete(7, { runId: 'run-2', operationId: 'attempt-2', kind: 'image', outcome: 'completed', pngs: [png(64, 32)] })).rejects.toThrow('这次图片处理不在等待中')

    const failed = broker.expectImages({ runId: 'run-3', userId: 7, preparation: { ...imagePreparation, runId: 'run-3' }, expectation: { count: 1 }, signal, store })
    await broker.complete(7, { runId: 'run-3', operationId: 'attempt-2', kind: 'image', outcome: 'failed' })
    await expect(failed).rejects.toThrow('图片处理没有完成：来源图片读不出来，或者这组参数处理不了')
    const unanswered = broker.expectImages({ runId: 'run-4', userId: 7, preparation: { ...imagePreparation, runId: 'run-4' }, expectation: { count: 1 }, signal, store })
    clock.fire()
    await expect(unanswered).rejects.toThrow('图片处理结果没有交回来（画布关了或处理超时），请重新运行这个节点')
    expect(broker.size()).toBe(0)
  })

  it('checks image-tool sources against the web host limits and saves each picture as imported in the run project', async () => {
    const broker = new CanvasRunPreparationBroker({ schedule: manualClock().schedule })
    const projectId = '11111111-1111-4111-8111-111111111111'
    const sizes = new Map([['A'.repeat(43), 1024], ['B'.repeat(43), 20 * 1024 * 1024 + 1], ['C'.repeat(43), 20 * 1024 * 1024]])
    const readImageOwned = vi.fn(async (_userId: number, assetId: string) => ({ bytes: Buffer.alloc(sizes.get(assetId) ?? 0) }))
    let saved = 0
    const storeLocalBytes = vi.fn(async () => {
      saved += 1
      const assetId = String(saved).repeat(43)
      return { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' as const, width: 64, height: 32, fileName: `${assetId}.png` }
    })
    const setSource = vi.fn(async () => { throw new Error('来源写不进去') })
    const onSourceError = vi.fn()
    const tools = createCanvasImageToolProcessing({ broker, assets: { readImageOwned, forProject: async () => ({ images: { storeLocalBytes }, media: { setSource } }) }, onSourceError })

    await expect(tools.assertSources(7, projectId, ['A'.repeat(43)])).resolves.toBeUndefined()
    expect(readImageOwned).toHaveBeenCalledWith(7, 'A'.repeat(43), projectId)
    await expect(tools.assertSources(7, projectId, ['B'.repeat(43)])).rejects.toThrow('图片处理的来源图片超过 20 MB')
    await expect(tools.assertSources(7, projectId, ['C'.repeat(43), 'C'.repeat(43), 'C'.repeat(43), 'C'.repeat(43)])).rejects.toThrow('图片处理的来源图片合计超过 64 MB')
    await expect(tools.assertSources(7, projectId, Array.from({ length: 21 }, () => 'A'.repeat(43)))).rejects.toThrow('图片处理最多用 20 张图片')
    readImageOwned.mockRejectedValueOnce(new Error('AI 素材不存在或无权访问'))
    await expect(tools.assertSources(7, projectId, ['D'.repeat(43)])).rejects.toThrow('AI 素材不存在或无权访问')

    const imagePreparation: CanvasImagePreparation = {
      operationId: 'attempt-3', attemptId: 'attempt-3', runId: 'run-1', projectId, nodeId: 'layer',
      sourceAssetIds: [], recipe: { kind: 'layer', outputWidth: 64, outputHeight: 32 }, processorRevision: 'browser-image-v1',
    }
    const waiting = tools.waitForImages({ runId: 'run-1', userId: 7, projectId, preparation: imagePreparation, expectation: { count: 1, size: { width: 64, height: 32 } }, signal: new AbortController().signal })
    await broker.complete(7, { runId: 'run-1', operationId: 'attempt-3', kind: 'image', outcome: 'completed', pngs: [png(64, 32)] })
    await expect(waiting).resolves.toEqual([{ kind: 'image', assetId: '1'.repeat(43), localUrl: `xingmang-asset://image/${'1'.repeat(43)}`, mimeType: 'image/png', width: 64, height: 32 }])
    expect(setSource).toHaveBeenCalledWith(7, '1'.repeat(43), 'imported')
    expect(onSourceError).toHaveBeenCalledWith(expect.objectContaining({ message: '来源写不进去' }), '1'.repeat(43))
  })
})
