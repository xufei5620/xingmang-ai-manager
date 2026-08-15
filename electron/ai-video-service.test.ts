import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAiVideoService, delayVideoPoll } from './ai-video-service'
import { AiVideoTaskStore, MAXIMUM_VIDEO_TASKS, type StoredAiVideoTask } from './ai-video-task-store'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function mp4Response(): Response {
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)])
  return new Response(bytes, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) } })
}

function setup(fetchImpl: typeof fetch, options: { pending?: StoredAiVideoTask[] } = {}) {
  const credentials = {
    resolveCredential: vi.fn(async (group: string) => ({
      userId: 7, group, models: ['grok-imagine-video'], keyCreated: false,
      apiKey: 'sk-secret-never-return', keyId: 1, keyName: 'video',
    })),
  }
  const reservations = new Set<string>()
  let reservationSequence = 0
  const upsert = vi.fn(async (_task: StoredAiVideoTask) => undefined)
  const tasks = {
    list: vi.fn(async () => options.pending ?? []),
    upsert,
    reserve: vi.fn(async () => {
      if ((options.pending?.length ?? 0) + reservations.size >= MAXIMUM_VIDEO_TASKS) {
        throw new Error(`AI 视频待恢复任务已达 ${MAXIMUM_VIDEO_TASKS} 条上限，请先等待或清理已有任务`)
      }
      const reservationId = `reservation-${++reservationSequence}`
      reservations.add(reservationId)
      return reservationId
    }),
    commitReservation: vi.fn(async (reservationId: string, task: StoredAiVideoTask) => {
      if (!reservations.has(reservationId)) throw new Error('AI 视频任务预留已失效')
      await upsert(task)
      reservations.delete(reservationId)
    }),
    releaseReservation: vi.fn(async (_userId: number, reservationId: string) => {
      reservations.delete(reservationId)
    }),
    remove: vi.fn(async () => undefined),
  }
  const assets = {
    storeMp4: vi.fn(async (_userId: number, _bytes: Buffer, metadata: { taskId: string }) => ({
      assetId: 'a'.repeat(43), localUrl: `xingmang-asset://video/${'a'.repeat(43)}`,
      mimeType: 'video/mp4' as const, fileName: 'video.mp4', taskId: metadata.taskId,
    })),
    readImageDataUri: vi.fn(async () => 'data:image/png;base64,aGVsbG8='),
  }
  return {
    credentials, tasks, assets,
    service: createAiVideoService({
      baseUrl: 'https://xm.solov.cc', credentials, tasks, assets, fetchImpl,
      pollIntervalMs: 1, maximumPollIntervalMs: 2, maximumWaitMs: 2_000,
    }),
  }
}

