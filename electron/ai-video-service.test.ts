import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAiVideoService, delayVideoPoll } from './ai-video-service'
import { AI_VIDEO_TASK_VERSION, AiVideoTaskStore, MAXIMUM_VIDEO_TASKS, type StoredAiVideoTask } from './ai-video-task-store'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function mp4Response(): Response {
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)])
  return new Response(bytes, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) } })
}

function setup(
  fetchImpl: typeof fetch,
  options: { pending?: StoredAiVideoTask[]; tasks?: AiVideoTaskStore } = {},
) {
  const credentials = {
    resolveCredential: vi.fn(async (group: string) => ({
      userId: 7, group, models: [
        'grok-imagine-video', 'minimax-h3-mini', 'minimax-h3-fast', 'minimax-h3-base',
      ], keyCreated: false,
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
    readOwned: vi.fn(async (_userId: number, _assetId: string, kind: 'image' | 'video' | 'audio') => ({
      asset: {
        mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
        fileName: kind === 'image' ? 'reference.png' : kind === 'video' ? 'reference.mp4' : 'reference.mp3',
      },
      bytes: Buffer.from(`${kind}-reference`),
    })),
  }
  return {
    credentials, tasks, assets,
    service: createAiVideoService({
      baseUrl: 'https://xm.solov.cc', credentials, tasks: options.tasks ?? tasks, assets, fetchImpl,
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
    const stages: string[] = []

    await expect(service.generate(41, {
      requestId: 'request-1', group: '生图分组', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
    }, { onStage: (stage) => { stages.push(stage) } })).resolves.toMatchObject({ taskId: 'video_123', mimeType: 'video/mp4' })
    expect(order).toEqual(['post', 'persist', 'poll', 'content'])
    expect(tasks.releaseReservation).not.toHaveBeenCalled()
    expect(tasks.remove).toHaveBeenCalledWith(7, 'video_123')
    expect(assets.storeMp4).toHaveBeenCalledWith(7, expect.any(Buffer), { taskId: 'video_123', prompt: '海浪' })
    expect(stages).toEqual(['processing', 'downloading', 'saving'])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('persists canvas correlation alongside a newly submitted task', async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'video_correlated', status: 'queued' })
      return String(input).endsWith('/content') ? mp4Response() : jsonResponse({ id: 'video_correlated', status: 'completed' })
    }) as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl)
    await service.generate(41, {
      requestId: 'request-correlation', group: 'grok', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
      projectId: '11111111-1111-4111-8111-111111111111', runId: 'run-123', nodeId: 'video-node',
      attemptId: 'attempt-123', graphRevision: 'a'.repeat(64),
    })
    expect(tasks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'video_correlated', projectId: '11111111-1111-4111-8111-111111111111', runId: 'run-123',
      nodeId: 'video-node', attemptId: 'attempt-123', graphRevision: 'a'.repeat(64),
    }))
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

  it('submits MiniMax text-to-video as JSON with an idempotency key', async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => (
      init?.method === 'POST'
        ? jsonResponse({ id: 'task_minimax_text', status: 'queued' })
        : String(input).endsWith('/content')
          ? mp4Response()
          : jsonResponse({ id: 'task_minimax_text', status: 'completed', progress: 100 })
    )) as unknown as typeof fetch
    const { service, assets } = setup(fetchImpl)

    await service.generate(41, {
      requestId: 'minimax-text', group: '生图分组', model: 'minimax-h3-base', prompt: '纸船穿过溪流',
      seconds: '6', mode: 't2va', resolution: '720p', aspectRatio: '9:16', promptOptimization: true,
    })

    expect(assets.readOwned).not.toHaveBeenCalled()
    const [postUrl, postInit] = vi.mocked(fetchImpl).mock.calls[0]
    expect(String(postUrl)).toBe('https://xm.solov.cc/v1/videos')
    expect(postInit?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Idempotency-Key': 'minimax-text',
    })
    expect(JSON.parse(String(postInit?.body))).toEqual({
      model: 'minimax-h3-base', mode: 't2va', resolution: '720p', prompt: '纸船穿过溪流',
      seconds: '6', aspect_ratio: '9:16', prompt_optimization: true,
    })
  })

  it('submits owned MiniMax media as multipart without overriding its boundary', async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => (
      init?.method === 'POST'
        ? jsonResponse({ id: 'task_minimax_media', status: 'queued' })
        : String(input).endsWith('/content')
          ? mp4Response()
          : jsonResponse({ id: 'task_minimax_media', status: 'completed' })
    )) as unknown as typeof fetch
    const { service, assets } = setup(fetchImpl)
    const projectId = '11111111-1111-4111-8111-111111111111'
    const images = ['a'.repeat(43), 'b'.repeat(43)]
    const videos = ['v'.repeat(43)]
    const audios = ['m'.repeat(43)]

    await service.generate(41, {
      requestId: 'minimax-media', group: '生图分组', model: 'minimax-h3-fast', prompt: '保留人物、动作和声音',
      seconds: '10', mode: 'ref2va', resolution: '480p', aspectRatio: '4:5', promptOptimization: false,
      imageAssetIds: images, videoAssetIds: videos, audioAssetIds: audios, projectId,
    })

    expect(assets.readOwned.mock.calls).toEqual([
      [7, images[0], 'image', projectId],
      [7, images[1], 'image', projectId],
      [7, videos[0], 'video', projectId],
      [7, audios[0], 'audio', projectId],
    ])
    const postInit = vi.mocked(fetchImpl).mock.calls[0][1]
    expect(postInit?.body).toBeInstanceOf(FormData)
    expect(postInit?.headers).not.toHaveProperty('Content-Type')
    const form = postInit?.body as FormData
    expect(form.get('mode')).toBe('ref2va')
    expect(form.get('resolution')).toBe('480p')
    expect(form.get('seconds')).toBe('10')
    expect(form.get('prompt_optimization')).toBe('false')
    expect(form.getAll('images')).toHaveLength(2)
    expect(form.getAll('videos')).toHaveLength(1)
    expect(form.getAll('audios')).toHaveLength(1)
    expect(form.getAll('images').every((entry) => entry instanceof File && entry.type === 'image/png')).toBe(true)
  })

  it('rejects MiniMax per-file and aggregate media limits before paid dispatch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const oversizedImage = Buffer.allocUnsafe(20 * 1024 * 1024 + 1)
    const { service, assets, tasks } = setup(fetchImpl)
    assets.readOwned.mockResolvedValueOnce({
      asset: { mimeType: 'image/png', fileName: 'oversized.png' }, bytes: oversizedImage,
    })
    await expect(service.generate(41, {
      requestId: 'minimax-image-too-large', group: '生图分组', model: 'minimax-h3-mini', prompt: '参考图',
      seconds: '5', mode: 'i2va', imageAssetIds: ['i'.repeat(43)],
    })).rejects.toThrow('单个参考图片超过接口大小限制')

    const sharedAudio = Buffer.allocUnsafe(40 * 1024 * 1024)
    assets.readOwned.mockImplementation(async (_userId, _assetId, kind) => ({
      asset: {
        mimeType: kind === 'image' ? 'image/png' : 'audio/mpeg',
        fileName: kind === 'image' ? 'reference.png' : 'reference.mp3',
      },
      bytes: kind === 'image' ? Buffer.from([1]) : sharedAudio,
    }))
    await expect(service.generate(41, {
      requestId: 'minimax-total-too-large', group: '生图分组', model: 'minimax-h3-base', prompt: '多素材',
      seconds: '5', mode: 'ref2va', imageAssetIds: ['i'.repeat(43)],
      audioAssetIds: ['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43)],
    })).rejects.toThrow('合计超过 120 MiB')

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(tasks.reserve).not.toHaveBeenCalled()
  })

  it('projects MiniMax determinate, indeterminate, and delayed progress', async () => {
    let poll = 0
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'task_minimax_progress', status: 'queued' })
      if (String(input).endsWith('/content')) return mp4Response()
      poll += 1
      if (poll === 1) return jsonResponse({
        id: 'task_minimax_progress', status: 'in_progress', progress: 42,
        progress_detail: { mode: 'determinate', health: 'normal' },
      })
      if (poll === 2) return jsonResponse({
        id: 'task_minimax_progress', status: 'in_progress', progress: 42,
        progress_detail: { mode: 'indeterminate', health: 'delayed' },
      })
      return jsonResponse({
        id: 'task_minimax_progress', status: 'completed', progress: 100,
        progress_detail: { mode: 'determinate', health: 'normal' },
      })
    }) as unknown as typeof fetch
    const { service } = setup(fetchImpl)
    const updates: Array<{ value?: number; mode?: string; health?: string }> = []

    await service.generate(41, {
      requestId: 'minimax-progress', group: '生图分组', model: 'minimax-h3-mini', prompt: '海浪',
      seconds: '5', mode: 't2va',
    }, { onStage: vi.fn(), onProgress: (update) => { updates.push(update) } })

    expect(updates).toEqual([
      { value: 42, mode: 'determinate', health: 'normal' },
      { value: 42, mode: 'indeterminate', health: 'delayed' },
      { value: 100, mode: 'determinate', health: 'normal' },
    ])
  })

  it('removes a MiniMax recovery task when the server reports cancelled', async () => {
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => (
      init?.method === 'POST'
        ? jsonResponse({ id: 'task_minimax_cancelled', status: 'queued' })
        : jsonResponse({ id: 'task_minimax_cancelled', status: 'cancelled' })
    )) as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl)

    await expect(service.generate(41, {
      requestId: 'minimax-cancelled', group: '生图分组', model: 'minimax-h3-base', prompt: '海浪',
      seconds: '5', mode: 't2va',
    })).rejects.toThrow('视频任务已取消')
    expect(tasks.remove).toHaveBeenCalledWith(7, 'task_minimax_cancelled')
  })

  it('sends a best-effort remote MiniMax cancel only for an explicit user cancellation', async () => {
    const fetchImpl = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/v1/videos')) {
        return Promise.resolve(jsonResponse({ id: 'task_minimax_remote_cancel', status: 'queued' }))
      }
      if (init?.method === 'POST' && url.endsWith('/task_minimax_remote_cancel/cancel')) {
        return Promise.resolve(jsonResponse({ id: 'task_minimax_remote_cancel', cancellation_requested: true }))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }) as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl)
    const pending = service.generate(41, {
      requestId: 'minimax-explicit-cancel', group: '生图分组', model: 'minimax-h3-fast', prompt: '海浪',
      seconds: '5', mode: 't2va',
    })
    await vi.waitFor(() => expect(tasks.upsert).toHaveBeenCalled())

    expect(service.cancel(41, 'minimax-explicit-cancel')).toEqual({ canceled: true, mayStillComplete: true })
    await expect(pending).rejects.toThrow('服务端可能仍在生成视频')
    await vi.waitFor(() => {
      const cancelCall = vi.mocked(fetchImpl).mock.calls.find(([input]) => (
        String(input).endsWith('/task_minimax_remote_cancel/cancel')
      ))
      expect(cancelCall?.[1]).toMatchObject({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-secret-never-return' }),
      })
    })
    expect(tasks.remove).not.toHaveBeenCalled()
  })

  it.each([
    [413, {}, '超过接口大小限制'],
    [422, { error: { message: 'ref2va requires media' } }, 'ref2va requires media'],
    [429, {}, '等待 12 秒'],
  ])('maps MiniMax HTTP %i without replaying the paid request', async (status, payload, message) => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload, status, status === 429 ? { 'Retry-After': '12' } : {})) as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl)

    await expect(service.generate(41, {
      requestId: `minimax-http-${status}`, group: '生图分组', model: 'minimax-h3-mini', prompt: '海浪',
      seconds: '5', mode: 't2va',
    })).rejects.toThrow(message)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(tasks.upsert).not.toHaveBeenCalled()
    expect(tasks.releaseReservation).toHaveBeenCalledOnce()
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
    { error: { message: 'Invalid URL (POST /v1/video_generation)' } },
    { message: JSON.stringify({ error: { message: 'Invalid URL (POST [本地路径]' } }) },
  ])('reports a MiniMax channel protocol mismatch without exposing the raw error payload', async (payload) => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload, 404)) as unknown as typeof fetch
    const { service, tasks } = setup(fetchImpl)

    await expect(service.generate(41, {
      requestId: 'minimax-channel-mismatch', group: '视频分组', model: 'minimax-h3-mini', prompt: '海浪',
      seconds: '5', mode: 't2va',
    })).rejects.toThrow('请管理员改为 Sora/OpenAI Video 透传后重试；本次未创建任务')
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
      version: AI_VIDEO_TASK_VERSION,
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
        version: AI_VIDEO_TASK_VERSION,
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
      version: AI_VIDEO_TASK_VERSION, userId: 7, taskId: 'video_resume', group: '生图分组', model: 'grok-imagine-video',
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

  it('records the prompt with the task and writes it onto the clip a later session finishes', async () => {
    // The task record is the only thing that survives a restart, so a prompt
    // that is not on it is a prompt the resumed clip can never carry.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-prompt-'))
    try {
      const tasks = new AiVideoTaskStore({ rootDirectory: root })
      const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => (
        init?.method === 'POST'
          ? jsonResponse({ id: 'video_prompted', status: 'queued' })
          : jsonResponse({ id: 'video_prompted', status: 'queued' })
      )) as unknown as typeof fetch
      const { service } = setup(fetchImpl, { tasks })
      const pending = service.generate(41, {
        requestId: 'prompted', group: 'grok', model: 'grok-imagine-video', prompt: ' 海边的黄昏 ', seconds: '5',
      })
      await vi.waitFor(async () => expect(await tasks.list(7)).toHaveLength(1))
      expect((await tasks.list(7))[0]).toMatchObject({ taskId: 'video_prompted', prompt: '海边的黄昏' })
      service.cancel(41, 'prompted')
      await expect(pending).rejects.toThrow(/视频/)

      // A fresh process reads the record back and hands the prompt to the store.
      const reopened = new AiVideoTaskStore({ rootDirectory: root })
      const download = vi.fn(async (input: URL | RequestInfo) => (
        String(input).endsWith('/content') ? mp4Response() : jsonResponse({ id: 'video_prompted', status: 'completed' })
      )) as unknown as typeof fetch
      const resumed = setup(download, { tasks: reopened })
      await resumed.service.resumeUser(7)
      expect(resumed.assets.storeMp4).toHaveBeenCalledWith(7, expect.any(Buffer), {
        taskId: 'video_prompted', prompt: '海边的黄昏',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes a persisted task after the server reports terminal failure without POST', async () => {
    const stored: StoredAiVideoTask = {
      version: AI_VIDEO_TASK_VERSION, userId: 7, taskId: 'video_failed', group: 'grok', model: 'grok-imagine-video',
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
      version: AI_VIDEO_TASK_VERSION, userId: 7, taskId: 'video_single', group: 'grok', model: 'grok-imagine-video',
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
      version: AI_VIDEO_TASK_VERSION, userId: 7, taskId: 'video_window_owned', group: 'grok', model: 'grok-imagine-video',
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
      version: AI_VIDEO_TASK_VERSION, userId: 8, taskId: 'video_foreign', group: 'grok', model: 'grok-imagine-video',
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
      version: AI_VIDEO_TASK_VERSION, userId: 7, taskId: 'video_account_switch', group: 'grok', model: 'grok-imagine-video',
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
