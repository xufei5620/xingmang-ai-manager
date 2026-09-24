import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandSpec, RunCommandOptions } from './command-runner'
import {
  commandLineToolsShimNotice,
  commandLineToolsTargetFor,
  inspectCommandLineToolsShim,
  isCommandLineToolsShimBacked,
  isMacOsCommandLineToolsShim,
  isXcodeLicenseNotAgreedOutput,
  parseXcodeSelectDeveloperDirectory,
  xcodeLicensePendingNotice,
  xcodeSelectExecutable,
} from './macos-command-line-tools'

// xcrun 在 Xcode 许可协议没同意时打印的原文（2026-09-24 yoyo 的 Mac 上截到的）。
const xcodeLicenseMessage = "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license."

function result(spec: CommandSpec, stdout: string): CommandResult {
  return {
    executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null,
    stdout, stderr: '', outputBytes: stdout.length, durationMs: 1,
  }
}

describe('macos-command-line-tools', () => {
  it('treats only the two system trampolines on macOS as shims', () => {
    expect(isMacOsCommandLineToolsShim('/usr/bin/git', 'darwin')).toBe(true)
    expect(isMacOsCommandLineToolsShim('/usr/bin/python3', 'darwin')).toBe(true)
    expect(isMacOsCommandLineToolsShim('/usr//bin/./git', 'darwin')).toBe(true)
    // 用户自己装的那份照常探测。
    expect(isMacOsCommandLineToolsShim('/opt/homebrew/bin/git', 'darwin')).toBe(false)
    expect(isMacOsCommandLineToolsShim('/usr/local/bin/python3', 'darwin')).toBe(false)
    expect(isMacOsCommandLineToolsShim('/usr/bin/node', 'darwin')).toBe(false)
    expect(isMacOsCommandLineToolsShim(null, 'darwin')).toBe(false)
    // 其余平台上同一路径是真的 git，不许被挡。
    expect(isMacOsCommandLineToolsShim('/usr/bin/git', 'linux')).toBe(false)
    expect(isMacOsCommandLineToolsShim('/usr/bin/git', 'win32')).toBe(false)
  })

  it('parses only an absolute developer directory from xcode-select', () => {
    expect(parseXcodeSelectDeveloperDirectory('/Library/Developer/CommandLineTools\n'))
      .toBe('/Library/Developer/CommandLineTools')
    expect(parseXcodeSelectDeveloperDirectory('\n/Applications/Xcode.app/Contents/Developer/\n'))
      .toBe('/Applications/Xcode.app/Contents/Developer/')
    expect(parseXcodeSelectDeveloperDirectory('')).toBeNull()
    expect(parseXcodeSelectDeveloperDirectory('CommandLineTools')).toBeNull()
  })

  it('maps a shim to the same-named command inside the developer directory', () => {
    expect(commandLineToolsTargetFor('/Library/Developer/CommandLineTools', '/usr/bin/python3'))
      .toBe('/Library/Developer/CommandLineTools/usr/bin/python3')
  })

  it('asks xcode-select through argv and accepts the shim only when its target exists', async () => {
    const calls: Array<{ spec: CommandSpec; options: RunCommandOptions | undefined }> = []
    const checked: string[] = []
    const backed = await isCommandLineToolsShimBacked('/usr/bin/git', {
      runCommand: async (spec, options) => {
        calls.push({ spec, options })
        return result(spec, '/Library/Developer/CommandLineTools\n')
      },
      isFile: (candidate) => {
        checked.push(candidate)
        return true
      },
    })

    expect(backed).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0].spec).toEqual({ executable: xcodeSelectExecutable, argv: ['-p'] })
    expect(calls[0].options?.timeoutMs).toBeGreaterThan(0)
    // 背后那份确认在了才试跑空壳本身，这一步不会招来安装对话框。
    expect(calls[1].spec).toEqual({ executable: '/usr/bin/git', argv: ['--version'] })
    expect(calls[1].options?.timeoutMs).toBeGreaterThan(0)
    expect(checked).toEqual(['/Library/Developer/CommandLineTools/usr/bin/git'])
  })

  it('never runs the shim itself when nothing stands behind it', async () => {
    const executed: string[] = []
    await expect(inspectCommandLineToolsShim('/usr/bin/python3', {
      runCommand: async (spec) => {
        executed.push(spec.executable)
        return result(spec, '/Library/Developer/CommandLineTools\n')
      },
      isFile: () => false,
    })).resolves.toBe('missing')
    expect(executed).toEqual([xcodeSelectExecutable])
  })

  it('reports a pending Xcode license instead of accepting the shim', async () => {
    const state = await inspectCommandLineToolsShim('/usr/bin/python3', {
      runCommand: async (spec) => {
        if (spec.executable === xcodeSelectExecutable) return result(spec, '/Applications/Xcode.app/Contents/Developer\n')
        // xcrun 以退出码 69 失败，原文只在 stderr。
        throw Object.assign(new Error('Command failed with exit code 69'), { stdout: '', stderr: `${xcodeLicenseMessage}\n` })
      },
      isFile: () => true,
    })

    expect(state).toBe('license-pending')
    await expect(isCommandLineToolsShimBacked('/usr/bin/python3', {
      runCommand: async (spec) => {
        if (spec.executable === xcodeSelectExecutable) return result(spec, '/Applications/Xcode.app/Contents/Developer\n')
        throw Object.assign(new Error('Command failed with exit code 69'), { stdout: '', stderr: xcodeLicenseMessage })
      },
      isFile: () => true,
    })).resolves.toBe(false)
  })

  it('treats any other failed trial run as missing', async () => {
    await expect(inspectCommandLineToolsShim('/usr/bin/git', {
      runCommand: async (spec) => {
        if (spec.executable === xcodeSelectExecutable) return result(spec, '/Library/Developer/CommandLineTools\n')
        throw Object.assign(new Error('timed out'), { stdout: '', stderr: 'xcrun: error: invalid active developer path' })
      },
      isFile: () => true,
    })).resolves.toBe('missing')
  })

  it('recognizes only the Xcode license complaint', () => {
    expect(isXcodeLicenseNotAgreedOutput(xcodeLicenseMessage)).toBe(true)
    expect(isXcodeLicenseNotAgreedOutput('xcrun: error: invalid active developer path')).toBe(false)
    expect(isXcodeLicenseNotAgreedOutput('')).toBe(false)
  })

  it('explains the pending license in plain words without asking for sudo', () => {
    const notice = xcodeLicensePendingNotice('python3')
    expect(notice).toContain('Xcode')
    expect(notice).toContain('同意')
    expect(notice).toContain('Python')
    expect(notice).not.toMatch(/sudo|xcodebuild|终端|Terminal/)
    expect(notice).not.toMatch(/[。.]$/)
    expect(xcodeLicensePendingNotice('git')).toContain('Git')
  })

  it('refuses the shim when xcode-select fails, prints nothing, or points at a removed directory', async () => {
    await expect(isCommandLineToolsShimBacked('/usr/bin/git', {
      runCommand: async () => { throw new Error('xcode-select: error: unable to get active developer directory') },
      isFile: () => true,
    })).resolves.toBe(false)
    await expect(isCommandLineToolsShimBacked('/usr/bin/git', {
      runCommand: async (spec) => result(spec, ''),
      isFile: () => true,
    })).resolves.toBe(false)
    // 手动删掉 CommandLineTools 之后 xcode-select 仍可能打印旧路径。
    await expect(isCommandLineToolsShimBacked('/usr/bin/python3', {
      runCommand: async (spec) => result(spec, '/Library/Developer/CommandLineTools\n'),
      isFile: () => false,
    })).resolves.toBe(false)
  })

  it('tells the customer why the built-in command does not count and how to fix it', () => {
    const notice = commandLineToolsShimNotice('git')
    expect(notice).toContain('空壳')
    expect(notice).toContain('xcode-select --install')
    expect(notice).not.toMatch(/[。.]$/)
  })
})
