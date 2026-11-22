import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildWindowsUpdateHandoffCommand,
  classifyWindowsElevateExit,
  createWindowsUpdateHandoff,
  createWindowsUpdateHandoffRecordStore,
  isUpdatePackageDigest,
  launchDetachedWindowsProcess,
  parseWindowsUpdateHandoffRecord,
  parseWindowsUpdateHandoffStatus,
  resolvePreviousWindowsHandoffFailure,
  resolveWindowsUpdateHandoffStatusPath,
  windowsUpdateHandoffParentWaitMs,
  type WindowsUpdateHandoffDependencies,
} from './windows-update-handoff'

const digest = Buffer.alloc(64, 9).toString('base64')
const nonce = '0123456789abcdef0123456789abcdef'
const paths = {
  elevate: 'C:\\Program Files\\星芒AI管理工具\\resources\\elevate.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  script: 'C:\\Program Files\\星芒AI管理工具\\resources\\update-handoff\\verified-install.ps1',
  windowsDirectory: 'C:\\Windows',
}
const setupFile = 'C:\\Users\\测试 用户\\下载 目录\\XingMang-AI-Manager-1.1.0-Setup.exe'
const updatePackage = { path: setupFile, sha512: digest, size: 4242, version: '1.1.0' }

function commandInput(overrides: Record<string, unknown> = {}) {
  return { ...paths, packagePath: setupFile, sha512: digest, size: 4242, parentPid: 4321, nonce, ...overrides }
}

function status(state: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ nonce, state, exitCode: 0, ...extra })
}

describe('windows update handoff command', () => {
  it('starts the system PowerShell through elevate.exe with every value as its own argument', () => {
    const command = buildWindowsUpdateHandoffCommand(commandInput())
    expect(command.file).toBe(paths.elevate)
    expect(command.args).toEqual([
      paths.powershell,
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', paths.script,
      '-Package', setupFile,
      '-Sha512', digest,
      '-Size', '4242',
      '-ParentPid', '4321',
      '-Nonce', nonce,
    ])
    // Spaces and Chinese stay exactly as they are; quoting is left to the
    // Windows argument rules Node applies when it builds the command line.
    expect(command.args.filter((arg) => arg.includes('"'))).toEqual([])
  })

  it('passes an unknown size as 0 and accepts the hex digest form too', () => {
    const hex = Buffer.alloc(64, 9).toString('hex').toUpperCase()
    const command = buildWindowsUpdateHandoffCommand(commandInput({ size: null, sha512: hex }))
    expect(command.args[command.args.indexOf('-Size') + 1]).toBe('0')
    expect(command.args[command.args.indexOf('-Sha512') + 1]).toBe(hex)
  })

  it('refuses relative, drive-relative and device paths, and anything that is not the expected program', () => {
    for (const overrides of [
      { elevate: 'elevate.exe' },
      { elevate: 'C:\\Program Files\\星芒AI管理工具\\resources\\other.exe' },
      { powershell: 'powershell.exe' },
      { powershell: 'C:\\Users\\测试 用户\\powershell.exe.lnk' },
      { script: 'C:verified-install.ps1' },
      { script: 'C:\\Program Files\\星芒AI管理工具\\resources\\update-handoff\\verified-install.txt' },
      { packagePath: 'pending\\XingMang-AI-Manager-1.1.0-Setup.exe' },
      { packagePath: '\\\\.\\pipe\\XingMang-AI-Manager-1.1.0-Setup.exe' },
      { packagePath: '\\\\?\\C:\\pending\\XingMang-AI-Manager-1.1.0-Setup.exe' },
      { packagePath: 'C:\\pending\\XingMang-AI-Manager-1.1.0-Setup.msi' },
      { packagePath: 'C:\\pending\\a\0b.exe' },
    ]) {
      expect(() => buildWindowsUpdateHandoffCommand(commandInput(overrides)), JSON.stringify(overrides)).toThrow()
    }
  })

  it('refuses a digest, size, process id or nonce that is not well formed', () => {
    for (const overrides of [
      { sha512: '' },
      { sha512: 'not a digest' },
      { sha512: Buffer.alloc(32, 9).toString('base64') },
      { sha512: `${digest.slice(0, 85)}B==` },
      { size: -1 },
      { size: 1.5 },
      { size: 3 * 1024 ** 3 },
      { parentPid: 0 },
      { parentPid: Number.NaN },
      { nonce: 'ABCDEF' },
      { nonce: `${nonce} -Package C:\\other.exe` },
    ]) {
      expect(() => buildWindowsUpdateHandoffCommand(commandInput(overrides)), JSON.stringify(overrides)).toThrow()
    }
  })

  it('recognises only the canonical base64 or the hex form of a 64-byte digest', () => {
    expect(isUpdatePackageDigest(digest)).toBe(true)
    expect(isUpdatePackageDigest('a'.repeat(128))).toBe(true)
    expect(isUpdatePackageDigest('a'.repeat(127))).toBe(false)
    expect(isUpdatePackageDigest(`${digest.slice(0, 85)}B==`)).toBe(false)
  })

  it('puts the status file in the Windows Temp directory under this handoff\'s nonce', () => {
    expect(resolveWindowsUpdateHandoffStatusPath('C:\\Windows', nonce)).toBe(`C:\\Windows\\Temp\\xingmang-update-status-${nonce}.json`)
    expect(() => resolveWindowsUpdateHandoffStatusPath('Windows', nonce)).toThrow()
    expect(() => resolveWindowsUpdateHandoffStatusPath('C:\\Windows', '..\\..\\x')).toThrow()
  })
})

