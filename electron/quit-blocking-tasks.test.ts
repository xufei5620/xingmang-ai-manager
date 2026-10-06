import { describe, expect, it } from 'vitest'
import { providerIds } from './catalog'
import { externalToolIds } from './external-client-contract'
import { isKeepAwakeInstallKey } from './install-keep-awake'
import { resolveInstallableUpdateOnQuit, resolveInterruptibleInstallTask, waitForUpdateInstallFailure } from './quit-blocking-tasks'
import type { UpdateSnapshot } from './updater'

function snapshot(activeKey: string | null, pendingKeys: string[] = []) {
  return { activeKey, pendingKeys }
}

describe('interruptible install tasks', () => {
  it('reports nothing while the installation queue is idle', () => {
    expect(resolveInterruptibleInstallTask(snapshot(null))).toBeNull()
  })

  it('names the CLI whose installation is running', () => {
    expect(resolveInterruptibleInstallTask(snapshot('cli:install:claude'))).toEqual({
      key: 'cli:install:claude', description: '正在安装 Claude Code', count: 1,
    })
  })

  it('names the bundled runtimes and the Codex desktop download', () => {
    const descriptions = ['runtime:node', 'runtime:python', 'desktop:codex:install']
      .map((key) => resolveInterruptibleInstallTask(snapshot(key))?.description)
    expect(descriptions).toEqual(['正在安装 Node.js 运行环境', '正在安装 Python 运行环境', '正在安装 Codex 桌面端'])
  })

  it('names Git, which Windows installs right after Claude Code', () => {
    expect(resolveInterruptibleInstallTask(snapshot('runtime:git'))).toEqual({
      key: 'runtime:git', description: '正在安装 Git', count: 1,
    })
  })

  it('names the external client being installed', () => {
    const descriptions = ['external-client:install:workbuddy', 'external-client:install:claudeDesktop', 'external-client:install:opencode']
      .map((key) => resolveInterruptibleInstallTask(snapshot(key))?.description)
    expect(descriptions).toEqual(['正在安装 WorkBuddy', '正在安装 Claude Desktop', '正在安装 OpenCode'])
  })

  it('ignores launches and uninstalls, which lose nothing when interrupted', () => {
    const keys = ['cli:launch:codex', 'desktop:codex:launch:new:default', 'cli:uninstall:gemini', 'desktop:codex:uninstall', 'external-client:launch:workbuddy']
    for (const key of keys) expect(resolveInterruptibleInstallTask(snapshot(key, keys))).toBeNull()
  })

  it('ignores an unknown or malformed provider so quitting is never blocked by a typo', () => {
    expect(resolveInterruptibleInstallTask(snapshot('cli:install:'))).toBeNull()
    expect(resolveInterruptibleInstallTask(snapshot('cli:install:__proto__'))).toBeNull()
    expect(resolveInterruptibleInstallTask(snapshot('something:else'))).toBeNull()
  })

  it('ignores an unknown or malformed external client the same way', () => {
    for (const key of ['external-client:install:', 'external-client:install:__proto__', 'external-client:install:cursor', 'external-client:install:claudedesktop']) {
      expect(resolveInterruptibleInstallTask(snapshot(key))).toBeNull()
    }
  })

  it('counts queued installs but keeps the name of the one the user is watching', () => {
    const result = resolveInterruptibleInstallTask(snapshot('cli:install:codex', ['cli:launch:grok', 'runtime:node']))
    expect(result).toEqual({ key: 'cli:install:codex', description: '正在安装 Codex CLI', count: 2 })
  })

  it('still warns when only a queued install is waiting behind a launch', () => {
    const result = resolveInterruptibleInstallTask(snapshot('cli:launch:grok', ['cli:install:gemini']))
    expect(result).toEqual({ key: 'cli:install:gemini', description: '正在安装 Gemini CLI', count: 1 })
  })

  it('counts a client queued behind the Git install and keeps naming Git', () => {
    const result = resolveInterruptibleInstallTask(snapshot('runtime:git', ['external-client:install:workbuddy']))
    expect(result).toEqual({ key: 'runtime:git', description: '正在安装 Git', count: 2 })
  })

  it('blocks quitting for exactly the queue keys that also keep the computer awake', () => {
    // 程序里会进安装队列的每一种 key。防睡和退出拦截各认一份，新加一种安装时两边要一起认，
    // 不然就是「电脑不睡了，退出却不拦」。
    const keys = [
      'runtime:node', 'runtime:python', 'runtime:git', 'maintenance:install-leftovers',
      'desktop:codex:install', 'desktop:codex:uninstall', 'desktop:codex:reset', 'desktop:codex:launch:new:zh-CN',
      ...providerIds.flatMap((provider) => [`cli:install:${provider}`, `cli:uninstall:${provider}`, `cli:launch:${provider}:new:/work`]),
      ...externalToolIds.flatMap((tool) => [`external-client:install:${tool}`, `external-client:launch:${tool}`]),
    ]
    const blocking = keys.map((key) => [key, resolveInterruptibleInstallTask(snapshot(key)) !== null])
    expect(blocking).toEqual(keys.map((key) => [key, isKeepAwakeInstallKey(key)]))
  })
})

function updateSnapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'downloaded',
    currentVersion: '0.2.8',
    availableVersion: '0.2.9',
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    failedStep: null,
    development: false,
    ...overrides,
  }
}

describe('update ready to install on quit', () => {
  it('offers the verified package waiting on disk', () => {
    expect(resolveInstallableUpdateOnQuit(updateSnapshot())).toEqual({ version: '0.2.9' })
  })

  it('stays quiet until the download and its verification are finished', () => {
    const phases = ['disabled', 'idle', 'checking', 'available', 'not-available', 'downloading', 'cancelled', 'error'] as const
    for (const phase of phases) {
      expect(resolveInstallableUpdateOnQuit(updateSnapshot({ phase }))).toBeNull()
    }
  })

  it('stays quiet when the installer already failed on this package', () => {
    const failed = updateSnapshot({ error: { code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT', message: '更新程序未能启动' }, failedStep: 'install' })
    expect(resolveInstallableUpdateOnQuit(failed)).toBeNull()
  })

  it('never offers an install in development, where the updater refuses it anyway', () => {
    expect(resolveInstallableUpdateOnQuit(updateSnapshot({ development: true }))).toBeNull()
  })

  it('still offers the install when the snapshot carries no version to name', () => {
    expect(resolveInstallableUpdateOnQuit(updateSnapshot({ availableVersion: null }))).toEqual({ version: null })
  })
})

describe('waiting on the Mac installer at quit', () => {
  function updates() {
    const listeners = new Set<(snapshot: UpdateSnapshot) => void>()
    return {
      listeners,
      subscribe(listener: (snapshot: UpdateSnapshot) => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      emit(snapshot: UpdateSnapshot) {
        for (const listener of [...listeners]) listener(snapshot)
      },
    }
  }

  it('settles once the installer reports it could not install, and stops listening', async () => {
    const source = updates()
    let settled = false
    const waiting = waitForUpdateInstallFailure(source).then(() => { settled = true })
    source.emit(updateSnapshot())
    source.emit(updateSnapshot({ phase: 'downloading' }))
    await Promise.resolve()
    expect(settled).toBe(false)
    source.emit(updateSnapshot({ error: { code: 'UPDATE_SIGNATURE_REJECTED', message: '校验没通过' }, failedStep: 'install' }))
    await waiting
    expect(settled).toBe(true)
    expect(source.listeners.size).toBe(0)
  })

  it('keeps waiting through a failure in another step, which the installer did not report', async () => {
    const source = updates()
    let settled = false
    void waitForUpdateInstallFailure(source).then(() => { settled = true })
    source.emit(updateSnapshot({ phase: 'error', error: { code: 'UPDATE_ERROR', message: '下载失败' }, failedStep: 'download' }))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(source.listeners.size).toBe(1)
  })

  it('keeps waiting through the launch watchdog, which only means the installer has not quit yet', async () => {
    const source = updates()
    let settled = false
    void waitForUpdateInstallFailure(source).then(() => { settled = true })
    source.emit(updateSnapshot({ error: { code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT', message: '新版本没装上：安装程序没起来。' }, failedStep: 'install' }))
    await Promise.resolve()
    expect(settled).toBe(false)
    // 看门狗之后才到的验签结果照样算数（updater.ts 的 macInstallHandoffRegistered 那条）。
    source.emit(updateSnapshot({ error: { code: 'UPDATE_SIGNATURE_REJECTED', message: '校验没通过' }, failedStep: 'install' }))
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('copes with a source that reports its current state while subscribing', async () => {
    const failed = updateSnapshot({ error: { code: 'UPDATE_ERROR', message: '没装上' }, failedStep: 'install' })
    const listeners = new Set<(snapshot: UpdateSnapshot) => void>()
    const source = {
      subscribe(listener: (snapshot: UpdateSnapshot) => void) {
        listeners.add(listener)
        listener(failed)
        return () => { listeners.delete(listener) }
      },
    }
    await waitForUpdateInstallFailure(source)
    expect(listeners.size).toBe(0)
  })
})
