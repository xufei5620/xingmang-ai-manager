import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { desktopCanvasCapabilities } from './canvas-contract'

type CanvasBridge = Record<string, (...args: unknown[]) => Promise<unknown>>

function loadCanvasBridge(invoke: (...args: unknown[]) => Promise<unknown>, getPathForFile: (file: unknown) => string = () => '', globals: Record<string, unknown> = {}) {
  const sourceText = fs.readFileSync(path.join(__dirname, 'canvas-preload.ts'), 'utf8')
  const compiled = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  let bridge: CanvasBridge | undefined
  vm.runInNewContext(compiled, {
    ...globals,
    exports: {},
    require: (name: string) => {
      if (name !== 'electron') throw new Error('Sandbox cannot load runtime modules')
      return {
        ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
        contextBridge: { exposeInMainWorld: (_name: string, api: CanvasBridge) => { bridge = api } },
        webUtils: { getPathForFile },
      }
    },
  })
  return bridge!
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as { message: string }
  }
  throw new Error('Expected the bridge call to reject')
}

describe('canvas sandbox preload', () => {
  it('peels the IPC wrapper so canvas nodes and banners show only the main-process reason', async () => {
    const bridge = loadCanvasBridge(vi.fn(async () => {
      throw new Error("Error invoking remote method 'canvas-host:generate-image': Error: 当前模型不支持这个图片尺寸，请更换尺寸后重试")
    }))

    const error = await rejection(bridge.generateImage({ prompt: 'cat' }))

    expect(error.message).toBe('当前模型不支持这个图片尺寸，请更换尺寸后重试')
  })

  it('drops a custom main-process error class name and every nested wrapper layer', async () => {
    const bridge = loadCanvasBridge(vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'canvas-host:prepare-group': "
        + "Error invoking remote method 'account:get-session': RealmAccountError: 请先登录星芒账号",
      )
    }))

    expect((await rejection(bridge.prepareGroup('default'))).message).toBe('请先登录星芒账号')
  })

  it('keeps error codes and drive letters that open the reason itself', async () => {
    const reasons = [
      'EPERM: operation not permitted, rename',
      'C:\\Users\\a\\canvas.json 无法写入',
    ]
    for (const reason of reasons) {
      const bridge = loadCanvasBridge(vi.fn(async () => {
        throw new Error(`Error invoking remote method 'canvas-host:save-project': Error: ${reason}`)
      }))
      expect((await rejection(bridge.saveProject('p1', '{}'))).message).toBe(reason)
    }
  })

  it('passes resolved values and unwrapped rejections through untouched', async () => {
    const plain = new Error('画布项目已归档，无法保存')
    const invoke = vi.fn()
      .mockResolvedValueOnce({ projectId: 'p1' })
      .mockRejectedValueOnce(plain)
    const bridge = loadCanvasBridge(invoke)

    await expect(bridge.openProject('p1')).resolves.toEqual({ projectId: 'p1' })
    expect(await rejection(bridge.saveProject('p1', '{}'))).toBe(plain)
    expect(invoke.mock.calls).toEqual([
      ['canvas-host:open-project', 'p1'],
      ['canvas-host:save-project', 'p1', '{}'],
    ])
  })

  it('answers capabilities from a frozen copy of the contract without touching IPC', () => {
    const invoke = vi.fn(async () => null)
    const bridge = loadCanvasBridge(invoke)
    const capabilities: unknown = bridge.capabilities()
    // The copy lives in another realm, so compare the data, not the objects.
    expect(JSON.parse(JSON.stringify(capabilities))).toEqual(JSON.parse(JSON.stringify(desktopCanvasCapabilities)))
    expect(bridge.capabilities()).toBe(capabilities)
    const frozen: unknown[] = []
    function collect(value: unknown) {
      if (!value || typeof value !== 'object') return
      frozen.push(value)
      for (const entry of Object.values(value)) collect(entry)
    }
    collect(capabilities)
    expect(frozen.length).toBeGreaterThan(10)
    expect(frozen.every((value) => Object.isFrozen(value))).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('forwards the content and source of a saved copy only when the kernel passes them', async () => {
    const invoke = vi.fn(async () => null)
    const bridge = loadCanvasBridge(invoke)
    await bridge.createProject('新项目')
    await bridge.createProject('副本', '{"schemaVersion":2}', { sourceProjectId: 'source' })
    await bridge.createProject('副本', '{"schemaVersion":2}')
    // A wrong type is passed on so the main process refuses it, rather than
    // being dropped into an empty new project.
    await bridge.createProject('副本', 42)
    await bridge.createProject('副本', undefined, { sourceProjectId: 'source' })
    expect(invoke.mock.calls).toEqual([
      ['canvas-host:create-project', '新项目'],
      ['canvas-host:create-project', '副本', '{"schemaVersion":2}', { sourceProjectId: 'source' }],
      ['canvas-host:create-project', '副本', '{"schemaVersion":2}', undefined],
      ['canvas-host:create-project', '副本', 42, undefined],
      ['canvas-host:create-project', '副本', undefined, { sourceProjectId: 'source' }],
    ])
  })

  it('reads one asset by its id alone and leaves the kernel signal behind', async () => {
    const invoke = vi.fn(async () => ({ assetId: 'a'.repeat(43) }))
    const bridge = loadCanvasBridge(invoke)
    await expect(bridge.getAssetDetail('a'.repeat(43), new AbortController().signal)).resolves.toEqual({ assetId: 'a'.repeat(43) })
    expect(invoke.mock.calls).toEqual([['canvas-host:get-asset-detail', 'a'.repeat(43)]])
  })

  it('sends a dropped file by its path and a picture the page drew by its bytes alone', async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => ({ assetId: 'a' }))
    const dropped = { name: 'cat.png', type: 'image/png', size: 4, arrayBuffer: vi.fn() }
    const bridge = loadCanvasBridge(invoke, (file) => file === dropped ? 'C:\\Users\\me\\cat.png' : '')
    await bridge.importAssetFile(dropped)
    expect(dropped.arrayBuffer).not.toHaveBeenCalled()
    const mask = { name: '星芒-黑白蒙版-4x4.png', type: 'image/png', size: 4, arrayBuffer: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer) }
    await bridge.importAssetFile(mask, { mediaType: 'image' })
    expect(invoke.mock.calls[0]).toEqual(['canvas-host:import-asset-file', 'C:\\Users\\me\\cat.png'])
    expect(invoke.mock.calls[1][0]).toBe('canvas-host:import-asset-bytes')
    expect(invoke.mock.calls[1]).toHaveLength(2)
    expect([...(invoke.mock.calls[1][1] as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('refuses a pathless file that is not a picture, or is too large, before reading it', async () => {
    const invoke = vi.fn(async () => null)
    const bridge = loadCanvasBridge(invoke)
    const video = { name: 'clip.mp4', type: 'video/mp4', size: 4, arrayBuffer: vi.fn() }
    const huge = { name: 'huge.png', type: 'image/png', size: 20 * 1024 * 1024 + 1, arrayBuffer: vi.fn() }
    expect((await rejection(bridge.importAssetFile(video))).message).toBe('无法读取拖入的本地文件')
    expect((await rejection(bridge.importAssetFile(huge))).message).toBe('画布图片超过 20 MB，没有保存')
    expect(video.arrayBuffer).not.toHaveBeenCalled()
    expect(huge.arrayBuffer).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reads a video for the frame picker by its asset address only, within the decoder limit', async () => {
    const assetId = 'V'.repeat(43)
    const fetch = vi.fn(async (_url: string, _init: unknown) => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } }))
    const invoke = vi.fn(async () => null)
    const bridge = loadCanvasBridge(invoke, () => '', { fetch, Blob })

    const video = await bridge.readVideoForFramePreview(assetId) as Blob
    expect(fetch).toHaveBeenCalledWith(`xingmang-asset://video/${assetId}`, { cache: 'no-store', redirect: 'error' })
    expect(video.type).toBe('video/mp4')
    expect(video.size).toBe(3)
    expect(invoke).not.toHaveBeenCalled()

    for (const wrong of ['../etc/passwd', 'C:\\clip.mp4', `${assetId}/x`, 42]) {
      expect((await rejection(bridge.readVideoForFramePreview(wrong))).message).toBe('视频素材标识格式错误')
    }
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect((await rejection(bridge.readVideoForFramePreview(assetId))).message).toBe('视频读不出来，请确认素材还在')
    fetch.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } }))
    expect((await rejection(bridge.readVideoForFramePreview(assetId))).message).toBe('视频超过 32 MB，画布抽不了这一帧')
    fetch.mockResolvedValueOnce(new Response(new Uint8Array(32 * 1024 * 1024 + 1)))
    expect((await rejection(bridge.readVideoForFramePreview(assetId))).message).toBe('视频超过 32 MB，画布抽不了这一帧')
  })

  it('hands a decoded frame back as bytes with the ids, and a failure with nothing else', async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => undefined)
    const bridge = loadCanvasBridge(invoke, () => '', { Blob })
    const ids = { runId: 'run-1', operationId: 'attempt-1', kind: 'frame' }

    await bridge.completeRunPreparation({ ...ids, outcome: 'completed', png: new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' }), decodedTimestampSeconds: 2.5, name: 'frame.png' })
    expect(invoke.mock.calls[0][0]).toBe('canvas-host:complete-run-preparation')
    const sent = invoke.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['decodedTimestampSeconds', 'kind', 'operationId', 'outcome', 'png', 'runId'])
    expect([...(sent.png as Uint8Array)]).toEqual([0x89, 0x50])

    await bridge.completeRunPreparation({ ...ids, outcome: 'failed', message: '页面里的字', png: new Blob([new Uint8Array([1])]) })
    expect(invoke.mock.calls[1]).toEqual(['canvas-host:complete-run-preparation', { ...ids, outcome: 'failed' }])

    expect((await rejection(bridge.completeRunPreparation(null))).message).toBe('画布运行准备回执格式错误')
    expect((await rejection(bridge.completeRunPreparation({ ...ids, outcome: 'completed', png: 'C:\\frame.png' }))).message).toBe('视频帧图片内容格式错误')
    expect((await rejection(bridge.completeRunPreparation({ ...ids, outcome: 'completed', png: new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]) }))).message).toBe('视频帧图片超过 20 MB，没有保存')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
