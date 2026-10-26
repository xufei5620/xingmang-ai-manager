import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { desktopCanvasCapabilities } from './canvas-contract'

type CanvasBridge = Record<string, (...args: unknown[]) => Promise<unknown>>

function loadCanvasBridge(invoke: (...args: unknown[]) => Promise<unknown>) {
  const sourceText = fs.readFileSync(path.join(__dirname, 'canvas-preload.ts'), 'utf8')
  const compiled = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  let bridge: CanvasBridge | undefined
  vm.runInNewContext(compiled, {
    exports: {},
    require: (name: string) => {
      if (name !== 'electron') throw new Error('Sandbox cannot load runtime modules')
      return {
        ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
        contextBridge: { exposeInMainWorld: (_name: string, api: CanvasBridge) => { bridge = api } },
        webUtils: { getPathForFile: () => '' },
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
})
