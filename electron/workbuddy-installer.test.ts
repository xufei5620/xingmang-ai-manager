import { webcrypto } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandRunnerError, type CommandSpec, runCommand } from './command-runner'
import type { ExternalClientInstallProgress } from './external-client-contract'
import { installWorkBuddyFromOfficial, WORKBUDDY_OFFICIAL_INSTALLER, type WorkBuddyOfficialInstallOptions } from './workbuddy-installer'

// Use real streaming SHA-256 for every byte, with one synthetic fixture digest
// mapped to the pinned release digest. No actual installer is downloaded/run.
const fixtureDigests = vi.hoisted(() => new Map<string, string>())
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, createHash: (algorithm: string) => {
    const hash = actual.createHash(algorithm)
    const digest = hash.digest.bind(hash)
    Object.defineProperty(hash, 'digest', { value: (encoding: 'hex') => {
      const value = digest(encoding)
      return fixtureDigests.get(value) ?? value
    } })
    return hash
  } }
})

const temporaryDirectories: string[] = []
const payload = Buffer.from('MZ-synthetic-workbuddy-installer-fixture-only')
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const publisher = 'CN=Tencent Technology (Shenzhen) Company Limited, O=Tencent Technology (Shenzhen) Company Limited, C=CN'
const machinePaths = { systemRoot: 'C:\\Windows', system32: 'C:\\Windows\\System32', programFiles: 'C:\\Program Files', programFilesX86: 'C:\\Program Files (x86)', programData: 'C:\\ProgramData' }

function response(body: BodyInit | null = payload, headers: HeadersInit = { 'content-length': String(payload.length) }): Response {
  const value = new Response(body, { status: 200, headers })
  Object.defineProperty(value, 'url', { value: WORKBUDDY_OFFICIAL_INSTALLER.url, configurable: true })
  return value
}
function result(spec: CommandSpec, stdout = '') {
  return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: stdout.length, durationMs: 1 }
}
async function fixture(overrides: WorkBuddyOfficialInstallOptions = {}) {
  fixtureDigests.set(Buffer.from(await webcrypto.subtle.digest('SHA-256', payload)).toString('hex'), WORKBUDDY_OFFICIAL_INSTALLER.sha256[0])
  const directory = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-workbuddy-test-')))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, WORKBUDDY_OFFICIAL_INSTALLER.fileName)
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response())
  const execute = vi.fn<typeof runCommand>(async (spec) => result(spec, spec.executable === powershell ? JSON.stringify({ status: 'Valid', subject: publisher }) : ''))
  const progress: ExternalClientInstallProgress[] = []
  const create = vi.fn(async () => directory)
  const remove = vi.fn(async (target: string) => fs.promises.rmdir(target))
  const options: WorkBuddyOfficialInstallOptions = {
    platform: 'win32', architecture: 'x64', windowsExecutionMode: 'same-user',
    env: { NODE_OPTIONS: '--require malicious.cjs', PSModulePath: 'C:\\untrusted', TEMP: 'C:\\untrusted', TMP: 'C:\\untrusted', PATH: 'C:\\untrusted' },
    fetch, runCommand: execute, resolveMachinePaths: () => machinePaths,
    resolvePowerShellExecutable: () => powershell,
    createTemporaryDirectory: create, removeTemporaryDirectory: remove,
    isTrustedTemporaryPath: () => true,
    onProgress: (event) => progress.push(event), ...overrides,
  }
  return { directory, filePath, fetch, execute, create, remove, options, progress }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  fixtureDigests.clear()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })))
})