describe('windows update handoff status', () => {
  it('reads only a complete status written for this nonce', () => {
    expect(parseWindowsUpdateHandoffStatus(status('verified'), nonce)).toEqual({ state: 'verified', exitCode: 0 })
    expect(parseWindowsUpdateHandoffStatus(status('install-failed', { exitCode: 2 }), nonce)).toEqual({ state: 'install-failed', exitCode: 2 })
    expect(parseWindowsUpdateHandoffStatus(JSON.stringify({ nonce, state: 'started' }), nonce)).toEqual({ state: 'started', exitCode: 0 })
    for (const content of [
      null,
      '',
      '{"nonce":"0123',
      status('verified', { nonce: 'ffffffffffffffffffffffffffffffff' }),
      status('installing'),
      status('verified', { exitCode: '0' }),
      '[]',
    ]) {
      expect(parseWindowsUpdateHandoffStatus(content, nonce), String(content)).toBeNull()
    }
  })

  it('maps the elevate.exe exit code', () => {
    expect(classifyWindowsElevateExit(0)).toBe('launched')
    expect(classifyWindowsElevateExit(1223)).toBe('cancelled')
    expect(classifyWindowsElevateExit(1)).toBe('failed')
    expect(classifyWindowsElevateExit(null)).toBe('failed')
  })
})

describe('windows update handoff', () => {
  function harness(statuses: Array<string | null>, overrides: Partial<WindowsUpdateHandoffDependencies> = {}) {
    let clock = 0
    const reads: string[] = []
    const dependencies: WindowsUpdateHandoffDependencies = {
      resolvePaths: () => paths,
      parentPid: 4321,
      launch: vi.fn(async () => 0),
      readStatus: vi.fn(async (filePath: string) => {
        reads.push(filePath)
        return statuses.length > 1 ? statuses.shift() ?? null : statuses[0] ?? null
      }),
      rememberAttempt: vi.fn(async () => undefined),
      createNonce: () => nonce,
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
      startedTimeoutMs: 1_000,
      verifiedTimeoutMs: 5_000,
      pollIntervalMs: 250,
      ...overrides,
    }
    return { dependencies, reads, handoff: createWindowsUpdateHandoff(dependencies) }
  }

  it('remembers the attempt, starts elevate.exe and reports verified once the script says so', async () => {
    const { dependencies, reads, handoff } = harness([null, status('started'), '{"nonce":', status('verified')])
    await expect(handoff.start(updatePackage)).resolves.toEqual({ kind: 'verified' })
    expect(dependencies.rememberAttempt).toHaveBeenCalledWith({ nonce, version: '1.1.0' })
    expect(dependencies.launch).toHaveBeenCalledWith(paths.elevate, expect.arrayContaining(['-Package', setupFile, '-Nonce', nonce]))
    expect(new Set(reads)).toEqual(new Set([`C:\\Windows\\Temp\\xingmang-update-status-${nonce}.json`]))
  })

  it('reports a mismatch from the script', async () => {
    const { handoff } = harness([status('started'), status('mismatch')])
    await expect(handoff.start(updatePackage)).resolves.toEqual({ kind: 'mismatch' })
  })

  it('reports a cancelled prompt without waiting for a status', async () => {
    const { dependencies, handoff } = harness([null], { launch: vi.fn(async () => 1223) })
    await expect(handoff.start(updatePackage)).resolves.toEqual({ kind: 'cancelled' })
    expect(dependencies.readStatus).not.toHaveBeenCalled()
  })

  it('reports every other way the handoff can stop as a failure', async () => {
    const cases: Array<[Array<string | null>, Partial<WindowsUpdateHandoffDependencies>, string]> = [
      [[null], { launch: vi.fn(async () => 1) }, '提权程序退出码 1'],
      [[null], { launch: vi.fn(async () => { throw new Error('spawn UNKNOWN') }) }, '提权程序未能启动'],
      [[null], {}, '安装脚本没有启动'],
      [[status('started')], {}, '安装脚本没有核对完'],
      [[status('started'), status('failed')], {}, '安装脚本停在 failed'],
      [[status('verified', { nonce: 'ffffffffffffffffffffffffffffffff' })], {}, '安装脚本没有启动'],
      [[null], { resolvePaths: () => ({ ...paths, elevate: 'elevate.exe' }) }, '提权程序不是绝对路径'],
    ]
    for (const [statuses, overrides, reason] of cases) {
      const { handoff } = harness(statuses, overrides)
      const outcome = await handoff.start(updatePackage)
      expect(outcome.kind, reason).toBe('failed')
      expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(reason)
    }
  })

  it('still hands over when the attempt could not be remembered', async () => {
    const { handoff } = harness([status('verified')], { rememberAttempt: vi.fn(async () => { throw new Error('disk full') }) })
    await expect(handoff.start(updatePackage)).resolves.toEqual({ kind: 'verified' })
  })

  it('treats a status read that throws as not written yet', async () => {
    let first = true
    const { handoff } = harness([null], {
      readStatus: vi.fn(async () => {
        if (first) {
          first = false
          throw new Error('EBUSY')
        }
        return status('verified')
      }),
    })
    await expect(handoff.start(updatePackage)).resolves.toEqual({ kind: 'verified' })
  })
})

