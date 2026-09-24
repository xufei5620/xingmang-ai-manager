import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CommandRunnerError, runCommand, type CommandSpec, type CommandErrorDetails } from './command-runner'
import type { ExternalClientInstallProgress } from './external-client-contract'
import { buildExternalClientWingetInstall, createExternalClientRuntime, externalClientWingetUnavailableHint, verifyExternalClientPath, windowsExternalClientInventoryScript, type ExternalClientRuntimeOptions } from './external-client-runtime'
import type { ExternalToolId } from './external-tool-config'
import { InstallationQueue } from './installation-queue'
import { encodeWindowsPowerShellCommand, resolveWindowsPowerShellExecutable } from './windows-elevation'
import * as pathIdentity from './path-identity'
import * as safeLocalData from './safe-local-data'

const machinePaths = {
  systemRoot: 'C:\\Windows', system32: 'C:\\Windows\\System32', programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)', programData: 'C:\\ProgramData',
}
const winget = 'C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.0_x64__8wekyb3d8bbwe\\winget.exe'
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const explorer = 'C:\\Windows\\explorer.exe'
const subjects = {
  workbuddy: 'CN=Tencent Technology (Shenzhen) Company Limited, O=Tencent Technology (Shenzhen) Company Limited, C=CN',
  claudeDesktop: 'CN="Anthropic, PBC", O="Anthropic, PBC", C=US',
  opencode: 'CN="Anomaly Innovations, Inc https://anoma.ly/", O="Anomaly Innovations, Inc https://anoma.ly/", C=US',
}
function candidate(tool: ExternalToolId, extra: Record<string, unknown> = {}) {
  const executable = tool === 'claudeDesktop' ? 'Claude' : tool === 'opencode' ? 'OpenCode' : 'WorkBuddy'
  return { tool, path: `C:\\Users\\Tester\\AppData\\Local\\${executable}\\${executable}.exe`, version: '1.2.3', running: false, signatureStatus: 'Valid', signatureSubject: subjects[tool], ...extra }
}
function appx(extra: Record<string, unknown> = {}) {
  const directory = 'C:\\Program Files\\WindowsApps\\Claude_2.110.1.0_x64__pzs8sxrjxfjjc'
  return candidate('claudeDesktop', {
    path: `${directory}\\app\\Claude.exe`, version: '2.110.1.0', running: true, family: 'Claude_pzs8sxrjxfjjc',
    publisher: subjects.claudeDesktop, installLocation: directory, applicationId: 'Claude_pzs8sxrjxfjjc!Claude', ...extra,
  })
}
function commandResult(spec: CommandSpec, stdout = '') {
  return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: stdout.length, durationMs: 1 }
}
function wingetError(overrides: Partial<CommandErrorDetails> = {}) {
  return new CommandRunnerError('命令执行失败（退出码 2147954429）：winget.exe', {
    code: 'EXIT_NON_ZERO', executable: winget, argv: ['install'], exitCode: 2147954429, signal: null,
    stdout: '尝试更新源失败： winget\r\nInternetOpenUrl() failed.\r\n0x80072efd : unknown error\r\n',
    stderr: '', outputBytes: 130, maxOutputBytes: 2097152, durationMs: 30293, ...overrides,
  })
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(overrides: ExternalClientRuntimeOptions = {}) {
  let inventory: { clients: Record<string, unknown>[]; errors: Record<string, string> } = { clients: [], errors: {} }
  const execute = vi.fn<typeof runCommand>(async (spec) => commandResult(spec, spec.executable === powershell ? JSON.stringify(inventory) : ''))
  const launchProcess = vi.fn(async () => undefined)
  const resolveWinget = vi.fn(async () => ({ executable: winget, reason: null }))
  const officialInstaller = vi.fn<NonNullable<ExternalClientRuntimeOptions['installWorkBuddyFromOfficial']>>(async () => {
    throw new Error('Unexpected official installer call')
  })
  const runtime = createExternalClientRuntime({
    platform: 'win32', architecture: 'x64', userHome: 'C:\\Users\\Tester', env: { PATH: 'C:\\Evil', NODE_OPTIONS: '--require evil.cjs' },
    runCommand: execute, resolveMachinePaths: () => machinePaths,
    resolvePowerShellExecutable: () => powershell, resolveExplorerExecutable: () => explorer,
    resolveWingetExecutable: resolveWinget, verifyPath: async (value) => value,
    launchProcess, installWorkBuddyFromOfficial: officialInstaller, ...overrides,
  })
  return { runtime, execute, launchProcess, resolveWinget, officialInstaller, setInventory(clients: Record<string, unknown>[], errors: Record<string, string> = {}) { inventory = { clients, errors } } }
}

describe('external desktop client lifecycle', () => {
  it.runIf(process.platform === 'win32')('keeps verified AppX results when an unrelated uninstall key is unreadable', async () => {
    const prelude = String.raw`
function Test-Path { param([string]$LiteralPath) return $true }
function Get-ChildItem { param([string]$LiteralPath) [pscustomobject]@{ PSPath='unrelated-unreadable-key' } }
function Get-ItemProperty { param([string]$LiteralPath) throw 'Access denied to unrelated registry item' }
function Get-Process { @() }
function Get-AppxPackage {
  [pscustomobject]@{ PackageFamilyName='Claude_pzs8sxrjxfjjc'; InstallLocation='C:\Program Files\WindowsApps\Claude_2.110.1.0_x64__pzs8sxrjxfjjc'; Version='2.110.1.0'; Publisher='CN="Anthropic, PBC", O="Anthropic, PBC", C=US' }
}
`
    const result = await runCommand({ executable: resolveWindowsPowerShellExecutable(), argv: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsPowerShellCommand(prelude + windowsExternalClientInventoryScript())] }, { timeoutMs: 15000, windowsHide: true })
    const data = JSON.parse(result.stdout.trim())
    expect(data.clients).toHaveLength(1)
    expect(data.clients[0]).toMatchObject({ tool: 'claudeDesktop', version: '2.110.1.0' })
    const f = fixture()
    f.setInventory(data.clients, data.errors)
    const statuses = await f.runtime.scan()
    expect(statuses[1]).toMatchObject({ installed: true, launchSupported: true, detectionError: null })
    expect(statuses[0].detectionError).toContain('部分软件安装记录')
    await expect(f.runtime.install('workbuddy')).rejects.toThrow('不能确认')
    expect(f.execute.mock.calls.some(([spec]) => spec.executable === winget)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('decodes every remembered signature in Windows PowerShell', async () => {
    const prelude = String.raw`
function Test-Path { param([string]$LiteralPath) return $false }
function Get-Process { @() }
function Get-AppxPackage { @() }
`
    const known = [
      { path: 'C:\\Users\\Tester\\AppData\\Local\\WorkBuddy\\WorkBuddy.exe', stamp: '1:2:3', status: 'Valid', subject: subjects.workbuddy },
      { path: "C:\\Users\\Tester\\AppData\\Local\\Open'Code\\OpenCode.exe", stamp: '4:5:6', status: 'Valid', subject: subjects.opencode },
    ]
    const script = prelude + windowsExternalClientInventoryScript(known) + "\n'KNOWN:' + (@($knownSignatures.Keys | Sort-Object) -join '|')"
    const result = await runCommand({ executable: resolveWindowsPowerShellExecutable(), argv: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsPowerShellCommand(script)] }, { timeoutMs: 15000, windowsHide: true })
    const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('KNOWN:'))
    expect(line).toBe(`KNOWN:${known.map((entry) => entry.path).sort().join('|')}`)
  })

  it('detects signed installed desktop applications and current-user Claude Store without executing their binaries', async () => {
    const f = fixture()
    f.setInventory([candidate('workbuddy'), appx(), candidate('opencode')])
    const statuses = await f.runtime.scan()
    expect(statuses.map((status) => [status.tool, status.installed, status.installSupported, status.launchSupported])).toEqual([
      ['workbuddy', true, true, true], ['claudeDesktop', true, true, true], ['opencode', true, true, true],
    ])
    expect(statuses[1]).toMatchObject({ version: '2.110.1.0', running: true, detectionError: null })
    expect(f.execute).toHaveBeenCalledOnce()
    expect(f.execute.mock.calls[0][0].executable).toBe(powershell)
    expect(f.execute.mock.calls[0][1]?.env?.NODE_OPTIONS).toBeUndefined()
    expect(f.launchProcess).not.toHaveBeenCalled()
  })

  it.each(['workbuddy', 'claudeDesktop', 'opencode'] as const)('skips installation of already installed %s, preserving even newer Store versions', async (tool) => {
    const f = fixture()
    f.setInventory([tool === 'claudeDesktop' ? appx() : candidate(tool)])
    const progress: ExternalClientInstallProgress[] = []
    expect((await f.runtime.install(tool, (event) => progress.push(event))).installed).toBe(true)
    expect(f.execute.mock.calls.every(([spec]) => spec.executable === powershell)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ phase: 'completed', percent: 100 })
  })

  it.each([
    ['workbuddy', 'Tencent.WorkBuddy'], ['claudeDesktop', 'Anthropic.Claude'], ['opencode', 'SST.OpenCodeDesktop'],
  ] as const)('installs %s with the exact official desktop package and verifies it afterwards', async (tool, packageId) => {
    const f = fixture()
    const progress: ExternalClientInstallProgress[] = []
    f.execute.mockImplementation(async (spec, options) => {
      if (spec.executable === powershell) return commandResult(spec, JSON.stringify({ clients: f.execute.mock.calls.some(([call]) => call.executable === winget) ? [candidate(tool)] : [], errors: {} }))
      options?.onOutput?.({ stream: 'stdout', text: 'Starting package install...' })
      return commandResult(spec)
    })
    const status = await f.runtime.install(tool, (event) => progress.push(event))
    expect(status.installed).toBe(true)
    const call = f.execute.mock.calls.find(([spec]) => spec.executable === winget)!
    expect(call[0].argv).toEqual(['install', '--id', packageId, '--exact', '--source', 'winget', '--scope', 'user', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'])
    expect(call[1]).toMatchObject({ trustedOnly: false, timeoutMs: 900_000, acceptedExitCodes: [0] })
    expect(call[1]?.env?.NODE_OPTIONS).toBeUndefined()
    expect(progress.map((event) => event.phase)).toEqual(['queued', 'checking', 'downloading', 'installing', 'checking', 'completed'])
  })

  it('does not report success when winget exits but no installed application is found', async () => {
    const f = fixture()
    const progress: ExternalClientInstallProgress[] = []
    await expect(f.runtime.install('opencode', (event) => progress.push(event))).rejects.toThrow('未检测到客户端')
    expect(progress.at(-1)?.phase).toBe('error')
    expect(progress.some((event) => event.phase === 'completed')).toBe(false)
  })

  it('preserves winget errors and allows a later retry', async () => {
    const f = fixture()
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable === winget) throw new Error('winget failed: network unreachable')
      return commandResult(spec, '{"clients":[],"errors":{}}')
    })
    await expect(f.runtime.install('workbuddy')).rejects.toThrow('network unreachable')
    await expect(f.runtime.install('workbuddy')).rejects.toThrow('network unreachable')
    expect(f.execute.mock.calls.filter(([spec]) => spec.executable === winget)).toHaveLength(2)
  })

  it('shares duplicate install promises and serializes with the existing installation queue', async () => {
    const queue = new InstallationQueue()
    const blocker = deferred()
    void queue.enqueue('existing-runtime-install', () => blocker.promise)
    const f = fixture({ installationQueue: queue })
    f.setInventory([candidate('workbuddy'), candidate('opencode')])
    const firstEvents: ExternalClientInstallProgress[] = []
    const secondEvents: ExternalClientInstallProgress[] = []
    const first = f.runtime.install('workbuddy', (event) => firstEvents.push(event))
    const duplicate = f.runtime.install('workbuddy', (event) => secondEvents.push(event))
    const second = f.runtime.install('opencode')
    expect(duplicate).toBe(first)
    expect(f.execute).not.toHaveBeenCalled()
    expect(queue.snapshot().pendingKeys).toEqual(['external-client:install:workbuddy', 'external-client:install:opencode'])
    blocker.resolve()
    await Promise.all([first, second])
    expect(firstEvents.at(-1)?.phase).toBe('completed')
    expect(secondEvents.at(-1)?.phase).toBe('completed')
    expect(f.execute).toHaveBeenCalledTimes(2)
  })

  it('isolates failing progress observers', async () => {
    const f = fixture()
    f.setInventory([candidate('opencode')])
    await expect(f.runtime.install('opencode', () => { throw new Error('renderer disconnected') })).resolves.toMatchObject({ installed: true })
  })

  it('deduplicates concurrent read-only scans without retaining stale post-install state', async () => {
    const f = fixture()
    const gate = deferred<ReturnType<typeof commandResult>>()
    f.execute.mockImplementationOnce(() => gate.promise)
    const first = f.runtime.scan()
    expect(f.runtime.scan()).toBe(first)
    gate.resolve(commandResult({ executable: powershell, argv: [] }, '{"clients":[],"errors":{}}'))
    await first
    f.setInventory([candidate('opencode')])
    expect((await f.runtime.scan({ force: true }))[2].installed).toBe(true)
    expect(f.execute).toHaveBeenCalledTimes(2)
  })

  it('reuses one inventory for five minutes unless the user forces a rescan', async () => {
    let clock = 1_000
    const f = fixture({ now: () => clock })
    f.setInventory([candidate('opencode')])
    expect((await f.runtime.scan())[2].installed).toBe(true)
    f.setInventory([])
    clock += 4 * 60_000
    expect((await f.runtime.scan())[2].installed).toBe(true)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect((await f.runtime.scan({ force: true }))[2].installed).toBe(false)
    expect(f.execute).toHaveBeenCalledTimes(2)
    f.setInventory([candidate('workbuddy')])
    clock += 5 * 60_000
    expect((await f.runtime.scan())[0].installed).toBe(true)
    expect(f.execute).toHaveBeenCalledTimes(3)
  })

  it('does not cache a scan that could not tell whether a client is installed', async () => {
    const f = fixture()
    f.execute.mockRejectedValueOnce(new Error('PowerShell probe timed out'))
    expect((await f.runtime.scan()).every((status) => status.detectionError)).toBe(true)
    f.setInventory([candidate('opencode')])
    expect((await f.runtime.scan())[2]).toMatchObject({ installed: true, detectionError: null })
    expect(f.execute).toHaveBeenCalledTimes(2)
  })

  it('forgets the cached inventory after installing or launching a client, even when the scan was in flight', async () => {
    const f = fixture()
    f.setInventory([candidate('opencode')])
    await f.runtime.scan()
    await f.runtime.launch('opencode')
    f.setInventory([candidate('opencode', { running: true })])
    expect((await f.runtime.scan())[2].running).toBe(true)

    const gate = deferred<ReturnType<typeof commandResult>>()
    f.execute.mockImplementationOnce(() => gate.promise)
    const stale = f.runtime.scan({ force: true })
    f.setInventory([candidate('opencode'), candidate('workbuddy')])
    await f.runtime.install('workbuddy')
    gate.resolve(commandResult({ executable: powershell, argv: [] }, JSON.stringify({ clients: [candidate('opencode')], errors: {} })))
    expect((await stale)[0].installed).toBe(false)
    expect((await f.runtime.scan())[0].installed).toBe(true)
  })

  it('offers remembered signatures to display scans only, never to install or launch', async () => {
    const f = fixture()
    f.setInventory([candidate('opencode', { signatureStamp: '123:456:789' })])
    await f.runtime.scan()
    await f.runtime.scan({ force: true })
    await f.runtime.launch('opencode')
    const scripts = f.execute.mock.calls
      .filter(([spec]) => spec.executable === powershell)
      .map(([spec]) => Buffer.from(spec.argv.at(-1)!, 'base64').toString('utf16le'))
    const known = (script: string) => JSON.parse(Buffer.from(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(script)![1], 'base64').toString('utf8'))
    expect(known(scripts[0])).toEqual([])
    expect(known(scripts[1])).toEqual([{ path: candidate('opencode').path, stamp: '123:456:789', status: 'Valid', subject: subjects.opencode }])
    // launch() inspects before it opens anything; that inspection verifies the signature anew.
    expect(known(scripts[2])).toEqual([])
  })

  it('embeds remembered signatures as base64 so registry text never becomes PowerShell source', () => {
    const hostile = { path: "C:\\Evil'; Start-Process calc; '\\WorkBuddy.exe", stamp: '1:2:3', status: "Valid'$(calc)", subject: '`"; calc' }
    const script = windowsExternalClientInventoryScript([hostile])
    expect(script).not.toContain('Start-Process')
    expect(script).not.toContain('calc')
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(script)![1]
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual([hostile])
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $exe')
  })

  it('reports probe failure separately from absence and refuses installation while status is uncertain', async () => {
    const f = fixture()
    f.execute.mockRejectedValue(new Error('PowerShell probe timed out'))
    expect((await f.runtime.scan()).every((status) => status.detectionError?.includes('timed out'))).toBe(true)
    await expect(f.runtime.install('workbuddy')).rejects.toThrow('无法确认当前安装状态')
    expect(f.execute.mock.calls.some(([spec]) => spec.executable === winget)).toBe(false)
  })

  it('keeps a per-tool AppX failure from hiding other clients', async () => {
    const f = fixture()
    f.setInventory([candidate('opencode')], { claudeDesktop: 'AppX unavailable' })
    const statuses = await f.runtime.scan()
    expect(statuses[1]).toMatchObject({ installed: false, detectionError: 'AppX unavailable' })
    expect(statuses[2]).toMatchObject({ installed: true, detectionError: null })
  })

  it.each([
    { path: '\\\\attacker\\share\\OpenCode.exe' },
    { path: 'C:\\Users\\Tester\\OpenCode.exe:payload.exe' },
    { path: 'C:\\Users\\Tester\\cmd.exe' },
    { signatureStatus: 'HashMismatch' },
    { signatureStatus: 'NotSigned' },
    { signatureSubject: 'CN=Attacker, O=Attacker' },
    { signatureSubject: 'CN="Anomaly Innovations, Inc https://anoma.ly/.evil"' },
  ])('refuses unsafe executable locations or signatures: %j', async (extra) => {
    const f = fixture()
    f.setInventory([candidate('opencode', extra)])
    expect((await f.runtime.scan())[2]).toMatchObject({ installed: false, launchSupported: false, detectionError: expect.any(String) })
    await expect(f.runtime.launch('opencode')).rejects.toThrow()
    expect(f.launchProcess).not.toHaveBeenCalled()
  })

  it('refuses redirected paths even if the executable has an expected name', async () => {
    const f = fixture({ verifyPath: async () => 'C:\\redirected\\OpenCode.exe' })
    f.setInventory([candidate('opencode')])
    expect((await f.runtime.scan())[2].detectionError).toContain('符号链接')
  })

  it.each([
    { publisher: 'CN="Anthropic, PBC.evil"' },
    { family: 'Claude_attacker' },
    { applicationId: 'Claude_pzs8sxrjxfjjc!Attacker' },
    { path: 'C:\\Users\\Tester\\app\\Claude.exe', installLocation: 'C:\\Users\\Tester' },
  ])('rejects forged Claude AppX metadata: %j', async (extra) => {
    const f = fixture()
    f.setInventory([appx(extra)])
    expect((await f.runtime.scan())[1].detectionError).toContain('AppX')
  })

  it('reports unavailable winget for clients without an official fallback, without consulting a PATH alias', async () => {
    const f = fixture({ resolveWingetExecutable: async () => ({ executable: null, reason: 'Microsoft App Installer missing' }) })
    expect((await f.runtime.scan())[2]).toMatchObject({ installSupported: false, installHint: externalClientWingetUnavailableHint })
    await expect(f.runtime.install('opencode')).rejects.toThrow(externalClientWingetUnavailableHint)
    expect(f.execute.mock.calls.some(([spec]) => /winget/i.test(spec.executable))).toBe(false)
  })

  it('keeps the raw winget failure out of the hint and logs it once per distinct reason', async () => {
    const onWingetUnavailable = vi.fn()
    let reason = "系统级 winget 解析失败：ENOENT: no such file or directory, realpath 'C:\\Program Files\\WindowsApps\\x\\winget.exe'"
    let clock = 0
    const f = fixture({
      resolveWingetExecutable: async () => ({ executable: null, reason }),
      onWingetUnavailable, now: () => clock,
    })
    const statuses = await f.runtime.scan()
    for (const tool of [statuses[1], statuses[2]]) {
      expect(tool.installHint).toBe(externalClientWingetUnavailableHint)
      expect(tool.installHint).not.toMatch(/winget|ENOENT|App Installer/i)
    }
    clock += 10 * 60_000
    await f.runtime.scan({ force: true })
    expect(onWingetUnavailable.mock.calls).toEqual([[reason]])
    reason = '未检测到系统级 Microsoft App Installer 包'
    await f.runtime.scan({ force: true })
    expect(onWingetUnavailable.mock.calls.map(([logged]) => logged)).toEqual([expect.stringContaining('ENOENT'), reason])
  })

  it.each([0x80072efd, 0x80072efd | 0, 0x80072ee7, 0x80072ee2])('recovers a WorkBuddy source connection failure %s through its official installer and verifies the result', async (exitCode) => {
    const f = fixture({ windowsExecutionMode: 'same-user' })
    const progress: ExternalClientInstallProgress[] = []
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable === winget) throw wingetError({ exitCode })
      return commandResult(spec, JSON.stringify({ clients: f.officialInstaller.mock.calls.length ? [candidate('workbuddy')] : [], errors: {} }))
    })
    f.officialInstaller.mockImplementation(async (options) => {
      options?.onProgress?.({ tool: 'workbuddy', phase: 'downloading', message: '正在下载腾讯官方安装包', percent: 42 })
    })
    await expect(f.runtime.install('workbuddy', (event) => progress.push(event))).resolves.toMatchObject({ installed: true })
    expect(f.officialInstaller).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ architecture: 'x64', windowsExecutionMode: 'same-user', runCommand: f.execute }))
    expect(progress.some((event) => event.message.includes('正在切换到腾讯官方下载'))).toBe(true)
    expect(progress.some((event) => event.percent === 42)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ phase: 'completed', percent: 100 })
    expect(progress.some((event) => event.phase === 'error')).toBe(false)
  })

  it('uses the official WorkBuddy installer when trusted winget is unavailable', async () => {
    const f = fixture({ resolveWingetExecutable: async () => ({ executable: null, reason: 'missing' }) })
    expect((await f.runtime.scan())[0]).toMatchObject({ installSupported: true, installHint: '将使用腾讯官方安装包' })
    f.officialInstaller.mockImplementation(async () => { f.setInventory([candidate('workbuddy')]) })
    await expect(f.runtime.install('workbuddy')).resolves.toMatchObject({ installed: true })
    expect(f.officialInstaller).toHaveBeenCalledOnce()
    expect(f.execute.mock.calls.some(([spec]) => spec.executable === winget)).toBe(false)
  })

  it.each([
    { code: 'ABORTED' }, { code: 'TIMED_OUT' }, { signal: 'SIGTERM' }, { exitCode: 1 }, { exitCode: 0x800704c7 },
  ] satisfies Partial<CommandErrorDetails>[])('never retries cancellation, timeout, termination or installer failure through another source: %j', async (details) => {
    const f = fixture()
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable === winget) throw wingetError(details)
      return commandResult(spec, '{"clients":[],"errors":{}}')
    })
    await expect(f.runtime.install('workbuddy')).rejects.toThrow()
    expect(f.officialInstaller).not.toHaveBeenCalled()
  })

  it('does not start a second installer after the first reports starting in split output chunks', async () => {
    const f = fixture()
    f.execute.mockImplementation(async (spec, options) => {
      if (spec.executable === winget) {
        options?.onOutput?.({ stream: 'stdout', text: 'Starting package in' })
        options?.onOutput?.({ stream: 'stdout', text: 'stall...' })
        throw wingetError()
      }
      return commandResult(spec, '{"clients":[],"errors":{}}')
    })
    await expect(f.runtime.install('workbuddy')).rejects.toThrow('连不上微软的软件下载源')
    expect(f.officialInstaller).not.toHaveBeenCalled()
  })

  it('detects an installer start at the beginning of a large output chunk before retaining its tail', async () => {
    const f = fixture()
    f.execute.mockImplementation(async (spec, options) => {
      if (spec.executable === winget) {
        options?.onOutput?.({ stream: 'stdout', text: 'Starting package install...\n' + 'x'.repeat(4096) })
        throw wingetError()
      }
      return commandResult(spec, '{"clients":[],"errors":{}}')
    })
    await expect(f.runtime.install('workbuddy')).rejects.toThrow('连不上微软的软件下载源')
    expect(f.officialInstaller).not.toHaveBeenCalled()
  })

  it.each(['installed', 'unknown'] as const)('rechecks WorkBuddy after source failure and avoids fallback when status is %s', async (state) => {
    const f = fixture()
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable === winget) {
        f.setInventory(state === 'installed' ? [candidate('workbuddy')] : [], state === 'unknown' ? { workbuddy: '读安装记录失败' } : {})
        throw wingetError()
      }
      return commandResult(spec, JSON.stringify({ clients: f.execute.mock.calls.some(([call]) => call.executable === winget) && state === 'installed' ? [candidate('workbuddy')] : [], errors: f.execute.mock.calls.some(([call]) => call.executable === winget) && state === 'unknown' ? { workbuddy: '读安装记录失败' } : {} }))
    })
    if (state === 'installed') await expect(f.runtime.install('workbuddy')).resolves.toMatchObject({ installed: true })
    else await expect(f.runtime.install('workbuddy')).rejects.toThrow('无法确认客户端安装状态')
    expect(f.officialInstaller).not.toHaveBeenCalled()
  })

  it('retains both failure causes, shows a useful error and permits a later retry', async () => {
    const f = fixture()
    const network = wingetError()
    const invalidPackage = new Error('SHA-256 校验失败')
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable === winget) throw network
      return commandResult(spec, '{"clients":[],"errors":{}}')
    })
    f.officialInstaller.mockRejectedValue(invalidPackage)
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.runtime.install('workbuddy')).rejects.toMatchObject({ message: '连不上微软的软件下载源；腾讯官方安装未完成：SHA-256 校验失败', originalError: { winget: network, official: invalidPackage } })
    }
    expect(f.officialInstaller).toHaveBeenCalledTimes(2)
  })

  it('does not mistake an official installer exit for a verified installed client', async () => {
    const f = fixture({ resolveWingetExecutable: async () => ({ executable: null, reason: 'missing' }) })
    f.officialInstaller.mockResolvedValue(undefined)
    const progress: ExternalClientInstallProgress[] = []
    await expect(f.runtime.install('workbuddy', (event) => progress.push(event))).rejects.toThrow('未检测到客户端')
    expect(progress.at(-1)?.phase).toBe('error')
    expect(progress.some((event) => event.phase === 'completed')).toBe(false)
  })

  it('explains a source connection failure for other clients without invoking WorkBuddy installation', async () => {
    const f = fixture()
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable === winget) throw wingetError()
      return commandResult(spec, '{"clients":[],"errors":{}}')
    })
    await expect(f.runtime.install('opencode')).rejects.toThrow('连不上微软的软件下载源（错误码 0x80072efd）')
    expect(f.officialInstaller).not.toHaveBeenCalled()
  })

  it('uses the trusted Explorer broker for user applications even in trusted-only mode', async () => {
    const f = fixture({ windowsExecutionMode: 'trusted-only' })
    f.setInventory([candidate('opencode')])
    await f.runtime.launch('opencode')
    expect(f.launchProcess).toHaveBeenCalledWith(expect.objectContaining({ executable: explorer, argv: [candidate('opencode').path], cwd: machinePaths.systemRoot }))
    expect(f.execute.mock.calls.some(([spec]) => spec.executable.endsWith('OpenCode.exe'))).toBe(false)
  })

  it('launches Claude Store through its fixed AUMID and waits for active installs', async () => {
    const queue = new InstallationQueue()
    const gate = deferred()
    void queue.enqueue('existing-install', () => gate.promise)
    const f = fixture({ installationQueue: queue })
    f.setInventory([appx()])
    const opened = f.runtime.launch('claudeDesktop')
    expect(f.launchProcess).not.toHaveBeenCalled()
    gate.resolve()
    await opened
    expect(f.launchProcess).toHaveBeenCalledWith(expect.objectContaining({ executable: explorer, argv: ['shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude'] }))
  })

  it('limits Windows installation to available official architectures', async () => {
    const f = fixture({ architecture: 'arm64' })
    const statuses = await f.runtime.scan()
    expect(statuses.map((status) => status.installSupported)).toEqual([false, true, true])
    expect(statuses[0].installHint).toContain('处理器架构')
  })

  it('does not claim official Linux WorkBuddy or Claude Desktop installation support', async () => {
    const f = fixture({ platform: 'linux' })
    const statuses = await f.runtime.scan()
    expect(statuses.every((status) => !status.installSupported && !status.launchSupported)).toBe(true)
    await expect(f.runtime.install('claudeDesktop')).rejects.toThrow('当前不支持此系统')
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.resolveWinget).not.toHaveBeenCalled()
  })

  it('does not execute registry version/uninstall strings in the fixed Windows inventory script', () => {
    const script = windowsExternalClientInventoryScript()
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $exe')
    expect(script).not.toMatch(/Start-Process|Invoke-Expression|UninstallString|--version/)
    expect(buildExternalClientWingetInstall('opencode', winget).argv).toContain('SST.OpenCodeDesktop')
    expect(buildExternalClientWingetInstall('opencode', winget).argv).not.toContain('SST.opencode')
  })

  it('validates the full AppX identity when WindowsApps parent native realpath is denied, preserving strict checks for ordinary executables', async () => {
    const file = appx().path
    const identity = vi.spyOn(pathIdentity, 'sameLocalPathIdentity').mockReturnValue(true)
    const parents = vi.spyOn(safeLocalData, 'assertNoReparseComponents').mockImplementation(() => { throw new Error('WindowsApps parent realpath EPERM') })
    const lstat = vi.spyOn(fs.promises, 'lstat').mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true, nlink: 2 } as fs.Stats)
    const realpath = vi.spyOn(fs.promises, 'realpath').mockResolvedValue(file)
    try {
      await expect(verifyExternalClientPath(file, 'appx-file')).resolves.toBe(file)
      expect(identity).toHaveBeenCalledWith(file, file)
      expect(parents).not.toHaveBeenCalled()
      await expect(verifyExternalClientPath(file, 'file')).rejects.toThrow('EPERM')
      identity.mockReturnValue(false)
      await expect(verifyExternalClientPath(file, 'appx-file')).rejects.toThrow('路径身份')
    } finally { identity.mockRestore(); parents.mockRestore(); lstat.mockRestore(); realpath.mockRestore() }
  })
})

