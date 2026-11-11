import { describe, expect, it, vi } from 'vitest'
import { createCanvasNodeExecutors } from './canvas-node-executors'
import { executeCanvasRun } from './canvas-run-engine'
import type { CanvasImageTransformRecipe, CanvasRunAsset, CanvasRunGraph } from './canvas-run-contract'
import type { AiRelayBillingObserver } from './ai-operation-progress'
import { dramaParseMaximumRequestCount } from '../canvas-v2/src/runtime/run-preflight'
import {
  CanvasRunPreparationBroker, createCanvasFrameExtraction, createCanvasImageToolProcessing,
  type CanvasFrameExtraction, type CanvasImageToolProcessing,
} from './canvas-run-preparations'

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
        data: { prompt: 'local', model: 'gpt-image-2', group: '生图', size: '1024x1024', quality: 'low', imageResolution: '4K' },
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
      imageResolution: '4K',
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
        data: { prompt: '夜景', model: 'gpt-image-2', group: '生图', size: '1024x1024', quality: 'low', imageResolution: '2K' },
      },
      inputs: { text: '保持主体', image: sourceA, images: [sourceA, sourceB, sourceA] },
      signal: new AbortController().signal,
    })

    expect(edit).toHaveBeenCalledWith(9, {
      requestId: 'canvas-run:edit-attempt', group: '生图', model: 'gpt-image-2',
      prompt: '保持主体\n夜景', sourceAssetIds: ['a'.repeat(43), 'b'.repeat(43)], expectedUserId: 42,
      size: '1024x1024', quality: 'low', imageResolution: '2K',
    })
    expect(result.assets?.[0]).toMatchObject({ assetId: 'c'.repeat(43) })
  })

  it('routes image-generate to edit when reference images are connected', async () => {
    const generate = vi.fn()
    const edit = vi.fn(async () => [{
      assetId: 'e'.repeat(43), localUrl: `xingmang-asset://image/${'e'.repeat(43)}`,
      mimeType: 'image/png' as const, fileName: 'edited.png',
    }])
    const executors = createCanvasNodeExecutors({
      imageService: {
        generate, edit,
        cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
      },
    })
    const source = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }
    await executors['image-generate']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'generate-edit', ownerId: 9, userId: 42,
      node: {
        id: 'image', kind: 'image-generate', definitionVersion: 1,
        data: { prompt: '改成夜景', model: 'gpt-image-2', group: '生图' },
      },
      inputs: { images: [source] },
      signal: new AbortController().signal,
    })
    expect(generate).not.toHaveBeenCalled()
    expect(edit).toHaveBeenCalledWith(9, expect.objectContaining({
      model: 'gpt-image-2', sourceAssetIds: ['a'.repeat(43)],
    }))
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

  it('sends a masked edit with its one bound source and a mask PNG at the source size', async () => {
    const edit = vi.fn(async () => [{
      assetId: 'c'.repeat(43), localUrl: `xingmang-asset://image/${'c'.repeat(43)}`,
      mimeType: 'image/png' as const, fileName: 'edited.png',
    }])
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), edit, cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
    })
    const source = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, width: 64, height: 48 }
    const imageEditMask = { version: 1 as const, sourceAssetId: source.assetId, width: 64, height: 48, strokes: [{ tool: 'brush' as const, size: 0.2, points: [{ x: 0.5, y: 0.5 }] }] }
    await executors['image-edit']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'mask-attempt', ownerId: 9, userId: 42,
      node: { id: 'edit', kind: 'image-edit', definitionVersion: 1, data: { prompt: '换成红色', model: 'gpt-image-2', imageEditMask } },
      inputs: { image: source },
      signal: new AbortController().signal,
    })
    expect(edit).toHaveBeenCalledWith(9, expect.objectContaining({
      requestId: 'canvas-run:mask-attempt', sourceAssetIds: [source.assetId],
      mask: { width: 64, height: 48, png: expect.any(Function) },
    }))
    const input = (edit.mock.calls[0] as unknown as [number, { mask: { png(signal: AbortSignal): Promise<Uint8Array> } }])[1]
    const png = Buffer.from(await input.mask.png(new AbortController().signal))
    expect(png.toString('ascii', 12, 16)).toBe('IHDR')
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([64, 48, 8, 6])
  })

  it('refuses a mask that does not fit its source before paid dispatch', async () => {
    const edit = vi.fn()
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), edit, cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
    })
    const source = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, width: 64, height: 48 }
    const other = { ...source, assetId: 'b'.repeat(43) }
    const imageEditMask = { version: 1 as const, sourceAssetId: source.assetId, width: 64, height: 48, strokes: [{ tool: 'brush' as const, size: 0.2, points: [{ x: 0.5, y: 0.5 }] }] }
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['gpt-image-2.5-flare', { image: source }, '当前模型尚未接通蒙版局部修改'],
      ['gpt-image-2', { image: other }, '局部修改需要唯一且与蒙版绑定一致的原图'],
      ['gpt-image-2', { images: [source, other] }, '局部修改需要唯一且与蒙版绑定一致的原图'],
      ['gpt-image-2', { image: { ...source, width: 128 } }, '原图像素尺寸与蒙版不一致'],
    ]
    for (const [model, inputs, message] of cases) {
      await expect(executors['image-edit']!({
        runId: 'run', graphRevision: 'revision', attemptId: 'mask-attempt', ownerId: 9, userId: 42,
        node: { id: 'edit', kind: 'image-edit', definitionVersion: 1, data: { prompt: '换成红色', model, imageEditMask } },
        inputs, signal: new AbortController().signal,
      }), model).rejects.toThrow(message)
    }
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

  it('passes all owned MiniMax media references and explicit H3 settings', async () => {
    const generate = vi.fn(async () => ({
      assetId: 'z'.repeat(43), localUrl: `xingmang-asset://video/${'z'.repeat(43)}`,
      mimeType: 'video/mp4' as const, fileName: 'video.mp4', taskId: 'minimax_task',
    }))
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      videoService: { generate, cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      videoGroup: 'video',
    })
    const images = ['a', 'b'].map((prefix) => ({
      kind: 'image' as const,
      assetId: prefix.repeat(43),
      localUrl: `xingmang-asset://image/${prefix.repeat(43)}`,
    }))
    const videos = [{
      kind: 'video' as const,
      assetId: 'v'.repeat(43),
      localUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
    }]
    const audios = [{
      kind: 'audio' as const,
      assetId: 'm'.repeat(43),
      localUrl: `xingmang-asset://audio/${'m'.repeat(43)}`,
    }]

    await executors.video({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 41, userId: 7,
      node: { id: 'video', kind: 'video-generate', definitionVersion: 1, data: {
        prompt: '保留人物和声音', model: 'minimax-h3-base', seconds: '10',
        videoMode: 'ref2va', videoResolution: '720p', videoAspectRatio: '9:16', promptOptimization: true,
      } },
      inputs: { images, videos, audios }, signal: new AbortController().signal,
    })

    expect(generate).toHaveBeenCalledWith(41, expect.objectContaining({
      model: 'minimax-h3-base', mode: 'ref2va', resolution: '720p', aspectRatio: '9:16',
      promptOptimization: true,
      imageAssetIds: ['a'.repeat(43), 'b'.repeat(43)],
      videoAssetIds: ['v'.repeat(43)],
      audioAssetIds: ['m'.repeat(43)],
    }))
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

  it('refuses to dispatch image, image-edit or video when the run was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped before dispatch'))
    const generate = vi.fn(async () => [])
    const edit = vi.fn(async () => [])
    const generateVideo = vi.fn()
    const executors = createCanvasNodeExecutors({
      imageService: { generate, edit, cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      videoService: { generate: generateVideo, cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      videoGroup: 'grok',
    })
    const source = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }
    const base = { runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 41, userId: 7, signal: controller.signal }

    await expect(executors.image({
      ...base,
      node: { id: 'image', kind: 'image', definitionVersion: 1, data: { prompt: 'p', model: 'gpt-image-2' } },
      inputs: {},
    })).rejects.toThrow('stopped before dispatch')
    await expect(executors['image-edit']!({
      ...base,
      node: { id: 'edit', kind: 'image-edit', definitionVersion: 1, data: { prompt: 'p', model: 'gpt-image-2' } },
      inputs: { image: source },
    })).rejects.toThrow('stopped before dispatch')
    await expect(executors.video({
      ...base,
      node: { id: 'video', kind: 'video-generate', definitionVersion: 1, data: { prompt: 'p', model: 'grok-imagine-video' } },
      inputs: {},
    })).rejects.toThrow('stopped before dispatch')

    expect(generate).not.toHaveBeenCalled()
    expect(edit).not.toHaveBeenCalled()
    expect(generateVideo).not.toHaveBeenCalled()
  })

  it('sends a text node\'s upstream text and prompt as one user message, with its pictures, and keeps the answer', async () => {
    const completeOnce = vi.fn().mockResolvedValue('一只坐在窗台上的橘猫，午后阳光')
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      completeText: { completeOnce },
    })
    const picture = { kind: 'image' as const, assetId: 'p'.repeat(43), localUrl: 'xingmang-asset://p', mimeType: 'image/png' }
    const billing = { onRelayDispatch: vi.fn(), onRelayAnswer: vi.fn() }
    const result = await executors['text-generate']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7, projectId: 'project-1',
      node: { id: 'write', kind: 'text-generate', definitionVersion: 1, data: { prompt: '写成生图提示词', model: 'gpt-5.5', group: 'GPT' } },
      inputs: { text: '一只猫', image: picture, images: [picture, picture] },
      signal: new AbortController().signal,
      billing,
    })
    expect(result).toEqual({ outputText: '一只坐在窗台上的橘猫，午后阳光', group: 'GPT', model: 'gpt-5.5' })
    expect(completeOnce).toHaveBeenCalledOnce()
    const request = completeOnce.mock.calls[0][0]
    expect(request).toMatchObject({ group: 'GPT', model: 'gpt-5.5', user: '一只猫\n写成生图提示词', images: { assetIds: [picture.assetId, picture.assetId], projectId: 'project-1' }, billing })
    expect(request.system).toBeUndefined()
  })

  it('refuses a text node before any paid request when it has nothing to say, a picture its model cannot read, or too many pictures', async () => {
    const completeOnce = vi.fn().mockResolvedValue('好')
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      completeText: { completeOnce },
    })
    const picture = { kind: 'image' as const, assetId: 'p'.repeat(43), localUrl: 'xingmang-asset://p', mimeType: 'image/png' }
    function run(data: { prompt: string; model: string; group?: string }, inputs: Record<string, unknown> = {}) {
      return executors['text-generate']!({
        runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7,
        node: { id: 'write', kind: 'text-generate', definitionVersion: 1, data: { group: 'GPT', ...data } },
        inputs,
        signal: new AbortController().signal,
      })
    }
    await expect(run({ prompt: '  ', model: 'gpt-5.5' }, { text: ' ' })).rejects.toThrow('请输入文字提示词或连接上游提示词节点')
    await expect(run({ prompt: '描述', model: '' })).rejects.toThrow('请选择文字模型')
    await expect(run({ prompt: '描述', model: 'gemini-3.7-flash' }, { image: picture, images: [picture] }))
      .rejects.toThrow('当前模型尚未确认支持图片理解，请选择已支持的视觉文字模型或移除图片；不会忽略图片后继续生成')
    await expect(run({ prompt: '描述', model: 'gpt-5.5' }, { image: picture, images: Array.from({ length: 5 }, () => picture) }))
      .rejects.toThrow('文字视觉输入最多支持 4 张图片，请减少图片或改用单图输出')
    expect(completeOnce).not.toHaveBeenCalled()
    // Text alone needs no picture-reading model.
    await expect(run({ prompt: '扩写', model: 'gemini-3.7-flash' })).resolves.toMatchObject({ outputText: '好' })
  })

  it('does not keep a text answer longer than a canvas project can hold', async () => {
    const completeOnce = vi.fn().mockResolvedValue('字'.repeat(32_001))
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      completeText: { completeOnce },
    })
    await expect(executors['text-generate']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7,
      node: { id: 'write', kind: 'text-generate', definitionVersion: 1, data: { prompt: '写长文', model: 'gpt-5.5', group: 'GPT' } },
      inputs: {},
      signal: new AbortController().signal,
    })).rejects.toThrow('文字结果超过 32000 字上限，请调整生成长度后再运行')
  })

  it('parses drama tables through injected chat completion and retries once', async () => {
    const { danyinTwoShotFixture } = await import('./drama-parse')
    const completeOnce = vi.fn()
      .mockResolvedValueOnce('这不是表格')
      .mockResolvedValueOnce(JSON.stringify(danyinTwoShotFixture))
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      completeText: { completeOnce },
    })
    const result = await executors['drama-parse']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7,
      node: { id: 'parse', kind: 'drama-parse', definitionVersion: 1, data: { prompt: '', model: 'gemini-3.7-flash', group: 'Gemini' } },
      inputs: { text: '虞晚斜倚锦榻' },
      signal: new AbortController().signal,
    })
    expect(completeOnce).toHaveBeenCalledTimes(2)
    expect(JSON.parse(result.outputText ?? '').shots[0].shotId).toBe('s01')
  })

  it('does not send a second paid drama parse request when the first request itself failed', async () => {
    const completeOnce = vi.fn().mockRejectedValue(new Error('无法连接 AI 服务，请检查网络后重试'))
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      completeText: { completeOnce },
    })
    await expect(executors['drama-parse']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7,
      node: { id: 'parse', kind: 'drama-parse', definitionVersion: 1, data: { prompt: '', model: 'gemini-3.7-flash', group: 'Gemini' } },
      inputs: { text: '虞晚斜倚锦榻' },
      signal: new AbortController().signal,
    })).rejects.toThrow('剧本解析失败：无法连接 AI 服务，请检查网络后重试')
    expect(completeOnce).toHaveBeenCalledOnce()
  })

  // The canvas run confirmation tells the user how many paid requests a drama
  // parse may cost; asking more often here would make that number a lie.
  it('never asks a drama parse more often than the synced canvas tells the user it may be billed', async () => {
    const completeOnce = vi.fn().mockResolvedValue('这不是表格')
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      completeText: { completeOnce },
    })
    await expect(executors['drama-parse']!({
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7,
      node: { id: 'parse', kind: 'drama-parse', definitionVersion: 1, data: { prompt: '', model: 'gemini-3.7-flash', group: 'Gemini' } },
      inputs: { text: '虞晚斜倚锦榻' },
      signal: new AbortController().signal,
    })).rejects.toThrow('剧本解析没有返回有效 JSON')
    expect(completeOnce).toHaveBeenCalledTimes(dramaParseMaximumRequestCount)
  })
})

