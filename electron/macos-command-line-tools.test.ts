import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandSpec, RunCommandOptions } from './command-runner'
import {
  commandLineToolsShimNotice,
  commandLineToolsTargetFor,
  isCommandLineToolsShimBacked,
  isMacOsCommandLineToolsShim,
  parseXcodeSelectDeveloperDirectory,
  xcodeSelectExecutable,
} from './macos-command-line-tools'

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
    expect(calls).toHaveLength(1)
    expect(calls[0].spec).toEqual({ executable: xcodeSelectExecutable, argv: ['-p'] })
    expect(calls[0].options?.timeoutMs).toBeGreaterThan(0)
    expect(checked).toEqual(['/Library/Developer/CommandLineTools/usr/bin/git'])
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
