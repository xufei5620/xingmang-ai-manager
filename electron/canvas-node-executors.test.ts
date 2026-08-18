import { describe, expect, it, vi } from 'vitest'
import { createCanvasNodeExecutors } from './canvas-node-executors'
import { executeCanvasRun } from './canvas-run-engine'
import type { CanvasRunGraph } from './canvas-run-contract'

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
      expectedUserId: 7,
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

  it('delegates video generation with bounded seconds and an optional image asset', async () => {
    const generate = vi.fn(async () => ({
      assetId: 'v'.repeat(43), localUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
      mimeType: 'video/mp4' as const, fileName: 'video.mp4', taskId: 'video_123',
    }))
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      videoService: { generate, cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      videoGroup: 'grok',
    })
    const image = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }
    const result = await executors.video({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 41, userId: 7,
      node: { id: 'video', kind: 'video-generate', definitionVersion: 1, data: {
        prompt: '镜头推进', model: 'grok-imagine-video', seconds: '15', size: '720x1280',
      } },
      inputs: { text: '海岸', image }, signal: new AbortController().signal,
    })
    expect(generate).toHaveBeenCalledWith(41, {
      requestId: 'canvas-run:attempt', group: 'grok', model: 'grok-imagine-video',
      prompt: '海岸\n镜头推进', seconds: '15', width: 720, height: 1280,
      expectedUserId: 7, runId: 'run', nodeId: 'video', attemptId: 'attempt',
      graphRevision: 'revision', imageAssetId: 'a'.repeat(43),
    })
    expect(result.assets).toEqual([expect.objectContaining({
      kind: 'video', assetId: 'v'.repeat(43), taskId: 'video_123',
    })])
  })

  it.each(['image-generate', 'image-edit'] as const)(
    'passes the saved %s result into downstream image-to-video generation',
    async (producerKind) => {
      const sourceAssetId = 's'.repeat(43)
      const producedAssetId = producerKind === 'image-edit' ? 'e'.repeat(43) : 'g'.repeat(43)
      const generatedImage = {
        assetId: producedAssetId,
        localUrl: `xingmang-asset://image/${producedAssetId}`,
        mimeType: 'image/png' as const,
        fileName: 'produced.png',
      }
      const imageGenerate = vi.fn(async () => [generatedImage])
      const imageEdit = vi.fn(async () => [generatedImage])
      const videoGenerate = vi.fn(async () => ({
        assetId: 'v'.repeat(43), localUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
        mimeType: 'video/mp4' as const, fileName: 'video.mp4', taskId: 'video_chain',
      }))
      const executors = createCanvasNodeExecutors({
        imageService: {
          generate: imageGenerate,
          edit: imageEdit,
          cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
        },
        videoService: {
          generate: videoGenerate,
          cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
        },
        assets: { readOwned: vi.fn(async () => ({ asset: {
          assetId: sourceAssetId,
          localUrl: `xingmang-asset://image/${sourceAssetId}`,
          mimeType: 'image/png',
        } })) },
        imageGroup: '生图',
        videoGroup: 'grok',
      })
      const nodes: CanvasRunGraph['nodes'] = [
        ...(producerKind === 'image-edit' ? [{
          id: 'source', kind: 'image-input' as const, definitionVersion: 1,
          data: { prompt: '', model: '', adoptedAssetId: sourceAssetId },
        }] : []),
        {
          id: 'producer', kind: producerKind, definitionVersion: 1,
          data: { prompt: producerKind === 'image-edit' ? '调整光影' : '生成产品图', model: 'gpt-image-2' },
        },
        {
          id: 'video', kind: 'video-generate', definitionVersion: 1,
          data: { prompt: '镜头推进', model: 'grok-imagine-video', seconds: '5', size: '1280x720' },
        },
      ]
      const edges: CanvasRunGraph['edges'] = [
        ...(producerKind === 'image-edit' ? [{
          id: 'source-to-producer', source: 'source', sourceHandle: 'out:image',
          target: 'producer', targetHandle: 'in:image',
        }] : []),
        {
          id: 'producer-to-video', source: 'producer', sourceHandle: 'out:image',
          target: 'video', targetHandle: 'in:image',
        },
      ]
      let sequence = 0

      const record = await executeCanvasRun({
        userId: 7,
        ownerId: 41,
        projectId: 'project-1',
        runId: `run-${producerKind}`,
        graphRevision: `revision-${producerKind}`,
        graph: { nodes, edges },
        scope: { kind: 'all' },
        executors,
        signal: new AbortController().signal,
        randomUUID: () => `chain-id-${++sequence}`,
        now: () => new Date('2026-08-14T10:00:00.000Z'),
      })

      expect(record.status).toBe('succeeded')
      expect(videoGenerate).toHaveBeenCalledWith(41, expect.objectContaining({
        imageAssetId: producedAssetId,
        width: 1280,
        height: 720,
        projectId: 'project-1',
      }), expect.objectContaining({ onStage: expect.any(Function) }))
      if (producerKind === 'image-edit') {
        expect(imageEdit).toHaveBeenCalledWith(
          41,
          expect.objectContaining({ sourceAssetIds: [sourceAssetId] }),
          expect.objectContaining({ onStage: expect.any(Function) }),
        )
      } else {
        expect(imageGenerate).toHaveBeenCalledWith(
          41,
          expect.objectContaining({ projectId: 'project-1' }),
          expect.objectContaining({ onStage: expect.any(Function) }),
        )
      }
    },
  )

  it('rejects video generation without a video group before paid dispatch', async () => {
    const generate = vi.fn()
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      videoService: { generate, cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      imageGroup: '生图分组',
    })

    await expect(executors.video({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 41, userId: 7,
      node: { id: 'video', kind: 'video-generate', definitionVersion: 1, data: {
        prompt: '镜头推进', model: 'grok-imagine-video', seconds: '5',
      } },
      inputs: {}, signal: new AbortController().signal,
    })).rejects.toThrow('视频节点缺少生成分组')
    expect(generate).not.toHaveBeenCalled()
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

  it('resolves a video-input asset through the authenticated user video boundary', async () => {
    const readOwned = vi.fn(async () => ({ asset: {
      assetId: 'v'.repeat(43),
      localUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
      mimeType: 'video/mp4',
    } }))
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      assets: { readOwned },
    })
    const result = await executors['video-input']?.({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7,
      node: { id: 'input', kind: 'video-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'v'.repeat(43) } },
      inputs: {}, signal: new AbortController().signal,
    })
    expect(readOwned).toHaveBeenCalledWith(7, 'v'.repeat(43), 'video')
    expect(result?.assets?.[0]).toMatchObject({ kind: 'video', assetId: 'v'.repeat(43), mimeType: 'video/mp4' })
  })

  it.each(['router', 'gallery', 'output'] as const)('passes video assets through %s nodes', async (kind) => {
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
    })
    const video = {
      kind: 'video' as const,
      assetId: 'v'.repeat(43),
      localUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
      mimeType: 'video/mp4',
    }
    const result = await executors[kind]?.({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7,
      node: { id: kind, kind, definitionVersion: 1, data: { prompt: '', model: '' } },
      inputs: { video }, signal: new AbortController().signal,
    })
    expect(result?.assets).toEqual([video])
  })

  it('aggregates all ordered gallery inputs from the highest-priority media family', async () => {
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
    })
    const images = Array.from({ length: 6 }, (_, index) => ({
      kind: 'image' as const,
      assetId: String(index).repeat(43),
      localUrl: `xingmang-asset://image/${String(index).repeat(43)}`,
    }))
    const result = await executors.gallery?.({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7,
      node: { id: 'gallery', kind: 'gallery', definitionVersion: 1, data: { prompt: '', model: '' } },
      inputs: {
        images,
        videos: [{ kind: 'video', assetId: 'v'.repeat(43), localUrl: `xingmang-asset://video/${'v'.repeat(43)}` }],
      },
      signal: new AbortController().signal,
    })
    expect(result?.assets?.map((asset) => asset.assetId)).toEqual(images.map((asset) => asset.assetId))
  })
})
