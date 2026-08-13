import { describe, expect, it, vi } from 'vitest'
import { createCanvasNodeExecutors } from './canvas-node-executors'

describe('createCanvasNodeExecutors', () => {
  it('delegates image generation through the injected main-process service', async () => {
    const generate = vi.fn(async () => [{
      assetId: 'a'.repeat(43),
      localUrl: `xingmang-asset://image/${'a'.repeat(43)}`,
      mimeType: 'image/png' as const,
      fileName: 'image.png',
    }])
    const cancel = vi.fn(() => ({ canceled: false, mayStillComplete: false }))
    const executors = createCanvasNodeExecutors({ imageService: { generate, cancel } })
    const result = await executors.image({
      runId: 'run',
      graphRevision: 'revision',
      attemptId: 'attempt',
      ownerId: 99,
      userId: 7,
      node: {
        id: 'image',
        kind: 'image',
        definitionVersion: 1,
        data: { prompt: 'local', model: 'gpt-image-2', group: '生图', size: '1024x1024', quality: 'low' },
      },
      inputs: { text: 'upstream' },
      signal: new AbortController().signal,
    })
    expect(generate).toHaveBeenCalledWith(99, {
      requestId: 'canvas-run:attempt',
      group: '生图',
      model: 'gpt-image-2',
      prompt: 'upstream\nlocal',
      size: '1024x1024',
      quality: 'low',
    })
    expect(result.assets?.[0]).toMatchObject({ kind: 'image', assetId: 'a'.repeat(43) })
  })

  it('cancels the exact image request when the run aborts', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(() => ({ canceled: true, mayStillComplete: true }))
    const executors = createCanvasNodeExecutors({
      imageService: {
        generate: () => new Promise(() => undefined),
        cancel,
      },
    })
    void executors.image({
      runId: 'run',
      graphRevision: 'revision',
      attemptId: 'attempt',
      ownerId: 99,
      userId: 7,
      node: { id: 'image', kind: 'image', definitionVersion: 1, data: { prompt: 'prompt', model: 'model' } },
      inputs: {},
      signal: controller.signal,
    })
    controller.abort()
    expect(cancel).toHaveBeenCalledWith(99, 'canvas-run:attempt')
  })

  it('passes distinct reference images and the authenticated user to image editing', async () => {
    const edit = vi.fn(async () => [{
      assetId: 'c'.repeat(43), localUrl: `xingmang-asset://image/${'c'.repeat(43)}`,
      mimeType: 'image/png' as const, fileName: 'edited.png',
    }])
    const executors = createCanvasNodeExecutors({
      imageService: {
        generate: vi.fn(), edit,
        cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
      },
    })
    const sourceA = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }
    const sourceB = { kind: 'image' as const, assetId: 'b'.repeat(43), localUrl: `xingmang-asset://image/${'b'.repeat(43)}` }
    const result = await executors['image-edit']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'edit-attempt', ownerId: 9, userId: 42,
      node: {
        id: 'edit', kind: 'image-edit', definitionVersion: 1,
        data: { prompt: '夜景', model: 'gpt-image-2', group: '生图', size: '1024x1024', quality: 'low' },
      },
      inputs: { text: '保持主体', image: sourceA, images: [sourceA, sourceB, sourceA] },
      signal: new AbortController().signal,
    })

    expect(edit).toHaveBeenCalledWith(9, {
      requestId: 'canvas-run:edit-attempt', group: '生图', model: 'gpt-image-2',
      prompt: '保持主体\n夜景', sourceAssetIds: ['a'.repeat(43), 'b'.repeat(43)], expectedUserId: 42,
      size: '1024x1024', quality: 'low',
    })
    expect(result.assets?.[0]).toMatchObject({ assetId: 'c'.repeat(43) })
  })

  it('rejects image editing without a local reference before paid dispatch', async () => {
    const edit = vi.fn()
    const executors = createCanvasNodeExecutors({
      imageService: {
        generate: vi.fn(), edit,
        cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
      },
    })
    await expect(executors['image-edit']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'edit-attempt', ownerId: 9, userId: 42,
      node: { id: 'edit', kind: 'image-edit', definitionVersion: 1, data: { prompt: '夜景', model: 'gpt-image-2' } },
      inputs: {}, signal: new AbortController().signal,
    })).rejects.toThrow('请连接至少一张')
    expect(edit).not.toHaveBeenCalled()
  })

  it('rejects a model without image-edit support before paid dispatch', async () => {
    const edit = vi.fn()
    const executors = createCanvasNodeExecutors({
      imageService: {
        generate: vi.fn(), edit,
        cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
      },
    })
    await expect(executors['image-edit']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'edit-attempt', ownerId: 9, userId: 42,
      node: { id: 'edit', kind: 'image-edit', definitionVersion: 1, data: { prompt: '夜景', model: 'jimeng_high_aes_general_v21_L' } },
      inputs: { image: {
        kind: 'image', assetId: 'a'.repeat(43),
        localUrl: `xingmang-asset://image/${'a'.repeat(43)}`,
      } },
      signal: new AbortController().signal,
    })).rejects.toThrow('不支持图片编辑')
    expect(edit).not.toHaveBeenCalled()
  })

  it('cancels the exact image-edit request when the run aborts', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(() => ({ canceled: true, mayStillComplete: true }))
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), edit: () => new Promise(() => undefined), cancel },
    })
    void executors['image-edit']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'edit-abort', ownerId: 99, userId: 42,
      node: { id: 'edit', kind: 'image-edit', definitionVersion: 1, data: { prompt: '夜景', model: 'gpt-image-2' } },
      inputs: { image: {
        kind: 'image', assetId: 'a'.repeat(43),
        localUrl: `xingmang-asset://image/${'a'.repeat(43)}`,
      } }, signal: controller.signal,
    })
    controller.abort()
    expect(cancel).toHaveBeenCalledWith(99, 'canvas-run:edit-abort')
  })

  it('resolves an adopted image through the current user ownership boundary', async () => {
    const readOwned = vi.fn(async () => ({ asset: {
      assetId: 'a'.repeat(43),
      localUrl: `xingmang-asset://image/${'a'.repeat(43)}`,
      mimeType: 'image/png',
      width: 100,
      height: 80,
    } }))
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      assets: { readOwned },
    })
    const result = await executors['image-input']!({
      runId: 'run',
      graphRevision: 'revision',
      attemptId: 'attempt',
      ownerId: 99,
      userId: 42,
      node: {
        id: 'input', kind: 'image-input', definitionVersion: 1,
        data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) },
      },
      inputs: {},
      signal: new AbortController().signal,
    })

    expect(readOwned).toHaveBeenCalledWith(42, 'a'.repeat(43))
    expect(result.assets).toEqual([expect.objectContaining({ kind: 'image', assetId: 'a'.repeat(43) })])
  })

  it('surfaces cross-account adopted assets as an ownership failure', async () => {
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      assets: { readOwned: vi.fn(async () => { throw new Error('无权访问该 AI 图片资产') }) },
    })
    await expect(executors['image-input']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 1, userId: 99,
      node: {
        id: 'input', kind: 'image-input', definitionVersion: 1,
        data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) },
      },
      inputs: {}, signal: new AbortController().signal,
    })).rejects.toThrow('无权访问')
  })

  it('refuses unsupported video without dispatching paid work', async () => {
    const executors = createCanvasNodeExecutors({
      imageService: {
        generate: vi.fn(),
        cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
      },
    })
    await expect(executors.video({
      runId: 'run',
      graphRevision: 'revision',
      attemptId: 'attempt',
      ownerId: 1,
      userId: 7,
      node: { id: 'video', kind: 'video', definitionVersion: 1, data: { prompt: '', model: '' } },
      inputs: {},
      signal: new AbortController().signal,
    })).rejects.toThrow('不会提交付费请求')
  })

  it('resolves an image-input asset through the authenticated user boundary', async () => {
    const readOwned = vi.fn(async () => ({ asset: {
      assetId: 'a'.repeat(43),
      localUrl: `xingmang-asset://image/${'a'.repeat(43)}`,
      mimeType: 'image/png',
    } }))
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      assets: { readOwned },
    })
    const result = await executors['image-input']?.({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7,
      node: { id: 'input', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) } },
      inputs: {}, signal: new AbortController().signal,
    })
    expect(readOwned).toHaveBeenCalledWith(7, 'a'.repeat(43))
    expect(result?.assets?.[0]).toMatchObject({ kind: 'image', assetId: 'a'.repeat(43) })
  })
})