describe('createAiVideoService', () => {
  it('removes each poll abort listener after a normal delay', async () => {
    vi.useFakeTimers()
    const signal = new AbortController().signal
    const add = vi.spyOn(signal, 'addEventListener')
    const remove = vi.spyOn(signal, 'removeEventListener')
    const waiting = delayVideoPoll(10, signal)
    await vi.advanceTimersByTimeAsync(10)
    await waiting
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    vi.useRealTimers()
  })
  it('submits once, persists id before polling, then downloads an owned MP4', async () => {
    const order: string[] = []
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') { order.push('post'); return jsonResponse({ id: 'video_123', status: 'queued' }) }
      if (url.endsWith('/content')) { order.push('content'); return mp4Response() }
      order.push('poll')
      return jsonResponse({ id: 'video_123', status: 'completed', progress: 100 })
    }) as unknown as typeof fetch
    const { service, tasks, assets } = setup(fetchImpl)
    vi.mocked(tasks.upsert).mockImplementation(async () => { order.push('persist') })

    await expect(service.generate(41, {
      requestId: 'request-1', group: '生图分组', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
    })).resolves.toMatchObject({ taskId: 'video_123', mimeType: 'video/mp4' })
    expect(order).toEqual(['post', 'persist', 'poll', 'content'])
    expect(tasks.releaseReservation).not.toHaveBeenCalled()
    expect(tasks.remove).toHaveBeenCalledWith(7, 'video_123')
    expect(assets.storeMp4).toHaveBeenCalledWith(7, expect.any(Buffer), { taskId: 'video_123' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('uses an owned local image as a bounded data URI for image-to-video', async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => (
      init?.method === 'POST'
        ? jsonResponse({ id: 'video_image', status: 'queued' })
        : String(input).endsWith('/content') ? mp4Response() : jsonResponse({ id: 'video_image', status: 'completed' })
    )) as unknown as typeof fetch
    const { service, assets } = setup(fetchImpl)
    await service.generate(41, {
      requestId: 'request-image', group: '生图分组', model: 'grok-imagine-video', prompt: '镜头推进',
      seconds: '4', imageAssetId: 'b'.repeat(43), width: 720, height: 1280, expectedUserId: 7,
    })
    expect(assets.readImageDataUri).toHaveBeenCalledWith(7, 'b'.repeat(43))
    const [postUrl, postInit] = vi.mocked(fetchImpl).mock.calls[0]
    expect(String(postUrl)).toBe('https://xm.solov.cc/v1/videos')
    expect(postInit?.method).toBe('POST')
    const body = JSON.parse(String(postInit?.body))
    expect(body).toMatchObject({
      image: 'data:image/png;base64,aGVsbG8=',
      width: 720,
      height: 1280,
    })
  })

  it('never automatically replays an ambiguous paid POST', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('socket reset') }) as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl)
    await expect(service.generate(41, {
      requestId: 'request-ambiguous', group: '生图分组', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
    })).rejects.toThrow('结果不明确')
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(tasks.upsert).not.toHaveBeenCalled()
    expect(tasks.releaseReservation).toHaveBeenCalledOnce()
  })

  it.each([
    ['HTTP 503', () => jsonResponse({ error: { message: 'upstream unavailable' } }, 503)],
    ['invalid success JSON', () => new Response('{bad', { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['success without a task id', () => jsonResponse({ status: 'queued' })],
  ])('treats %s after paid dispatch as ambiguous', async (_label, responseFactory) => {
    const fetchImpl = vi.fn(async () => responseFactory()) as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl)

    await expect(service.generate(41, {
      requestId: `ambiguous-${_label}`, group: 'grok', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
    })).rejects.toThrow('结果不明确')
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(tasks.upsert).not.toHaveBeenCalled()
  })

  it('rejects a video model missing from the selected group before paid dispatch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'must-not-run' })) as unknown as typeof fetch
    const { service, credentials, tasks } = setup(fetchImpl)
    credentials.resolveCredential.mockResolvedValue({
      userId: 7, group: '生图分组', models: ['gpt-image-2'], keyCreated: false,
      apiKey: 'sk-secret-never-return', keyId: 1, keyName: 'video',
    })

    await expect(service.generate(41, {
      requestId: 'video-unavailable', group: '生图分组', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
    })).rejects.toThrow('当前分组「生图分组」不提供模型')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(tasks.upsert).not.toHaveBeenCalled()
  })

  it('reserves recovery capacity before dispatching a paid video request', async () => {
    const pending = Array.from({ length: 200 }, (_, index): StoredAiVideoTask => ({
      version: 1,
      userId: 7,
      taskId: `video_pending_${index}`,
      group: 'grok',
      model: 'grok-imagine-video',
      requestId: `pending-${index}`,
      createdAt: '2026-08-14T00:00:00.000Z',
    }))
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl, { pending })

    await expect(service.generate(41, {
      requestId: 'capacity-full', group: 'grok', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
    })).rejects.toThrow('200 条上限')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(tasks.upsert).not.toHaveBeenCalled()
  })

  it('releases a reservation when cancellation wins before paid dispatch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl)
    vi.mocked(tasks.reserve).mockImplementation(async () => {
      expect(service.cancel(41, 'cancel-before-post')).toEqual({ canceled: true, mayStillComplete: false })
      return 'reservation-before-post'
    })

    await expect(service.generate(41, {
      requestId: 'cancel-before-post', group: 'grok', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
    })).rejects.toThrow('已取消视频请求')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(tasks.releaseReservation).toHaveBeenCalledWith(7, 'reservation-before-post')
  })

  it('allows only one paid POST when two reversed credential resolutions compete for the final slot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-reservation-'))
    try {
      const pending = Array.from({ length: 199 }, (_, index): StoredAiVideoTask => ({
        version: 1,
        userId: 7,
        taskId: `video_pending_${index}`,
        group: 'grok',
        model: 'grok-imagine-video',
        requestId: `pending-${index}`,
        createdAt: '2026-08-14T00:00:00.000Z',
      }))
      const directory = path.join(root, 'user-7')
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'video-tasks.json'), `${JSON.stringify({ version: 1, userId: 7, tasks: pending })}\n`, 'utf8')
      const tasks = new AiVideoTaskStore({ rootDirectory: root })
      const credential = {
        userId: 7, group: 'grok', models: ['grok-imagine-video'], keyCreated: false,
        apiKey: 'sk-secret-never-return', keyId: 1, keyName: 'video',
      }
      let resolveFirstCredential!: (value: typeof credential) => void
      let credentialCall = 0
      const credentials = {
        resolveCredential: vi.fn(async () => {
          credentialCall += 1
          if (credentialCall === 1) {
            return new Promise<typeof credential>((resolve) => { resolveFirstCredential = resolve })
          }
          return credential
        }),
      }
      let resolvePost!: (response: Response) => void
      const fetchImpl = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Promise<Response>((resolve) => { resolvePost = resolve })
        }
        return Promise.resolve(String(input).endsWith('/content')
          ? mp4Response()
          : jsonResponse({ id: 'video_reserved', status: 'completed' }))
      }) as unknown as typeof fetch
      const assets = {
        storeMp4: vi.fn(async (_userId: number, _bytes: Buffer, metadata: { taskId: string }) => ({
          assetId: 'a'.repeat(43), localUrl: `xingmang-asset://video/${'a'.repeat(43)}`,
          mimeType: 'video/mp4' as const, fileName: 'video.mp4', taskId: metadata.taskId,
        })),
        readImageDataUri: vi.fn(async () => 'data:image/png;base64,aGVsbG8='),
      }
      const service = createAiVideoService({
        baseUrl: 'https://xm.solov.cc', credentials, tasks, assets, fetchImpl,
        pollIntervalMs: 1, maximumPollIntervalMs: 2, maximumWaitMs: 2_000,
      })

      const first = service.generate(41, {
        requestId: 'slow-credential', group: 'grok', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
      })
      const firstRejected = expect(first).rejects.toThrow('200 条上限')
      await vi.waitFor(() => expect(credentials.resolveCredential).toHaveBeenCalledOnce())
      const second = service.generate(42, {
        requestId: 'fast-credential', group: 'grok', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
      })
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())

      resolveFirstCredential(credential)
      await firstRejected
      expect(vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)

      resolvePost(jsonResponse({ id: 'video_reserved', status: 'queued' }))
      await expect(second).resolves.toMatchObject({ taskId: 'video_reserved' })
      expect(vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('warns not to resubmit when task persistence fails after a known paid id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'video_known', status: 'queued' })) as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl)
    vi.mocked(tasks.upsert).mockRejectedValue(new Error('disk full'))
    await expect(service.generate(41, {
      requestId: 'request-persist-fail', group: '生图分组', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
    })).rejects.toThrow(/video_known.*请勿重复提交/)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(tasks.releaseReservation).toHaveBeenCalledOnce()
  })

  it('cancels waiting without deleting an already persisted server task', async () => {
    let resolvePoll!: (response: Response) => void
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'video_waiting', status: 'queued' })
      return new Promise<Response>((resolve) => { resolvePoll = resolve })
    }) as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl)
    const pending = service.generate(41, {
      requestId: 'request-cancel', group: '生图分组', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
    })
    await vi.waitFor(() => expect(tasks.upsert).toHaveBeenCalled())
    expect(service.cancel(41, 'request-cancel')).toEqual({ canceled: true, mayStillComplete: true })
    resolvePoll(jsonResponse({ id: 'video_waiting', status: 'queued' }))
    await expect(pending).rejects.toThrow('服务端可能仍在生成视频')
    expect(tasks.remove).not.toHaveBeenCalled()
  })

  it('recovers by polling persisted ids only and never submits again', async () => {
    const stored: StoredAiVideoTask = {
      version: 1, userId: 7, taskId: 'video_resume', group: '生图分组', model: 'grok-imagine-video',
      requestId: 'old-request', createdAt: '2026-08-14T00:00:00.000Z',
      projectId: '11111111-1111-4111-8111-111111111111',
    }
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => (
      String(input).endsWith('/content') ? mp4Response() : jsonResponse({ id: 'video_resume', status: 'completed' })
    )) as unknown as typeof fetch
    const { service, credentials, assets } = setup(fetchImpl, { pending: [stored] })
    const recovered = await service.resumeUser(7)
    expect(recovered).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetchImpl).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    expect(credentials.resolveCredential).toHaveBeenCalledWith('生图分组')
    expect(assets.storeMp4).toHaveBeenCalledWith(7, expect.any(Buffer), {
      taskId: 'video_resume', projectId: stored.projectId,
    })
  })

  it('removes a persisted task after the server reports terminal failure without POST', async () => {
    const stored: StoredAiVideoTask = {
      version: 1, userId: 7, taskId: 'video_failed', group: 'grok', model: 'grok-imagine-video',
      requestId: 'old-request', createdAt: '2026-08-14T00:00:00.000Z',
    }
    const fetchImpl = vi.fn(async () => jsonResponse({
      id: stored.taskId, status: 'failed', error: { message: 'upstream rejected video' },
    })) as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl, { pending: [stored] })

    await expect(service.resumeVideoTask(41, 7, stored.taskId)).rejects.toThrow('upstream rejected video')
    expect(tasks.remove).toHaveBeenCalledWith(7, stored.taskId)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(vi.mocked(fetchImpl).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('resumes exactly one persisted task for the requested account without POST', async () => {
    const stored: StoredAiVideoTask = {
      version: 1, userId: 7, taskId: 'video_single', group: 'grok', model: 'grok-imagine-video',
      requestId: 'old-request', createdAt: '2026-08-14T00:00:00.000Z',
    }
    const unrelated: StoredAiVideoTask = { ...stored, taskId: 'video_unrelated' }
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).not.toBe('POST')
      return String(input).endsWith('/content')
        ? mp4Response()
        : jsonResponse({ id: 'video_single', status: 'completed' })
    }) as unknown as typeof fetch
    const { service, tasks, assets } = setup(fetchImpl, { pending: [unrelated, stored] })

    await expect(service.resumeVideoTask(41, 7, 'video_single')).resolves.toMatchObject({
      taskId: 'video_single', mimeType: 'video/mp4',
    })
    expect(tasks.list).toHaveBeenCalledWith(7)
    expect(tasks.remove).toHaveBeenCalledWith(7, 'video_single')
    expect(assets.storeMp4).toHaveBeenCalledWith(7, expect.any(Buffer), { taskId: 'video_single' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('owns a manual resume by its canvas sender so closing the window stops the wait', async () => {
    const stored: StoredAiVideoTask = {
      version: 1, userId: 7, taskId: 'video_window_owned', group: 'grok', model: 'grok-imagine-video',
      requestId: 'old-request', createdAt: '2026-08-14T00:00:00.000Z',
    }
    const fetchImpl = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })) as unknown as typeof fetch
    const { service } = setup(fetchImpl, { pending: [stored] })

    const pending = service.resumeVideoTask(41, 7, stored.taskId)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    expect(service.cancelSender(41)).toBe(1)
    await expect(pending).rejects.toThrow('已停止等待视频生成')
    expect(vi.mocked(fetchImpl).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('rejects unknown and cross-account task ids before resolving credentials or fetching', async () => {
    const otherAccountTask: StoredAiVideoTask = {
      version: 1, userId: 8, taskId: 'video_foreign', group: 'grok', model: 'grok-imagine-video',
      requestId: 'old-request', createdAt: '2026-08-14T00:00:00.000Z',
    }
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const { service, credentials } = setup(fetchImpl, { pending: [otherAccountTask] })

    await expect(service.resumeVideoTask(41, 7, 'video_foreign')).rejects.toThrow('当前账号没有可恢复')
    await expect(service.resumeVideoTask(41, 7, '../video')).rejects.toThrow('任务标识格式错误')
    expect(credentials.resolveCredential).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stops a persisted task before querying when credential ownership changed', async () => {
    const stored: StoredAiVideoTask = {
      version: 1, userId: 7, taskId: 'video_account_switch', group: 'grok', model: 'grok-imagine-video',
      requestId: 'old-request', createdAt: '2026-08-14T00:00:00.000Z',
    }
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const { service, credentials } = setup(fetchImpl, { pending: [stored] })
    credentials.resolveCredential.mockResolvedValue({
      userId: 8, group: 'grok', models: [], keyCreated: false,
      apiKey: 'sk-other-account', keyId: 2, keyName: 'video',
    })

    await expect(service.resumeVideoTask(41, 7, stored.taskId)).rejects.toThrow('登录账号已变化')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
