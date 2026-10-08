import { describe, expect, it } from 'vitest'
import { CommandRunnerError, type CommandResult } from './command-runner'
import { gitMacInstallWaitingHint } from './git-runtime'
import type { GitRuntimeInstallProgress } from './git-runtime-install'
import type { CommandLineToolsShimState } from './macos-command-line-tools'
import {
  installMacGitRuntime,
  isCommandLineToolsInstallerListed,
  macGitAlreadyInstalledButMissingMessage,
  macGitInstallOutcomeMessage,
  requestMacCommandLineToolsInstall,
  waitForMacCommandLineTools,
  type MacGitInstallWaitOutcome,
} from './macos-git-install'

function ok(executable: string, argv: readonly string[]): CommandResult {
  return { executable, argv: [...argv], exitCode: 0, signal: null, stdout: '', stderr: '', outputBytes: 0, durationMs: 1 }
}

function exitError(stderr: string): CommandRunnerError {
  return new CommandRunnerError('failed', {
    code: 'EXIT_NON_ZERO',
    executable: '/usr/bin/xcode-select',
    argv: ['--install'],
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr,
    outputBytes: 0,
    maxOutputBytes: 1,
    durationMs: 1,
  })
}

/** Replays one scripted answer per poll; the clock advances by the poll interval. */
function scripted(git: CommandLineToolsShimState[], installer: Array<boolean | null>) {
  let clock = 0
  let gitIndex = 0
  let installerIndex = 0
  return {
    inspectGit: async () => git[Math.min(gitIndex++, git.length - 1)],
    isInstallerRunning: async () => installer[Math.min(installerIndex++, installer.length - 1)],
    sleep: async (milliseconds: number) => { clock += milliseconds },
    now: () => clock,
  }
}

describe('macOS Git install through the Command Line Tools installer', () => {
  it('runs xcode-select --install by absolute path and recognises an existing install', async () => {
    const calls: string[][] = []
    await expect(requestMacCommandLineToolsInstall(async (executable, argv) => {
      calls.push([executable, ...argv])
      return ok(executable, argv)
    })).resolves.toBe('prompted')
    expect(calls).toEqual([['/usr/bin/xcode-select', '--install']])

    await expect(requestMacCommandLineToolsInstall(async () => {
      throw exitError('xcode-select: error: command line tools are already installed, use "Software Update" to install updates')
    })).resolves.toBe('already-installed')

    await expect(requestMacCommandLineToolsInstall(async () => {
      throw exitError('something else')
    })).rejects.toThrow('没能打开苹果的安装窗口')
  })

  it('keeps what xcode-select said as the cause when the installer window does not open', async () => {
    const refused = exitError('xcode-select: error: invalid developer directory')
    const failure: unknown = await requestMacCommandLineToolsInstall(async () => { throw refused })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error && failure.cause).toBe(refused)
  })

  it('finds the Apple installer in the process list', () => {
    expect(isCommandLineToolsInstallerListed([
      '/sbin/launchd',
      '/System/Library/CoreServices/Install Command Line Developer Tools.app/Contents/MacOS/Install Command Line Developer Tools',
    ].join('\n'))).toBe(true)
    expect(isCommandLineToolsInstallerListed('/sbin/launchd\n/usr/libexec/logd\n')).toBe(false)
  })

  it('reports installed as soon as the real git behind the shim works', async () => {
    await expect(waitForMacCommandLineTools(scripted(['missing', 'missing', 'usable'], [true])))
      .resolves.toBe('installed')
  })

  it('treats the installer disappearing while git still does not work as a cancel', async () => {
    await expect(waitForMacCommandLineTools(scripted(['missing'], [true, true, false, false])))
      .resolves.toBe('cancelled')
  })

  it('does not call it a cancel when the installer exits because it just finished', async () => {
    // Last check after the installer is gone: the tools landed in that same moment.
    await expect(waitForMacCommandLineTools(scripted(['missing', 'missing', 'missing', 'usable'], [true, false, false])))
      .resolves.toBe('installed')
  })

  it('stops spinning without claiming a cancel when the installer never showed up', async () => {
    await expect(waitForMacCommandLineTools(scripted(['missing'], [false]), { pollMs: 5_000, unseenGiveUpMs: 60_000 }))
      .resolves.toBe('unconfirmed')
    await expect(waitForMacCommandLineTools(scripted(['missing'], [null]), { pollMs: 5_000, unseenGiveUpMs: 60_000 }))
      .resolves.toBe('unconfirmed')
  })

  it('gives up after the timeout while the installer is still running', async () => {
    await expect(waitForMacCommandLineTools(scripted(['missing'], [true]), { pollMs: 60_000, timeoutMs: 10 * 60_000 }))
      .resolves.toBe('timed-out')
  })

  it('keeps technical words out of every outcome sentence', () => {
    for (const outcome of ['installed', 'cancelled', 'unconfirmed', 'timed-out'] as MacGitInstallWaitOutcome[]) {
      expect(macGitInstallOutcomeMessage(outcome)).not.toMatch(/终端|xcode|brew|PATH|命令行开发者工具/i)
    }
    expect(macGitInstallOutcomeMessage('cancelled')).toBe('没有装 Git。需要时再点一次「安装 Git」就行。')
  })
})