describe('macOS external desktop lifecycle', () => {
  function macFixture(extra: ExternalClientRuntimeOptions = {}) {
    const execute = vi.fn<typeof runCommand>(async (spec) => {
      if (spec.executable === '/usr/bin/plutil') return commandResult(spec, JSON.stringify({ CFBundleIdentifier: 'com.tencent.workbuddy.mac', CFBundleShortVersionString: '5.5.6' }))
      return commandResult(spec, spec.executable === '/bin/ps' ? '/Applications/WorkBuddy.app/Contents/MacOS/Electron\n' : '')
    })
    const verifyPath = vi.fn(async (candidate: string) => {
      if (candidate.startsWith('/Applications/WorkBuddy.app')) return candidate
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    return { execute, runtime: createExternalClientRuntime({ platform: 'darwin', userHome: '/Users/tester', runCommand: execute, verifyPath, getuid: () => 501, ...extra }) }
  }
  it('validates installed bundles with Gatekeeper and the verified WorkBuddy team, then launches through open', async () => {
    const f = macFixture()
    expect((await f.runtime.scan())[0]).toMatchObject({ installed: true, version: '5.5.6', running: true, installSupported: false, launchSupported: true })
    expect(f.execute.mock.calls.some(([spec]) => spec.executable === '/usr/bin/codesign' && spec.argv.some((arg) => arg.includes('FN2V63AD2J')))).toBe(true)
    await f.runtime.launch('workbuddy')
    expect(f.execute).toHaveBeenCalledWith({ executable: '/usr/bin/open', argv: ['-a', '/Applications/WorkBuddy.app'] }, expect.any(Object))
  })
  it('never claims trustedOnly on darwin, where runCommand drops the path checks silently', async () => {
    const f = macFixture()
    await f.runtime.scan()
    await f.runtime.launch('workbuddy')
    expect(f.execute.mock.calls.length).toBeGreaterThan(0)
    for (const [, options] of f.execute.mock.calls) expect(options?.trustedOnly).toBe(false)
  })
  it('reports missing apps without inventing an automatic macOS installer', async () => {
    const f = macFixture()
    const status = (await f.runtime.scan())[1]
    expect(status).toMatchObject({ installed: false, detectionError: null, installSupported: false })
    await expect(f.runtime.install('claudeDesktop')).rejects.toThrow('官网下载')
  })
  it('refuses root launch and reports invalid signatures as failed detection', async () => {
    const root = macFixture({ getuid: () => 0 })
    expect((await root.runtime.scan())[0].launchSupported).toBe(false)
    await expect(root.runtime.launch('workbuddy')).rejects.toThrow('普通用户')
    const invalid = macFixture()
    invalid.execute.mockImplementation(async (spec) => {
      if (spec.executable === '/usr/bin/plutil') return commandResult(spec, '{"CFBundleIdentifier":"com.tencent.workbuddy.mac"}')
      throw new Error('signature rejected')
    })
    expect((await invalid.runtime.scan())[0]).toMatchObject({ installed: false, detectionError: 'signature rejected' })
  })
})
