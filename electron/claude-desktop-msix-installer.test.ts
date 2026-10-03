import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyClaudeDesktopInstallFailure } from './claude-desktop-install-failure'
import {
  buildClaudeDesktopPackageInspectionScript, claudeDesktopMsixEntryUrl, describeClaudeDesktopMsixDownload,
  installClaudeDesktopFromOfficial, validateClaudeDesktopDownloadUrl, validateClaudeDesktopPackageInspection,
  windowsPackagePublisherId, type ClaudeDesktopMsixInstallOptions, type ClaudeDesktopMsixProgress,
} from './claude-desktop-msix-installer'
import { claudeAppxProduct } from './codex-desktop-appx'
import { CommandRunnerError, type CommandSpec, type runCommand } from './command-runner'
import { decodeWindowsPowerShellCommand } from './windows-elevation'

// No real Claude package is downloaded or installed: fetch, PowerShell and the
// MSIX installer are all replaced. The repository does not carry Anthropic's
// full publisher string, so the happy path checks a known Microsoft publisher
// against its known family suffix through the publisher-ID test seam.
const machinePaths = {
  systemRoot: 'C:\\Windows', system32: 'C:\\Windows\\System32', programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)', programData: 'C:\\ProgramData',
}
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const microsoftPublisher = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
const microsoftPublisherId = '8wekyb3d8bbwe'
const releaseUrl = 'https://downloads.claude.ai/releases/win32/x64/1.1.2345/Claude-0123abcd.msix'
const payload = Buffer.alloc(10 * 1024 * 1024 + 4096, 0x5a)
const temporaryDirectories: string[] = []

function inspectionRecord(extra: Record<string, unknown> = {}) {
  return {
    name: 'Claude', version: '1.1.2345.0', architecture: 'x64', publisher: microsoftPublisher, publisherCanonical: microsoftPublisher,
    hasSignature: true, signatureStatus: 'Valid', signerName: 'Anthropic, PBC', signerSubject: microsoftPublisher, ...extra,
  }
}
function redirect(location: string | null, status = 307): Response {
  return new Response(null, { status, headers: location === null ? {} : { location } })
}
function packageResponse(body: Uint8Array = payload, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/vnd.ms-appx', 'content-length': String(body.byteLength), etag: '"claude-v1"', ...headers },
  })
}
function brokenBody(first: Uint8Array): ReadableStream<Uint8Array> {
  let pulls = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(first)
      else controller.error(new TypeError('terminated'))
    },
  })
}
function result(spec: CommandSpec, stdout = '') {
  return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: stdout.length, durationMs: 1 }
}
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input)
}
async function fixture(overrides: Partial<ClaudeDesktopMsixInstallOptions> = {}) {
  const directory = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-claude-msix-test-')))
  temporaryDirectories.push(directory)
  const packagePath = path.join(directory, 'Claude-x64.msix')
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => (
    requestUrl(input) === claudeDesktopMsixEntryUrl('x64') ? redirect(releaseUrl) : packageResponse()
  ))
  const execute = vi.fn<typeof runCommand>(async (spec) => result(spec, JSON.stringify(inspectionRecord())))
  const installed: Buffer[] = []
  const installPackage = vi.fn<NonNullable<ClaudeDesktopMsixInstallOptions['installPackage']>>(async (file) => {
    installed.push(await fs.promises.readFile(file))
  })
  const createTemporaryDirectory = vi.fn(async () => directory)
  const progress: ClaudeDesktopMsixProgress[] = []
  const options: ClaudeDesktopMsixInstallOptions = {
    architecture: 'x64', wingetTried: false, fetch, platform: 'win32', windowsExecutionMode: 'same-user',
    env: { NODE_OPTIONS: '--require evil.cjs', PSModulePath: 'C:\\untrusted', PATH: 'C:\\untrusted' },
    runCommand: execute, resolveMachinePaths: () => machinePaths, resolvePowerShellExecutable: () => powershell,
    createTemporaryDirectory, installPackage, packagePublisherId: microsoftPublisherId,
    resumeOptions: { wait: async () => undefined },
    onProgress: (event) => progress.push(event), ...overrides,
  }
  return { directory, packagePath, fetch, execute, installPackage, installed, createTemporaryDirectory, progress, options }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })))
})

