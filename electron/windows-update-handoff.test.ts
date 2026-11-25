import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildWindowsUpdateHandoffCommand,
  classifyWindowsHandoffLaunchExit,
  createWindowsUpdateHandoff,
  createWindowsUpdateHandoffRecordStore,
  isUpdatePackageDigest,
  parseWindowsUpdateHandoffRecord,
  parseWindowsUpdateHandoffStatus,
  resolvePreviousWindowsHandoffFailure,
  resolveWindowsUpdateHandoffStatusPath,
  runHiddenWindowsProcess,
  windowsHandoffBlockedExitCode,
  windowsUpdateHandoffParentWaitMs,
  type WindowsUpdateHandoffDependencies,
} from './windows-update-handoff'

const digest = Buffer.alloc(64, 9).toString('base64')
const nonce = '0123456789abcdef0123456789abcdef'
const paths = {
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
  it('starts the script unelevated in the system PowerShell to relaunch itself, every value its own argument', () => {
    const command = buildWindowsUpdateHandoffCommand(commandInput())
    expect(command.file).toBe(paths.powershell)
    expect(command.args).toEqual([
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', paths.script,
      '-Relaunch',
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
      { powershell: 'powershell.exe' },
      { powershell: 'C:\\Program Files\\星芒AI管理工具\\resources\\elevate.exe' },
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

  it('maps the exit code of the unelevated relaunch', () => {
    expect(classifyWindowsHandoffLaunchExit(0)).toBe('launched')
    expect(classifyWindowsHandoffLaunchExit(1223)).toBe('cancelled')
    // PowerShell itself stopped the script: ConstrainedLanguage or an execution policy from Group Policy.
    expect(classifyWindowsHandoffLaunchExit(windowsHandoffBlockedExitCode)).toBe('blocked')
    expect(classifyWindowsHandoffLaunchExit(1)).toBe('blocked')
    expect(classifyWindowsHandoffLaunchExit(2)).toBe('failed')
    expect(classifyWindowsHandoffLaunchExit(null)).toBe('failed')
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

  it('remembers the attempt, starts the relaunch and reports verified once the script says so', async () => {
    const { dependencies, reads, handoff } = harness([null, status('started'), '{"nonce":', status('verified')])
    await expect(handoff.start(updatePackage)).resolves.toEqual({ kind: 'verified' })
    expect(dependencies.rememberAttempt).toHaveBeenCalledWith({ nonce, version: '1.1.0' })
    expect(dependencies.launch).toHaveBeenCalledWith(paths.powershell, expect.arrayContaining(['-Relaunch', '-Package', setupFile, '-Nonce', nonce]))
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

  it('reports a relaunch PowerShell refused to run as blocked, remembers that for next launch, and waits for no status', async () => {
    const { dependencies, handoff } = harness([null], { launch: vi.fn(async () => 1) })
    await expect(handoff.start(updatePackage)).resolves.toEqual({ kind: 'blocked', reason: 'PowerShell 未运行安装脚本（退出码 1）' })
    expect(dependencies.rememberAttempt).toHaveBeenNthCalledWith(1, { nonce, version: '1.1.0' })
    expect(dependencies.rememberAttempt).toHaveBeenNthCalledWith(2, { nonce, version: '1.1.0', blocked: true })
    expect(dependencies.readStatus).not.toHaveBeenCalled()
  })

  it('still reports blocked when that could not be remembered', async () => {
    const remember = vi.fn(async (attempt: { blocked?: true }) => { if (attempt.blocked) throw new Error('disk full') })
    const { handoff } = harness([null], { launch: vi.fn(async () => 1), rememberAttempt: remember })
    await expect(handoff.start(updatePackage)).resolves.toMatchObject({ kind: 'blocked' })
  })

  it('reports every other way the handoff can stop as a failure', async () => {
    const cases: Array<[Array<string | null>, Partial<WindowsUpdateHandoffDependencies>, string]> = [
      [[null], { launch: vi.fn(async () => 5) }, '提权请求退出码 5'],
      [[null], { launch: vi.fn(async () => { throw new Error('spawn UNKNOWN') }) }, '提权请求未能启动'],
      [[null], {}, '安装脚本没有启动'],
      [[status('started')], {}, '安装脚本没有核对完'],
      [[status('started'), status('failed')], {}, '安装脚本停在 failed'],
      [[status('verified', { nonce: 'ffffffffffffffffffffffffffffffff' })], {}, '安装脚本没有启动'],
      [[null], { resolvePaths: () => ({ ...paths, powershell: 'powershell.exe' }) }, 'PowerShell不是绝对路径'],
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

describe('launching the relaunch', () => {
  function fakeChild() {
    return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess
  }

  it('starts it hidden and attached, without a shell, with the environment it is given', async () => {
    const child = fakeChild()
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => child)
    const env = { SystemRoot: 'C:\\Windows' }
    const exited = runHiddenWindowsProcess(paths.powershell, ['a b', '中文'], env, spawn)
    child.emit('exit', 1223)
    await expect(exited).resolves.toBe(1223)
    expect(spawn).toHaveBeenCalledWith(paths.powershell, ['a b', '中文'], expect.objectContaining({
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env,
    }))
    // A detached PowerShell has no console; on the CI runner it exited 0 at once
    // without running the script.
    expect(spawn.mock.calls[0]?.[2].detached).not.toBe(true)
  })

  it('drains what it prints so a chatty PowerShell cannot block on a full pipe', async () => {
    const child = fakeChild()
    const exited = runHiddenWindowsProcess(paths.powershell, [], {}, () => child)
    expect(child.stdout?.readableFlowing).toBe(true)
    expect(child.stderr?.readableFlowing).toBe(true)
    child.emit('exit', 0)
    await expect(exited).resolves.toBe(0)
  })

  it('rejects when it cannot be started', async () => {
    const child = fakeChild()
    const exited = runHiddenWindowsProcess(paths.powershell, [], {}, () => child)
    child.emit('error', new Error('ENOENT'))
    await expect(exited).rejects.toThrow('ENOENT')
    const thrown = runHiddenWindowsProcess(paths.powershell, [], {}, () => { throw new Error('EINVAL') })
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
    await store.write({ nonce, version: '1.1.0', blocked: true })
    expect(store.read()).toEqual({ nonce, version: '1.1.0', blocked: true })
    // The next attempt starts from a record without the flag.
    await store.write({ nonce, version: '1.1.0' })
    expect(store.read()).toEqual({ nonce, version: '1.1.0' })
    expect(parseWindowsUpdateHandoffRecord(`{"nonce":"${nonce}","targetVersion":"1.1.0","blocked":"yes"}`)).toEqual({ nonce, version: '1.1.0' })
    expect(parseWindowsUpdateHandoffRecord('{"nonce":"x","targetVersion":"1.1.0"}')).toBeNull()
    expect(parseWindowsUpdateHandoffRecord(`{"nonce":"${nonce}","targetVersion":"../1"}`)).toBeNull()
    expect(parseWindowsUpdateHandoffRecord('not json')).toBeNull()
  })

  it('reports last run\'s installer failure only for the same version still not installed', () => {
    const record = { nonce, version: '1.1.0' }
    const failed = () => status('install-failed', { exitCode: 2 })
    expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.0.0', failed)).toBe('install-failed')
    expect(resolvePreviousWindowsHandoffFailure(record, '1.2.0', '1.0.0', failed)).toBeNull()
    expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.1.0', failed)).toBeNull()
    expect(resolvePreviousWindowsHandoffFailure(null, '1.1.0', '1.0.0', failed)).toBeNull()
    for (const state of ['started', 'verified', 'mismatch', 'aborted', 'installed', 'failed']) {
      expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.0.0', () => status(state)), state).toBeNull()
    }
    expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.0.0', () => null)).toBeNull()
    expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.0.0', () => { throw new Error('EACCES') })).toBeNull()
  })

  it('reports last run\'s blocked relaunch for the same version still not installed, without reading a status', () => {
    const record = { nonce, version: '1.1.0', blocked: true as const }
    const readStatus = vi.fn(() => null)
    expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.0.0', readStatus)).toBe('blocked')
    expect(readStatus).not.toHaveBeenCalled()
    expect(resolvePreviousWindowsHandoffFailure(record, '1.2.0', '1.0.0', readStatus)).toBeNull()
    expect(resolvePreviousWindowsHandoffFailure(record, '1.1.0', '1.1.0', readStatus)).toBeNull()
  })
})

describe('verified-install.ps1', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'build', 'update-handoff', 'verified-install.ps1'), 'utf8')

  it('stays ASCII, because Windows PowerShell 5.1 reads a script without a BOM in the system code page', () => {
    expect([...script].filter((character) => character.charCodeAt(0) > 0x7f)).toEqual([])
  })

  it('never exits with the code the app reads as PowerShell refusing to run it', () => {
    const code = script.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
    const literal = [...code.matchAll(/\bexit\s+(-?\d+)/g)].map((match) => Number(match[1]))
    const named = [...code.matchAll(/^\$(exit\w+)\s*=\s*(-?\d+)/gm)]
    const results = [...code.matchAll(/\$result\s*=\s*(-?\d+)/g)].map((match) => Number(match[1]))
    expect(named.length).toBeGreaterThan(5)
    expect([...literal, ...results, ...named.map((match) => Number(match[2]))]).not.toContain(windowsHandoffBlockedExitCode)
    // Every exit through a variable goes through one of the named codes, or $result, which only ever holds them or 0.
    const names = ['result', ...named.map((match) => match[1])]
    for (const match of code.matchAll(/\bexit\s+\$(\w+)/g)) expect(names, match[1]).toContain(match[1])
    for (const match of code.matchAll(/\$result\s*=\s*\$(\w+)/g)) expect(names, match[1]).toContain(match[1])
  })

  it('waits for the app exactly as long as the app expects', () => {
    expect(script).toContain(`$parentWaitMs = ${windowsUpdateHandoffParentWaitMs}`)
  })

  it('takes the parameters the command passes and nothing else', () => {
    const declared = [...script.matchAll(/^\s+\[(?:string|long|int|switch)\]\$(\w+)/gm)].map((match) => match[1])
    const passed = buildWindowsUpdateHandoffCommand(commandInput()).args
      .filter((arg, index, all) => arg.startsWith('-') && all[index - 1] !== '-WindowStyle' && index > all.indexOf('-File') + 1)
      .map((arg) => arg.slice(1))
    expect([...declared].sort()).toEqual([...passed].sort())
  })

  it('relaunches itself elevated through the shell before it checks for administrator rights', () => {
    const relaunch = script.indexOf('if ($Relaunch) {')
    expect(relaunch).toBeGreaterThan(script.indexOf('$expected = ConvertFrom-ExpectedDigest $Sha512'))
    expect(relaunch).toBeLessThan(script.indexOf('WindowsBuiltInRole]::Administrator'))
    const block = script.slice(relaunch, script.indexOf('\n}\n', relaunch))
    // The system PowerShell from the fixed system directory (I14), the consent
    // prompt through the shell, and a declined prompt told apart from a failure.
    expect(block).toContain("[IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\\v1.0\\powershell.exe')")
    expect(block).toContain('$request.UseShellExecute = $true')
    expect(block).toContain("$request.Verb = 'runas'")
    expect(block).toContain('$failure.NativeErrorCode -eq $exitCancelled')
    expect(script).toContain('$exitCancelled = 1223')
    // Every value goes on to the elevated copy, which is not told to relaunch again.
    for (const name of ['Package', 'Sha512', 'Size', 'ParentPid', 'Nonce']) expect(block).toContain(`' -${name} ' +`)
    expect(block).not.toMatch(/-Relaunch/)
    expect(block).toContain('-File \' + (ConvertTo-QuotedArgument $self)')
  })

  it('gives the installer a temp folder inside the protected staging directory', () => {
    // The installer unpacks and runs things from under TEMP while elevated, so
    // the user's own temp folder must not reach it.
    const created = script.indexOf('[void][IO.Directory]::CreateDirectory($installTemp, $directorySecurity)')
    const started = script.indexOf('$installer = [Diagnostics.Process]::Start($start)')
    expect(script).toContain("$installTemp = [IO.Path]::Combine($staging, 'temp')")
    expect(created).toBeGreaterThan(script.indexOf('$start = [Diagnostics.ProcessStartInfo]::new($payload'))
    for (const name of ['TEMP', 'TMP']) {
      const assigned = script.indexOf(`$start.EnvironmentVariables['${name}'] = $installTemp`)
      expect(assigned).toBeGreaterThan(created)
      expect(assigned).toBeLessThan(started)
    }
    // Removed on the way out, before the staging directory that cannot go while
    // it is still there.
    const cleanup = script.slice(script.indexOf('} finally {'))
    const removed = cleanup.indexOf('[IO.Directory]::Delete($installTemp, $false)')
    expect(removed).toBeGreaterThan(-1)
    expect(removed).toBeLessThan(cleanup.indexOf('[IO.Directory]::Delete($staging, $false)'))
  })

  it('writes its status under the Windows directory it resolves itself, never a path the app passes in', () => {
    expect(script).toContain("'xingmang-update-status-' + $Nonce + '.json'")
    expect(script).toContain('[IO.FileMode]::CreateNew')
    expect(script).not.toMatch(/\$StatusFile|\$env:(?:TEMP|TMP|SystemRoot|windir)/i)
  })
})
