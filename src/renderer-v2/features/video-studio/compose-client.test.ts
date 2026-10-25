import { describe, expect, it } from 'vitest'
import { composeInVideoStudioWorker, type VideoStudioWorkerListener, type VideoStudioWorkerPort } from './compose-client'
import type { VideoStudioComposeProgress, VideoStudioComposeRequest, VideoStudioWorkerMessage } from './compose-protocol'

function fakeWorker(options: { failStart?: boolean } = {}) {
  const state: { message?: VideoStudioWorkerMessage, transfer?: Transferable[], listener?: VideoStudioWorkerListener, terminated: number } = { terminated: 0 }
  const port: VideoStudioWorkerPort = {
    start(message, transfer, listener) {
      if (options.failStart) throw new DOMException('detached', 'DataCloneError')
      state.message = message
      state.transfer = transfer
      state.listener = listener
    },
    terminate() { state.terminated += 1 },
  }
  return { port, state }
}

function request(): VideoStudioComposeRequest {
  return { clips: [{ data: new ArrayBuffer(4) }, { data: new ArrayBuffer(8), caption: '字幕' }], options: { aspect: '16:9', resolution: 480, fit: 'contain', frameRate: 25 } }
}

const result = { data: new ArrayBuffer(16), mimeType: 'video/mp4', videoCodec: 'avc', audioCodec: null, width: 854, height: 480, duration: 2 }

describe('video studio compose client', () => {
  it('hands the clip bytes to the worker and resolves with its result', async () => {
    const { port, state } = fakeWorker()
    const progress: VideoStudioComposeProgress[] = []
    const input = request()
    const pending = composeInVideoStudioWorker(input, { createWorker: () => port, onProgress: (value) => progress.push(value) })
    expect(state.message).toEqual({ kind: 'compose', request: input })
    expect(state.transfer).toEqual(input.clips.map((clip) => clip.data))
    state.listener?.message({ kind: 'progress', progress: { stage: 'rendering', ratio: 0.5 } })
    state.listener?.message({ kind: 'done', result })
    await expect(pending).resolves.toEqual(result)
    expect(progress).toEqual([{ stage: 'rendering', ratio: 0.5 }])
    expect(state.terminated).toBe(1)
    state.listener?.message({ kind: 'progress', progress: { stage: 'finishing', ratio: 1 } })
    expect(progress).toHaveLength(1)
  })

  it('passes the worker failure message through', async () => {
    const { port, state } = fakeWorker()
    const pending = composeInVideoStudioWorker(request(), { createWorker: () => port })
    state.listener?.message({ kind: 'failed', message: '第 2 段片段里没有画面', detail: 'Error: no track' })
    await expect(pending).rejects.toThrow('第 2 段片段里没有画面')
    expect(state.terminated).toBe(1)
  })

  it('fails on a reply it cannot read or a worker that dies', async () => {
    const unreadable = fakeWorker()
    const first = composeInVideoStudioWorker(request(), { createWorker: () => unreadable.port })
    unreadable.state.listener?.message({ kind: 'done', result: { ...result, data: null } })
    await expect(first).rejects.toThrow('拼片线程回了看不懂的消息，请再试一次')

    const dying = fakeWorker()
    const second = composeInVideoStudioWorker(request(), { createWorker: () => dying.port })
    dying.state.listener?.error()
    await expect(second).rejects.toThrow('拼片线程意外停了，请再试一次')
    expect(dying.state.terminated).toBe(1)
  })

  it('closes the worker straight away when cancelled', async () => {
    const { port, state } = fakeWorker()
    const controller = new AbortController()
    const pending = composeInVideoStudioWorker(request(), { createWorker: () => port, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.terminated).toBe(1)
    state.listener?.message({ kind: 'done', result })
    expect(state.terminated).toBe(1)
  })

  it('never starts a worker for a request that was already cancelled', async () => {
    let created = 0
    const controller = new AbortController()
    controller.abort()
    await expect(composeInVideoStudioWorker(request(), { signal: controller.signal, createWorker: () => { created += 1; return fakeWorker().port } }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(created).toBe(0)
  })

  it('reports clip bytes that cannot be handed over', async () => {
    const { port, state } = fakeWorker({ failStart: true })
    await expect(composeInVideoStudioWorker(request(), { createWorker: () => port })).rejects.toThrow('片段交不给拼片线程，请重新读一遍片段再试')
    expect(state.terminated).toBe(1)
  })
})
