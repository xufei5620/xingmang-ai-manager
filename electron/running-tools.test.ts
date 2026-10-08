import { describe, expect, it, vi } from 'vitest'
import type { ProviderId } from './catalog'
import type { CliProcessProbe } from './cli-process-probe'
import {
  cliProcessProbeRoots,
  describeRunningTools,
  inspectRunningTools,
  describeToolRouteRestartHint,
  offersCodexDesktopRestart,
  offersToolRouteDesktopRestart,
  toolRouteRestartNeeds,
  type RunningToolsProbeDependencies,
  type RunningToolsReport,
} from './running-tools'
import type { CliInstallation } from './tool-installation'

function installation(overrides: Partial<CliInstallation>): CliInstallation {
  return {
    commandPath: '/opt/npm/bin/claude',
    installDirectory: '/opt/npm/bin',
    packageRoot: '/opt/npm/lib/node_modules/@anthropic-ai/claude-code',
    npmPrefix: '/opt/npm',
    source: 'npm',
    ...overrides,
  }
}

function checked(count: number): CliProcessProbe {
  return {
    status: 'checked',
    processes: Array.from({ length: count }, (_, index) => ({ processId: index + 10, name: 'node', executablePath: '' })),
  }
}

function report(overrides: Partial<RunningToolsReport> = {}): RunningToolsReport {
  return { running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: true, ...overrides }
}

function dependencies(overrides: Partial<RunningToolsProbeDependencies> = {}) {
  const deps: RunningToolsProbeDependencies = {
    probeRoots: async (provider: ProviderId) => [`/root/${provider}`],
    probe: async () => checked(0),
    codexDesktopRunning: async () => false,
    canRestartCodexDesktop: true,
    ...overrides,
  }
  return deps
}