describe('Claude Desktop official MSIX download addresses', () => {
  it('accepts only the documented entry and the release files it redirects to', () => {
    for (const value of [claudeDesktopMsixEntryUrl('x64'), claudeDesktopMsixEntryUrl('arm64'), releaseUrl]) {
      expect(validateClaudeDesktopDownloadUrl(value).href).toBe(value)
    }
    for (const value of [
      'http://downloads.claude.ai/releases/win32/x64/Claude.msix',
      'https://downloads.claude.ai:8443/releases/win32/x64/Claude.msix',
      'https://user@downloads.claude.ai/releases/win32/x64/Claude.msix',
      'https://downloads.claude.ai/releases/win32/x64/Claude.msix?token=1',
      'https://downloads.claude.ai/releases/win32/x64/Claude.msix#fragment',
      'https://downloads.claude.ai/claude-desktop/Claude.msix',
      'https://downloads.claude.ai/releases/',
      'https://claude.ai/api/desktop/win32/x64/msix/latest/redirect/extra',
      'https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect',
      'https://claude.ai.evil.example/api/desktop/win32/x64/msix/latest/redirect',
      'https://evil.example/releases/Claude.msix',
      'not a url',
    ]) {
      expect(() => validateClaudeDesktopDownloadUrl(value), value).toThrow(/Claude 官网下载/)
    }
  })
})

describe('Claude Desktop official MSIX identity', () => {
  it('derives Windows publisher IDs exactly as package family names show them', () => {
    expect(windowsPackagePublisherId(microsoftPublisher)).toBe(microsoftPublisherId)
    expect(windowsPackagePublisherId('CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US')).toBe('cw5n1h2txyewy')
    // The Store publisher behind OpenAI.Codex_2p2nqsd0c76g0 (codex-desktop.ts).
    expect(windowsPackagePublisherId('CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B')).toBe('2p2nqsd0c76g0')
  })

  it('keeps the package path a quoted literal in a read-only inspection script', () => {
    const script = buildClaudeDesktopPackageInspectionScript("C:\\Users\\O'Brien\\Temp\\Claude-x64.msix")
    expect(script).toContain("$packagePath = 'C:\\Users\\O''Brien\\Temp\\Claude-x64.msix'")
    expect(script).toContain('Microsoft.PowerShell.Security.psd1')
    expect(script).toContain('[System.Xml.DtdProcessing]::Prohibit')
    expect(script).toContain('$settings.XmlResolver = $null')
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $packagePath')
    expect(script).not.toMatch(/Add-AppxPackage|Remove-|Invoke-Expression/i)
  })

  it('accepts a package whose publisher, signer and architecture all match', () => {
    expect(validateClaudeDesktopPackageInspection(`\uFEFF${JSON.stringify(inspectionRecord())}\r\n`, 'x64', microsoftPublisherId)).toEqual({ version: '1.1.2345.0' })
    expect(validateClaudeDesktopPackageInspection(JSON.stringify(inspectionRecord({ architecture: 'ARM64' })), 'arm64', microsoftPublisherId)).toEqual({ version: '1.1.2345.0' })
  })

  it('checks the real Claude family suffix unless a test says otherwise', () => {
    expect(() => validateClaudeDesktopPackageInspection(JSON.stringify(inspectionRecord()), 'x64')).toThrow('发布者不是 Anthropic')
    const lookalike = 'CN="Anthropic, PBC", O="Anthropic, PBC", C=US'
    expect(() => validateClaudeDesktopPackageInspection(JSON.stringify(inspectionRecord({ publisher: lookalike, publisherCanonical: lookalike, signerSubject: lookalike })), 'x64'))
      .toThrow('发布者不是 Anthropic')
  })

  it.each([
    [{ name: 'Claude.Beta' }, '身份不对'],
    [{ architecture: 'arm64' }, '身份不对'],
    [{ architecture: 'neutral' }, '身份不对'],
    [{ publisher: '' }, '发布者不是 Anthropic'],
    [{ hasSignature: false }, '缺少有效的 Anthropic 签名'],
    [{ signatureStatus: 'NotSigned' }, '缺少有效的 Anthropic 签名'],
    [{ signatureStatus: 'HashMismatch' }, '缺少有效的 Anthropic 签名'],
    [{ signerName: 'Anthropic PBC' }, '缺少有效的 Anthropic 签名'],
    [{ signerSubject: 'CN=Someone Else' }, '缺少有效的 Anthropic 签名'],
    [{ publisherCanonical: '' }, '缺少有效的 Anthropic 签名'],
    [{ version: '1.2.3' }, '版本号无效'],
    [{ version: '1.2.3.70000' }, '版本号无效'],
  ] as const)('refuses %j as damaged or unofficial', (extra, message) => {
    let failure: unknown = null
    try {
      validateClaudeDesktopPackageInspection(JSON.stringify(inspectionRecord(extra)), 'x64', microsoftPublisherId)
    } catch (error) {
      failure = error
    }
    expect((failure as Error | null)?.message).toContain(message)
    expect(classifyClaudeDesktopInstallFailure((failure as Error).message)).toBe('damaged')
  })

  it('refuses unreadable inspection output', () => {
    for (const output of ['', 'not json', '[]', 'null']) {
      expect(() => validateClaudeDesktopPackageInspection(output, 'x64', microsoftPublisherId)).toThrow('结果读不出来')
    }
  })
})