describe('canvas node executors relay billing', () => {
  const imageAsset = { assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, mimeType: 'image/png' as const, fileName: 'image.png' }
  function context(kind: 'image' | 'video' | 'drama-parse', billing?: AiRelayBillingObserver) {
    return {
      runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7,
      node: { id: kind, kind, definitionVersion: 1, data: kind === 'video'
        ? { prompt: '海浪', model: 'grok-imagine-video', group: '视频模型' }
        : kind === 'image' ? { prompt: '一只猫', model: 'gpt-image-2', group: '图片模型' } : { prompt: '', model: 'gemini-3.7-flash', group: 'Gemini' } },
      inputs: kind === 'drama-parse' ? { text: '虞晚斜倚锦榻' } : {},
      signal: new AbortController().signal,
      ...(billing ? { billing } : {}),
    }
  }

  it('hands the attempt billing to the image and video requests and forwards what they report', async () => {
    const generate = vi.fn(async (_senderId: number, _input: unknown, progress?: { onRelayDispatch?(sent: boolean): void; onRelayAnswer?(id: string | null): void }) => {
      progress?.onRelayDispatch?.(true)
      progress?.onRelayAnswer?.('req-image')
      return [imageAsset]
    })
    const generateVideo = vi.fn(async (_senderId: number, _input: unknown, progress?: { onRelayAnswer?(id: string | null): void }) => {
      progress?.onRelayAnswer?.('req-video')
      return { assetId: 'v'.repeat(43), localUrl: `xingmang-asset://video/${'v'.repeat(43)}`, mimeType: 'video/mp4', taskId: 'task' }
    })
    const cancel = vi.fn(() => ({ canceled: false, mayStillComplete: false }))
    const executors = createCanvasNodeExecutors({ imageService: { generate, cancel }, videoService: { generate: generateVideo as never, cancel } })
    const billing = { onRelayDispatch: vi.fn<(sent: boolean) => void>(), onRelayAnswer: vi.fn<(id: string | null) => void>() }
    await executors.image(context('image', billing))
    await executors.video(context('video', billing))
    expect(billing.onRelayDispatch).toHaveBeenCalledWith(true)
    expect(billing.onRelayAnswer.mock.calls).toEqual([['req-image'], ['req-video']])
    // No billing and no stage reporting: the request goes out with no observer, as before.
    await executors.image(context('image'))
    expect(generate.mock.calls.at(-1)).toHaveLength(2)
  })

  it('hands the attempt billing to each drama parse request', async () => {
    const { danyinTwoShotFixture } = await import('./drama-parse')
    const completeOnce = vi.fn().mockResolvedValueOnce('这不是表格').mockResolvedValueOnce(JSON.stringify(danyinTwoShotFixture))
    const executors = createCanvasNodeExecutors({
      imageService: { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      completeText: { completeOnce },
    })
    const billing = { onRelayDispatch: vi.fn<(sent: boolean) => void>(), onRelayAnswer: vi.fn<(id: string | null) => void>() }
    await executors['drama-parse']!(context('drama-parse', billing))
    expect(completeOnce).toHaveBeenCalledTimes(2)
    expect(completeOnce.mock.calls.every((call) => call[0].billing === billing)).toBe(true)
  })
})

// 画布完善第 7 条第二步: the main process does not decode video; it asks the page for the frame.
describe('canvas frame-extract executor', () => {
  const videoAsset = { kind: 'video' as const, assetId: 'V'.repeat(43), localUrl: `xingmang-asset://video/${'V'.repeat(43)}`, mimeType: 'video/mp4' }
  const frameAsset = { kind: 'image' as const, assetId: 'F'.repeat(43), localUrl: `xingmang-asset://image/${'F'.repeat(43)}`, mimeType: 'image/png', width: 8, height: 8 }
  const imageService = { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) }
  const frameNode = { id: 'frame', kind: 'frame-extract' as const, definitionVersion: 1, data: { prompt: '', model: '', frameTimestampSeconds: 2.5 } }
  const base = { runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7, projectId: '11111111-1111-4111-8111-111111111111' }

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

  it('stays refused without a frame extractor, without a video, or for a video the page cannot decode', async () => {
    const report = vi.fn(async () => undefined)
    const refused = createCanvasNodeExecutors({ imageService })['frame-extract']!
    await expect(refused({ ...base, node: frameNode, inputs: { video: videoAsset }, signal: new AbortController().signal, reportFramePreparation: report }))
      .rejects.toThrow('当前不会提交付费请求')

    const frames: CanvasFrameExtraction = {
      assertDecodableVideo: vi.fn(async () => { throw new Error('视频超过 32 MB，画布抽不了这一帧') }),
      waitForFrame: vi.fn(async () => frameAsset),
    }
    const executor = createCanvasNodeExecutors({ imageService, frames })['frame-extract']!
    await expect(executor({ ...base, node: frameNode, inputs: { video: videoAsset }, signal: new AbortController().signal }))
      .rejects.toThrow('「视频抽帧」节点桌面版暂不支持')
    await expect(executor({ ...base, node: frameNode, inputs: {}, signal: new AbortController().signal, reportFramePreparation: report }))
      .rejects.toThrow('请先给视频抽帧节点连接一段视频')
    await expect(executor({ ...base, node: frameNode, inputs: { video: videoAsset }, signal: new AbortController().signal, reportFramePreparation: report }))
      .rejects.toThrow('视频超过 32 MB，画布抽不了这一帧')
    expect(frames.assertDecodableVideo).toHaveBeenCalledWith(7, videoAsset.assetId)
    expect(frames.waitForFrame).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
    expect(imageService.generate).not.toHaveBeenCalled()
  })

  it('waits for the frame before telling the page, and clears the request whether or not it came back', async () => {
    const order: string[] = []
    let answer!: (asset: CanvasRunAsset) => void
    let refuse!: (error: Error) => void
    const frames: CanvasFrameExtraction = {
      assertDecodableVideo: vi.fn(async () => undefined),
      waitForFrame: vi.fn(() => {
        order.push('wait')
        return new Promise<CanvasRunAsset>((resolve, reject) => { answer = resolve; refuse = reject })
      }),
    }
    const report = vi.fn(async (_preparation: unknown, waiting: boolean) => { order.push(waiting ? 'ask' : 'clear') })
    const executor = createCanvasNodeExecutors({ imageService, frames })['frame-extract']!
    const preparation = { operationId: 'attempt', nodeId: 'frame', attemptId: 'attempt', sourceAssetId: videoAsset.assetId, timestampSeconds: 2.5 }

    const running = executor({ ...base, node: frameNode, inputs: { video: videoAsset }, signal: new AbortController().signal, reportFramePreparation: report })
    await vi.waitFor(() => expect(order).toEqual(['wait', 'ask']))
    expect(frames.waitForFrame).toHaveBeenCalledWith({ runId: 'run', userId: 7, projectId: base.projectId, preparation, signal: expect.any(AbortSignal) })
    answer(frameAsset)
    await expect(running).resolves.toEqual({ assets: [frameAsset] })
    expect(order).toEqual(['wait', 'ask', 'clear'])
    expect(report.mock.calls).toEqual([[preparation, true], [preparation, false]])

    const failing = executor({ ...base, node: { ...frameNode, data: { prompt: '', model: '' } }, inputs: { video: videoAsset }, signal: new AbortController().signal, reportFramePreparation: report })
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(3))
    expect(report.mock.calls[2]).toEqual([{ ...preparation, timestampSeconds: 0 }, true])
    refuse(new Error('视频帧没有抽出来：视频读不出来，或者时间点不在视频里'))
    await expect(failing).rejects.toThrow('视频帧没有抽出来')
    expect(report.mock.calls[3]).toEqual([{ ...preparation, timestampSeconds: 0 }, false])
  })

  it('runs a video into a frame node end to end with the frame the page hands back, without a paid request', async () => {
    const broker = new CanvasRunPreparationBroker()
    const storeLocalBytes = vi.fn(async () => ({ assetId: frameAsset.assetId, localUrl: frameAsset.localUrl, mimeType: 'image/png' as const, width: 8, height: 8, fileName: 'frame.png' }))
    const setSource = vi.fn(async () => undefined)
    const frames = createCanvasFrameExtraction({
      broker,
      assets: {
        readOwnedVideoRange: vi.fn(async () => ({ totalBytes: 1024 })),
        forProject: vi.fn(async () => ({ images: { storeLocalBytes }, media: { setSource } })),
      },
    })
    const readOwned = vi.fn(async () => ({ asset: videoAsset }))
    const generateVideo = vi.fn()
    const executors = createCanvasNodeExecutors({
      imageService,
      videoService: { generate: generateVideo, cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) },
      videoGroup: 'grok',
      assets: { readOwned },
      frames,
    })
    const graph: CanvasRunGraph = {
      nodes: [
        { id: 'clip', kind: 'video-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: videoAsset.assetId } },
        frameNode,
      ],
      edges: [{ id: 'e', source: 'clip', sourceHandle: 'out:video', target: 'frame', targetHandle: 'in:video' }],
    }
    const asked: unknown[] = []
    const record = await executeCanvasRun({
      userId: 7, ownerId: 9, projectId: base.projectId, runId: 'run-frame', graphRevision: 'revision', graph, scope: { kind: 'all' },
      executors, signal: new AbortController().signal,
      onEvent: async (event) => {
        if (event.type !== 'run-waiting' || !event.framePreparations.length) return
        asked.push(...event.framePreparations)
        const [preparation] = event.framePreparations
        await broker.complete(7, { runId: 'run-frame', operationId: preparation.operationId, kind: 'frame', outcome: 'completed', png: png(8, 8) })
      },
    })
    expect(record.status).toBe('succeeded')
    expect(asked).toEqual([expect.objectContaining({ nodeId: 'frame', sourceAssetId: videoAsset.assetId, timestampSeconds: 2.5 })])
    expect(record.nodes.find((entry) => entry.nodeId === 'frame')?.state).toBe('succeeded')
    expect(storeLocalBytes).toHaveBeenCalledTimes(1)
    expect(setSource).toHaveBeenCalledWith(7, frameAsset.assetId, 'imported')
    expect(generateVideo).not.toHaveBeenCalled()
    expect(broker.size()).toBe(0)
    expect(record).not.toHaveProperty('framePreparations')
  })
})