describe('launching elevate.exe', () => {
  function fakeChild() {
    return Object.assign(new EventEmitter(), { unref: vi.fn() }) as unknown as ChildProcess
  }

  it('starts it detached, without a shell, with the environment it is given', async () => {
    const child = fakeChild()
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => child)
    const env = { SystemRoot: 'C:\\Windows' }
    const exited = launchDetachedWindowsProcess(paths.elevate, ['a b', '中文'], env, spawn)
    child.emit('exit', 1223)
    await expect(exited).resolves.toBe(1223)
    expect(spawn).toHaveBeenCalledWith(paths.elevate, ['a b', '中文'], expect.objectContaining({
      detached: true, shell: false, stdio: 'ignore', windowsHide: true, env,
    }))
  })

  it('rejects when it cannot be started', async () => {
    const child = fakeChild()
    const exited = launchDetachedWindowsProcess(paths.elevate, [], {}, () => child)
    child.emit('error', new Error('ENOENT'))
    await expect(exited).rejects.toThrow('ENOENT')
    const thrown = launchDetachedWindowsProcess(paths.elevate, [], {}, () => { throw new Error('EINVAL') })
    await expect(thrown).rejects.toThrow('EINVAL')
  })
})

describe('windows update handoff record', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('writes and reads back the last attempt, and ignores anything else', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-update-handoff-'))
    roots.push(root)
    const store = createWindowsUpdateHandoffRecordStore({ filePath: path.join(root, 'data', 'update-handoff.json') })
    expect(store.read()).toBeNull()
    await store.write({ nonce, version: '1.1.0' })
    expect(store.read()).toEqual({ nonce, version: '1.1.0' })
    expect(parseWindowsUpdateHandoffRecord('{"nonce":"x","targetVersion":"1.1.0"}')).toBeNull()
    expect(parseWindowsUpdateHandoffRecord(`{"nonce":"${nonce}","targetVersion":"../1"}`)).toBeNull()
    expect(parseWindowsUpdateHandoffRecord('not json')).toBeNull()
  })

  it('reports last run\'s installer failure only for the same version still not installed', () => {
    const record = { nonce, version: '1.1.0' }
    const failed = () => status('install-failed', { exitCode: 2 })
    expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.0.0', failed)).toBe(true)
    expect(resolvePreviousWindowsHandoffFailure(record, '1.2.0', '1.0.0', failed)).toBe(false)
    expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.1.0', failed)).toBe(false)
    expect(resolvePreviousWindowsHandoffFailure(null, '1.1.0', '1.0.0', failed)).toBe(false)
    for (const state of ['started', 'verified', 'mismatch', 'aborted', 'installed', 'failed']) {
      expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.0.0', () => status(state)), state).toBe(false)
    }
    expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.0.0', () => null)).toBe(false)
    expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.0.0', () => { throw new Error('EACCES') })).toBe(false)
  })
})

describe('verified-install.ps1', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'build', 'update-handoff', 'verified-install.ps1'), 'utf8')

  it('stays ASCII, because Windows PowerShell 5.1 reads a script without a BOM in the system code page', () => {
    expect([...script].filter((character) => character.charCodeAt(0) > 0x7f)).toEqual([])
  })

  it('waits for the app exactly as long as the app expects', () => {
    expect(script).toContain(`$parentWaitMs = ${windowsUpdateHandoffParentWaitMs}`)
  })

  it('takes the parameters the command passes and nothing else', () => {
    const declared = [...script.matchAll(/^\s+\[(?:string|long|int)\]\$(\w+)/gm)].map((match) => match[1])
    const passed = buildWindowsUpdateHandoffCommand(commandInput()).args
      .filter((arg, index, all) => arg.startsWith('-') && all[index - 1] !== '-WindowStyle' && index > all.indexOf('-File') + 1)
      .map((arg) => arg.slice(1))
    expect(declared).toEqual(passed)
  })

  it('writes its status under the Windows directory it resolves itself, never a path the app passes in', () => {
    expect(script).toContain("'xingmang-update-status-' + $Nonce + '.json'")
    expect(script).toContain('[IO.FileMode]::CreateNew')
    expect(script).not.toMatch(/\$StatusFile|\$env:(?:TEMP|TMP|SystemRoot|windir)/i)
  })
})
