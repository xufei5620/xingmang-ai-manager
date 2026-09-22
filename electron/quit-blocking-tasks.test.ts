import { describe, expect, it } from 'vitest'
import { resolveInstallableUpdateOnQuit, resolveInterruptibleInstallTask } from './quit-blocking-tasks'
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

  it('ignores launches and uninstalls, which lose nothing when interrupted', () => {
    const keys = ['cli:launch:codex', 'desktop:codex:launch:new:default', 'cli:uninstall:gemini', 'desktop:codex:uninstall']
    for (const key of keys) expect(resolveInterruptibleInstallTask(snapshot(key, keys))).toBeNull()
  })

  it('ignores an unknown or malformed provider so quitting is never blocked by a typo', () => {
    expect(resolveInterruptibleInstallTask(snapshot('cli:install:'))).toBeNull()
    expect(resolveInterruptibleInstallTask(snapshot('cli:install:__proto__'))).toBeNull()
    expect(resolveInterruptibleInstallTask(snapshot('something:else'))).toBeNull()
  })

  it('counts queued installs but keeps the name of the one the user is watching', () => {
    const result = resolveInterruptibleInstallTask(snapshot('cli:install:codex', ['cli:launch:grok', 'runtime:node']))
    expect(result).toEqual({ key: 'cli:install:codex', description: '正在安装 Codex CLI', count: 2 })
  })

  it('still warns when only a queued install is waiting behind a launch', () => {
    const result = resolveInterruptibleInstallTask(snapshot('cli:launch:grok', ['cli:install:gemini']))
    expect(result).toEqual({ key: 'cli:install:gemini', description: '正在安装 Gemini CLI', count: 1 })
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