// 画布完善第 7 条第三步: the main process does not make the pictures of an image tool; the page does.
describe('canvas image-tool executors', () => {
  const imageService = { generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })) }
  const projectId = '11111111-1111-4111-8111-111111111111'
  const base = { runId: 'run', graphRevision: 'revision', attemptId: 'attempt', ownerId: 9, userId: 7, projectId }
  function picture(letter: string): CanvasRunAsset {
    return { kind: 'image', assetId: letter.repeat(43), localUrl: `xingmang-asset://image/${letter.repeat(43)}`, mimeType: 'image/png', width: 8, height: 8 }
  }
  function sources(...letters: string[]) {
    return letters.map((letter) => ({ edgeId: `edge-${letter}`, outputIndex: 0, asset: picture(letter) }))
  }
  function toolNode(kind: 'image-crop' | 'image-collage' | 'image-tile' | 'image-layer', imageTransform: CanvasImageTransformRecipe, extra: Record<string, unknown> = {}) {
    return { id: kind, kind, definitionVersion: 1, data: { prompt: '', model: '', imageTransform: { outputWidth: 64, outputHeight: 32, ...imageTransform }, ...extra } } as CanvasRunGraph['nodes'][number]
  }
  function inputs(...letters: string[]) {
    const list = sources(...letters)
    return list.length ? { image: list[0].asset, images: list.map((entry) => entry.asset), imageSources: list } : {}
  }
  function processing(): CanvasImageToolProcessing & { answer(assets: CanvasRunAsset[]): void } {
    let answer: (assets: CanvasRunAsset[]) => void = () => {}
    return {
      assertSources: vi.fn(async () => undefined),
      waitForImages: vi.fn(() => new Promise<CanvasRunAsset[]>((resolve) => { answer = resolve })),
      answer: (assets) => answer(assets),
    }
  }

  it('is left out without image-tool processing, so the engine refuses those nodes by name', () => {
    const executors = createCanvasNodeExecutors({ imageService })
    for (const kind of ['image-crop', 'image-collage', 'image-tile', 'image-layer', 'image-compare', 'image-panorama'] as const) {
      expect(executors[kind]).toBeUndefined()
    }
  })

  it('asks the page for the pictures of a crop, after checking its one source, and clears the request either way', async () => {
    const tools = processing()
    const report = vi.fn(async () => undefined)
    const executor = createCanvasNodeExecutors({ imageService, imageTools: tools })['image-crop']!
    const node = toolNode('image-crop', { kind: 'crop' })
    await expect(executor({ ...base, node, inputs: inputs('A'), signal: new AbortController().signal })).rejects.toThrow('「裁剪图片」节点桌面版暂不支持')
    await expect(executor({ ...base, projectId: undefined, node, inputs: inputs('A'), signal: new AbortController().signal, reportImagePreparation: report })).rejects.toThrow('画布项目尚未选择')
    await expect(executor({ ...base, node, inputs: inputs('A', 'B'), signal: new AbortController().signal, reportImagePreparation: report })).rejects.toThrow('裁剪只能使用一个图片来源')
    await expect(executor({ ...base, node, inputs: {}, signal: new AbortController().signal, reportImagePreparation: report })).rejects.toThrow('裁剪只能使用一个图片来源')
    await expect(executor({ ...base, node: { ...node, data: { prompt: '', model: '' } }, inputs: inputs('A'), signal: new AbortController().signal, reportImagePreparation: report })).rejects.toThrow('请先设置图像工具参数')
    expect(report).not.toHaveBeenCalled()

    const running = executor({ ...base, node, inputs: inputs('A'), signal: new AbortController().signal, reportImagePreparation: report })
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    const preparation = {
      operationId: 'attempt', attemptId: 'attempt', runId: 'run', projectId, nodeId: 'image-crop',
      sourceAssetIds: ['A'.repeat(43)], recipe: { kind: 'crop', outputWidth: 64, outputHeight: 32 }, processorRevision: 'browser-image-v1',
    }
    expect(tools.assertSources).toHaveBeenCalledWith(7, projectId, ['A'.repeat(43)])
    expect(tools.waitForImages).toHaveBeenCalledWith({ runId: 'run', userId: 7, projectId, preparation, expectation: { count: 1, size: { width: 64, height: 32 } }, signal: expect.any(AbortSignal) })
    tools.answer([picture('C')])
    await expect(running).resolves.toEqual({ assets: [picture('C')] })
    expect(report.mock.calls).toEqual([[preparation, true], [preparation, false]])
    expect(imageService.generate).not.toHaveBeenCalled()
  })

  it('asks the page for one slice per grid cell of a grid split, after checking its one source', async () => {
    const tools = processing()
    const report = vi.fn(async () => undefined)
    const executor = createCanvasNodeExecutors({ imageService, imageTools: tools })['image-grid-split']!
    const node = { id: 'grid', kind: 'image-grid-split', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: { kind: 'grid-split', rows: 2, columns: 3 } } } as CanvasRunGraph['nodes'][number]
    await expect(executor({ ...base, node, inputs: inputs('A', 'B'), signal: new AbortController().signal, reportImagePreparation: report })).rejects.toThrow('宫格裁剪只能使用一个图片来源')
    await expect(executor({ ...base, node, inputs: {}, signal: new AbortController().signal, reportImagePreparation: report })).rejects.toThrow('宫格裁剪只能使用一个图片来源')
    expect(report).not.toHaveBeenCalled()

    const running = executor({ ...base, node, inputs: inputs('A'), signal: new AbortController().signal, reportImagePreparation: report })
    await vi.waitFor(() => expect(tools.waitForImages).toHaveBeenCalledTimes(1))
    // Six slices, and no size: the slices are as big as the cells of the picture they came from.
    expect(vi.mocked(tools.waitForImages).mock.calls[0][0]).toMatchObject({ preparation: { nodeId: 'grid', sourceAssetIds: ['A'.repeat(43)], recipe: { kind: 'grid-split', rows: 2, columns: 3 } }, expectation: { count: 6 } })
    expect(vi.mocked(tools.waitForImages).mock.calls[0][0].expectation).not.toHaveProperty('size')
    const slices = ['C', 'D', 'E', 'F', 'G', 'H'].map(picture)
    tools.answer(slices)
    await expect(running).resolves.toEqual({ assets: slices })
    expect(report).toHaveBeenCalledTimes(2)
    expect(imageService.generate).not.toHaveBeenCalled()
  })

  it('orders a collage the way the user arranged it, picks the chosen tile, and marks layer groups', async () => {
    const tools = processing()
    const report = vi.fn(async () => undefined)
    const executors = createCanvasNodeExecutors({ imageService, imageTools: tools })
    const order = { version: 1, slots: [{ edgeId: 'edge-C', outputIndex: 0 }, { edgeId: 'edge-A', outputIndex: 0 }] }
    void executors['image-collage']!({ ...base, node: toolNode('image-collage', { kind: 'collage', layout: 'horizontal', autoSize: true }, { imageCollageInputOrder: order }), inputs: inputs('A', 'B', 'C'), signal: new AbortController().signal, reportImagePreparation: report })
    await vi.waitFor(() => expect(tools.waitForImages).toHaveBeenCalledTimes(1))
    expect(vi.mocked(tools.waitForImages).mock.calls[0][0]).toMatchObject({ preparation: { sourceAssetIds: ['C'.repeat(43), 'A'.repeat(43), 'B'.repeat(43)] }, expectation: { count: 1 } })
    expect(vi.mocked(tools.waitForImages).mock.calls[0][0].expectation).not.toHaveProperty('size')

    void executors['image-tile']!({ ...base, node: toolNode('image-tile', { kind: 'tile' }, { tileInput: { edgeId: 'edge-B', outputIndex: 0 } }), inputs: inputs('A', 'B'), signal: new AbortController().signal, reportImagePreparation: report })
    await vi.waitFor(() => expect(tools.waitForImages).toHaveBeenCalledTimes(2))
    expect(vi.mocked(tools.waitForImages).mock.calls[1][0].preparation.sourceAssetIds).toEqual(['B'.repeat(43)])
    await expect(executors['image-tile']!({ ...base, node: toolNode('image-tile', { kind: 'tile' }, { tileInput: { edgeId: 'edge-Z', outputIndex: 0 } }), inputs: inputs('A'), signal: new AbortController().signal, reportImagePreparation: report }))
      .rejects.toThrow('已选平铺贴图的连线已移除')
    await expect(executors['image-tile']!({ ...base, node: toolNode('image-tile', { kind: 'tile' }, { tileInput: { missing: true } }), inputs: inputs('A'), signal: new AbortController().signal, reportImagePreparation: report }))
      .rejects.toThrow('已选平铺贴图已移除')

    // A layer of only text and shapes needs no picture; groups need layerGroupsVersion.
    void executors['image-layer']!({ ...base, node: toolNode('image-layer', { kind: 'layer', layers: [{ content: { kind: 'text' } }], layerGroups: { version: 1, groups: [] } }), inputs: {}, signal: new AbortController().signal, reportImagePreparation: report })
    await vi.waitFor(() => expect(tools.waitForImages).toHaveBeenCalledTimes(3))
    expect(vi.mocked(tools.waitForImages).mock.calls[2][0].preparation).toMatchObject({ sourceAssetIds: [], layerGroupsVersion: 1 })

    vi.mocked(tools.assertSources).mockRejectedValueOnce(new Error('图片处理的来源图片超过 20 MB，请换一张小一点的图'))
    await expect(executors['image-crop']!({ ...base, node: toolNode('image-crop', { kind: 'crop' }), inputs: inputs('A'), signal: new AbortController().signal, reportImagePreparation: report }))
      .rejects.toThrow('图片处理的来源图片超过 20 MB')
    expect(tools.waitForImages).toHaveBeenCalledTimes(3)
  })

  it('passes the pictures of a compare or panorama node on as they are', async () => {
    const executors = createCanvasNodeExecutors({ imageService, imageTools: processing() })
    for (const kind of ['image-compare', 'image-panorama'] as const) {
      const node = { id: kind, kind, definitionVersion: 1, data: { prompt: '', model: '' } }
      await expect(executors[kind]!({ ...base, node, inputs: inputs('A', 'B'), signal: new AbortController().signal })).resolves.toEqual({ assets: [picture('A'), picture('B')] })
      await expect(executors[kind]!({ ...base, node, inputs: {}, signal: new AbortController().signal })).rejects.toThrow('请连接可读取的图片来源')
    }
  })

  it('runs a picture through a crop end to end with the PNG the page hands back, without a paid request', async () => {
    const broker = new CanvasRunPreparationBroker()
    const stored = picture('S')
    const storeLocalBytes = vi.fn(async () => ({ assetId: stored.assetId, localUrl: stored.localUrl, mimeType: 'image/png' as const, width: 64, height: 32, fileName: 'crop.png' }))
    const tools = createCanvasImageToolProcessing({
      broker,
      assets: {
        readImageOwned: vi.fn(async () => ({ bytes: Buffer.alloc(1024) })),
        forProject: vi.fn(async () => ({ images: { storeLocalBytes }, media: { setSource: vi.fn(async () => undefined) } })),
      },
    })
    const source = picture('A')
    const executors = createCanvasNodeExecutors({ imageService, assets: { readOwned: vi.fn(async () => ({ asset: source })) }, imageTools: tools })
    const header = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
    header.writeUInt32BE(13, 8)
    header.write('IHDR', 12, 'ascii')
    header.writeUInt32BE(64, 16)
    header.writeUInt32BE(32, 20)
    header[24] = 8
    header[25] = 6
    const graph: CanvasRunGraph = {
      nodes: [
        { id: 'photo', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: source.assetId } },
        toolNode('image-crop', { kind: 'crop' }),
      ],
      edges: [{ id: 'e', source: 'photo', sourceHandle: 'out:image', target: 'image-crop', targetHandle: 'in:image' }],
    }
    const asked: string[][] = []
    const record = await executeCanvasRun({
      userId: 7, ownerId: 9, projectId, runId: 'run-crop', graphRevision: 'revision', graph, scope: { kind: 'all' },
      executors, signal: new AbortController().signal,
      onEvent: async (event) => {
        if (event.type !== 'run-waiting' || !event.imagePreparations?.length) return
        const [preparation] = event.imagePreparations
        asked.push(preparation.sourceAssetIds)
        await broker.complete(7, { runId: 'run-crop', operationId: preparation.operationId, kind: 'image', outcome: 'completed', pngs: [Buffer.concat([header, Buffer.alloc(16)])] })
      },
    })
    expect(record.status).toBe('succeeded')
    expect(asked).toEqual([[source.assetId]])
    expect(record.nodes.find((entry) => entry.nodeId === 'image-crop')?.attempts.at(-1)?.candidates.map((candidate) => candidate.asset.assetId)).toEqual([stored.assetId])
    expect(imageService.generate).not.toHaveBeenCalled()
    expect(broker.size()).toBe(0)
  })
})
