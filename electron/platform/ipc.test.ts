import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { platformChannels } from './contract'
import { assertPlatformOwner, registerPlatformHandlers } from './ipc'
import type { PlatformSystemService } from './system-service'

function harness() {
  const frame = { url: 'http://127.0.0.1:5174/index.html' }
  const owner = {
    isDestroyed: () => false,
    getURL: () => frame.url,
    mainFrame: frame,
  } as unknown as WebContents
  const event = {
    sender: owner,
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent
  const policy = {
    rendererRoot: 'C:/app/dist',
    devServerUrl: 'http://127.0.0.1:5174',
    packagedBaseUrl: 'xingmang://app/',
  }
  return { frame, owner, event, policy }
}

describe('platform IPC main-window boundary', () => {
  it('rejects other windows, same-origin subframes, missing frames, and external navigations', () => {
    const h = harness()
    expect(() => assertPlatformOwner(h.event, h.owner, h.policy)).not.toThrow()
    expect(() =>
      assertPlatformOwner(
        { ...h.event, sender: {} as WebContents },
        h.owner,
        h.policy,
      ),
    ).toThrow('非主应用窗口')
    expect(() =>
      assertPlatformOwner(
        {
          ...h.event,
          senderFrame: {
            url: h.frame.url,
          } as IpcMainInvokeEvent['senderFrame'],
        },
        h.owner,
        h.policy,
      ),
    ).toThrow('非主应用窗口')
    expect(() =>
      assertPlatformOwner({ ...h.event, senderFrame: null }, h.owner, h.policy),
    ).toThrow('非主应用窗口')
    expect(() => assertPlatformOwner(h.event, null, h.policy)).toThrow(
      '非主应用窗口',
    )
    h.frame.url = 'https://evil.example/'
    expect(() => assertPlatformOwner(h.event, h.owner, h.policy)).toThrow(
      '非主应用窗口',
    )
  })
  it('accepts only the finite methods and validated argument shapes', async () => {
    const h = harness()
    const callbacks = new Map<
      string,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    >()
    const service = {
      getState: vi.fn(() => 'state'),
      getProxyStatus: vi.fn(),
      setThemePreference: vi.fn(async () => 'theme'),
      setHighContrast: vi.fn(),
      setStartup: vi.fn(),
    } as unknown as PlatformSystemService
    const removeHandler = vi.fn()
    const dispose = registerPlatformHandlers({
      ipcMain: {
        handle: (channel, callback) => {
          callbacks.set(channel, callback)
        },
        removeHandler,
      },
      owner: () => h.owner,
      policy: () => h.policy,
      service: () => service,
    })
    expect(callbacks.size).toBe(9)
    expect(() =>
      callbacks.get(platformChannels.getState)!(h.event, 'unexpected'),
    ).toThrow('参数')
    expect(() =>
      callbacks.get(platformChannels.setStartup)!(h.event, 'yes'),
    ).toThrow('开关')
    expect(() =>
      callbacks.get(platformChannels.setThemePreference)!(h.event, 'auto'),
    ).toThrow('主题')
    await expect(
      callbacks.get(platformChannels.setThemePreference)!(h.event, 'system'),
    ).resolves.toBe('theme')
    expect(service.setThemePreference).toHaveBeenCalledWith('system')
    dispose()
    expect(removeHandler).toHaveBeenCalledTimes(9)
    expect(() =>
      callbacks.get(platformChannels.notifyActivity)!(
        h.event,
        'task',
        'arbitrary text',
      ),
    ).toThrow('事件编号')
    expect(() =>
      callbacks.get(platformChannels.setNotificationPreference)!(
        h.event,
        'arbitrary',
        true,
      ),
    ).toThrow('通知类型')
    expect(() =>
      callbacks.get(platformChannels.setPrivacyPreference)!(
        h.event,
        'arbitrary',
        true,
      ),
    ).toThrow('隐私偏好')
  })
  it('keeps sandbox preload literal channels aligned and emits no sibling require', () => {
    const file = path.join(__dirname, 'preload.ts')
    const sourceText = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    )
    let object: ts.ObjectLiteralExpression | undefined
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === 'channels' &&
        node.initializer &&
        ts.isAsExpression(node.initializer) &&
        ts.isObjectLiteralExpression(node.initializer.expression)
      )
        object = node.initializer.expression
      ts.forEachChild(node, visit)
    }
    visit(source)
    const values = Object.fromEntries(
      object!.properties.map((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isStringLiteral(property.initializer)
        )
          throw new Error('Unexpected preload channel declaration')
        return [property.name.getText(source), property.initializer.text]
      }),
    )
    expect(values).toEqual(platformChannels)
    const compiled = ts.transpileModule(sourceText, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText
    expect(compiled).not.toMatch(/require\(["']\.\//)
    expect(compiled).toContain('process.isMainFrame')
    expect(compiled).not.toContain('exposeInMainWorld("ipcRenderer"')
  })
})