describe('cliProcessProbeRoots', () => {
  it('probes nothing for a tool that is not installed', () => {
    expect(cliProcessProbeRoots(null, 'win32')).toEqual([])
  })

  it('uses only the package directory on Windows, where the npm shim puts it on the command line', () => {
    expect(cliProcessProbeRoots(installation({ commandPath: 'C:\\npm\\claude.cmd', packageRoot: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code' }), 'win32'))
      .toEqual(['C:\\npm\\node_modules\\@anthropic-ai\\claude-code'])
  })

  it('also matches the bin entry itself on macOS, because a shebang shim hides the package directory from ps', () => {
    expect(cliProcessProbeRoots(installation({}), 'darwin'))
      .toEqual(['/opt/npm/lib/node_modules/@anthropic-ai/claude-code', '/opt/npm/bin/claude'])
  })

  it('matches a native binary by its own file, never by the shared directory it sits in', () => {
    expect(cliProcessProbeRoots(installation({ commandPath: 'C:\\Users\\a\\.local\\bin\\claude.exe', packageRoot: null, source: 'native' }), 'win32'))
      .toEqual(['C:\\Users\\a\\.local\\bin\\claude.exe'])
  })
})

describe('inspectRunningTools', () => {
  it('reports only the tools a probe actually found running', async () => {
    const result = await inspectRunningTools(['claude', 'gemini'], dependencies({
      probe: async (root) => checked(root.endsWith('claude') ? 2 : 0),
    }))
    expect(result).toEqual(report({ running: ['claude'] }))
  })

  it('files a tool under unknown when the probe could not run, instead of calling it closed', async () => {
    const result = await inspectRunningTools(['grok'], dependencies({
      probe: async () => ({ status: 'unavailable', processes: [], detail: 'timeout' }),
    }))
    expect(result).toEqual(report({ unknown: ['grok'] }))
  })

  it('treats a failed installation lookup as unknown and keeps going with the rest', async () => {
    const result = await inspectRunningTools(['claude', 'gemini'], dependencies({
      probeRoots: async (provider) => { if (provider === 'claude') throw new Error('EACCES'); return ['/root/gemini'] },
      probe: async () => checked(1),
    }))
    expect(result).toEqual(report({ running: ['gemini'], unknown: ['claude'] }))
  })

  it('counts a tool as running when any of its roots matched, even if another root could not be probed', async () => {
    const result = await inspectRunningTools(['claude'], dependencies({
      probeRoots: async () => ['/pkg', '/bin/claude'],
      probe: async (root) => root === '/pkg' ? { status: 'unavailable', processes: [] } : checked(1),
    }))
    expect(result.running).toEqual(['claude'])
    expect(result.unknown).toEqual([])
  })

  it('reports a tool that is not installed as not running', async () => {
    const probe = vi.fn(async () => checked(1))
    const result = await inspectRunningTools(['grok'], dependencies({ probeRoots: async () => [], probe }))
    expect(result).toEqual(report())
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes one tool at a time so a low-end PC never starts several PowerShells at once', async () => {
    let active = 0
    let peak = 0
    await inspectRunningTools(['claude', 'codex', 'gemini', 'grok'], dependencies({
      probe: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return checked(0)
      },
    }))
    expect(peak).toBe(1)
  })

  it('asks about Codex desktop only when Codex was part of the switch', async () => {
    const codexDesktopRunning = vi.fn(async () => true)
    expect((await inspectRunningTools(['claude'], dependencies({ codexDesktopRunning }))).codexDesktopRunning).toBe(false)
    expect(codexDesktopRunning).not.toHaveBeenCalled()
    expect((await inspectRunningTools(['codex'], dependencies({ codexDesktopRunning }))).codexDesktopRunning).toBe(true)
  })

  it('says Codex desktop is unknown when asking about it fails', async () => {
    const result = await inspectRunningTools(['codex'], dependencies({ codexDesktopRunning: async () => { throw new Error('denied') } }))
    expect(result.codexDesktopRunning).toBeNull()
  })

  it('asks about each tool once even when the list repeats it', async () => {
    const probeRoots = vi.fn(async (provider: ProviderId) => [`/root/${provider}`])
    await inspectRunningTools(['claude', 'claude'], dependencies({ probeRoots }))
    expect(probeRoots).toHaveBeenCalledTimes(1)
  })
})

describe('describeRunningTools', () => {
  it('says nothing when nothing is running', () => {
    expect(describeRunningTools(report(), 'account')).toBe('')
  })

  it('names every running tool, Codex desktop included', () => {
    expect(describeRunningTools(report({ running: ['claude', 'codex'], codexDesktopRunning: true }), 'account'))
      .toBe('Claude Code、Codex CLI、Codex 桌面端 还开着，要关掉重开才会用上当前账号。')
  })

  it('says where the switch goes when going back to the official account', () => {
    expect(describeRunningTools(report({ running: ['gemini'] }), 'official'))
      .toBe('Gemini CLI 还开着，要关掉重开才会换回官方账号。')
  })

  it('hedges for tools it could not check rather than claiming they are open', () => {
    expect(describeRunningTools(report({ unknown: ['grok'], codexDesktopRunning: null }), 'account'))
      .toBe('如果 Grok CLI、Codex 桌面端 还开着，要关掉重开才会用上当前账号。')
    expect(describeRunningTools(report({ running: ['claude'], unknown: ['grok'] }), 'account'))
      .toBe('Claude Code 还开着，要关掉重开才会用上当前账号。如果 Grok CLI 还开着，也要关掉重开才会用上当前账号。')
  })

  it('never names a site or a technical term', () => {
    const text = describeRunningTools(report({ running: ['claude', 'codex', 'gemini', 'grok'], unknown: [], codexDesktopRunning: true }), 'account')
    expect(text).not.toMatch(/solov|Sub2API|Key|PATH|npm|进程/)
  })

  it('tells a Mac user that closing the desktop window is not enough when the app cannot reopen it', () => {
    expect(describeRunningTools(report({ running: ['codex'], unknown: ['grok'], codexDesktopRunning: true, canRestartCodexDesktop: false }), 'official'))
      .toBe('Codex CLI、Codex 桌面端 还开着，要关掉重开才会换回官方账号。Codex 桌面端只关窗口不算，要在它的窗口里按 Command + Q 完全退出再打开。如果 Grok CLI 还开着，也要关掉重开才会换回官方账号。')
  })

  it('keeps the quit hint to a desktop app confirmed open, so an unchecked Windows desktop never hears about Command + Q', () => {
    expect(describeRunningTools(report({ codexDesktopRunning: true }), 'account'))
      .toBe('Codex 桌面端 还开着，要关掉重开才会用上当前账号。')
    expect(describeRunningTools(report({ codexDesktopRunning: null, canRestartCodexDesktop: false }), 'account'))
      .toBe('如果 Codex 桌面端 还开着，要关掉重开才会用上当前账号。')
  })
})

describe('offersCodexDesktopRestart', () => {
  it('offers the restart button only for a desktop app confirmed open on a platform that can restart it', () => {
    expect(offersCodexDesktopRestart(report({ codexDesktopRunning: true }))).toBe(true)
    expect(offersCodexDesktopRestart(report({ codexDesktopRunning: true, canRestartCodexDesktop: false }))).toBe(false)
    expect(offersCodexDesktopRestart(report({ codexDesktopRunning: null }))).toBe(false)
    expect(offersCodexDesktopRestart(undefined)).toBe(false)
  })
})

describe('tool route restart hint', () => {
  it('names only tools that need a restart and leaves Claude Code out', () => {
    expect(toolRouteRestartNeeds(['claude'], report({ running: ['claude'] }), { geminiLaunched: false, platform: 'win32' })).toEqual({})
    expect(toolRouteRestartNeeds(['codex', 'gemini', 'grok'], report({ running: ['codex', 'grok'], codexDesktopRunning: true }), { geminiLaunched: true, platform: 'win32' }))
      .toEqual({ codex: { cli: true, desktop: 'win32', canRestartDesktop: true }, gemini: 'launched', grok: 'running' })
    expect(toolRouteRestartNeeds(['gemini', 'grok'], report({ unknown: ['gemini', 'grok'] }), { geminiLaunched: false, platform: 'linux' }))
      .toEqual({ gemini: 'unknown', grok: 'unknown' })
    expect(toolRouteRestartNeeds(['gemini', 'grok'], report(), { geminiLaunched: false, platform: 'linux' })).toEqual({})
    // 桌面端只在 Windows 和 Mac 上说怎么退出。
    expect(toolRouteRestartNeeds(['codex'], report({ codexDesktopRunning: true }), { geminiLaunched: false, platform: 'linux' }).codex?.desktop).toBeNull()
  })

  it('always mentions editor plugins once Codex moved, even when nothing is known to be open', () => {
    expect(describeToolRouteRestartHint({ id: 1, codex: { cli: false, desktop: null, canRestartDesktop: false } }))
      .toEqual(['如果在 VS Code 等编辑器里用着 Codex，新建对话就走新线路，已经打开的对话要重新加载窗口。'])
  })

  it('uses the approved sentence for each case', () => {
    expect(describeToolRouteRestartHint({ id: 1, codex: { cli: true, desktop: 'darwin', canRestartDesktop: false }, gemini: 'unknown', grok: 'unknown' })).toEqual([
      'Codex 还开着：新建对话就走新线路，已经打开的对话要退出 Codex 再打开。',
      'Codex 桌面端还开着：新建对话就走新线路，已经打开的对话要按 Command + Q 完全退出再打开。',
      '如果在 VS Code 等编辑器里用着 Codex，新建对话就走新线路，已经打开的对话要重新加载窗口。',
      '如果 Gemini 还开着，要关掉再打开才会走新线路。',
      '如果 Grok 还开着，要退出再打开才会走新线路。',
    ])
    expect(describeToolRouteRestartHint({ id: 1, codex: { cli: false, desktop: 'win32', canRestartDesktop: true }, gemini: 'launched', grok: 'running' })).toEqual([
      'Codex 桌面端还开着：新建对话就走新线路，已经打开的对话要完全退出再打开。',
      '如果在 VS Code 等编辑器里用着 Codex，新建对话就走新线路，已经打开的对话要重新加载窗口。',
      '从星芒打开的 Gemini 窗口要关掉再打开，才会走新线路。',
      'Grok 还开着，要退出再打开才会走新线路。',
    ])
  })

  it('offers to restart the desktop app only when it is open and can be restarted', () => {
    expect(offersToolRouteDesktopRestart({ id: 1, codex: { cli: false, desktop: 'win32', canRestartDesktop: true } })).toBe(true)
    expect(offersToolRouteDesktopRestart({ id: 1, codex: { cli: false, desktop: 'darwin', canRestartDesktop: false } })).toBe(false)
    expect(offersToolRouteDesktopRestart({ id: 1, codex: { cli: true, desktop: null, canRestartDesktop: true } })).toBe(false)
    expect(offersToolRouteDesktopRestart(null)).toBe(false)
  })
})
