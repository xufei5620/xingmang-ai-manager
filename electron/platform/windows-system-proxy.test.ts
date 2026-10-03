import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandRunnerError, type CommandErrorCode, type runCommand } from '../command-runner'
import { scanPowerShell, unbalancedBracket } from '../powershell-script-scan.test-support'
import {
  buildWindowsLoopbackProxySnapshot, createWindowsSystemProxy, parseWindowsProxySnapshot, shouldRetryWithCompiledScript,
  windowsSystemProxyCompiledScript, windowsSystemProxyScript, type WindowsProxySnapshot,
} from './windows-system-proxy'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

function commandFailure(code: CommandErrorCode, exitCode: number | null, stderr = ''): CommandRunnerError {
  return new CommandRunnerError('PowerShell 未完成。', {
    code, executable: 'powershell.exe', argv: [], exitCode, signal: null, stdout: '', stderr, outputBytes: 0, maxOutputBytes: 0, durationMs: 0,
  })
}

const scriptBlockScanningRefusal = 'This script contains malicious content and has been blocked by your antivirus software.\r\n'
  + '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException\r\n'
  + '    + FullyQualifiedErrorId : ScriptContainedMaliciousContent\r\n'

function scriptOf(argv: readonly string[]): string {
  return Buffer.from(argv[4], 'base64').toString('utf16le')
}

function originalSnapshot(): WindowsProxySnapshot {
  return {
    flags: 13, server: 'legacy.example.test:8080', bypass: '*.internal.example.test', autoConfigUrl: 'https://pac.example.test/config',
    registry: { ProxyEnable: 0, ProxyServer: 'legacy.example.test:8080', ProxyOverride: null, AutoConfigURL: 'https://pac.example.test/config' },
  }
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-proxy-lease-'))
  directories.push(directory)
  const journalPath = path.join(directory, 'system-proxy.json')
  const lockPath = `${journalPath}.lock`
  const before = originalSnapshot()
  let current = structuredClone(before)
  let ownerTime: string | null = '134022112340000000'
  let failApply: 'before' | 'after' | null = null
  let beforeApply: ((expected: WindowsProxySnapshot, desired: WindowsProxySnapshot) => void) | null = null
  let lockDepth = 0
  let lockQueue: Promise<unknown> = Promise.resolve()
  const mutations: WindowsProxySnapshot[] = []
  const execute = vi.fn<typeof runCommand>(async (spec, options) => {
    expect(lockDepth).toBe(1)
    const request = JSON.parse(Buffer.from(options!.env!.XINGMANG_SYSTEM_PROXY_REQUEST!, 'base64').toString('utf8'))
    let output: unknown
    if (request.operation === 'inspect') output = { owner: { pid: process.pid, startedAt: '134022112340000000' }, snapshot: current }
    else if (request.operation === 'owner') output = { startedAt: ownerTime }
    else if (request.operation === 'apply') {
      beforeApply?.(request.expected, request.desired)
      if (JSON.stringify(current) !== JSON.stringify(request.expected)) output = { changed: false, snapshot: current }
      else {
        expect(fs.existsSync(journalPath)).toBe(true)
        expect(fs.existsSync(lockPath)).toBe(true)
        if (failApply === 'before') { failApply = null; throw new Error('sensitive-proxy-operation-error') }
        current = structuredClone(request.desired)
        mutations.push(structuredClone(current))
        if (failApply === 'after') { failApply = null; throw new Error('sensitive-proxy-operation-error') }
        output = { changed: true, snapshot: current }
      }
    } else throw new Error('unexpected command')
    return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout: JSON.stringify(output), stderr: '', outputBytes: 0, durationMs: 0 }
  })
  const withOperationLock = async <T,>(operation: () => Promise<T>): Promise<T> => {
    const pending = lockQueue.then(async () => {
      lockDepth += 1
      try { return await operation() } finally { lockDepth -= 1 }
    })
    lockQueue = pending.catch(() => undefined)
    return pending
  }
  const options = { journalPath, platform: 'win32' as const, runCommand: execute, powerShellExecutable: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', commandEnvironment: () => ({}), withOperationLock }
  const service = createWindowsSystemProxy(options)
  return {
    directory, journalPath, lockPath, before, service, options, execute, mutations,
    get current() { return current },
    set current(value: WindowsProxySnapshot) { current = value },
    set ownerTime(value: string | null) { ownerTime = value },
    set failApply(value: 'before' | 'after' | null) { failApply = value },
    set beforeApply(value: typeof beforeApply) { beforeApply = value },
  }
}

