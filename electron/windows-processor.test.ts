import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chooseNodeRuntimeArchitecture,
  inspectWindowsExecutableMachine,
  inspectWindowsProcessorArchitecture,
  parseWindowsExecutableMachine,
  parseWindowsProcessorIdentifier,
  parseWindowsSystemProcessorArchitecture,
  resolveWindowsProcessorFromEnvironment,
} from './windows-processor'

const environmentKey = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

function regOutput(name: string, value: string): string {
  return `\r\n${environmentKey}\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`
}

function peHeader(machine: number): Buffer {
  const buffer = Buffer.alloc(512)
  buffer.write('MZ', 0, 'latin1')
  buffer.writeUInt32LE(0x80, 0x3c)
  buffer.writeUInt32LE(0x00004550, 0x80)
  buffer.writeUInt16LE(machine, 0x84)
  return buffer
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('windows-processor', () => {
  it('reads the machine-wide processor architecture from reg query output', () => {
    expect(parseWindowsSystemProcessorArchitecture(regOutput('PROCESSOR_ARCHITECTURE', 'ARM64'))).toBe('arm64')
    expect(parseWindowsSystemProcessorArchitecture(regOutput('PROCESSOR_ARCHITECTURE', 'AMD64'))).toBe('x64')
    expect(parseWindowsSystemProcessorArchitecture(regOutput('PROCESSOR_ARCHITECTURE', 'x86'))).toBeNull()
    expect(parseWindowsSystemProcessorArchitecture('')).toBeNull()
    expect(parseWindowsSystemProcessorArchitecture('x'.repeat(70 * 1024))).toBeNull()
  })

  it('recognizes ARM and x64 CPU identifiers', () => {
    expect(parseWindowsProcessorIdentifier(regOutput('Identifier', 'ARMv8 (64-bit) Family 8 Model 1 Revision 201, Qualcomm Technologies Inc')))
      .toBe('arm64')
    expect(parseWindowsProcessorIdentifier(regOutput('Identifier', 'Intel64 Family 6 Model 154 Stepping 3'))).toBe('x64')
    expect(parseWindowsProcessorIdentifier(regOutput('Identifier', 'AMD64 Family 25 Model 80 Stepping 0'))).toBe('x64')
    expect(parseWindowsProcessorIdentifier(regOutput('Identifier', 'x86 Family 6'))).toBeNull()
  })

  it('only trusts ARM64 from the process environment, never guesses from an emulated AMD64', () => {
    expect(resolveWindowsProcessorFromEnvironment({ PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'ARM64' })).toBe('arm64')
    expect(resolveWindowsProcessorFromEnvironment({ PROCESSOR_ARCHITECTURE: 'ARM64' })).toBe('arm64')
    expect(resolveWindowsProcessorFromEnvironment({ PROCESSOR_ARCHITECTURE: 'AMD64' })).toBe('x64')
    expect(resolveWindowsProcessorFromEnvironment({})).toBeNull()
  })

  it('sees an ARM laptop through the registry even when the emulated process reports AMD64', async () => {
    const queryRegistry = vi.fn(async (_key: string, name: string) => regOutput(name, 'ARM64'))
    await expect(inspectWindowsProcessorArchitecture({
      platform: 'win32',
      env: { PROCESSOR_ARCHITECTURE: 'AMD64' },
      queryRegistry,
    })).resolves.toBe('arm64')
    expect(queryRegistry).toHaveBeenCalledTimes(1)
    expect(queryRegistry.mock.calls[0]?.[0]).toMatch(/Session Manager\\Environment$/)
  })

  it('falls back to the CPU identifier and then the environment when a registry read fails', async () => {
    await expect(inspectWindowsProcessorArchitecture({
      platform: 'win32',
      env: {},
      queryRegistry: async (_key, name) => {
        if (name === 'PROCESSOR_ARCHITECTURE') throw new Error('access denied')
        return regOutput('Identifier', 'ARMv8 (64-bit) Family 8 Model 1 Revision 201')
      },
    })).resolves.toBe('arm64')
    await expect(inspectWindowsProcessorArchitecture({
      platform: 'win32',
      env: { PROCESSOR_ARCHITEW6432: 'ARM64' },
      queryRegistry: async () => { throw new Error('reg.exe missing') },
    })).resolves.toBe('arm64')
    await expect(inspectWindowsProcessorArchitecture({
      platform: 'win32',
      env: {},
      queryRegistry: async () => { throw new Error('reg.exe missing') },
    })).resolves.toBeNull()
  })

  it('does not probe anything outside Windows', async () => {
    const queryRegistry = vi.fn()
    await expect(inspectWindowsProcessorArchitecture({ platform: 'darwin', queryRegistry })).resolves.toBeNull()
    expect(queryRegistry).not.toHaveBeenCalled()
  })

  it('reads the machine type from a PE header', () => {
    expect(parseWindowsExecutableMachine(peHeader(0x8664))).toBe('x64')
    expect(parseWindowsExecutableMachine(peHeader(0xaa64))).toBe('arm64')
    expect(parseWindowsExecutableMachine(peHeader(0x014c))).toBe('x86')
    expect(parseWindowsExecutableMachine(peHeader(0x01c4))).toBeNull()
    expect(parseWindowsExecutableMachine(Buffer.from('#!/bin/sh\n'.padEnd(128, ' ')))).toBeNull()
    const truncated = peHeader(0xaa64)
    truncated.writeUInt32LE(0xfff0, 0x3c)
    expect(parseWindowsExecutableMachine(truncated)).toBeNull()
  })

  it('inspects only absolute .exe paths and tolerates unreadable files', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-pe-header-'))
    temporaryDirectories.push(directory)
    const executable = path.join(directory, 'node.exe')
    fs.writeFileSync(executable, peHeader(0xaa64))
    // path.win32.isAbsolute accepts POSIX absolute paths, so this runs on every platform.
    await expect(inspectWindowsExecutableMachine(executable)).resolves.toBe('arm64')
    await expect(inspectWindowsExecutableMachine(path.join(directory, 'missing.exe'))).resolves.toBeNull()
    await expect(inspectWindowsExecutableMachine(path.join(directory, 'npm.cmd'))).resolves.toBeNull()
    await expect(inspectWindowsExecutableMachine('node.exe')).resolves.toBeNull()
  })

  it('picks the ARM runtime only for a fresh install and keeps an existing runtime on its own build', () => {
    expect(chooseNodeRuntimeArchitecture({ processor: 'arm64', existingNodeMachine: null, nodeInstalled: false })).toBe('arm64')
    expect(chooseNodeRuntimeArchitecture({ processor: 'x64', existingNodeMachine: null, nodeInstalled: false })).toBe('x64')
    expect(chooseNodeRuntimeArchitecture({ processor: null, existingNodeMachine: null, nodeInstalled: false })).toBeUndefined()
    // x64 and arm64 MSIs do not upgrade each other; replacing an old x64 Node.js with arm64 would leave both behind.
    expect(chooseNodeRuntimeArchitecture({ processor: 'arm64', existingNodeMachine: 'x64', nodeInstalled: true })).toBe('x64')
    expect(chooseNodeRuntimeArchitecture({ processor: 'arm64', existingNodeMachine: 'arm64', nodeInstalled: true })).toBe('arm64')
    expect(chooseNodeRuntimeArchitecture({ processor: 'arm64', existingNodeMachine: null, nodeInstalled: true })).toBeUndefined()
    expect(chooseNodeRuntimeArchitecture({ processor: 'arm64', existingNodeMachine: 'x86', nodeInstalled: true })).toBeUndefined()
  })
})