describe('installMacGitRuntime', () => {
  function dependencies(overrides: Partial<Parameters<typeof installMacGitRuntime>[0]> = {}) {
    const progress: GitRuntimeInstallProgress[] = []
    const calls: string[] = []
    return {
      progress,
      calls,
      deps: {
        inspectInstalled: async () => null,
        inspectShim: async (): Promise<CommandLineToolsShimState> => 'missing',
        request: async () => { calls.push('request'); return 'prompted' as const },
        wait: async () => { calls.push('wait'); return 'installed' as const },
        onProgress: (entry: GitRuntimeInstallProgress) => progress.push(entry),
        ...overrides,
      },
    }
  }

  it('leaves an existing Git alone without opening the Apple window', async () => {
    const { deps, calls } = dependencies({ inspectInstalled: async () => ({ version: '2.39.5' }) })
    await expect(installMacGitRuntime(deps, 'arm64')).resolves.toMatchObject({
      installed: true,
      action: 'unchanged',
      version: '2.39.5',
    })
    expect(calls).toEqual([])
  })

  it('opens the Apple window, tells the customer what to click, and reports the installed version', async () => {
    let installedYet = false
    const { deps, progress, calls } = dependencies({
      inspectInstalled: async () => installedYet ? { version: '2.39.5' } : null,
      wait: async () => { calls.push('wait'); installedYet = true; return 'installed' },
    })
    await expect(installMacGitRuntime(deps, 'arm64')).resolves.toMatchObject({
      installed: true,
      action: 'installed',
      version: '2.39.5',
      pathRefreshRequired: false,
    })
    expect(calls).toEqual(['request', 'wait'])
    expect(progress.map((entry) => entry.message)).toContain(gitMacInstallWaitingHint)
  })

  it('returns a not-installed result with the sentence to show when the customer cancels', async () => {
    const { deps } = dependencies({ wait: async () => 'cancelled' })
    await expect(installMacGitRuntime(deps, 'x64')).resolves.toEqual({
      installed: false,
      action: 'cancelled',
      source: null,
      version: null,
      architecture: 'x64',
      pathRefreshRequired: false,
      message: '没有装 Git。需要时再点一次「安装 Git」就行。',
    })
    const pending = dependencies({ wait: async () => 'timed-out' })
    await expect(installMacGitRuntime(pending.deps, 'x64')).resolves.toMatchObject({ installed: false, action: 'pending' })
  })

  it('points at the Xcode agreement instead of opening a window that would not appear', async () => {
    const { deps, calls } = dependencies({ inspectShim: async () => 'license-pending' })
    await expect(installMacGitRuntime(deps, 'arm64')).rejects.toThrow('点「同意」')
    expect(calls).toEqual([])
  })

  it('says so when Apple claims the tools are installed but Git still does not work', async () => {
    const { deps } = dependencies({ request: async () => 'already-installed' })
    await expect(installMacGitRuntime(deps, 'arm64')).rejects.toThrow(macGitAlreadyInstalledButMissingMessage)
  })
})