describe('Windows system proxy lease', () => {
  it('persists the full original state before enabling and restores PAC, WPAD and absent registry values', async () => {
    const f = fixture()
    await f.service.enable(18765)
    expect(f.current).toEqual(buildWindowsLoopbackProxySnapshot(18765))
    expect(JSON.parse(fs.readFileSync(f.journalPath, 'utf8'))).toMatchObject({ version: 1, before: f.before, applied: f.current, owner: { pid: process.pid, startedAt: '134022112340000000' } })
    expect(f.current.flags & 12).toBe(0)
    await f.service.restore()
    expect(f.current).toEqual(f.before)
    expect(fs.existsSync(f.journalPath)).toBe(false)
    expect(fs.existsSync(f.lockPath)).toBe(false)
    expect(f.mutations).toHaveLength(2)
  })

  it('keeps repeated enable and restore idempotent and refuses a port switch while active', async () => {
    const f = fixture()
    await Promise.all([f.service.enable(18765), f.service.enable(18765)])
    expect(f.mutations).toHaveLength(1)
    await expect(f.service.enable(18766)).rejects.toThrow('请先停止当前加速')
    await f.service.restore()
    await f.service.restore()
    expect(f.mutations).toHaveLength(2)
  })

  it('does not overwrite settings changed later by Clash or the user', async () => {
    const f = fixture()
    await f.service.enable(18765)
    const clash = buildWindowsLoopbackProxySnapshot(7897)
    f.current = clash
    await f.service.restore()
    expect(f.current).toEqual(clash)
    expect(f.mutations).toHaveLength(1)
    expect(fs.existsSync(f.journalPath)).toBe(false)
  })

  it.each(['before', 'after'] as const)('rolls back a failed enable %s the OS write and reports a safe error', async (failure) => {
    const f = fixture()
    f.failApply = failure
    await expect(f.service.enable(18765)).rejects.toThrow('系统代理启用失败，原设置已保留。')
    expect(f.current).toEqual(f.before)
    expect(fs.existsSync(f.journalPath)).toBe(false)
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it.each<{ name: string; bypass?: string; override?: string | null }>([
    { name: 'native and registry bypass', bypass: 'new-user-bypass', override: 'new-user-bypass' },
    { name: 'native bypass only', bypass: 'new-native-bypass' },
    { name: 'empty native bypass', bypass: '' },
    { name: 'registry bypass only', override: 'new-registry-bypass' },
    { name: 'deleted registry bypass', override: null },
    { name: 'empty registry bypass', override: '' },
  ])('restores owned proxy and PAC fields while preserving $name edits', async ({ bypass, override }) => {
    const f = fixture()
    await f.service.enable(18765)
    const edited = { ...f.current, ...(bypass === undefined ? {} : { bypass }),
      registry: { ...f.current.registry, ...(override === undefined ? {} : { ProxyOverride: override }) } }
    f.current = edited
    await f.service.restore()
    expect(f.current).toEqual({ ...f.before, ...(bypass === undefined ? {} : { bypass }),
      registry: { ...f.before.registry, ...(override === undefined ? {} : { ProxyOverride: override }) } })
    const request = JSON.parse(Buffer.from(f.execute.mock.calls.at(-1)![1]!.env!.XINGMANG_SYSTEM_PROXY_REQUEST!, 'base64').toString('utf8'))
    expect(request.expected).toEqual(edited)
    expect(f.mutations).toHaveLength(2)
    expect(fs.existsSync(f.journalPath)).toBe(false)
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it.each([
    { flags: 7 },
    { server: 'http=127.0.0.1:18765;https=other.example.test:8080' },
    { autoConfigUrl: 'https://changed.example.test/pac' },
    { registry: { ProxyEnable: 0 } },
    { registry: { ProxyServer: 'other.example.test:8080' } },
    { registry: { AutoConfigURL: 'https://changed.example.test/pac' } },
  ])('keeps the lease if bypass edits also change endpoint, PAC or flags: %j', async (change) => {
    const f = fixture()
    await f.service.enable(18765)
    f.current = { ...f.current, bypass: 'new-user-bypass', ...change,
      registry: { ...f.current.registry, ProxyOverride: 'new-user-bypass', ...change.registry } }
    const edited = structuredClone(f.current)
    await expect(f.service.restore()).rejects.toThrow('仍指向加速端口')
    expect(f.current).toEqual(edited)
    expect(f.mutations).toHaveLength(1)
    expect(fs.existsSync(f.journalPath)).toBe(true)
    expect(fs.existsSync(f.lockPath)).toBe(true)
    f.current = f.before
    await f.service.restore()
    expect(fs.existsSync(f.journalPath)).toBe(false)
  })

  it('keeps newer bypass edits and the journal when the recovery CAS loses a race, then retries', async () => {
    const f = fixture()
    await f.service.enable(18765)
    f.current = { ...f.current, registry: { ...f.current.registry, ProxyOverride: 'first-edit' } }
    let calls = 0
    f.beforeApply = () => {
      if (++calls === 2) f.current = { ...f.current, registry: { ...f.current.registry, ProxyOverride: 'later-edit' } }
    }
    await expect(f.service.restore()).rejects.toThrow('仍指向加速端口')
    expect(f.current.registry.ProxyOverride).toBe('later-edit')
    expect(f.mutations).toHaveLength(1)
    expect(fs.existsSync(f.journalPath)).toBe(true)
    expect(fs.existsSync(f.lockPath)).toBe(true)
    f.beforeApply = null
    await f.service.restore()
    expect(f.current).toEqual({ ...f.before, registry: { ...f.before.registry, ProxyOverride: 'later-edit' } })
    expect(fs.existsSync(f.journalPath)).toBe(false)
  })

  it('does not overwrite another proxy selected between the two recovery CAS operations', async () => {
    const f = fixture()
    await f.service.enable(18765)
    f.current = { ...f.current, bypass: 'first-edit' }
    const other = buildWindowsLoopbackProxySnapshot(7897)
    let calls = 0
    f.beforeApply = () => { if (++calls === 2) f.current = other }
    await f.service.restore()
    expect(f.current).toEqual(other)
    expect(f.mutations).toHaveLength(1)
    expect(fs.existsSync(f.journalPath)).toBe(false)
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it.each(['before', 'after'] as const)('retains bypass recovery records on a failed write %s commit and permits retry', async (failure) => {
    const f = fixture()
    await f.service.enable(18765)
    f.current = { ...f.current, bypass: 'user-edit', registry: { ...f.current.registry, ProxyOverride: '' } }
    f.failApply = failure
    await expect(f.service.restore()).rejects.toThrow('Windows 系统代理操作未完成')
    expect(fs.existsSync(f.journalPath)).toBe(true)
    expect(fs.existsSync(f.lockPath)).toBe(true)
    await f.service.restore()
    expect(f.current).toEqual({ ...f.before, bypass: 'user-edit', registry: { ...f.before.registry, ProxyOverride: '' } })
    expect(fs.existsSync(f.journalPath)).toBe(false)
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it('refuses a second live owner and serializes simultaneous acquisition around the journal', async () => {
    const f = fixture()
    const other = createWindowsSystemProxy(f.options)
    const results = await Promise.allSettled([f.service.enable(18765), other.enable(18766)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    const saved = fs.readFileSync(f.journalPath, 'utf8')
    await expect(other.recover()).rejects.toThrow('另一实例正在使用系统代理')
    await expect(other.restore()).rejects.toThrow('另一实例正在使用系统代理')
    expect(fs.readFileSync(f.journalPath, 'utf8')).toBe(saved)
    expect(f.current).toEqual(buildWindowsLoopbackProxySnapshot(18765))
    await f.service.restore()
  })

  it.each([null, '134022112349999999'])('recovers only a dead owner or a reused PID with a different creation time: %s', async (time) => {
    const f = fixture()
    await f.service.enable(18765)
    f.ownerTime = time
    await createWindowsSystemProxy(f.options).recover()
    expect(f.current).toEqual(f.before)
    expect(fs.existsSync(f.journalPath)).toBe(false)
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it('recovers an abandoned pre-write lease without changing the OS', async () => {
    const f = fixture()
    fs.writeFileSync(f.lockPath, JSON.stringify({ version: 1, id: '74f03e7f-3d83-40f5-8e56-0b6d86f98fd2', owner: { pid: 77, startedAt: '134022112340000000' } }), 'utf8')
    f.ownerTime = null
    await f.service.recover()
    expect(f.mutations).toHaveLength(0)
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it('retains the journal when restoration fails so a later stop can retry', async () => {
    const f = fixture()
    await f.service.enable(18765)
    f.failApply = 'before'
    await expect(f.service.restore()).rejects.toThrow('Windows 系统代理操作未完成')
    expect(fs.existsSync(f.journalPath)).toBe(true)
    expect(fs.existsSync(f.lockPath)).toBe(true)
    await f.service.restore()
    expect(f.current).toEqual(f.before)
  })

  it('fails closed on corrupt or mismatched recovery data without printing source text', async () => {
    const f = fixture()
    await f.service.enable(18765)
    fs.writeFileSync(f.journalPath, '{secret:https://user:password@example.test}', 'utf8')
    await expect(f.service.restore()).rejects.toThrow('系统代理恢复记录损坏，已保留原文件。')
    expect(f.mutations).toHaveLength(1)
    expect(fs.readFileSync(f.journalPath, 'utf8')).toContain('password')
  })

  it('uses a fixed encoded script and passes proxy strings only as data in the sanitized environment', async () => {
    const f = fixture()
    f.current = { ...f.before, autoConfigUrl: 'https://example.test/$(Start-Process calc);x', registry: { ...f.before.registry, AutoConfigURL: 'https://example.test/$(Start-Process calc);x' } }
    await f.service.enable(18765)
    for (const [command, options] of f.execute.mock.calls) {
      expect(command.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(command.argv.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
      const script = Buffer.from(command.argv[4], 'base64').toString('utf16le')
      expect(script).not.toContain('Start-Process calc')
      expect(script).toContain('InternetQueryOptionW')
      expect(script).toContain('InternetSetOptionW')
      expect(script).toContain('[IO.Path]::Combine([Environment]::SystemDirectory,')
      expect(script).not.toContain('DefaultConnectionSettings')
      expect(options).toMatchObject({ trustedOnly: true, windowsHide: true, timeoutMs: 15_000, maxOutputBytes: 96 * 1024 })
    }
    await f.service.restore()
  })

  it('declares WinInet in memory by its System32 path instead of compiling it on every call', () => {
    const { code, literals, unterminated } = scanPowerShell(windowsSystemProxyScript)
    expect(unterminated).toBe(false)
    expect(unbalancedBracket(code)).toBeNull()
    // A type definition makes Windows PowerShell start csc.exe and load the DLL it writes under
    // %TEMP%: a second cold process per call, 18.6 s against the 15 s limit on a CI runner (#805).
    expect(code).not.toMatch(/Add-Type|DllImport/)
    expect(code).toContain('$type.DefinePInvokeMethod($call[0],[IO.Path]::Combine([Environment]::SystemDirectory,$call[1]),$call[2],')
    expect(literals).toEqual(expect.arrayContaining(['wininet.dll', 'InternetQueryOptionW', 'InternetSetOptionW', 'kernel32.dll', 'GlobalFree']))
    // The owner lookup reads only the process start time, so it never declares WinInet: the
    // two calls are the first read or write, never a top-level one every operation pays for.
    expect(/'owner' \{([^\n]*)\}/.exec(windowsSystemProxyScript)?.[1]).not.toMatch(/State|WinInet/)
    expect(code.match(/^\s*Initialize-WinInet$/gm)).toHaveLength(2)
    expect(code).toMatch(/function New-WinInetList\(\[int\]\$extra\) \{\n\s*Initialize-WinInet\n/)
    expect(code).toMatch(/function Update-WinInet \{\n\s*Initialize-WinInet\n/)
    // The connection name, the error slot and each option's value are cleared field by field,
    // not by copying a byte array into the block the way a shellcode loader fills its own.
    expect(code).not.toContain('::Copy(')
    expect(code).toContain('$m::WriteIntPtr($list,$p,[IntPtr]::Zero);$m::WriteInt32($list,2*$p,4);$m::WriteInt32($list,2*$p+4,0);')
    expect(code).toContain('$m::WriteInt64($list,$size+$i*($p+8)+$p,0)')
  })

  it('keeps the fallback byte for byte as 0.2.14 ran it, compiling WinInet with Add-Type', () => {
    // Its worth is being the text customers' antivirus software has already seen on every
    // call; a change here, even one bringing it in line with the in-memory script, gives that up.
    expect(createHash('sha256').update(windowsSystemProxyCompiledScript.replaceAll('\r\n', '\n')).digest('hex'))
      .toBe('69a95a9361d9d6e637d53c913d1fa3dc87fa60e386ed2ea4636a0649f5cee1e3')
    const { code, literals } = scanPowerShell(windowsSystemProxyCompiledScript)
    expect(code).toContain("Add-Type -TypeDefinition @'")
    expect(code).not.toMatch(/Reflection\.Emit|DefinePInvokeMethod/)
    expect(literals.join('\n')).toContain('[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]')
  })

  it('retries with the compiled script after any error exit, but not after a timeout', () => {
    expect(shouldRetryWithCompiledScript(commandFailure('EXIT_NON_ZERO', 1, scriptBlockScanningRefusal))).toBe(true)
    expect(shouldRetryWithCompiledScript(commandFailure('EXIT_NON_ZERO', 1, 'proxy-query-failed'))).toBe(true)
    // An antivirus ending the process leaves an arbitrary exit code and no error record.
    expect(shouldRetryWithCompiledScript(commandFailure('EXIT_NON_ZERO', -1073741819))).toBe(true)
    expect(shouldRetryWithCompiledScript(commandFailure('TIMED_OUT', null))).toBe(false)
    expect(shouldRetryWithCompiledScript(commandFailure('SPAWN_FAILED', null))).toBe(false)
    expect(shouldRetryWithCompiledScript(new Error('ScriptContainedMaliciousContent'))).toBe(false)
  })

  it.each([
    ['script-block scanning refused it', commandFailure('EXIT_NON_ZERO', 1, scriptBlockScanningRefusal)],
    ['its process was ended', commandFailure('EXIT_NON_ZERO', 1)],
  ])('reruns the same request on the compiled script when %s, then keeps to it', async (_name, failure) => {
    const f = fixture()
    f.execute.mockRejectedValueOnce(failure)
    await f.service.enable(18765)
    expect(f.current).toEqual(buildWindowsLoopbackProxySnapshot(18765))
    expect(f.mutations).toHaveLength(1)
    const calls = f.execute.mock.calls
    expect(calls.map(([command]) => scriptOf(command.argv))).toEqual([
      windowsSystemProxyScript, windowsSystemProxyCompiledScript, windowsSystemProxyCompiledScript,
    ])
    expect(calls[1][1]!.env!.XINGMANG_SYSTEM_PROXY_REQUEST).toBe(calls[0][1]!.env!.XINGMANG_SYSTEM_PROXY_REQUEST)
    expect(calls[1][1]).toMatchObject({ trustedOnly: true, windowsHide: true, timeoutMs: 15_000, maxOutputBytes: 96 * 1024 })
    await f.service.restore()
    expect(scriptOf(calls.at(-1)![0].argv)).toBe(windowsSystemProxyCompiledScript)
    expect(f.current).toEqual(f.before)
  })

  it('never writes over a write the failed run left in place', async () => {
    const f = fixture()
    const passThrough = f.execute.getMockImplementation()!
    f.execute.mockImplementationOnce(passThrough).mockImplementationOnce(async (command, options) => {
      // The in-memory script writes the proxy, then fails to report it.
      await passThrough(command, options)
      throw commandFailure('EXIT_NON_ZERO', 1, 'proxy-apply-failed')
    })
    await expect(f.service.enable(18765)).rejects.toThrow('系统代理启用失败，原设置已保留。')
    // The compiled rerun finds the proxy already changed, writes nothing, and the journal
    // takes it back to the original exactly once.
    expect(f.mutations).toEqual([buildWindowsLoopbackProxySnapshot(18765), f.before])
    expect(f.current).toEqual(f.before)
    expect(f.execute.mock.calls.map(([command]) => scriptOf(command.argv))).toEqual([
      windowsSystemProxyScript, windowsSystemProxyScript, windowsSystemProxyCompiledScript, windowsSystemProxyCompiledScript,
    ])
    expect(fs.existsSync(f.journalPath)).toBe(false)
  })

  it('does not rerun after a timeout', async () => {
    const f = fixture()
    f.execute.mockRejectedValueOnce(commandFailure('TIMED_OUT', null))
    await expect(f.service.enable(18765)).rejects.toThrow('Windows 系统代理操作未完成')
    expect(f.execute).toHaveBeenCalledTimes(1)
    await f.service.enable(18765)
    expect(f.execute.mock.calls.map(([command]) => scriptOf(command.argv))).toEqual([
      windowsSystemProxyScript, windowsSystemProxyScript, windowsSystemProxyScript,
    ])
    await f.service.restore()
  })

  it('reruns an owner lookup too, which a refusal of the whole script stops as well', async () => {
    const f = fixture()
    fs.writeFileSync(f.lockPath, JSON.stringify({ version: 1, id: '74f03e7f-3d83-40f5-8e56-0b6d86f98fd2', owner: { pid: 77, startedAt: '134022112340000000' } }), 'utf8')
    f.ownerTime = null
    f.execute.mockRejectedValueOnce(commandFailure('EXIT_NON_ZERO', 1, scriptBlockScanningRefusal))
    await f.service.recover()
    expect(f.execute.mock.calls.map(([command]) => scriptOf(command.argv))).toEqual([windowsSystemProxyScript, windowsSystemProxyCompiledScript])
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it('lets a caller on a cold PowerShell raise the per-command limit without changing the default', async () => {
    const f = fixture()
    await createWindowsSystemProxy({ ...f.options, commandTimeoutMs: 45_000 }).enable(18765)
    expect(f.execute.mock.calls.length).toBeGreaterThan(0)
    for (const [, options] of f.execute.mock.calls) expect(options).toMatchObject({ timeoutMs: 45_000 })
  })

  it('validates ports, platform and journal paths before requesting native changes', async () => {
    const f = fixture()
    expect(() => f.service.enable(80)).toThrow('本地代理端口无效')
    expect(() => createWindowsSystemProxy({ journalPath: '../untrusted.json' })).toThrow('绝对路径')
    await expect(createWindowsSystemProxy({ ...f.options, platform: 'darwin' }).enable(18765)).rejects.toThrow('当前系统暂不支持')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('rejects unrecognized proxy flags and invalid registry values', () => {
    expect(() => parseWindowsProxySnapshot({ ...originalSnapshot(), flags: 16 })).toThrow('系统代理状态无效')
    expect(() => parseWindowsProxySnapshot({ ...originalSnapshot(), registry: { ProxyEnable: 'yes' } })).toThrow('系统代理状态无效')
  })
})
