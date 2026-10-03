import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CommandRunnerError, runCommand, type CommandSpec, type CommandErrorDetails } from './command-runner'
import type { ExternalClientInstallProgress } from './external-client-contract'
import { buildExternalClientWingetInstall, createExternalClientRuntime, externalClientWingetUnavailableHint, verifyExternalClientPath, windowsExternalClientInventoryScript, type ExternalClientRuntimeOptions } from './external-client-runtime'
import type { ExternalToolId } from './external-tool-config'
import { InstallationQueue } from './installation-queue'
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
  it('keeps verified AppX results when an unrelated uninstall key is unreadable', async () => {
    // What the inventory script prints when an unrelated uninstall key throws but
    // the current-user AppX query answers. The Windows packaging job runs that
    // script against the same mocks for real (e2e/windows-powershell-probes-smoke.mjs)
    // and checks it still prints this shape; here only the runtime's reading of it.
    const registryIncomplete = '部分软件安装记录无法读取，暂时不能确认客户端是否未安装，请重试检测'
    const f = fixture()
    f.setInventory([appx({ running: false })], { workbuddy: registryIncomplete, claudeDesktop: registryIncomplete, opencode: registryIncomplete })
    const statuses = await f.runtime.scan()
    expect(statuses[1]).toMatchObject({ installed: true, launchSupported: true, detectionError: null })
    expect(statuses[0].detectionError).toContain('部分软件安装记录')
    await expect(f.runtime.install('workbuddy')).rejects.toThrow('不能确认')
    expect(f.execute.mock.calls.some(([spec]) => spec.executable === winget)).toBe(false)
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
    expect(statuses[2].installHint).toBe(externalClientWingetUnavailableHint)
    expect(statuses[2].installHint).not.toMatch(/winget|ENOENT|App Installer/i)
    expect(statuses.map((entry) => entry.officialDownloadUrl)).toEqual([null, null, 'https://opencode.ai/download'])
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
    expect((await f.runtime.scan())[0]).toMatchObject({ installSupported: true, installHint: '将使用腾讯官方安装包', officialDownloadUrl: null })
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

describe('Windows Claude Desktop official package route', () => {
  /** 官网那一路装好后，下一次盘点就能看到当前用户注册的 Claude 包。 */
  function claudeFixture(overrides: ExternalClientRuntimeOptions = {}) {
    const claudeOfficial = vi.fn<NonNullable<ExternalClientRuntimeOptions['installClaudeDesktopFromOfficial']>>()
    const routed: string[] = []
    const assertDiskSpace = vi.fn(async (_subject: string) => undefined)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const f = fixture({
      installClaudeDesktopFromOfficial: claudeOfficial, assertDiskSpace, fetch,
      withDownloadRoute: async (operation) => { routed.push('start'); try { return await operation() } finally { routed.push('end') } },
      ...overrides,
    })
    claudeOfficial.mockImplementation(async (options) => {
      options.onProgress?.({ phase: 'downloading', message: '正在从 Claude 官网下载离线安装包（42%）', percent: 42 })
      f.setInventory([appx()])
      return { version: '2.110.1.0' }
    })
    const inventoryCommand = f.execute.getMockImplementation()!
    function failWinget(failure: unknown) {
      f.execute.mockImplementation(async (spec, options) => {
        if (spec.executable === winget) throw failure
        return inventoryCommand(spec, options)
      })
    }
    return { ...f, claudeOfficial, routed, assertDiskSpace, fetch, inventoryCommand, failWinget }
  }
  const noWinget = { resolveWingetExecutable: async () => ({ executable: null, reason: 'missing' }) }

  it('offers one-click installation without winget and installs from the Claude website inside the download route', async () => {
    const f = claudeFixture({ ...noWinget, windowsExecutionMode: 'same-user' })
    expect((await f.runtime.scan())[1]).toMatchObject({ installSupported: true, installHint: null, officialDownloadUrl: null })
    const progress: ExternalClientInstallProgress[] = []
    await expect(f.runtime.install('claudeDesktop', (event) => progress.push(event))).resolves.toMatchObject({ installed: true, version: '2.110.1.0' })
    expect(f.claudeOfficial).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      architecture: 'x64', wingetTried: false, windowsExecutionMode: 'same-user', runCommand: f.execute, fetch: f.fetch,
      env: expect.objectContaining({ NODE_OPTIONS: '--require evil.cjs' }),
    }))
    expect(f.assertDiskSpace).toHaveBeenCalledWith('Claude Desktop 安装失败')
    expect(f.routed).toEqual(['start', 'end'])
    expect(f.execute.mock.calls.some(([spec]) => spec.executable === winget)).toBe(false)
    expect(progress.map((event) => event.message)).toEqual([
      'Claude Desktop 已加入安装队列', '正在检测 Claude Desktop', '正在从 Claude 官网下载离线安装包（0%）',
      '正在从 Claude 官网下载离线安装包（42%）', '正在验证安装结果', 'Claude Desktop 安装完成',
    ])
    expect(progress.find((event) => event.percent === 42)).toMatchObject({ tool: 'claudeDesktop', phase: 'downloading' })
  })

  it('installs the arm64 package on arm64 computers and defaults to trusted-only checks', async () => {
    const f = claudeFixture({ ...noWinget, architecture: 'arm64' })
    expect((await f.runtime.scan())[1]).toMatchObject({ installSupported: true, installHint: null })
    await expect(f.runtime.install('claudeDesktop')).resolves.toMatchObject({ installed: true })
    expect(f.claudeOfficial).toHaveBeenCalledWith(expect.objectContaining({ architecture: 'arm64', windowsExecutionMode: 'trusted-only' }))
  })

  it.each([
    ['a source connection failure', {}],
    ['a timeout', { code: 'TIMED_OUT' }],
    ['an installer failure', { exitCode: 1 }],
    ['a terminated installer', { signal: 'SIGTERM' }],
  ] satisfies Array<[string, Partial<CommandErrorDetails>]>)('falls back to the Claude website after %s', async (_label, details) => {
    const f = claudeFixture()
    f.failWinget(wingetError(details))
    const progress: string[] = []
    await expect(f.runtime.install('claudeDesktop', (event) => progress.push(event.message))).resolves.toMatchObject({ installed: true })
    expect(f.claudeOfficial).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ wingetTried: true }))
    expect(progress).toContain('系统自带的安装组件这次没装上，正在从 Claude 官网下载离线安装包（0%）')
    expect(progress.at(-1)).toBe('Claude Desktop 安装完成')
  })

  it('falls back even after winget reported that the installer had started', async () => {
    const f = claudeFixture()
    f.execute.mockImplementation(async (spec, options) => {
      if (spec.executable === winget) {
        options?.onOutput?.({ stream: 'stdout', text: 'Starting package install...' })
        throw wingetError({ exitCode: 0x80073cf3 })
      }
      return f.inventoryCommand(spec, options)
    })
    await expect(f.runtime.install('claudeDesktop')).resolves.toMatchObject({ installed: true })
    expect(f.claudeOfficial).toHaveBeenCalledOnce()
  })

  it.each([{ code: 'ABORTED' }, { exitCode: 1223 }, { exitCode: 0x800704c7 }] satisfies Partial<CommandErrorDetails>[])('never replaces a cancelled winget installation: %j', async (details) => {
    const f = claudeFixture()
    f.failWinget(wingetError(details))
    await expect(f.runtime.install('claudeDesktop')).rejects.toThrow('安装已取消。')
    expect(f.claudeOfficial).not.toHaveBeenCalled()
  })

  it.each(['installed', 'unknown'] as const)('rechecks Claude Desktop after a winget failure and avoids the fallback when status is %s', async (state) => {
    const f = claudeFixture()
    f.execute.mockImplementation(async (spec, options) => {
      if (spec.executable === winget) {
        f.setInventory(state === 'installed' ? [appx()] : [], state === 'unknown' ? { claudeDesktop: '无法读取当前用户 Claude 桌面端的 AppX 注册信息' } : {})
        throw wingetError({ exitCode: 1 })
      }
      return f.inventoryCommand(spec, options)
    })
    if (state === 'installed') await expect(f.runtime.install('claudeDesktop')).resolves.toMatchObject({ installed: true })
    else await expect(f.runtime.install('claudeDesktop')).rejects.toThrow('无法确认当前安装状态：无法读取当前用户 Claude 桌面端的 AppX 注册信息')
    expect(f.claudeOfficial).not.toHaveBeenCalled()
  })

  it('words a failed fallback in one plain sentence, keeps both raw causes for the log and permits a retry', async () => {
    const f = claudeFixture()
    const network = wingetError()
    const official = new Error('Claude 官网返回 HTTP 503')
    f.failWinget(network)
    f.claudeOfficial.mockRejectedValue(official)
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.runtime.install('claudeDesktop')).rejects.toMatchObject({
        message: 'Claude Desktop 没装上：系统自带的安装组件和 Claude 官网的离线安装包这次都没装上，Claude 官网这会儿连不上。',
        originalError: { winget: network, official },
      })
    }
    expect(f.claudeOfficial).toHaveBeenCalledTimes(2)
  })

  it('leaves the system installer out of the sentence when the computer never had one', async () => {
    const f = claudeFixture(noWinget)
    const official = new Error('Claude 官网的安装包缺少有效的 Anthropic 签名')
    f.claudeOfficial.mockRejectedValue(official)
    const progress: ExternalClientInstallProgress[] = []
    await expect(f.runtime.install('claudeDesktop', (event) => progress.push(event))).rejects.toMatchObject({
      message: 'Claude Desktop 没装上：下载下来的安装包不完整或不是官方原版，已经删掉了。',
      originalError: official,
    })
    expect(progress.at(-1)).toMatchObject({ phase: 'error', message: 'Claude Desktop 没装上：下载下来的安装包不完整或不是官方原版，已经删掉了。' })
  })

  it.each([
    '已取消管理员授权，Claude Desktop 安装未开始。重新点击安装即可再次授权。',
    '未获得管理员权限，Claude Desktop 安装已停止。请在弹出的授权窗口点击「是」；如果这台电脑用的是普通账号，需要输入一个管理员账号的密码。',
  ])('passes a sentence that already says what to do through unchanged: %s', async (message) => {
    const f = claudeFixture(noWinget)
    f.claudeOfficial.mockRejectedValue(new Error(message))
    await expect(f.runtime.install('claudeDesktop')).rejects.toThrow(message)
    await expect(f.runtime.install('claudeDesktop')).rejects.not.toThrow('没装上')
  })

  it('checks the disk before anything is downloaded', async () => {
    const f = claudeFixture({ ...noWinget, assertDiskSpace: async (subject) => { throw new Error(`${subject}：安装目录所在磁盘空间不足，只剩 1.0 GB，至少需要 2.0 GB，请先清理磁盘再试`) } })
    await expect(f.runtime.install('claudeDesktop')).rejects.toThrow('Claude Desktop 安装失败：安装目录所在磁盘空间不足，只剩 1.0 GB，至少需要 2.0 GB，请先清理磁盘再试')
    expect(f.claudeOfficial).not.toHaveBeenCalled()
    expect(f.routed).toEqual([])
  })

  it('does not mistake a finished official installation for a verified installed client', async () => {
    const f = claudeFixture(noWinget)
    f.claudeOfficial.mockResolvedValue({ version: '2.110.1.0' })
    await expect(f.runtime.install('claudeDesktop')).rejects.toThrow('未检测到客户端')
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
    return { execute, runtime: createExternalClientRuntime({ platform: 'darwin', architecture: 'arm64', userHome: '/Users/tester', runCommand: execute, verifyPath, getuid: () => 501, ...extra }) }
  }
  /** OpenCode 还没装、装完才出现在「应用程序」里的那台 Mac。 */
  function macInstallFixture(extra: ExternalClientRuntimeOptions = {}) {
    let placed = false
    const execute = vi.fn<typeof runCommand>(async (spec) => {
      if (spec.executable === '/usr/bin/plutil') return commandResult(spec, JSON.stringify({ CFBundleIdentifier: 'ai.opencode.desktop', CFBundleShortVersionString: '1.18.34' }))
      return commandResult(spec)
    })
    const verifyPath = vi.fn(async (candidate: string) => {
      if (placed && candidate.startsWith('/Applications/OpenCode.app')) return candidate
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    const installMacosDesktopApp = vi.fn<NonNullable<ExternalClientRuntimeOptions['installMacosDesktopApp']>>(async (options) => {
      options.onProgress?.({ phase: 'downloading', message: '正在下载 OpenCode 1.18.34', percent: 40 })
      await options.runProcess({ executable: '/usr/bin/codesign', argv: ['--verify'], timeoutMs: 1_000 })
      options.onProgress?.({ phase: 'installing', message: '正在放进「应用程序」', percent: null })
      placed = true
      return { version: '1.18.34', path: '/Applications/OpenCode.app' }
    })
    const assertDiskSpace = vi.fn(async (_subject: string) => undefined)
    const routed: string[] = []
    const runtime = createExternalClientRuntime({
      platform: 'darwin', architecture: 'arm64', userHome: '/Users/tester', runCommand: execute, verifyPath, getuid: () => 501,
      installMacosDesktopApp, assertDiskSpace, fetch: vi.fn<typeof fetch>(),
      withDownloadRoute: async (operation) => { routed.push('start'); try { return await operation() } finally { routed.push('end') } },
      ...extra,
    })
    return { execute, runtime, installMacosDesktopApp, assertDiskSpace, routed }
  }
  it('offers one-click installation only for clients whose official Mac package has been verified', async () => {
    const f = macInstallFixture()
    const statuses = await f.runtime.scan()
    expect(statuses.map((status) => [status.tool, status.installSupported])).toEqual([['workbuddy', false], ['claudeDesktop', false], ['opencode', true]])
    expect(statuses[2].installHint).toBeNull()
    expect(statuses[0].installHint).toContain('官网下载')
    // A bundle installed as root would belong to root, and the customer could never update it.
    const root = macInstallFixture({ getuid: () => 0 })
    expect((await root.runtime.scan())[2]).toMatchObject({ installSupported: false })
    await expect(root.runtime.install('opencode')).rejects.toThrow('官网下载')
    expect(root.installMacosDesktopApp).not.toHaveBeenCalled()
  })
  it('installs OpenCode from its official package inside the download route, then verifies it like any detected app', async () => {
    const f = macInstallFixture()
    const progress: string[] = []
    const status = await f.runtime.install('opencode', (event) => progress.push(event.message))
    expect(status).toMatchObject({ tool: 'opencode', installed: true, version: '1.18.34', path: '/Applications/OpenCode.app' })
    expect(f.assertDiskSpace).toHaveBeenCalledWith('OpenCode 安装失败')
    expect(f.routed).toEqual(['start', 'end'])
    expect(f.installMacosDesktopApp).toHaveBeenCalledWith(expect.objectContaining({ tool: 'opencode', architecture: 'arm64', userHome: '/Users/tester' }))
    expect(progress).toEqual([
      'OpenCode 已加入安装队列', '正在检测 OpenCode', '正在下载 OpenCode 1.18.34', '正在放进「应用程序」',
      '正在验证安装结果', 'OpenCode 安装完成',
    ])
    // The installer's own checks run through the same runner, never claiming trustedOnly on darwin.
    expect(f.execute).toHaveBeenCalledWith({ executable: '/usr/bin/codesign', argv: ['--verify'] }, expect.objectContaining({ trustedOnly: false, timeoutMs: 1_000 }))
    for (const [, options] of f.execute.mock.calls) expect(options?.trustedOnly).toBe(false)
    expect(f.execute.mock.calls.some(([spec]) => spec.executable === '/usr/sbin/spctl' && spec.argv.at(-1) === '/Applications/OpenCode.app')).toBe(true)
  })
  it('checks the disk before anything is downloaded and passes the installer failure on unchanged', async () => {
    const short = macInstallFixture({ assertDiskSpace: async (subject) => { throw new Error(`${subject}：安装目录所在磁盘空间不足`) } })
    await expect(short.runtime.install('opencode')).rejects.toThrow('OpenCode 安装失败：安装目录所在磁盘空间不足')
    expect(short.installMacosDesktopApp).not.toHaveBeenCalled()
    const failure = Object.assign(new Error('OpenCode 没下载下来，请检查网络后再点一次「安装」。'), { detail: 'fetch failed' })
    const failing = macInstallFixture({ installMacosDesktopApp: async () => { throw failure } })
    await expect(failing.runtime.install('opencode')).rejects.toBe(failure)
  })
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