describe('Claude Desktop official MSIX progress', () => {
  it('words the download the way the approved interface text does, without jargon', () => {
    expect(describeClaudeDesktopMsixDownload(false, { percent: 3 })).toBe('正在从 Claude 官网下载离线安装包（3%）')
    expect(describeClaudeDesktopMsixDownload(true, { percent: 3 })).toBe('系统自带的安装组件这次没装上，正在从 Claude 官网下载离线安装包（3%）')
    expect(describeClaudeDesktopMsixDownload(true, { percent: 40, resuming: true })).toBe('网络断了一下，正在接着从 Claude 官网下载离线安装包（已下 40%）')
    for (const wingetTried of [false, true]) {
      expect(describeClaudeDesktopMsixDownload(wingetTried, { percent: 1 })).not.toMatch(/MSIX|winget|SHA|HTTP|Appx/i)
    }
  })
})

describe('Claude Desktop official MSIX installation', () => {
  it('follows the official redirect, checks the Anthropic signature and installs the exact downloaded bytes', async () => {
    const f = await fixture()
    await expect(installClaudeDesktopFromOfficial(f.options)).resolves.toEqual({ version: '1.1.2345.0' })
    expect(f.fetch.mock.calls.map(([input]) => requestUrl(input))).toEqual([claudeDesktopMsixEntryUrl('x64'), releaseUrl])
    for (const [, init] of f.fetch.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit', signal: expect.any(AbortSignal) })
    }
    expect(f.createTemporaryDirectory).toHaveBeenCalledWith('same-user')
    expect(f.execute).toHaveBeenCalledOnce()
    const [spec, commandOptions] = f.execute.mock.calls[0]
    expect(spec.executable).toBe(powershell)
    expect(spec.argv.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(decodeWindowsPowerShellCommand(spec.argv[4])).toContain(`$packagePath = '${f.packagePath}'`)
    expect(commandOptions).toMatchObject({ trustedOnly: false, trustedPaths: [f.packagePath], machinePaths, windowsHide: true })
    expect(commandOptions?.env?.NODE_OPTIONS).toBeUndefined()
    expect(commandOptions?.env?.PSModulePath).not.toBe('C:\\untrusted')
    expect(f.installPackage).toHaveBeenCalledExactlyOnceWith(f.packagePath, expect.objectContaining({
      product: claudeAppxProduct,
      sha256Base64: createHash('sha256').update(payload).digest('base64'),
      contentLength: payload.byteLength,
    }))
    expect(f.installed).toHaveLength(1)
    expect(f.installed[0].equals(payload)).toBe(true)
    const messages = f.progress.map((event) => event.message)
    expect(messages[0]).toBe('正在从 Claude 官网下载离线安装包（0%）')
    expect(messages).toContain('正在从 Claude 官网下载离线安装包（100%）')
    expect(messages.slice(-2)).toEqual(['正在检查下载下来的安装包是不是完整的官方版', '正在安装 Claude Desktop 1.1.2345.0'])
    expect(f.progress.at(-1)).toMatchObject({ phase: 'installing', percent: null })
  })

  it('opens the download with what the system installer left behind and passes the elevation prompt on', async () => {
    const f = await fixture({ wingetTried: true })
    f.installPackage.mockImplementation(async (_file, options) => { options.onElevationRequired?.() })
    await installClaudeDesktopFromOfficial(f.options)
    expect(f.progress[0].message).toBe('系统自带的安装组件这次没装上，正在从 Claude 官网下载离线安装包（0%）')
    expect(f.progress.at(-1)?.message).toBe('此版本需管理员权限安装服务，请在 Windows 授权窗口中允许本次安装；取消将停止安装。')
  })

  it('checks the package from protected staging with path verification when running trusted-only', async () => {
    const f = await fixture({ windowsExecutionMode: 'trusted-only' })
    await installClaudeDesktopFromOfficial(f.options)
    expect(f.createTemporaryDirectory).toHaveBeenCalledWith('trusted-only')
    expect(f.execute.mock.calls[0][1]).toMatchObject({ trustedOnly: true, trustedPaths: [f.packagePath], machinePaths })
  })

  it('downloads the arm64 package for arm64 computers', async () => {
    const arm64Release = 'https://downloads.claude.ai/releases/win32/arm64/1.1.2345/Claude-0123abcd.msix'
    const f = await fixture({ architecture: 'arm64' })
    f.fetch.mockImplementation(async (input) => requestUrl(input) === claudeDesktopMsixEntryUrl('arm64') ? redirect(arm64Release) : packageResponse())
    f.execute.mockImplementation(async (spec) => result(spec, JSON.stringify(inspectionRecord({ architecture: 'arm64' }))))
    await expect(installClaudeDesktopFromOfficial(f.options)).resolves.toEqual({ version: '1.1.2345.0' })
    expect(f.fetch.mock.calls.map(([input]) => requestUrl(input))).toEqual([claudeDesktopMsixEntryUrl('arm64'), arm64Release])
    expect(f.installPackage.mock.calls[0][0]).toBe(path.join(f.directory, 'Claude-arm64.msix'))
  })

  it.each([
    'https://evil.example/Claude.msix',
    'http://downloads.claude.ai/releases/win32/x64/Claude.msix',
    'https://downloads.claude.ai/releases/win32/x64/Claude.msix?token=1',
    'https://downloads.claude.ai.evil.example/releases/win32/x64/Claude.msix',
  ])('refuses a redirect to %s before anything is downloaded', async (location) => {
    const f = await fixture()
    f.fetch.mockImplementation(async (input) => requestUrl(input) === claudeDesktopMsixEntryUrl('x64') ? redirect(location) : packageResponse())
    await expect(installClaudeDesktopFromOfficial(f.options)).rejects.toThrow('Claude 官网下载重定向到了没核实过的地址')
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.installPackage).not.toHaveBeenCalled()
  })

  it('stops on redirect loops, endless redirects and redirects without a target', async () => {
    const loop = await fixture()
    loop.fetch.mockImplementation(async () => redirect(claudeDesktopMsixEntryUrl('x64')))
    await expect(installClaudeDesktopFromOfficial(loop.options)).rejects.toThrow('循环重定向')

    const endless = await fixture()
    let hop = 0
    endless.fetch.mockImplementation(async () => redirect(`https://downloads.claude.ai/releases/hop-${hop++}.msix`))
    await expect(installClaudeDesktopFromOfficial(endless.options)).rejects.toThrow('重定向次数过多')
    expect(endless.fetch).toHaveBeenCalledTimes(4)

    const missing = await fixture()
    missing.fetch.mockImplementation(async () => redirect(null, 302))
    await expect(installClaudeDesktopFromOfficial(missing.options)).rejects.toThrow('重定向缺少目标地址')
    for (const f of [loop, endless, missing]) expect(f.installPackage).not.toHaveBeenCalled()
  })

  it('refuses a response that is redirected behind the manual redirect policy', async () => {
    const f = await fixture()
    f.fetch.mockImplementation(async () => {
      const response = packageResponse()
      Object.defineProperty(response, 'url', { value: 'https://evil.example/Claude.msix' })
      return response
    })
    await expect(installClaudeDesktopFromOfficial(f.options)).rejects.toThrow('绕过了受限的重定向规则')
    expect(f.installPackage).not.toHaveBeenCalled()
  })

  it.each([
    [packageResponse(payload, {}, 404), 'HTTP 404', 'unreachable'],
    [packageResponse(payload, { 'content-type': 'text/html; charset=utf-8' }), 'Content-Type', 'damaged'],
    [packageResponse(payload, { 'content-type': 'application/json' }), 'Content-Type', 'damaged'],
    [packageResponse(Buffer.alloc(1024)), '大小无效', 'damaged'],
    [new Response(payload, { status: 200, headers: { 'content-type': 'application/octet-stream' } }), '大小无效', 'damaged'],
    [packageResponse(payload, { 'content-length': String(1_600 * 1024 * 1024) }), '安全上限', 'damaged'],
  ] as const)('refuses a package response that is not the installer (%#)', async (response, message, reason) => {
    const f = await fixture()
    f.fetch.mockImplementation(async (input) => requestUrl(input) === claudeDesktopMsixEntryUrl('x64') ? redirect(releaseUrl) : response)
    const failure = await installClaudeDesktopFromOfficial(f.options).then(() => null, (error: Error) => error)
    expect(failure?.message).toContain(message)
    expect(classifyClaudeDesktopInstallFailure(failure?.message ?? '')).toBe(reason)
    expect(fs.existsSync(f.packagePath)).toBe(false)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.installPackage).not.toHaveBeenCalled()
  })

  it('accepts a plain octet-stream package and a package without a declared type', async () => {
    for (const headers of [{ 'content-type': 'application/octet-stream' }, { 'content-type': '' }]) {
      const f = await fixture()
      f.fetch.mockImplementation(async (input) => requestUrl(input) === claudeDesktopMsixEntryUrl('x64') ? redirect(releaseUrl) : packageResponse(payload, headers))
      await expect(installClaudeDesktopFromOfficial(f.options)).resolves.toEqual({ version: '1.1.2345.0' })
    }
  })

  it('picks a broken download up from the same release file instead of asking the entry again', async () => {
    const f = await fixture()
    const half = payload.byteLength / 2
    f.fetch.mockImplementation(async (input, init) => {
      const url = requestUrl(input)
      if (url === claudeDesktopMsixEntryUrl('x64')) return redirect(releaseUrl)
      const range = new Headers(init?.headers).get('range')
      if (!range) return new Response(brokenBody(payload.subarray(0, half)), { status: 200, headers: { 'content-type': 'application/vnd.ms-appx', 'content-length': String(payload.byteLength), etag: '"claude-v1"' } })
      expect(range).toBe(`bytes=${half}-`)
      expect(new Headers(init?.headers).get('if-range')).toBe('"claude-v1"')
      return new Response(payload.subarray(half), {
        status: 206,
        headers: { 'content-type': 'application/vnd.ms-appx', 'content-range': `bytes ${half}-${payload.byteLength - 1}/${payload.byteLength}`, 'content-length': String(payload.byteLength - half) },
      })
    })
    await expect(installClaudeDesktopFromOfficial(f.options)).resolves.toEqual({ version: '1.1.2345.0' })
    expect(f.fetch.mock.calls.map(([input]) => requestUrl(input))).toEqual([claudeDesktopMsixEntryUrl('x64'), releaseUrl, releaseUrl])
    expect(f.progress.map((event) => event.message)).toContain('网络断了一下，正在接着从 Claude 官网下载离线安装包（已下 50%）')
    expect(f.installed[0].equals(payload)).toBe(true)
  })

  it('does not splice a resumed download onto a release the entry no longer points at', async () => {
    const f = await fixture()
    f.fetch.mockImplementation(async (input, init) => {
      if (requestUrl(input) === claudeDesktopMsixEntryUrl('x64')) return redirect(releaseUrl)
      if (!new Headers(init?.headers).get('range')) return new Response(brokenBody(payload.subarray(0, 1024)), { status: 200, headers: { 'content-type': 'application/vnd.ms-appx', 'content-length': String(payload.byteLength) } })
      return redirect('https://downloads.claude.ai/releases/win32/x64/1.1.9999/Claude-ffff.msix')
    })
    await expect(installClaudeDesktopFromOfficial(f.options)).rejects.toThrow('terminated')
    expect(f.fetch.mock.calls.map(([input]) => requestUrl(input))).toEqual([claudeDesktopMsixEntryUrl('x64'), releaseUrl, releaseUrl])
    expect(f.installPackage).not.toHaveBeenCalled()
  })

  it.each([
    [{ hasSignature: false }, '缺少有效的 Anthropic 签名'],
    [{ name: 'NotClaude' }, '身份不对'],
  ] as const)('deletes a package that fails the identity check (%j)', async (extra, message) => {
    const f = await fixture()
    let inspected: string | null = null
    f.execute.mockImplementation(async (spec, commandOptions) => {
      inspected = commandOptions?.trustedPaths?.[0] ?? null
      return result(spec, JSON.stringify(inspectionRecord(extra)))
    })
    await expect(installClaudeDesktopFromOfficial(f.options)).rejects.toThrow(message)
    expect(inspected).toBe(f.packagePath)
    expect(fs.existsSync(f.packagePath)).toBe(false)
    expect(f.installPackage).not.toHaveBeenCalled()
  })

  it('keeps a local inspection failure from reading like an unreachable website', async () => {
    const f = await fixture()
    f.execute.mockRejectedValue(new CommandRunnerError('命令执行时间过长，已中止：powershell.exe', {
      code: 'TIMED_OUT', executable: powershell, argv: [], exitCode: null, signal: 'SIGTERM',
      stdout: '', stderr: 'Exception calling "OpenRead": End of Central Directory record could not be found.', outputBytes: 0, maxOutputBytes: 65536, durationMs: 120_000,
    }))
    const failure = await installClaudeDesktopFromOfficial(f.options).then(() => null, (error: Error & { stderr?: string }) => error)
    expect(failure?.message).toBe('核对 Claude 官网安装包没有完成：命令执行时间过长，已中止：powershell.exe')
    expect(failure?.stderr).toContain('End of Central Directory')
    expect(classifyClaudeDesktopInstallFailure(failure?.message ?? '')).toBe('unknown')
    expect(f.installPackage).not.toHaveBeenCalled()
  })

  it('stops without installing once the installation is cancelled', async () => {
    const early = new AbortController()
    early.abort(new Error('安装已取消。'))
    const before = await fixture({ signal: early.signal })
    await expect(installClaudeDesktopFromOfficial(before.options)).rejects.toThrow('安装已取消。')
    expect(before.fetch).not.toHaveBeenCalled()

    const during = new AbortController()
    const f = await fixture({ signal: during.signal })
    f.execute.mockImplementation(async () => {
      during.abort(new Error('安装已取消。'))
      throw new CommandRunnerError('命令已取消：powershell.exe', {
        code: 'ABORTED', executable: powershell, argv: [], exitCode: null, signal: null,
        stdout: '', stderr: '', outputBytes: 0, maxOutputBytes: 65536, durationMs: 1,
      })
    })
    await expect(installClaudeDesktopFromOfficial(f.options)).rejects.toThrow('安装已取消。')
    expect(f.installPackage).not.toHaveBeenCalled()
  })

  it('passes the shared installer failure on for the caller to word', async () => {
    const f = await fixture()
    f.installPackage.mockRejectedValue(new Error('已取消管理员授权，Claude Desktop 安装未开始。重新点击安装即可再次授权。'))
    await expect(installClaudeDesktopFromOfficial(f.options)).rejects.toThrow('已取消管理员授权，Claude Desktop 安装未开始。')
  })

  it('refuses other platforms and processors without touching the network', async () => {
    const mac = await fixture({ platform: 'darwin' })
    await expect(installClaudeDesktopFromOfficial(mac.options)).rejects.toThrow('只用于 Windows')
    const ia32 = await fixture({ architecture: 'ia32' })
    await expect(installClaudeDesktopFromOfficial(ia32.options)).rejects.toThrow('处理器架构')
    expect(mac.fetch).not.toHaveBeenCalled()
    expect(ia32.fetch).not.toHaveBeenCalled()
  })
})
