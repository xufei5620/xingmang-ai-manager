import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasFramePreparation, CanvasRunPreparationCompletion } from '../host'
import type { BrowserFrameOptions, BrowserFrameResult } from '../library/browser-frame'
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

describe('host run preparations in the editor', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

  it('feeds the frames from run-waiting events and run records, and stops them with the run or the project', () => {
    expect(app).toContain('createHostRunPreparations(window.xingmangCanvasHost)')
    expect(app).toMatch(/if \(event\.type === 'run-waiting'\) \{\n\s+runPreparationsRef\.current\?\.update\(event\.runId, event\.framePreparations\)/)
    expect(app).toMatch(/if \(event\.type === 'run-terminal'\) \{\n\s+forgetActiveRun\(event\.runId\)\n\s+runPreparationsRef\.current\?\.finish\(event\.runId\)/)
    expect(app).toContain("if (record.status === 'running' && record.projectId === projectId && record.framePreparations?.length) runPreparationsRef.current?.resume(record.runId, record.framePreparations)")
    // Opening another project and closing this one both drop the run list, and the frames with it.
    expect(app.match(/activeRunsRef\.current\.clear\(\)\n\s+runPreparationsRef\.current\?\.stopAll\(\)/g)).toHaveLength(2)
    expect(app.match(/activeRunsRef\.current\.clear\(\)/g)).toHaveLength(2)
  })
})
