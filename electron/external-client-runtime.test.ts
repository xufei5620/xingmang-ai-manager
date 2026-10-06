import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CommandRunnerError, runCommand, type CommandErrorCode, type CommandSpec, type CommandErrorDetails } from './command-runner'
import type { ExternalClientInstallProgress } from './external-client-contract'
import { buildExternalClientWingetInstall, createExternalClientRuntime, externalClientWingetUnavailableHint, verifyExternalClientPath, windowsExternalClientInventoryScript, type ExternalClientRuntimeOptions } from './external-client-runtime'
import type { ExternalToolId } from './external-tool-config'
import { isInstallCancelledError } from './install-cancellation'
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
/** A download that only ends when the customer presses cancel. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
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

  // 第四十四批 A：首页只说「部分软件安装记录无法读取」，是哪几条、为什么只进运行日志。
  it('logs which uninstall keys could not be read, once for each distinct list', async () => {
    const registryIncomplete = '部分软件安装记录无法读取，暂时不能确认客户端是否未安装，请重试检测'
    const castFailure = { entry: 'nbi-nb-all-8.0.2.0', reason: 'Specified cast is not valid.' }
    const onRegistryIncomplete = vi.fn<NonNullable<ExternalClientRuntimeOptions['onRegistryIncomplete']>>()
    let failures: unknown = [castFailure]
    const f = fixture({ onRegistryIncomplete })
    f.execute.mockImplementation(async (spec) => commandResult(spec, JSON.stringify({
      clients: [], errors: { workbuddy: registryIncomplete, claudeDesktop: registryIncomplete, opencode: registryIncomplete },
      ...(failures === undefined ? {} : { registryFailures: failures }),
    })))
    expect((await f.runtime.scan())[0].detectionError).toBe(registryIncomplete)
    await f.runtime.scan({ force: true })
    expect(onRegistryIncomplete.mock.calls).toEqual([[[castFailure]]])
    // Another list is logged again, flattened to one line.
    const root = 'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    const rootFailures = [{ entry: root, reason: 'Requested registry\r\naccess is not allowed.' }]
    failures = rootFailures
    await f.runtime.scan({ force: true })
    expect(onRegistryIncomplete).toHaveBeenLastCalledWith([{ entry: root, reason: 'Requested registry access is not allowed.' }])
    // A scan that read everything, or printed nothing about it, forgets the last
    // list: the very same list coming back afterwards is logged again.
    failures = []
    await f.runtime.scan({ force: true })
    expect(onRegistryIncomplete).toHaveBeenCalledTimes(2)
    failures = rootFailures
    await f.runtime.scan({ force: true })
    expect(onRegistryIncomplete).toHaveBeenCalledTimes(3)
    failures = undefined
    await f.runtime.scan({ force: true })
    failures = rootFailures
    await f.runtime.scan({ force: true })
    expect(onRegistryIncomplete).toHaveBeenCalledTimes(4)
  })

  it('passes at most ten unreadable keys on, each bounded, whatever the script printed', async () => {
    const onRegistryIncomplete = vi.fn<NonNullable<ExternalClientRuntimeOptions['onRegistryIncomplete']>>()
    const f = fixture({ onRegistryIncomplete })
    f.execute.mockImplementation(async (spec) => commandResult(spec, JSON.stringify({
      clients: [candidate('workbuddy')], errors: {},
      registryFailures: Array.from({ length: 12 }, (_, index) => ({ entry: `entry-${index}`, reason: 'x'.repeat(2_000) })),
    })))
    expect((await f.runtime.scan())[0]).toMatchObject({ installed: true, detectionError: null })
    const logged = onRegistryIncomplete.mock.calls[0][0]
    expect(logged).toHaveLength(10)
    expect(logged[0]).toEqual({ entry: 'entry-0', reason: 'x'.repeat(500) })
  })

  it('reads just the matched values again from an uninstall key Get-ItemProperty cannot convert', () => {
    // The Windows packaging job runs this against a real key with a malformed
    // value (e2e/windows-powershell-probes-smoke.mjs); here only what it reads.
    const script = windowsExternalClientInventoryScript()
    expect(script).toContain("foreach ($name in @('DisplayName', 'InstallLocation', 'DisplayIcon', 'DisplayVersion'))")
    expect(script).toContain('try { $registry.Add((Read-UninstallValues $key)) }')
    expect(script).toContain('$registryFailures.Count -lt 10')
    expect(script).toContain('registryFailures=@($registryFailures.ToArray())')
  })

  // 已知3：AppX 注册信息、数字签名读不出时，首页那一行只说前半句中文，PowerShell 的原话只进运行日志。
  it('keeps what PowerShell said out of the sentences the inventory script prints', () => {
    // The Windows packaging job runs both failures for real (e2e/windows-powershell-probes-smoke.mjs).
    const script = windowsExternalClientInventoryScript()
    expect(script).toContain("$errors.claudeDesktop = '无法读取当前用户 Claude 桌面端的 AppX 注册信息'; $errorDetails.claudeDesktop = [string]$_.Exception.Message")
    expect(script).toContain("$errors[$product.tool] = '无法读取客户端数字签名'; $errorDetails[$product.tool] = [string]$_.Exception.Message")
    expect(script).toContain('errorDetails=$errorDetails')
    expect(script).not.toMatch(/\$errors[^\r\n]*\+ \$_\.Exception\.Message/)
  })

  it('logs what PowerShell said beside a Chinese detection failure, once for each distinct message', async () => {
    const appxReason = '无法读取当前用户 Claude 桌面端的 AppX 注册信息'
    const signatureReason = '无法读取客户端数字签名'
    const signatureMessage = 'Access to the path C:\\Users\\Tester\\AppData\\Local\\WorkBuddy\\WorkBuddy.exe is denied.'
    const onDetectionErrorDetail = vi.fn<NonNullable<ExternalClientRuntimeOptions['onDetectionErrorDetail']>>()
    const failing = {
      // OpenCode's own sentence is replaced by the runtime's check of the signature
      // it did read: PowerShell's words no longer belong to what the row says.
      clients: [candidate('opencode', { signatureStatus: 'HashMismatch' })],
      errors: { workbuddy: signatureReason, claudeDesktop: appxReason, opencode: signatureReason },
      errorDetails: { workbuddy: signatureMessage, claudeDesktop: 'The AppX Deployment Service\r\nis not running.', opencode: 'stale' },
    }
    let output: Record<string, unknown> = failing
    const f = fixture({ onDetectionErrorDetail })
    f.execute.mockImplementation(async (spec) => commandResult(spec, JSON.stringify(output)))
    expect((await f.runtime.scan()).map((status) => status.detectionError)).toEqual([
      signatureReason, appxReason, '客户端数字签名无效或签名发布者与官方发布者不一致',
    ])
    expect(onDetectionErrorDetail.mock.calls).toEqual([
      [{ tool: 'workbuddy', reason: signatureReason, message: signatureMessage }],
      [{ tool: 'claudeDesktop', reason: appxReason, message: 'The AppX Deployment Service is not running.' }],
    ])
    await f.runtime.scan({ force: true })
    expect(onDetectionErrorDetail).toHaveBeenCalledTimes(2)
    // Claude Desktop found this time: its message is forgotten, and the same one
    // coming back afterwards is logged again. WorkBuddy's never went away.
    output = { ...failing, clients: [...failing.clients, appx()] }
    expect((await f.runtime.scan({ force: true }))[1]).toMatchObject({ installed: true, detectionError: null })
    output = failing
    await f.runtime.scan({ force: true })
    expect(onDetectionErrorDetail).toHaveBeenCalledTimes(3)
    expect(onDetectionErrorDetail).toHaveBeenLastCalledWith({ tool: 'claudeDesktop', reason: appxReason, message: 'The AppX Deployment Service is not running.' })
    // Output from an older script, or a malformed list, only loses the log line.
    output = { ...failing, errorDetails: ['not', 'a', 'map'] }
    expect((await f.runtime.scan({ force: true }))[0].detectionError).toBe(signatureReason)
    output = failing
    await f.runtime.scan({ force: true })
    expect(onDetectionErrorDetail).toHaveBeenCalledTimes(5)
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

  it('cancels an install still waiting in the queue at once, before it touches anything, and installs again afterwards', async () => {
    const queue = new InstallationQueue()
    const blocker = deferred()
    const ahead = queue.enqueue('existing-runtime-install', () => blocker.promise)
    const f = fixture({ installationQueue: queue })
    const progress: ExternalClientInstallProgress[] = []
    const install = f.runtime.install('opencode', (event) => progress.push(event))
    const settled = install.then(() => 'installed', (cause: unknown) => cause)
    expect(f.runtime.cancelInstall('opencode')).toEqual({ cancelled: true, reason: null })
    // 再点一次仍是同一个「取消中」。
    expect(f.runtime.cancelInstall('opencode')).toEqual({ cancelled: true, reason: null })
    await new Promise<void>((resolve) => setImmediate(resolve))
    // 前面那项还没装完，排着队的这一项已经出队、结束了，不用等它。
    const error = await Promise.race([settled, Promise.resolve('still waiting for the install ahead')])
    expect(isInstallCancelledError(error)).toBe(true)
    expect((error as Error).message).toBe('OpenCode 安装已取消')
    expect(progress.map((event) => event.phase)).toEqual(['queued', 'error'])
    expect(progress.at(-1)).toMatchObject({ phase: 'error', message: 'OpenCode 安装已取消' })
    expect(queue.snapshot()).toEqual({ activeKey: 'existing-runtime-install', pendingKeys: [] })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.runtime.cancelInstall('opencode')).toEqual({ cancelled: false, reason: '这个工具当前没有正在进行的安装。' })
    blocker.resolve()
    await ahead
    f.setInventory([candidate('opencode')])
    await expect(f.runtime.install('opencode')).resolves.toMatchObject({ installed: true })
  })

  it('refuses to cancel while winget runs, because ending it ends the installer it started', async () => {
    const f = fixture()
    const wingetRunning = deferred()
    const finishWinget = deferred()
    const inventoryCommand = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (spec, options) => {
      if (spec.executable !== winget) return inventoryCommand(spec, options)
      wingetRunning.resolve()
      await finishWinget.promise
      f.setInventory([candidate('opencode')])
      return commandResult(spec)
    })
    const install = f.runtime.install('opencode')
    await wingetRunning.promise
    expect(f.runtime.cancelInstall('opencode')).toEqual({
      cancelled: false, reason: '正在安装 OpenCode，这一步中断会留下装了一半的程序，请等它结束。',
    })
    finishWinget.resolve()
    await expect(install).resolves.toMatchObject({ installed: true })
    expect(f.execute.mock.calls.find(([spec]) => spec.executable === winget)?.[1]?.signal).toBeUndefined()
  })

  it('stops the Tencent download on cancel but not the Tencent installer once it runs', async () => {
    const f = fixture({ resolveWingetExecutable: async () => ({ executable: null, reason: 'missing' }) })
    const downloading = deferred()
    f.officialInstaller.mockImplementationOnce(async (options) => {
      downloading.resolve()
      await untilAborted(options?.signal)
    })
    const cancelled = f.runtime.install('workbuddy')
    await downloading.promise
    expect(f.runtime.cancelInstall('workbuddy')).toEqual({ cancelled: true, reason: null })
    await expect(cancelled).rejects.toThrow('WorkBuddy 安装已取消')

    const installing = deferred()
    const finish = deferred()
    f.officialInstaller.mockImplementationOnce(async (options) => {
      options?.onInstallStarting?.()
      installing.resolve()
      await finish.promise
      f.setInventory([candidate('workbuddy')])
    })
    const install = f.runtime.install('workbuddy')
    await installing.promise
    expect(f.runtime.cancelInstall('workbuddy')).toEqual({
      cancelled: false, reason: '正在安装 WorkBuddy，这一步中断会留下装了一半的程序，请等它结束。',
    })
    finish.resolve()
    await expect(install).resolves.toMatchObject({ installed: true })
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

  // 第四十三批 A：换线路动客户端配置之前看它开没开，要的是这次调用之后才开始的那一轮。
  it('answers a fresh scan with an inventory taken after the call, never the cached or in-flight one', async () => {
    const f = fixture()
    f.setInventory([candidate('opencode')])
    await f.runtime.scan()
    f.setInventory([candidate('opencode', { running: true })])
    expect((await f.runtime.scan())[2].running).toBe(false)
    expect((await f.runtime.scan({ fresh: true }))[2].running).toBe(true)
    expect(f.execute).toHaveBeenCalledTimes(2)

    // 盘点已经在跑，客户这时才把 OpenCode 关掉：正在跑的那次读的是关之前的，fresh 等它跑完再盘点一轮。
    const gate = deferred<ReturnType<typeof commandResult>>()
    f.execute.mockImplementationOnce(() => gate.promise)
    const inFlight = f.runtime.scan({ force: true })
    f.setInventory([candidate('opencode')])
    const fresh = f.runtime.scan({ fresh: true })
    expect(f.runtime.scan({ force: true })).toBe(inFlight)
    gate.resolve(commandResult({ executable: powershell, argv: [] }, JSON.stringify({ clients: [candidate('opencode', { running: true })], errors: {} })))
    expect((await inFlight)[2].running).toBe(true)
    expect((await fresh)[2].running).toBe(false)
    expect(f.execute).toHaveBeenCalledTimes(4)
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

  // 第四十四批 B：winget 自己的软件源坏了（源数据没有、对不上）也发生在动手之前，同连不上一样换腾讯官方。
  it.each([0x8a15000f, 0x8a15000f | 0, 0x8a15003f])('recovers WorkBuddy through its official installer when the winget source itself is broken (%s)', async (exitCode) => {
    const f = fixture()
    const progress: ExternalClientInstallProgress[] = []
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable === winget) {
        throw wingetError({
          exitCode,
          stdout: "Failed when opening source(s); try the 'source reset' command if the problem persists.\r\nAn unexpected error occurred while executing the command:\r\n0x8a15000f : Data required by the source is missing\r\n",
        })
      }
      return commandResult(spec, JSON.stringify({ clients: f.officialInstaller.mock.calls.length ? [candidate('workbuddy')] : [], errors: {} }))
    })
    f.officialInstaller.mockResolvedValue(undefined)
    await expect(f.runtime.install('workbuddy', (event) => progress.push(event))).resolves.toMatchObject({ installed: true })
    expect(f.officialInstaller).toHaveBeenCalledOnce()
    expect(progress.map((event) => event.message)).toContain('连不上微软的软件下载源，正在切换到腾讯官方下载')
    expect(progress.at(-1)).toMatchObject({ phase: 'completed', percent: 100 })
  })

  it('leaves WorkBuddy to winget once its installer started, even when winget then reports missing source data', async () => {
    const f = fixture()
    f.execute.mockImplementation(async (spec, options) => {
      if (spec.executable === winget) {
        options?.onOutput?.({ stream: 'stdout', text: 'Starting package install...' })
        throw wingetError({ exitCode: 0x8a15000f })
      }
      return commandResult(spec, '{"clients":[],"errors":{}}')
    })
    await expect(f.runtime.install('workbuddy')).rejects.toThrow('安装没有完成（错误码 0x8a15000f）')
    expect(f.officialInstaller).not.toHaveBeenCalled()
  })

  it('still reports a broken winget source for OpenCode, which has no other route', async () => {
    const f = fixture()
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable === winget) throw wingetError({ exitCode: 0x8a15000f })
      return commandResult(spec, '{"clients":[],"errors":{}}')
    })
    await expect(f.runtime.install('opencode')).rejects.toThrow('安装没有完成（错误码 0x8a15000f），请查看运行日志中的安装器输出。')
    expect(f.officialInstaller).not.toHaveBeenCalled()
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

  it.each([
    ['without winget', noWinget, null],
    ['after winget failed', {}, wingetError()],
  ] as const)('stops the Claude website download when the customer cancels %s, and installs again afterwards', async (_label, overrides, wingetFailure) => {
    const f = claudeFixture(overrides)
    if (wingetFailure) f.failWinget(wingetFailure)
    const downloading = deferred()
    f.claudeOfficial.mockImplementationOnce(async (options) => {
      downloading.resolve()
      return untilAborted(options.signal)
    })
    const progress: ExternalClientInstallProgress[] = []
    const install = f.runtime.install('claudeDesktop', (event) => progress.push(event))
    await downloading.promise
    expect(f.runtime.cancelInstall('claudeDesktop')).toEqual({ cancelled: true, reason: null })
    const error = await install.catch((cause: unknown) => cause)
    expect(isInstallCancelledError(error)).toBe(true)
    expect((error as Error).message).toBe('Claude Desktop 安装已取消')
    expect(progress.at(-1)).toMatchObject({ phase: 'error', message: 'Claude Desktop 安装已取消' })
    expect(f.routed).toEqual(['start', 'end'])
    await expect(f.runtime.install('claudeDesktop')).resolves.toMatchObject({ installed: true })
  })

  it('refuses to cancel once the downloaded package is handed to Windows', async () => {
    const f = claudeFixture(noWinget)
    const installing = deferred()
    const finish = deferred()
    f.claudeOfficial.mockImplementationOnce(async (options) => {
      options.onInstallStarting?.()
      installing.resolve()
      await finish.promise
      f.setInventory([appx()])
      return { version: '2.110.1.0' }
    })
    const install = f.runtime.install('claudeDesktop')
    await installing.promise
    expect(f.runtime.cancelInstall('claudeDesktop')).toEqual({
      cancelled: false, reason: '正在安装 Claude Desktop，这一步中断会留下装了一半的程序，请等它结束。',
    })
    finish.resolve()
    await expect(install).resolves.toMatchObject({ installed: true, version: '2.110.1.0' })
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
    expect(statuses.map((status) => [status.tool, status.installSupported])).toEqual([['workbuddy', false], ['claudeDesktop', true], ['opencode', true]])
    expect(statuses[1].installHint).toBeNull()
    expect(statuses[2].installHint).toBeNull()
    expect(statuses[0].installHint).toContain('官网下载')
    // A bundle installed as root would belong to root, and the customer could never update it.
    const root = macInstallFixture({ getuid: () => 0 })
    expect((await root.runtime.scan()).map((status) => status.installSupported)).toEqual([false, false, false])
    await expect(root.runtime.install('opencode')).rejects.toThrow('官网下载')
    await expect(root.runtime.install('claudeDesktop')).rejects.toThrow('官网下载')
    expect(root.installMacosDesktopApp).not.toHaveBeenCalled()
  })
  it('installs Claude Desktop through the same verified installer and detects it afterwards', async () => {
    let placed = false
    const execute = vi.fn<typeof runCommand>(async (spec) => {
      if (spec.executable === '/usr/bin/plutil') return commandResult(spec, JSON.stringify({ CFBundleIdentifier: 'com.anthropic.claudefordesktop', CFBundleShortVersionString: '2.19675.0' }))
      return commandResult(spec)
    })
    const verifyPath = vi.fn(async (candidate: string) => {
      if (placed && candidate.startsWith('/Applications/Claude.app')) return candidate
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    const installMacosDesktopApp = vi.fn<NonNullable<ExternalClientRuntimeOptions['installMacosDesktopApp']>>(async () => {
      placed = true
      return { version: '2.19675.0', path: '/Applications/Claude.app' }
    })
    const runtime = createExternalClientRuntime({
      platform: 'darwin', architecture: 'x64', userHome: '/Users/tester', runCommand: execute, verifyPath, getuid: () => 501,
      installMacosDesktopApp, assertDiskSpace: async () => undefined, fetch: vi.fn<typeof fetch>(),
    })
    const status = await runtime.install('claudeDesktop')
    expect(status).toMatchObject({ tool: 'claudeDesktop', installed: true, version: '2.19675.0', path: '/Applications/Claude.app' })
    expect(installMacosDesktopApp).toHaveBeenCalledWith(expect.objectContaining({ tool: 'claudeDesktop', architecture: 'x64', userHome: '/Users/tester' }))
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
  it('stops a Mac install at any step when the customer cancels, even while the app is being moved into place', async () => {
    const placing = deferred()
    const f = macInstallFixture({ installMacosDesktopApp: async (options) => {
      await options.runProcess({ executable: '/usr/bin/sw_vers', argv: ['-productVersion'], timeoutMs: 1_000 })
      // 放进「应用程序」是整个改名，停在哪一步都不会留下半个应用，所以这一步也接受取消。
      options.onProgress?.({ phase: 'installing', message: '正在放进「应用程序」', percent: null })
      placing.resolve()
      return untilAborted(options.signal)
    } })
    const install = f.runtime.install('opencode')
    await placing.promise
    expect(f.runtime.cancelInstall('opencode')).toEqual({ cancelled: true, reason: null })
    await expect(install).rejects.toThrow('OpenCode 安装已取消')
    // The installer's own processes listen to the same cancel.
    expect(f.execute.mock.calls.find(([spec]) => spec.executable === '/usr/bin/sw_vers')?.[1]?.signal?.aborted).toBe(true)
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
    // WorkBuddy is the one client without a Mac package the toolbox could verify.
    const f = macFixture({ verifyPath: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } })
    const status = (await f.runtime.scan())[0]
    expect(status).toMatchObject({ tool: 'workbuddy', installed: false, detectionError: null, installSupported: false })
    await expect(f.runtime.install('workbuddy')).rejects.toThrow('官网下载')
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

// 第三十一批 C：打开只现验要开的那一个；展示用的检测认几分钟内验过、包没变的结果（同 Windows 的 knownSignatures）。
describe('macOS external client signature checks', () => {
  const bundles: Record<ExternalToolId, string> = { workbuddy: '/Applications/WorkBuddy.app', claudeDesktop: '/Applications/Claude.app', opencode: '/Applications/OpenCode.app' }
  const bundleIds: Record<ExternalToolId, string> = { workbuddy: 'com.tencent.workbuddy.mac', claudeDesktop: 'com.anthropic.claudefordesktop', opencode: 'ai.opencode.desktop' }
  const tools = Object.keys(bundles) as ExternalToolId[]
  /** 三家都装着的 Mac。rejected 里的包 spctl 不放行；touch 改一个文件的修改时间。 */
  function allInstalled(extra: ExternalClientRuntimeOptions = {}) {
    let clock = 1_000
    let executableName: string | undefined = 'Main'
    const rejected = new Set<string>()
    const mtimes = new Map<string, number>()
    const execute = vi.fn<typeof runCommand>(async (spec) => {
      const target = tools.find((tool) => spec.argv.some((arg) => arg.startsWith(bundles[tool])))
      if (spec.executable === '/usr/bin/plutil') {
        return commandResult(spec, JSON.stringify({ CFBundleIdentifier: bundleIds[target!], CFBundleShortVersionString: '1.0.0', CFBundleExecutable: executableName }))
      }
      if (spec.executable === '/usr/sbin/spctl' && target && rejected.has(bundles[target])) throw new Error('rejected by Gatekeeper')
      return commandResult(spec)
    })
    const lstatPath = vi.fn(async (candidate: string) => ({
      dev: 1, ino: candidate.length, mtimeMs: mtimes.get(candidate) ?? 100, size: 10, isFile: () => candidate.includes('/Contents/'),
    }))
    // 三家都装在 /Applications，~/Applications 下没有：某家在 /Applications 验不过时，不会再从那边读出另一种错。
    const verifyPath = async (candidate: string) => {
      if (candidate.startsWith('/Applications/')) return candidate
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    const runtime = createExternalClientRuntime({
      platform: 'darwin', architecture: 'arm64', userHome: '/Users/tester', runCommand: execute,
      verifyPath, lstatPath, getuid: () => 501, now: () => clock, ...extra,
    })
    /** 这个客户端从上次清零以来跑过的签名核对（spctl、codesign），按先后。 */
    function checks(tool: ExternalToolId): string[] {
      return execute.mock.calls
        .filter(([spec]) => (spec.executable === '/usr/sbin/spctl' || spec.executable === '/usr/bin/codesign') && spec.argv.includes(bundles[tool]))
        .map(([spec]) => spec.executable)
    }
    return {
      execute, runtime, checks, rejected,
      advance(ms: number) { clock += ms },
      touch(file: string) { mtimes.set(file, (mtimes.get(file) ?? 100) + 1) },
      dropExecutableName() { executableName = undefined },
    }
  }

  it('verifies only the client it opens, in full', async () => {
    const f = allInstalled()
    await f.runtime.launch('claudeDesktop')
    expect(f.checks('claudeDesktop')).toEqual(['/usr/sbin/spctl'])
    expect(f.checks('workbuddy')).toEqual([])
    expect(f.checks('opencode')).toEqual([])
    expect(f.execute.mock.calls.filter(([spec]) => spec.executable === '/usr/bin/plutil').map(([spec]) => spec.argv.at(-1)))
      .toEqual(['/Applications/Claude.app/Contents/Info.plist'])
    expect(f.execute).toHaveBeenCalledWith({ executable: '/usr/bin/open', argv: ['-a', '/Applications/Claude.app'] }, expect.any(Object))

    f.execute.mockClear()
    await f.runtime.launch('workbuddy')
    // WorkBuddy 照旧加一次整包深验。
    expect(f.checks('workbuddy')).toEqual(['/usr/sbin/spctl', '/usr/bin/codesign'])
    expect(f.checks('claudeDesktop')).toEqual([])
  })

  it('never lets opening or installing reuse an earlier verification', async () => {
    const f = allInstalled()
    await f.runtime.scan()
    f.execute.mockClear()
    await f.runtime.launch('workbuddy')
    expect(f.checks('workbuddy')).toEqual(['/usr/sbin/spctl', '/usr/bin/codesign'])
    f.execute.mockClear()
    await expect(f.runtime.install('claudeDesktop')).resolves.toMatchObject({ installed: true })
    for (const tool of tools) expect(f.checks(tool).length, tool).toBeGreaterThan(0)
  })

  it('lets a display scan reuse a verification from the last few minutes while the bundle is unchanged', async () => {
    const f = allInstalled()
    expect((await f.runtime.scan()).map((status) => status.installed)).toEqual([true, true, true])
    f.execute.mockClear()
    const statuses = await f.runtime.scan({ force: true })
    expect(statuses.map((status) => [status.installed, status.detectionError])).toEqual([[true, null], [true, null], [true, null]])
    for (const tool of tools) expect(f.checks(tool), tool).toEqual([])
    // 应用标识和「运行中」照旧每次现读。
    expect(f.execute.mock.calls.filter(([spec]) => spec.executable === '/usr/bin/plutil')).toHaveLength(3)
    expect(f.execute.mock.calls.some(([spec]) => spec.executable === '/bin/ps')).toBe(true)
  })

  it('remembers the verification made when opening, so the scan after it skips that deep check', async () => {
    const f = allInstalled()
    await f.runtime.launch('workbuddy')
    f.execute.mockClear()
    await f.runtime.scan()
    expect(f.checks('workbuddy')).toEqual([])
    // 另两家这之前没验过，照旧现验。
    expect(f.checks('claudeDesktop')).toEqual(['/usr/sbin/spctl'])
    expect(f.checks('opencode')).toEqual(['/usr/sbin/spctl'])
  })

  it('verifies again once the bundle changes or the few minutes are up', async () => {
    const f = allInstalled()
    await f.runtime.scan()
    f.touch('/Applications/WorkBuddy.app/Contents/MacOS/Main')
    f.execute.mockClear()
    await f.runtime.scan({ force: true })
    expect(f.checks('workbuddy')).toEqual(['/usr/sbin/spctl', '/usr/bin/codesign'])
    expect(f.checks('opencode')).toEqual([])

    f.advance(5 * 60_000)
    f.execute.mockClear()
    await f.runtime.scan({ force: true })
    for (const tool of tools) expect(f.checks(tool).length, tool).toBeGreaterThan(0)
  })

  it('forgets an earlier pass as soon as a fresh verification fails', async () => {
    const f = allInstalled()
    await f.runtime.scan()
    f.rejected.add('/Applications/OpenCode.app')
    await expect(f.runtime.launch('opencode')).rejects.toThrow('rejected by Gatekeeper')
    f.execute.mockClear()
    const statuses = await f.runtime.scan({ force: true })
    expect(statuses[2]).toMatchObject({ tool: 'opencode', installed: false, detectionError: 'rejected by Gatekeeper' })
    expect(f.checks('opencode')).toEqual(['/usr/sbin/spctl'])
    f.rejected.clear()
    f.execute.mockClear()
    expect((await f.runtime.scan({ force: true }))[2].installed).toBe(true)
    expect(f.checks('opencode')).toEqual(['/usr/sbin/spctl'])
  })

  it('verifies every time when the bundle names no main program to fingerprint', async () => {
    const f = allInstalled()
    f.dropExecutableName()
    await f.runtime.scan()
    f.execute.mockClear()
    await f.runtime.scan({ force: true })
    for (const tool of tools) expect(f.checks(tool).length, tool).toBeGreaterThan(0)
  })

  // 第四十四批 D：苹果明说不放行时，首页那一行说的和 Windows 上签名不对时同一句；苹果的原话只进运行日志。
  const signatureMismatch = '客户端数字签名无效或签名发布者与官方发布者不一致'
  /** runCommand 报一条外部命令没跑成时抛的就是它；stderr 是命令自己写的原话。 */
  function commandFailure(executable: string, code: CommandErrorCode, exitCode: number | null, stderr = '') {
    const name = executable.split('/').pop()
    return new CommandRunnerError(code === 'TIMED_OUT' ? `命令执行时间过长，已中止：${name}` : `命令执行失败（退出码 ${exitCode}）：${name}`, {
      code, executable, argv: [], exitCode, signal: null, stdout: '', stderr, outputBytes: stderr.length, maxOutputBytes: 262_144, durationMs: 5,
    })
  }
  /** 三家都装着的 Mac，其中一个包的某道核对按 fail() 给的失败；fail(null) 恢复放行。 */
  function oneRefused(bundle: string) {
    const onMacVerificationFailed = vi.fn<NonNullable<ExternalClientRuntimeOptions['onMacVerificationFailed']>>()
    const f = allInstalled({ onMacVerificationFailed })
    const allowed = f.execute.getMockImplementation()!
    let failure: CommandRunnerError | null = null
    f.execute.mockImplementation(async (spec, options) => {
      if (failure && spec.executable === failure.executable && spec.argv.includes(bundle)) throw failure
      return allowed(spec, options)
    })
    return { ...f, onMacVerificationFailed, fail(next: CommandRunnerError | null) { failure = next } }
  }

  it('says the signature sentence when Gatekeeper refuses a client and logs what spctl said, once', async () => {
    const f = oneRefused(bundles.claudeDesktop)
    const said = '/Applications/Claude.app: rejected\nsource=Unnotarized Developer ID'
    f.fail(commandFailure('/usr/sbin/spctl', 'EXIT_NON_ZERO', 3, `${said}\n`))
    const statuses = await f.runtime.scan()
    expect(statuses[1]).toMatchObject({ tool: 'claudeDesktop', installed: false, launchSupported: false, detectionError: signatureMismatch })
    expect(statuses[0]).toMatchObject({ installed: true, detectionError: null })
    expect(f.onMacVerificationFailed.mock.calls).toEqual([[
      { tool: 'claudeDesktop', path: bundles.claudeDesktop, command: 'spctl', code: 'EXIT_NON_ZERO', exitCode: 3, output: said },
    ]])
    // Rescanning and opening meet the same refusal: the same sentence, no second log line.
    expect((await f.runtime.scan({ force: true }))[1].detectionError).toBe(signatureMismatch)
    await expect(f.runtime.launch('claudeDesktop')).rejects.toThrow(signatureMismatch)
    expect(f.execute.mock.calls.some(([spec]) => spec.executable === '/usr/bin/open')).toBe(false)
    expect(f.onMacVerificationFailed).toHaveBeenCalledOnce()
    // Once it passes, a later refusal is news again.
    f.fail(null)
    expect((await f.runtime.scan({ force: true }))[1].installed).toBe(true)
    f.advance(5 * 60_000)
    f.fail(commandFailure('/usr/sbin/spctl', 'EXIT_NON_ZERO', 3, `${said}\n`))
    expect((await f.runtime.scan({ force: true }))[1].detectionError).toBe(signatureMismatch)
    expect(f.onMacVerificationFailed).toHaveBeenCalledTimes(2)
  })

  it.each([
    [1, '/Applications/WorkBuddy.app: a sealed resource is missing or invalid'],
    [3, 'test-requirement: code failed to satisfy specified code requirement(s)'],
  ] as const)('says the same sentence when codesign refuses WorkBuddy with exit code %s', async (exitCode, said) => {
    const f = oneRefused(bundles.workbuddy)
    f.fail(commandFailure('/usr/bin/codesign', 'EXIT_NON_ZERO', exitCode, said))
    expect((await f.runtime.scan())[0]).toMatchObject({ tool: 'workbuddy', installed: false, detectionError: signatureMismatch })
    expect(f.onMacVerificationFailed).toHaveBeenCalledExactlyOnceWith({
      tool: 'workbuddy', path: bundles.workbuddy, command: 'codesign', code: 'EXIT_NON_ZERO', exitCode, output: said,
    })
  })

  it.each([
    ['a timeout', commandFailure('/usr/sbin/spctl', 'TIMED_OUT', null), '命令执行时间过长，已中止：spctl'],
    ['any other exit code', commandFailure('/usr/sbin/spctl', 'EXIT_NON_ZERO', 1, 'spctl: internal error'), '命令执行失败（退出码 1）：spctl'],
  ] as const)('keeps %s as it was on screen, and still logs it', async (_case, failure, shown) => {
    const f = oneRefused(bundles.opencode)
    f.fail(failure)
    expect((await f.runtime.scan())[2]).toMatchObject({ tool: 'opencode', installed: false, detectionError: shown })
    expect(f.onMacVerificationFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      tool: 'opencode', command: 'spctl', code: failure.code, exitCode: failure.exitCode, output: failure.stderr,
    }))
  })
})
