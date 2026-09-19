import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearDarwinClaudeVerificationCache,
  verifyDarwinClaudeNativeExecutable,
} from './macos-claude'

const temporaryDirectories: string[] = []

// Windows reports no execute bits and has no realpath semantics this module relies on.
// The branch that calls it is gated on platform === 'darwin', so Linux coverage is
// enough to keep the trust decision honest on CI.
const onPosix = process.platform !== 'win32'

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-claude-'))
  temporaryDirectories.push(directory)
  return directory
}

function writeExecutable(filePath: string, content = 'fixture binary'): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, { mode: 0o700 })
  return filePath
}

function expectedArgv(executablePath: string): string[] {
  return [
    '--verify',
    '--strict',
    '-R=anchor apple generic'
      + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
      + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
      + ' and certificate leaf[subject.OU] = "Q6L2SF6YDW"',
    executablePath,
  ]
}

beforeEach(() => {
  clearDarwinClaudeVerificationCache()
})

afterEach(() => {
  clearDarwinClaudeVerificationCache()
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('verifyDarwinClaudeNativeExecutable', () => {
  it.runIf(onPosix)('pins the natively installed claude to Anthropic\'s Developer ID team', async () => {
    const executable = writeExecutable(path.join(temporaryDirectory(), 'claude'))
    const specs: Array<{ executable: string; argv: readonly string[] }> = []

    const verified = await verifyDarwinClaudeNativeExecutable({
      commandPath: executable,
      runCommand: async (spec) => {
        specs.push(spec)
        return { stdout: '', stderr: '' }
      },
    })

    expect(verified).toBe(fs.realpathSync(executable))
    expect(specs).toEqual([
      { executable: '/usr/bin/codesign', argv: expectedArgv(verified) },
    ])
  })

  it.runIf(onPosix)('verifies the resolved target rather than the symlink on PATH', async () => {
    const directory = temporaryDirectory()
    const target = writeExecutable(path.join(directory, 'versions', '2.1.278', 'claude'))
    const link = path.join(directory, 'bin', 'claude')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(target, link)
    const specs: Array<{ executable: string; argv: readonly string[] }> = []

    const verified = await verifyDarwinClaudeNativeExecutable({
      commandPath: link,
      runCommand: async (spec) => {
        specs.push(spec)
        return { stdout: '', stderr: '' }
      },
    })

    expect(verified).toBe(fs.realpathSync(target))
    expect(specs[0]!.argv).toEqual(expectedArgv(fs.realpathSync(target)))
  })

  it.runIf(onPosix)('fails closed when codesign rejects the executable', async () => {
    const executable = writeExecutable(path.join(temporaryDirectory(), 'claude'))

    // The codesign failure is wrapped so the reported reason names the trust decision
    // instead of leaking a bare command error, with the original kept as the cause.
    await expect(verifyDarwinClaudeNativeExecutable({
      commandPath: executable,
      runCommand: async () => {
        throw new Error('code object is not signed at all')
      },
    })).rejects.toThrow('Anthropic Developer ID')
  })

  it.runIf(onPosix)('does not cache a rejected executable', async () => {
    const executable = writeExecutable(path.join(temporaryDirectory(), 'claude'))
    let calls = 0
    const runCommand = async () => {
      calls += 1
      throw new Error('code object is not signed at all')
    }

    await expect(verifyDarwinClaudeNativeExecutable({ commandPath: executable, runCommand }))
      .rejects.toThrow('Anthropic Developer ID')
    await expect(verifyDarwinClaudeNativeExecutable({ commandPath: executable, runCommand }))
      .rejects.toThrow('Anthropic Developer ID')

    expect(calls).toBe(2)
  })

  it.runIf(onPosix)('reuses the verification while the executable is unchanged', async () => {
    const executable = writeExecutable(path.join(temporaryDirectory(), 'claude'))
    let calls = 0
    const runCommand = async () => {
      calls += 1
      return { stdout: '', stderr: '' }
    }

    await verifyDarwinClaudeNativeExecutable({ commandPath: executable, runCommand })
    await verifyDarwinClaudeNativeExecutable({ commandPath: executable, runCommand })

    expect(calls).toBe(1)
  })

  it.runIf(onPosix)('verifies again after the executable is replaced', async () => {
    const executable = writeExecutable(path.join(temporaryDirectory(), 'claude'))
    let calls = 0
    const runCommand = async () => {
      calls += 1
      return { stdout: '', stderr: '' }
    }

    await verifyDarwinClaudeNativeExecutable({ commandPath: executable, runCommand })
    fs.rmSync(executable)
    writeExecutable(executable, 'a different binary')
    await verifyDarwinClaudeNativeExecutable({ commandPath: executable, runCommand })

    expect(calls).toBe(2)
  })

  it.runIf(onPosix)('rejects a target that is not an executable file', async () => {
    const directory = temporaryDirectory()
    const target = path.join(directory, 'claude')
    fs.writeFileSync(target, 'not executable', { mode: 0o600 })

    await expect(verifyDarwinClaudeNativeExecutable({
      commandPath: target,
      runCommand: async () => ({ stdout: '', stderr: '' }),
    })).rejects.toThrow('不是可执行文件')
  })

  it.runIf(onPosix)('rejects a command path that cannot be resolved', async () => {
    const directory = temporaryDirectory()

    await expect(verifyDarwinClaudeNativeExecutable({
      commandPath: path.join(directory, 'missing', 'claude'),
      runCommand: async () => ({ stdout: '', stderr: '' }),
    })).rejects.toThrow('无法定位')
  })
})
