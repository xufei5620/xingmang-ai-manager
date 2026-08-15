import { describe, expect, it, vi } from 'vitest'
import type { WorkflowNode } from '../model'
import type { HostExecutorOptions } from './executors'
import { createHostExecutors } from './executors'

function workflowNode(kind: WorkflowNode['kind'], data: Partial<WorkflowNode['data']>): WorkflowNode {
  return {
    id: `node-${kind}`,
    kind,
    position: { x: 0, y: 0 },
    data: { prompt: '', model: '', status: 'idle', ...data },
  }
}

function hostMocks() {
  return {
    generateImage: vi.fn(async () => [{
      assetId: 'a'.repeat(43),
      localUrl: `xingmang-asset://image/${'a'.repeat(43)}`,
      mimeType: 'image/png' as const,
      fileName: 'image.png',
    }]),
    editImage: vi.fn(async () => []),
    generateVideo: vi.fn(async () => ({
      assetId: 'v'.repeat(43),
      localUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
      mimeType: 'video/mp4' as const,
      fileName: 'video.mp4',
      taskId: 'video-task-1',
    })),
    cancelRequest: vi.fn(async () => ({ canceled: true, mayStillComplete: true })),
  } satisfies HostExecutorOptions['host']
}

describe('canvas host executors', () => {
  it('runs image generation without requiring a video group and omits unsupported options', async () => {
    const host = hostMocks()
    const executors = createHostExecutors({ imageGroup: '生图分组', videoGroup: '', host })
    await executors['image-generate'](
      workflowNode('image-generate', { model: 'grok-imagine-image', prompt: '测试图片' }),
      {},
      new AbortController().signal,
    )

    expect(host.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      group: '生图分组',
      model: 'grok-imagine-image',
      prompt: '测试图片',
      size: undefined,
      quality: undefined,
    }))
  })

  it('passes video duration as a strict integer string and owned image id', async () => {
    const host = hostMocks()
    const executors = createHostExecutors({ imageGroup: '生图分组', videoGroup: 'grok', host })
    const imageAssetId = 'i'.repeat(43)
    const result = await executors['video-generate'](
      workflowNode('video-generate', {
        model: 'grok-imagine-video-1.5',
        prompt: '镜头缓慢推进',
        seconds: '10',
      }),
      { image: { kind: 'image', assetId: imageAssetId } },
      new AbortController().signal,
    )

    expect(host.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      group: 'grok',
      model: 'grok-imagine-video-1.5',
      prompt: '镜头缓慢推进',
      seconds: '10',
      imageAssetId,
      width: 1280,
      height: 720,
    }))
    expect(result.output.asset).toMatchObject({ kind: 'video', taskId: 'video-task-1' })
  })

  it('rejects fractional video duration before calling the paid host operation', async () => {
    const host = hostMocks()
    const executors = createHostExecutors({ imageGroup: '生图分组', videoGroup: 'grok', host })
    await expect(executors['video-generate'](
      workflowNode('video-generate', {
        model: 'grok-imagine-video',
        prompt: '海浪拍打礁石',
        seconds: '5.5',
      }),
      {},
      new AbortController().signal,
    )).rejects.toThrow('视频时长必须在 1-15 秒之间')
    expect(host.generateVideo).not.toHaveBeenCalled()
  })
})
