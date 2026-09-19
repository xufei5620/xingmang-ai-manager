import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { platformChannels } from './contract'
import {
  assertPlatformOwner,
  registerPlatformHandlers,
  summarizePlatformInvocation,
} from './ipc'
import type { PlatformIpcLogger } from './ipc'
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

describe('platform IPC audit log', () => {
  function logged() {
    const entries: {
      level: string
      source: string
      event: string
      message: string
      detail: Record<string, unknown>
    }[] = []
    const log: PlatformIpcLogger = (level, source, event, message, detail) => {
      entries.push({ level, source, event, message, detail })
    }
    return { entries, log }
  }

  function registered(log: PlatformIpcLogger) {
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
      setStartup: vi.fn(() => 'startup'),
      setNotificationPreference: vi.fn(() => 'notification'),
      setPrivacyPreference: vi.fn(() => 'privacy'),
      testNotification: vi.fn(() => 'requested'),
      notifyActivity: vi.fn(async () => 'duplicate'),
    } as unknown as PlatformSystemService
    registerPlatformHandlers({
      ipcMain: {
        handle: (channel, callback) => {
          callbacks.set(channel, callback)
        },
        removeHandler: vi.fn(),
      },
      owner: () => h.owner,
      policy: () => h.policy,
      service: () => service,
      log,
    })
    return { h, callbacks, service }
  }

  it('records reads at debug and machine-level switches at info', async () => {
    const sink = logged()
    const { h, callbacks } = registered(sink.log)
    callbacks.get(platformChannels.getState)!(h.event)
    callbacks.get(platformChannels.setStartup)!(h.event, true)
    await callbacks.get(platformChannels.setPrivacyPreference)!(
      h.event,
      'crashReports',
      false,
    )
    expect(sink.entries.map((entry) => [entry.level, entry.event])).toEqual([
      ['debug', platformChannels.getState],
      ['info', platformChannels.setStartup],
      ['info', platformChannels.setPrivacyPreference],
    ])
    expect(sink.entries.every((entry) => entry.source === 'ipc')).toBe(true)
    expect(sink.entries[1]!.message).toBe('切换开机自启完成')
    expect(sink.entries[1]!.detail.enabled).toBe(true)
    expect(typeof sink.entries[1]!.detail.durationMs).toBe('number')
    expect(sink.entries[2]!.detail).toMatchObject({
      kind: 'crashReports',
      enabled: false,
    })
  })

  it('waits for an asynchronous result before recording it', async () => {
    const sink = logged()
    const { h, callbacks } = registered(sink.log)
    const pending = callbacks.get(platformChannels.notifyActivity)!(
      h.event,
      'task',
      'install.done',
    )
    expect(sink.entries).toHaveLength(0)
    await pending
    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0]!.detail).toMatchObject({
      kind: 'task',
      eventKey: 'install.done',
      result: 'duplicate',
    })
  })

  it('records a rejected sender as a security event naming the page', () => {
    const sink = logged()
    const { h, callbacks } = registered(sink.log)
    expect(() =>
      callbacks.get(platformChannels.setStartup)!(
        { ...h.event, sender: {} as WebContents },
        true,
      ),
    ).toThrow('非主应用窗口')
    expect(sink.entries).toEqual([
      {
        level: 'warn',
        source: 'security',
        event: 'platform.denied',
        message: '已拒绝非主应用窗口的系统设置请求',
        detail: {
          channel: platformChannels.setStartup,
          senderUrl: 'http://127.0.0.1:5174/index.html',
        },
      },
    ])
  })

  it('records rejected arguments and failing services without their values', async () => {
    const sink = logged()
    const { h, callbacks, service } = registered(sink.log)
    expect(() =>
      callbacks.get(platformChannels.setStartup)!(h.event, 'yes'),
    ).toThrow('开关')
    vi.mocked(service.setThemePreference).mockRejectedValueOnce(
      new Error('主题写入失败'),
    )
    await expect(
      callbacks.get(platformChannels.setThemePreference)!(h.event, 'dark'),
    ).rejects.toThrow('主题写入失败')
    expect(sink.entries.map((entry) => [entry.level, entry.message])).toEqual([
      ['error', '切换开机自启失败：系统设置开关值无效。'],
      ['error', '切换主题偏好失败：主题写入失败'],
    ])
    for (const entry of sink.entries)
      expect(Object.keys(entry.detail).sort()).toEqual(['durationMs', 'error'])
  })

  it('stays silent when no logger is supplied', () => {
    const h = harness()
    const callbacks = new Map<
      string,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    >()
    const service = {
      getState: vi.fn(() => 'state'),
    } as unknown as PlatformSystemService
    registerPlatformHandlers({
      ipcMain: {
        handle: (channel, callback) => {
          callbacks.set(channel, callback)
        },
        removeHandler: vi.fn(),
      },
      owner: () => h.owner,
      policy: () => h.policy,
      service: () => service,
    })
    expect(callbacks.get(platformChannels.getState)!(h.event)).toBe('state')
  })

  it('summarizes only values that survive the channel validators', () => {
    expect(
      summarizePlatformInvocation(
        platformChannels.notifyActivity,
        ['task', 'install.done'],
        'requested',
      ),
    ).toEqual({ kind: 'task', eventKey: 'install.done', result: 'requested' })
    expect(
      summarizePlatformInvocation(
        platformChannels.notifyActivity,
        ['task', 'sk-live-0123456789 secret'],
        null,
      ),
    ).toEqual({ kind: 'task' })
    expect(
      summarizePlatformInvocation(
        platformChannels.setPrivacyPreference,
        ['../../etc/passwd', 'true'],
        null,
      ),
    ).toEqual({})
    expect(
      summarizePlatformInvocation(
        platformChannels.getState,
        [],
        { preferences: { themePreference: 'dark' } },
      ),
    ).toEqual({})
  })
})
