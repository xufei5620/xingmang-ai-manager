import { describe, expect, it } from 'vitest'
import { resolveInterruptibleInstallTask } from './quit-blocking-tasks'

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