describe('WorkBuddy official installer fallback', () => {
  it('downloads the pinned HTTPS release with redirects and ambient credentials disabled, validates and runs the exact current-user NSIS plan', async () => {
    const f = await fixture()
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
    expect(f.fetch).toHaveBeenCalledWith(WORKBUDDY_OFFICIAL_INSTALLER.url, expect.objectContaining({ redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal) }))
    expect(f.execute).toHaveBeenCalledTimes(2)
    const [signature, installer] = f.execute.mock.calls
    expect(signature[0].executable).toBe(powershell)
    const script = Buffer.from(signature[0].argv.at(-1)!, 'base64').toString('utf16le')
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $env:XINGMANG_WORKBUDDY_INSTALLER')
    expect(script).toContain('Microsoft.PowerShell.Security.psd1')
    expect(installer[0]).toEqual({ executable: f.filePath, argv: ['/S', '/currentuser'] })
    expect(installer[1]).toMatchObject({ trustedOnly: false, cwd: machinePaths.system32, timeoutMs: 900_000, acceptedExitCodes: [0], env: { TEMP: os.tmpdir(), TMP: os.tmpdir(), TMPDIR: os.tmpdir() } })
    expect(signature[1]).toMatchObject({ cwd: f.directory, env: { TEMP: f.directory } })
    expect(installer[1]?.env?.NODE_OPTIONS).toBeUndefined()
    expect(installer[1]?.env?.PSModulePath).not.toBe('C:\\untrusted')
    expect(f.progress.map((event) => event.phase)).toEqual(['downloading', 'checking', 'installing'])
    expect(f.progress.some((event) => event.phase === 'completed')).toBe(false)
    expect(f.remove).toHaveBeenCalledWith(f.directory)
    expect(fs.existsSync(f.directory)).toBe(false)
  })

  it('requires registered protected staging in trusted-only mode and keeps NSIS extraction inside that directory', async () => {
    const f = await fixture({ windowsExecutionMode: 'trusted-only' })
    await installWorkBuddyFromOfficial(f.options)
    expect(f.create).toHaveBeenCalledWith('trusted-only')
    expect(f.execute.mock.calls.every(([, options]) => options?.trustedOnly && options.cwd === f.directory && options.env?.TEMP === f.directory)).toBe(true)
  })

  it('accepts the independently verified CDN variant while still requiring the Tencent signature', async () => {
    const f = await fixture()
    fixtureDigests.set(Buffer.from(await webcrypto.subtle.digest('SHA-256', payload)).toString('hex'), WORKBUDDY_OFFICIAL_INSTALLER.sha256[1])
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
    expect(f.execute).toHaveBeenCalledTimes(2)
    const invalid = await fixture()
    fixtureDigests.set(Buffer.from(await webcrypto.subtle.digest('SHA-256', payload)).toString('hex'), WORKBUDDY_OFFICIAL_INSTALLER.sha256[1])
    invalid.execute.mockImplementation(async (spec) => result(spec, '{"status":"NotSigned","subject":""}'))
    await expect(installWorkBuddyFromOfficial(invalid.options)).rejects.toThrow('数字签名无效')
    expect(invalid.execute).toHaveBeenCalledOnce()
  })

  it('refuses an unprotected elevated staging directory before network or execution', async () => {
    const f = await fixture({ windowsExecutionMode: 'trusted-only', isTrustedTemporaryPath: () => false })
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('受保护路径')
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.remove).not.toHaveBeenCalled()
  })

  it.each(['arm64', 'ia32'] as const)('rejects unsupported architecture %s before creating files', async (architecture) => {
    const f = await fixture({ architecture })
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('x64')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('rejects non-Windows installation without a shell fallback', async () => {
    const f = await fixture({ platform: 'linux' })
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('仅支持 Windows')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it.each(['https://evil.invalid/installer.exe', 'http://download.codebuddy.cn/installer.exe'])('rejects a changed response URL %s', async (url) => {
    const f = await fixture()
    f.fetch.mockImplementation(async () => { const value = response(); Object.defineProperty(value, 'url', { value: url }); return value })
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('未经批准的跳转')
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.remove).toHaveBeenCalledOnce()
  })

  it('rejects redirect responses even when the final URL happens to equal the pinned URL', async () => {
    const f = await fixture()
    const value = response()
    Object.defineProperty(value, 'redirected', { value: true })
    f.fetch.mockResolvedValue(value)
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('跳转')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it.each([302, 403, 500])('reports HTTP %s without executing anything', async (status) => {
    const f = await fixture()
    f.fetch.mockResolvedValue(new Response(null, { status }))
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow(`HTTP ${status}`)
    expect(f.execute).not.toHaveBeenCalled()
    expect(fs.existsSync(f.directory)).toBe(false)
  })

  it.each(['1073741825', '-1', 'abc', '0', '1e2'])('rejects invalid or oversized Content-Length %s before reading the body', async (length) => {
    const f = await fixture()
    const read = vi.fn()
    const value = response(new ReadableStream({ pull: read }), { 'content-length': length })
    f.fetch.mockResolvedValue(value)
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('大小无效')
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.remove).toHaveBeenCalledOnce()
  })

  it('checks the streamed byte limit even without a Content-Length header', async () => {
    const f = await fixture()
    const oversized = new Uint8Array([1])
    Object.defineProperty(oversized, 'byteLength', { value: 1024 * 1024 * 1024 + 1 })
    f.fetch.mockResolvedValue(response(new ReadableStream({ start(controller) { controller.enqueue(oversized); controller.close() } }), {}))
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('1 GB')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('detects truncated and oversized streams relative to the declared byte count', async () => {
    for (const length of [payload.length - 1, payload.length + 1]) {
      const f = await fixture()
      f.fetch.mockResolvedValue(response(payload, { 'content-length': String(length) }))
      await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow(/大小|不完整/)
      expect(f.execute).not.toHaveBeenCalled()
      expect(fs.existsSync(f.directory)).toBe(false)
    }
  })

  it('accepts a bounded stream without Content-Length only after validating its pinned hash', async () => {
    const f = await fixture()
    f.fetch.mockResolvedValue(response(payload, {}))
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
    expect(f.execute).toHaveBeenCalledTimes(2)
  })

  it('refuses a SHA-256 mismatch before invoking even the signature inspector', async () => {
    const f = await fixture()
    f.fetch.mockResolvedValue(response(Buffer.alloc(payload.length, 0)))
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('SHA-256')
    expect(f.execute).not.toHaveBeenCalled()
    expect(fs.existsSync(f.directory)).toBe(false)
  })

  it.each([
    { status: 'HashMismatch', subject: publisher },
    { status: 'NotSigned', subject: publisher },
    { status: 'Valid', subject: 'CN=Attacker, O=Attacker' },
    { status: 'Valid', subject: 'CN=Tencent Technology (Shenzhen) Company Limited.evil' },
  ])('refuses an invalid signature or incorrect publisher %j', async (signature) => {
    const f = await fixture()
    f.execute.mockImplementation(async (spec) => result(spec, JSON.stringify(signature)))
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('数字签名')
    expect(f.execute).toHaveBeenCalledOnce()
    expect(fs.existsSync(f.directory)).toBe(false)
  })

  it('rechecks bytes after Authenticode and blocks mutation between validation and execution', async () => {
    const f = await fixture()
    f.execute.mockImplementation(async (spec) => {
      await fs.promises.writeFile(f.filePath, Buffer.alloc(payload.length, 0))
      return result(spec, JSON.stringify({ status: 'Valid', subject: publisher }))
    })
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('完整性校验失败')
    expect(f.execute).toHaveBeenCalledOnce()
  })

  it('refuses a hard-linked installer introduced after signature inspection', async () => {
    const f = await fixture()
    f.execute.mockImplementation(async (spec) => {
      await fs.promises.link(f.filePath, path.join(f.directory, 'alias.exe'))
      return result(spec, JSON.stringify({ status: 'Valid', subject: publisher }))
    })
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('发生变化')
    expect(f.execute).toHaveBeenCalledOnce()
  })

  it('rechecks the file after reporting installing so observers cannot swap the payload', async () => {
    const f = await fixture()
    f.options.onProgress = (event) => { if (event.phase === 'installing') fs.writeFileSync(f.filePath, Buffer.alloc(payload.length, 0)) }
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('完整性校验失败')
    expect(f.execute).toHaveBeenCalledOnce()
  })

  it('handles partial file writes without losing or duplicating bytes', async () => {
    const f = await fixture()
    const actualOpen = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const file = await actualOpen(...args)
      const write = file.write.bind(file)
      Object.defineProperty(file, 'write', { value: (buffer: Uint8Array, offset: number, length: number) => write(buffer, offset, Math.min(length, 3)) })
      return file
    })
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
    expect(f.execute).toHaveBeenCalledTimes(2)
  })

  it('throttles progress callbacks independently of network chunk count', async () => {
    const f = await fixture()
    f.fetch.mockResolvedValue(response(new ReadableStream({ start(controller) { for (const byte of payload) controller.enqueue(new Uint8Array([byte])); controller.close() } })))
    await installWorkBuddyFromOfficial(f.options)
    expect(f.progress.filter((event) => event.phase === 'downloading').length).toBeLessThan(5)
  })

  it('ignores failing progress observers', async () => {
    const f = await fixture({ onProgress: () => { throw new Error('disconnected renderer') } })
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
  })

  it('honors pre-aborted requests without creating directories', async () => {
    const controller = new AbortController()
    controller.abort(new Error('private-secret-abort-reason'))
    const f = await fixture({ signal: controller.signal })
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('已取消')
    expect(f.create).not.toHaveBeenCalled()
  })

  it('cancels a stalled body read promptly and removes its partial file', async () => {
    const controller = new AbortController()
    const f = await fixture({ signal: controller.signal })
    const cancel = vi.fn()
    f.fetch.mockResolvedValue(response(new ReadableStream({ start(stream) { stream.enqueue(payload.subarray(0, 4)) }, cancel }), {}))
    const installation = installWorkBuddyFromOfficial(f.options)
    const rejected = expect(installation).rejects.toThrow('已取消')
    await vi.waitFor(() => expect(fs.existsSync(f.filePath)).toBe(true))
    controller.abort()
    await rejected
    expect(cancel).toHaveBeenCalled()
    expect(fs.existsSync(f.directory)).toBe(false)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('times out a stalled fetch even if the injected transport ignores its AbortSignal', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    f.fetch.mockImplementation(() => new Promise(() => undefined))
    const installation = installWorkBuddyFromOfficial(f.options)
    const rejected = expect(installation).rejects.toThrow('下载超时')
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(900_001)
    vi.useRealTimers()
    await rejected
    expect(fs.existsSync(f.directory)).toBe(false)
  })

  it('does not include raw transport or command errors with credentials in user-facing failure messages', async () => {
    const f = await fixture()
    f.execute.mockRejectedValue(new Error('WorkBuddy private-secret-key https://user:password@proxy.invalid'))
    const error = await installWorkBuddyFromOfficial(f.options).catch((value: Error) => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toMatch(/private-secret|password/)
    expect(JSON.stringify(f.progress)).not.toMatch(/private-secret|password/)
    expect(fs.existsSync(f.directory)).toBe(false)
  })

  it('reports cleanup trouble without blocking the caller from verifying a successful installation', async () => {
    const f = await fixture({ removeTemporaryDirectory: async () => { throw new Error('private filesystem detail') } })
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(f.progress.at(-1)).toMatchObject({ phase: 'checking', message: 'WorkBuddy 安装包已清理，暂存目录暂时无法移除' })
    expect(f.progress.some((event) => event.phase === 'completed')).toBe(false)
  })

  it.each(['signature', 'installer'] as const)('preserves cancellation during the %s command without describing it as a network failure', async (stage) => {
    const f = await fixture()
    const cancelled = new CommandRunnerError('Command aborted: private-command-detail', {
      code: 'ABORTED', executable: stage === 'signature' ? powershell : f.filePath, argv: [], exitCode: null, signal: 'SIGTERM',
      stdout: '', stderr: '', outputBytes: 0, maxOutputBytes: 1024, durationMs: 1,
    })
    f.execute.mockImplementation(async (spec) => {
      if (stage === 'signature' || spec.executable !== powershell) throw cancelled
      return result(spec, JSON.stringify({ status: 'Valid', subject: publisher }))
    })
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toMatchObject({ message: 'WorkBuddy 安装已取消', originalError: cancelled })
    expect(f.progress.at(-1)).toMatchObject({ phase: 'error', message: 'WorkBuddy 安装已取消' })
    expect(f.progress.some((event) => /private-command|网络/.test(event.message))).toBe(false)
    expect(fs.existsSync(f.directory)).toBe(false)
  })

  it('reports an installer timeout distinctly and keeps its diagnostic cause', async () => {
    const f = await fixture()
    const timeout = new CommandRunnerError('Command timed out', {
      code: 'TIMED_OUT', executable: f.filePath, argv: [], exitCode: null, signal: 'SIGTERM',
      stdout: '', stderr: '', outputBytes: 0, maxOutputBytes: 1024, durationMs: 900000,
    })
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable !== powershell) throw timeout
      return result(spec, JSON.stringify({ status: 'Valid', subject: publisher }))
    })
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toMatchObject({ message: 'WorkBuddy 安装超时，请重新检测客户端状态后重试', originalError: timeout })
  })

  it('preserves the original hash rejection when cleanup also fails', async () => {
    const f = await fixture({ removeTemporaryDirectory: async () => { throw new Error('private filesystem detail') } })
    f.fetch.mockResolvedValue(response(Buffer.alloc(payload.length)))
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toMatchObject({ message: 'WorkBuddy 安装包 SHA-256 校验失败', cleanupError: expect.any(Error) })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('closes the response body after rejecting oversized headers', async () => {
    const f = await fixture()
    const cancel = vi.fn()
    f.fetch.mockResolvedValue(response(new ReadableStream({ cancel }), { 'content-length': '1073741825' }))
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('1 GB')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('uses verified normal user TEMP and stable cwd so auto-started application data survives staging removal', async () => {
    const f = await fixture({ removeTemporaryDirectory: undefined })
    const userTemp = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-workbuddy-user-temp-')))
    temporaryDirectories.push(userTemp)
    vi.spyOn(os, 'tmpdir').mockReturnValue(userTemp)
    f.options.env = { TEMP: 'C:\\untrusted', Temp: 'C:\\also-untrusted', tMp: 'C:\\untrusted-tmp', TMPDIR: 'C:\\untrusted-tmpdir' }
    const runtimeFile = path.join(userTemp, 'workbuddy-running-state.json')
    f.execute.mockImplementation(async (spec, options) => {
      if (spec.executable === powershell) return result(spec, JSON.stringify({ status: 'Valid', subject: publisher }))
      expect(options?.cwd).toBe(machinePaths.system32)
      expect(options?.env?.TEMP).toBe(userTemp)
      expect(options?.env?.TMP).toBe(userTemp)
      expect(options?.env?.TMPDIR).toBe(userTemp)
      expect(options?.env?.Temp).toBeUndefined()
      expect(options?.env?.tMp).toBeUndefined()
      expect(options?.env?.XINGMANG_WORKBUDDY_INSTALLER).toBeUndefined()
      await fs.promises.writeFile(runtimeFile, 'running')
      return result(spec)
    })
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
    expect(fs.existsSync(f.directory)).toBe(false)
    expect(await fs.promises.readFile(runtimeFile, 'utf8')).toBe('running')
    await fs.promises.appendFile(runtimeFile, '-still-running')
    expect(await fs.promises.readFile(runtimeFile, 'utf8')).toBe('running-still-running')
  })

  it.each(['same-user', 'trusted-only'] as const)('preserves application-created staging data in %s mode while deleting only the installer', async (mode) => {
    const diagnostics = vi.fn()
    const f = await fixture({ windowsExecutionMode: mode, removeTemporaryDirectory: undefined, onCleanupError: diagnostics })
    const runtimeDirectory = path.join(f.directory, 'workbuddy-running')
    const runtimeFile = path.join(runtimeDirectory, 'state.json')
    f.execute.mockImplementation(async (spec, options) => {
      if (spec.executable === powershell) return result(spec, JSON.stringify({ status: 'Valid', subject: publisher }))
      if (mode === 'trusted-only') expect(options).toMatchObject({ cwd: f.directory, trustedOnly: true, env: { TEMP: f.directory, TMP: f.directory, TMPDIR: f.directory } })
      await fs.promises.mkdir(runtimeDirectory)
      await fs.promises.writeFile(runtimeFile, 'live application state')
      return result(spec)
    })
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
    expect(fs.existsSync(f.filePath)).toBe(false)
    expect(await fs.promises.readFile(runtimeFile, 'utf8')).toBe('live application state')
    expect(f.progress.at(-1)).toMatchObject({ phase: 'checking', message: 'WorkBuddy 安装包已清理，暂存目录中的客户端运行文件已保留' })
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOTEMPTY' }))
  })

  it('does not delete an installer path replaced by another file after execution', async () => {
    const f = await fixture({ removeTemporaryDirectory: undefined })
    const original = path.join(f.directory, 'original-installer.exe')
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable === powershell) return result(spec, JSON.stringify({ status: 'Valid', subject: publisher }))
      await fs.promises.rename(f.filePath, original)
      await fs.promises.writeFile(f.filePath, 'replacement application data')
      return result(spec)
    })
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
    expect(await fs.promises.readFile(f.filePath, 'utf8')).toBe('replacement application data')
    expect(await fs.promises.readFile(original)).toEqual(payload)
    expect(f.progress.at(-1)?.message).toContain('身份已变化')
  })

  it('does not delete content from a replaced staging directory', async () => {
    const f = await fixture({ removeTemporaryDirectory: undefined })
    const moved = `${f.directory}-moved`
    temporaryDirectories.push(moved)
    f.execute.mockImplementation(async (spec) => {
      if (spec.executable === powershell) return result(spec, JSON.stringify({ status: 'Valid', subject: publisher }))
      await fs.promises.rename(f.directory, moved)
      await fs.promises.mkdir(f.directory)
      await fs.promises.writeFile(f.filePath, 'replacement directory content')
      return result(spec)
    })
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
    expect(await fs.promises.readFile(f.filePath, 'utf8')).toBe('replacement directory content')
    expect(fs.existsSync(path.join(moved, WORKBUDDY_OFFICIAL_INSTALLER.fileName))).toBe(true)
  })

  it('rejects a reparse user TEMP before executing the installer', async () => {
    const f = await fixture({ removeTemporaryDirectory: undefined })
    const tempParent = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-workbuddy-temp-link-')))
    temporaryDirectories.push(tempParent)
    const target = path.join(tempParent, 'target')
    const link = path.join(tempParent, 'link')
    await fs.promises.mkdir(target)
    await fs.promises.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    vi.spyOn(os, 'tmpdir').mockReturnValue(link)
    await expect(installWorkBuddyFromOfficial(f.options)).rejects.toThrow('备用安装失败')
    expect(f.execute).toHaveBeenCalledOnce()
    expect(fs.existsSync(f.directory)).toBe(false)
    expect(fs.existsSync(target)).toBe(true)
  })

  it('ignores cleanup diagnostic callback failures and preserves a successful installation result', async () => {
    const f = await fixture({ removeTemporaryDirectory: async () => { throw new Error('cleanup failed') }, onCleanupError: () => { throw new Error('diagnostic failed') } })
    await expect(installWorkBuddyFromOfficial(f.options)).resolves.toBeUndefined()
    expect(fs.existsSync(f.filePath)).toBe(false)
  })
})
