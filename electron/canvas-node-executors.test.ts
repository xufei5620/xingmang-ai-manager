import { describe, expect, it, vi } from 'vitest'
import { createCanvasNodeExecutors } from './canvas-node-executors'
import { executeCanvasRun } from './canvas-run-engine'
import type { CanvasRunGraph } from './canvas-run-contract'
import type { AiRelayBillingObserver } from './ai-operation-progress'
import { dramaParseMaximumRequestCount } from '../canvas-v2/src/runtime/run-preflight'

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
