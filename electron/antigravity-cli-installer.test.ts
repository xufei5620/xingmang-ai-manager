import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AntigravityCliElevatedSessionError, AntigravityCliInUseError, inspectAntigravityCliInstallation, installAntigravityCli,
  resolveAntigravityCliInstallTarget, type AntigravityCliInstallTarget, type InstallAntigravityCliOptions,
} from './antigravity-cli-installer'
import type { AntigravityCliDarwinProcess } from './antigravity-cli-macos'
import { buildAntigravityCliArtifactUrl, buildAntigravityCliManifestUrl, type AntigravityCliPlatform } from './antigravity-cli-release'
import { CommandRunnerError, type CommandResult } from './command-runner'
import { desktopPackageBucketOrigin } from './desktop-package-bucket'
import { DarwinCliProvenanceError } from './macos-code-signing'
import { renameWithTransientRetry } from './safe-local-data'
import { NativeCliPublisherMismatchError } from './trusted-native-cli'

vi.mock('./safe-local-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safe-local-data')>()
  return { ...actual, renameWithTransientRetry: vi.fn(actual.renameWithTransientRetry) }
})

// Everything is served by a fake fetch from buffers built here: nothing reaches Google or the
// bucket, the Windows signature check and codesign are stand-ins, and nothing installed is run.
const build = '5514532022517760'
const prefix = 'xingmang/offline/antigravity-cli'

function sha(algorithm: 'sha256' | 'sha512', data: Buffer): string {
  return createHash(algorithm).update(data).digest('hex')
}

// Big enough for the 1 MiB floor on both routes, and random so a Mac tar.gz does not shrink below it.
function windowsProgram(): Buffer {
  return Buffer.concat([Buffer.from('MZ'), randomBytes(1024 * 1024 + 4096)])
}

// A thin Mach-O header naming the chip, then random bytes.
function macProgram(chip: 'arm64' | 'x64'): Buffer {
  const header = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00, 0x00, 0x01])
  header[4] = chip === 'arm64' ? 0x0c : 0x07
  return Buffer.concat([header, randomBytes(1024 * 1024 + 4096)])
}

function tarGz(executable: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write('antigravity', 0, 100, 'utf8')
  header.write('0000755\0', 100, 8, 'latin1')
  header.write(`${executable.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1')
  header.write('0', 156, 1, 'latin1')
  header.write('ustar  \0', 257, 8, 'latin1')
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  const padding = (512 - (executable.length % 512)) % 512
  return zlib.gzipSync(Buffer.concat([header, executable, Buffer.alloc(padding + 1024)]))
}

const layouts = {
  windows_amd64: { family: 'windows', platformId: 'windows-x64', architecture: 'x64', extension: 'exe', contentType: 'application/octet-stream', verification: 'windows-authenticode-google' },
  windows_arm64: { family: 'windows', platformId: 'windows-arm64', architecture: 'arm64', extension: 'exe', contentType: 'application/octet-stream', verification: 'windows-authenticode-google' },
  darwin_amd64: { family: 'macos', platformId: 'macos-x64', architecture: 'x64', extension: 'tar.gz', contentType: 'application/gzip', verification: 'macos-developer-id-google' },
  darwin_arm64: { family: 'macos', platformId: 'macos-arm64', architecture: 'arm64', extension: 'tar.gz', contentType: 'application/gzip', verification: 'macos-developer-id-google' },
} as const

interface Artifact {
  platform: AntigravityCliPlatform
  version: string
  /** What is downloaded: the .exe, or the Mac tar.gz. */
  download: Buffer
  /** What ends up installed. */
  installed: Buffer
}

function artifact(platform: AntigravityCliPlatform, version = '1.5.15'): Artifact {
  if (platform.startsWith('windows_')) {
    const program = windowsProgram()
    return { platform, version, download: program, installed: program }
  }
  const program = macProgram(platform === 'darwin_arm64' ? 'arm64' : 'x64')
  return { platform, version, download: tarGz(program), installed: program }
}

function bucketKey(item: Artifact): string {
  const layout = layouts[item.platform]
  return `${prefix}/${layout.platformId}/sha256-${sha('sha256', item.download)}/agy-${item.version}-${layout.platformId}.${layout.extension}`
}

function bucketIndex(item: Artifact, overrides: Record<string, unknown> = {}): string {
  const layout = layouts[item.platform]
  const key = bucketKey(item)
  return JSON.stringify({
    schemaVersion: 1, product: 'antigravity-cli', family: layout.family,
    generatedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
    releases: [{
      version: item.version, build,
      files: [{
        platformId: layout.platformId, platform: layout.family, architecture: layout.architecture, manifest: item.platform,
        key, url: `${desktopPackageBucketOrigin}/${key}`, bytes: item.download.length,
        sha256: sha('sha256', item.download), sha512: sha('sha512', item.download),
        contentType: layout.contentType, verification: layout.verification,
        sourceUrl: buildAntigravityCliArtifactUrl(item.platform, item.version, build), cosEtag: '"etag"', ...overrides,
      }],
    }],
  })
}

function googleManifest(item: Artifact, sha512 = sha('sha512', item.download)): string {
  return JSON.stringify({ version: item.version, url: buildAntigravityCliArtifactUrl(item.platform, item.version, build), sha512 })
}

type Route = (init: RequestInit | undefined) => Response | Promise<Response>

function binary(data: Buffer, contentType = 'application/octet-stream', extra: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(data), { status: 200, headers: { 'content-type': contentType, 'content-length': String(data.length), ...extra } })
}

function json(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url })
  return response
}

interface Routes {
  bucketIndex?: Route
  bucketObject?: Route
  manifest?: Route
  google?: Route
}

function fakeFetch(item: Artifact, routes: Routes = {}) {
  const layout = layouts[item.platform]
  const table = new Map<string, Route>([
    [`${desktopPackageBucketOrigin}/${prefix}/${layout.family}.json`, routes.bucketIndex ?? (() => json(bucketIndex(item)))],
    [`${desktopPackageBucketOrigin}/${bucketKey(item)}`, routes.bucketObject ?? (() => binary(item.download, layout.contentType))],
    [buildAntigravityCliManifestUrl(item.platform), routes.manifest ?? (() => json(googleManifest(item)))],
    [buildAntigravityCliArtifactUrl(item.platform, item.version, build), routes.google ?? (() => binary(item.download))],
  ])
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const route = table.get(url)
    if (!route) throw new Error(`unexpected request ${url}`)
    return route(init)
  })
}

function requested(fetch: ReturnType<typeof fakeFetch>): string[] {
  return fetch.mock.calls.map(([input]) => String(input))
}

let workspace: string
let temporaryDirectory: string
let target: AntigravityCliInstallTarget

beforeEach(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-agy-install-')))
  temporaryDirectory = path.join(workspace, 'cache')
  fs.mkdirSync(temporaryDirectory)
  const directory = path.join(workspace, 'home', '.local', 'bin')
  target = { directory, executablePath: path.join(directory, 'agy') }
})

afterEach(() => {
  vi.mocked(renameWithTransientRetry).mockClear()
  fs.rmSync(workspace, { recursive: true, force: true })
})

const codesignAccepts = async (): Promise<CommandResult> => ({ executable: '/usr/bin/codesign', argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', outputBytes: 0, durationMs: 1 })

function codesignRefusal(): CommandRunnerError {
  return new CommandRunnerError('codesign refused', {
    code: 'EXIT_NON_ZERO', executable: '/usr/bin/codesign', argv: [], exitCode: 3, signal: null,
    stdout: '', stderr: 'test requirement failed', outputBytes: 0, maxOutputBytes: 1024, durationMs: 1,
  })
}

function windowsSignatureAccepts() {
  return vi.fn(async (filePath: string) => {
    const data = fs.readFileSync(filePath)
    return { size: data.length, sha256Hex: sha('sha256', data) }
  })
}

function windowsOptions(item: Artifact, extra: Partial<InstallAntigravityCliOptions> = {}): InstallAntigravityCliOptions {
  return {
    executionMode: 'same-user', platform: 'win32', architecture: item.platform === 'windows_arm64' ? 'arm64' : 'x64',
    target, fetchImpl: fakeFetch(item), bucket: {}, createTemporaryDirectory: async () => temporaryDirectory,
    verifyWindowsExecutable: windowsSignatureAccepts(), ensureWindowsUserPath: vi.fn(async () => 'added' as const), ...extra,
  }
}

function macOptions(item: Artifact, extra: Partial<InstallAntigravityCliOptions> = {}): InstallAntigravityCliOptions {
  return {
    executionMode: 'same-user', platform: 'darwin', architecture: item.platform === 'darwin_arm64' ? 'arm64' : 'x64',
    target, fetchImpl: fakeFetch(item), bucket: {}, createTemporaryDirectory: async () => temporaryDirectory,
    runDarwinProcess: vi.fn(codesignAccepts), ...extra,
  }
}

// The vendor route only wraps the call; this one counts how often it was used.
function countingVendorRoute() {
  const route = { calls: 0, wrap<T>(operation: () => Promise<T>): Promise<T> {
    route.calls += 1
    return operation()
  } }
  return route
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`a non-Error was thrown: ${String(error)}`)
  }
  throw new Error('the install was expected to fail')
}

function leftovers(): string[] {
  return fs.existsSync(target.directory) ? fs.readdirSync(target.directory).filter((name) => name.startsWith('.agy-')) : []
}

describe('Antigravity CLI install location', () => {
  it('uses the folder Google\'s own install script uses', () => {
    expect(resolveAntigravityCliInstallTarget('win32', { LOCALAPPDATA: 'D:\\Profiles\\ming\\AppData\\Local' }, 'C:\\Users\\ming')).toEqual({
      directory: 'D:\\Profiles\\ming\\AppData\\Local\\agy\\bin', executablePath: 'D:\\Profiles\\ming\\AppData\\Local\\agy\\bin\\agy.exe',
    })
    expect(resolveAntigravityCliInstallTarget('darwin', {}, '/Users/ming')).toEqual({
      directory: '/Users/ming/.local/bin', executablePath: '/Users/ming/.local/bin/agy',
    })
  })

  it.each([undefined, '', '   ', 'AppData\\Local', '%LOCALAPPDATA%'])('falls back to the profile folder when LOCALAPPDATA is %j', (value) => {
    expect(resolveAntigravityCliInstallTarget('win32', value === undefined ? {} : { LOCALAPPDATA: value }, 'C:\\Users\\ming')?.executablePath)
      .toBe('C:\\Users\\ming\\AppData\\Local\\agy\\bin\\agy.exe')
  })

  it('has no location on other systems', () => {
    expect(resolveAntigravityCliInstallTarget('linux', {}, '/home/ming')).toBeNull()
  })

  it('always lands on agy.exe inside agy\\bin whatever LOCALAPPDATA holds', () => {
    fc.assert(fc.property(fc.string(), (value) => {
      const resolved = resolveAntigravityCliInstallTarget('win32', { LOCALAPPDATA: value }, 'C:\\Users\\ming')
      expect(resolved).not.toBeNull()
      expect(path.win32.isAbsolute(resolved!.executablePath)).toBe(true)
      expect(resolved!.executablePath.endsWith('\\agy\\bin\\agy.exe')).toBe(true)
      expect(path.win32.dirname(resolved!.executablePath)).toBe(resolved!.directory)
    }), { numRuns: 200 })
  })
})

describe('Antigravity CLI install on Windows', () => {
  it('installs Google\'s signed build from the bucket and adds the folder to the user PATH', async () => {
    const item = artifact('windows_amd64')
    const winTarget = { directory: target.directory, executablePath: path.join(target.directory, 'agy.exe') }
    const progress: number[] = []
    const vendorRoute = countingVendorRoute()
    const options = windowsOptions(item, { target: winTarget, onProgress: ({ percent }) => progress.push(percent), withVendorDownloadRoute: vendorRoute.wrap })
    await expect(installAntigravityCli(options)).resolves.toEqual({ version: '1.5.15', executablePath: winTarget.executablePath, source: 'bucket', userPath: 'added' })
    expect(fs.readFileSync(winTarget.executablePath).equals(item.installed)).toBe(true)
    // The signature is checked on the downloaded copy in the installer cache, before it is placed.
    const checked = vi.mocked(options.verifyWindowsExecutable!).mock.calls.map(([filePath]) => filePath)
    expect(checked).toEqual([path.join(temporaryDirectory, 'agy-bucket-download.exe')])
    expect(options.ensureWindowsUserPath).toHaveBeenCalledWith(winTarget.directory)
    expect(requested(vi.mocked(options.fetchImpl!)).every((url) => url.startsWith(desktopPackageBucketOrigin))).toBe(true)
    expect(vendorRoute.calls).toBe(0)
    expect(progress[progress.length - 1]).toBe(100)
    expect(fs.existsSync(temporaryDirectory)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('reads the arm64 build for an arm64 PC', async () => {
    const item = artifact('windows_arm64')
    const options = windowsOptions(item)
    await expect(installAntigravityCli(options)).resolves.toMatchObject({ source: 'bucket' })
    expect(requested(vi.mocked(options.fetchImpl!))[0]).toBe(`${desktopPackageBucketOrigin}/${prefix}/windows.json`)
    expect(requested(vi.mocked(options.fetchImpl!))[1]).toContain('/windows-arm64/')
  })

  it.each([
    ['the index is missing', { bucketIndex: () => new Response('missing', { status: 404 }) }, 'HTTP 404'],
    ['the object is not what the index says', { bucketObject: () => binary(Buffer.alloc(1024 * 1024 + 4098)) }, 'SHA-256'],
    ['the bucket is unreachable', { bucketIndex: () => { throw new TypeError('fetch failed') } }, 'fetch failed'],
  ] as const)('falls back to Google through the vendor route when %s', async (_label, routes, reason) => {
    const item = artifact('windows_amd64')
    const fallbacks: string[] = []
    const vendorRoute = countingVendorRoute()
    const options = windowsOptions(item, { fetchImpl: fakeFetch(item, routes), bucket: { onFallback: (why) => fallbacks.push(why) }, withVendorDownloadRoute: vendorRoute.wrap })
    await expect(installAntigravityCli(options)).resolves.toMatchObject({ source: 'google', version: '1.5.15' })
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toMatch(/^antigravity-cli-windows_amd64：/)
    expect(fallbacks[0]).toContain(reason)
    expect(vendorRoute.calls).toBe(1)
    expect(fs.readFileSync(target.executablePath).equals(item.installed)).toBe(true)
  })

  it('falls back when the bucket copy is not the file Google\'s manifest names', async () => {
    const item = artifact('windows_amd64')
    const fallbacks: string[] = []
    const fetch = fakeFetch(item, { bucketIndex: () => json(bucketIndex(item, { sha512: 'aa'.repeat(64) })) })
    await expect(installAntigravityCli(windowsOptions(item, { fetchImpl: fetch, bucket: { onFallback: (why) => fallbacks.push(why) } })))
      .resolves.toMatchObject({ source: 'google' })
    expect(fallbacks[0]).toContain('SHA-512 不一致')
  })

  it('falls back when the bucket copy fails the signature check, and checks Google\'s copy again', async () => {
    const item = artifact('windows_amd64')
    const fallbacks: string[] = []
    const accepts = windowsSignatureAccepts()
    const verify = vi.fn(async (filePath: string) => {
      if (filePath.includes('agy-bucket')) throw new NativeCliPublisherMismatchError()
      return accepts(filePath)
    })
    await expect(installAntigravityCli(windowsOptions(item, { verifyWindowsExecutable: verify, bucket: { onFallback: (why) => fallbacks.push(why) } })))
      .resolves.toMatchObject({ source: 'google' })
    expect(verify).toHaveBeenCalledTimes(2)
    expect(fallbacks[0]).toContain('发布者不一致')
  })

  it('goes straight to Google when the bucket is not offered', async () => {
    const item = artifact('windows_amd64')
    const options = windowsOptions(item, { bucket: undefined })
    await expect(installAntigravityCli(options)).resolves.toMatchObject({ source: 'google' })
    expect(requested(vi.mocked(options.fetchImpl!))).toEqual([buildAntigravityCliManifestUrl('windows_amd64'), buildAntigravityCliArtifactUrl('windows_amd64', '1.5.15', build)])
  })

  it('asks Google without credentials and refuses redirects on both requests', async () => {
    const item = artifact('windows_amd64')
    const options = windowsOptions(item, { bucket: undefined })
    await installAntigravityCli(options)
    for (const [, init] of vi.mocked(options.fetchImpl!).mock.calls) {
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal) })
    }
  })

  it('reports a Google signature refusal as it is and installs nothing', async () => {
    const item = artifact('windows_amd64')
    const verify = vi.fn(async () => { throw new NativeCliPublisherMismatchError() })
    await expect(installAntigravityCli(windowsOptions(item, { bucket: undefined, verifyWindowsExecutable: verify })))
      .rejects.toBeInstanceOf(NativeCliPublisherMismatchError)
    expect(fs.existsSync(target.executablePath)).toBe(false)
    expect(fs.existsSync(temporaryDirectory)).toBe(false)
  })

  it.each([
    ['the download is not the file the manifest names', { manifest: () => json(googleManifest({ ...artifact('windows_amd64') })) }, 'SHA-512 不一致'],
    ['the manifest comes from another address', { manifest: () => withUrl(json('{}'), 'https://evil.example/manifests/windows_amd64.json') }, '版本清单被转到了别的地址'],
    ['the manifest is an error page', { manifest: () => new Response('down', { status: 503 }) }, 'HTTP 503'],
    ['the manifest names another host', { manifest: () => json(JSON.stringify({ version: '1.5.15', url: 'https://evil.example/cli_windows_x64.exe', sha512: 'aa'.repeat(64) })) }, '无法读取 Antigravity 命令行的版本信息'],
    ['the download comes from another address', { google: () => withUrl(binary(Buffer.alloc(2 * 1024 * 1024)), 'https://storage.googleapis.com/other/agy.exe') }, '下载被转到了别的地址'],
    ['the download is too small', { google: () => binary(Buffer.alloc(1024)) }, '1 MiB 至 512 MiB'],
    ['the download is an error page', { google: () => new Response('denied', { status: 403 }) }, 'HTTP 403'],
  ] as const)('refuses to install when %s', async (_label, routes, message) => {
    const item = artifact('windows_amd64')
    const verify = windowsSignatureAccepts()
    const failure = await failureOf(installAntigravityCli(windowsOptions(item, { fetchImpl: fakeFetch(item, routes), bucket: undefined, verifyWindowsExecutable: verify })))
    expect(failure.message).toMatch(/^Antigravity 命令行下载或签名校验失败：/)
    expect(failure.message).toContain(message)
    expect(verify).not.toHaveBeenCalled()
    expect(fs.existsSync(target.executablePath)).toBe(false)
    expect(fs.existsSync(temporaryDirectory)).toBe(false)
  })

  it('refuses to write into the user\'s folder from an administrator session', async () => {
    const item = artifact('windows_amd64')
    const options = windowsOptions(item, { executionMode: 'trusted-only' })
    await expect(installAntigravityCli(options)).rejects.toBeInstanceOf(AntigravityCliElevatedSessionError)
    expect(options.fetchImpl).not.toHaveBeenCalled()
    expect(fs.existsSync(target.directory)).toBe(false)
  })

  it('says agy is running when Windows will not let it be replaced', async () => {
    const item = artifact('windows_amd64')
    fs.mkdirSync(target.directory, { recursive: true })
    fs.writeFileSync(target.executablePath, 'old build')
    vi.mocked(renameWithTransientRetry).mockImplementationOnce(async () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    await expect(installAntigravityCli(windowsOptions(item))).rejects.toBeInstanceOf(AntigravityCliInUseError)
    expect(fs.readFileSync(target.executablePath, 'utf8')).toBe('old build')
    expect(leftovers()).toEqual([])
  })

  it('passes the customer cancel through without falling back or installing', async () => {
    const item = artifact('windows_amd64')
    const controller = new AbortController()
    const reason = new Error('客户取消了')
    const fallbacks: string[] = []
    const fetch = fakeFetch(item, {
      bucketObject: () => {
        controller.abort(reason)
        throw new DOMException('aborted', 'AbortError')
      },
    })
    await expect(installAntigravityCli(windowsOptions(item, { fetchImpl: fetch, signal: controller.signal, bucket: { onFallback: (why) => fallbacks.push(why) } })))
      .rejects.toBe(reason)
    expect(fallbacks).toEqual([])
    expect(requested(fetch).some((url) => url.includes('googleapis') || url.includes('run.app'))).toBe(false)
    expect(fs.existsSync(target.executablePath)).toBe(false)
    expect(fs.existsSync(temporaryDirectory)).toBe(false)
  })

  it('never hands a download that differs from the manifest to the signature check or installs it', async () => {
    const item = artifact('windows_amd64')
    await fc.assert(fc.asyncProperty(fc.nat({ max: item.download.length - 1 }), fc.integer({ min: 1, max: 255 }), async (offset, delta) => {
      const tampered = Buffer.from(item.download)
      tampered[offset] = (tampered[offset] + delta) % 256
      fs.mkdirSync(temporaryDirectory, { recursive: true })
      const verify = windowsSignatureAccepts()
      await expect(installAntigravityCli(windowsOptions(item, { fetchImpl: fakeFetch(item, { google: () => binary(tampered) }), bucket: undefined, verifyWindowsExecutable: verify })))
        .rejects.toThrow('SHA-512 不一致')
      expect(verify).not.toHaveBeenCalled()
      expect(fs.existsSync(target.executablePath)).toBe(false)
    }), { numRuns: 12 })
  })
})

describe('Antigravity CLI install on a Mac', () => {
  it.each(['darwin_arm64', 'darwin_amd64'] as const)('unpacks, checks and installs the %s build from the bucket', async (platform) => {
    const item = artifact(platform)
    const options = macOptions(item, { ensureWindowsUserPath: vi.fn(async () => 'added' as const) })
    await expect(installAntigravityCli(options)).resolves.toEqual({ version: '1.5.15', executablePath: target.executablePath, source: 'bucket' })
    expect(fs.readFileSync(target.executablePath).equals(item.installed)).toBe(true)
    if (process.platform !== 'win32') expect(fs.statSync(target.executablePath).mode & 0o777).toBe(0o755)
    const plan = vi.mocked(options.runDarwinProcess!).mock.calls[0][0] as AntigravityCliDarwinProcess
    expect(plan.executable).toBe('/usr/bin/codesign')
    expect(plan.argv[plan.argv.length - 1]).toBe(path.join(temporaryDirectory, 'agy-bucket'))
    expect(options.ensureWindowsUserPath).not.toHaveBeenCalled()
    expect(requested(vi.mocked(options.fetchImpl!))[0]).toBe(`${desktopPackageBucketOrigin}/${prefix}/macos.json`)
    expect(fs.existsSync(temporaryDirectory)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('does not refuse a Mac session for its execution mode', async () => {
    const item = artifact('darwin_arm64')
    await expect(installAntigravityCli(macOptions(item, { executionMode: 'trusted-only' }))).resolves.toMatchObject({ source: 'bucket' })
  })

  it('falls back to Google when codesign refuses the bucket copy', async () => {
    const item = artifact('darwin_arm64')
    const fallbacks: string[] = []
    const runDarwinProcess = vi.fn(async (plan: AntigravityCliDarwinProcess) => {
      if (plan.argv[plan.argv.length - 1].endsWith('agy-bucket')) throw codesignRefusal()
      return codesignAccepts()
    })
    await expect(installAntigravityCli(macOptions(item, { runDarwinProcess, bucket: { onFallback: (why) => fallbacks.push(why) } })))
      .resolves.toMatchObject({ source: 'google' })
    expect(fallbacks[0]).toContain('Developer ID')
    expect(fs.readFileSync(target.executablePath).equals(item.installed)).toBe(true)
  })

  it('reports a Google build codesign refuses as somebody else\'s build and installs nothing', async () => {
    const item = artifact('darwin_arm64')
    await expect(installAntigravityCli(macOptions(item, { bucket: undefined, runDarwinProcess: async () => { throw codesignRefusal() } })))
      .rejects.toBeInstanceOf(DarwinCliProvenanceError)
    expect(fs.existsSync(target.executablePath)).toBe(false)
  })

  it('refuses a build for the other chip', async () => {
    // An Apple silicon build served where the Intel one is expected, with matching digests.
    const intel = { ...artifact('darwin_arm64'), platform: 'darwin_amd64' as const }
    const failure = await failureOf(installAntigravityCli(macOptions(intel, { bucket: undefined })))
    expect(failure).toBeInstanceOf(DarwinCliProvenanceError)
    expect(failure.message).toBe('Antigravity 命令行的芯片和这台 Mac 对不上')
    expect(fs.existsSync(target.executablePath)).toBe(false)
  })

  it('refuses an archive that is not Google\'s layout', async () => {
    const item = artifact('darwin_arm64')
    const notTar = randomBytes(1024 * 1024 + 10)
    const crafted = { ...item, download: notTar }
    const failure = await failureOf(installAntigravityCli(macOptions(crafted, { bucket: undefined, fetchImpl: fakeFetch(crafted) })))
    expect(failure.message).toBe('Antigravity 命令行下载或签名校验失败：Antigravity 命令行安装包格式不对：解压失败')
    expect(fs.existsSync(target.executablePath)).toBe(false)
  })
})

describe('Antigravity CLI placement', () => {
  it('replaces an earlier agy in one step', async () => {
    const item = artifact('darwin_arm64')
    fs.mkdirSync(target.directory, { recursive: true })
    fs.writeFileSync(target.executablePath, 'old build')
    await installAntigravityCli(macOptions(item))
    expect(fs.readFileSync(target.executablePath).equals(item.installed)).toBe(true)
    expect(vi.mocked(renameWithTransientRetry)).toHaveBeenCalledWith(expect.stringMatching(/\.agy-[0-9a-f-]{36}\.pending$/), target.executablePath, expect.any(Function))
    expect(leftovers()).toEqual([])
  })

  it('leaves a folder in agy\'s place alone', async () => {
    const item = artifact('darwin_arm64')
    fs.mkdirSync(target.executablePath, { recursive: true })
    await expect(installAntigravityCli(macOptions(item))).rejects.toThrow('已经被别的东西占用，星芒不覆盖它')
    expect(fs.statSync(target.executablePath).isDirectory()).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('leaves a link in agy\'s place alone', async () => {
    const item = artifact('darwin_arm64')
    fs.mkdirSync(target.directory, { recursive: true })
    const elsewhere = path.join(workspace, 'elsewhere')
    fs.writeFileSync(elsewhere, 'theirs')
    fs.symlinkSync(elsewhere, target.executablePath)
    await expect(installAntigravityCli(macOptions(item))).rejects.toThrow('已经被别的东西占用，星芒不覆盖它')
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('theirs')
    expect(fs.lstatSync(target.executablePath).isSymbolicLink()).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('refuses a destination folder reached through a link', async () => {
    const item = artifact('darwin_arm64')
    const real = path.join(workspace, 'real-bin')
    fs.mkdirSync(real)
    fs.mkdirSync(path.dirname(target.directory), { recursive: true })
    fs.symlinkSync(real, target.directory)
    await expect(installAntigravityCli(macOptions(item))).rejects.toThrow('不能经过符号链接或目录联接')
    expect(fs.readdirSync(real)).toEqual([])
  })

  it('does not call agy running on a Mac when a rename fails', async () => {
    const item = artifact('darwin_arm64')
    fs.mkdirSync(target.directory, { recursive: true })
    fs.writeFileSync(target.executablePath, 'old build')
    const failure = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    vi.mocked(renameWithTransientRetry).mockImplementationOnce(async () => { throw failure })
    await expect(installAntigravityCli(macOptions(item))).rejects.toBe(failure)
    expect(leftovers()).toEqual([])
  })

  it('refuses systems and chips agy does not ship for', async () => {
    const item = artifact('windows_amd64')
    for (const [platform, architecture] of [['linux', 'x64'], ['win32', 'ia32'], ['darwin', 'ppc64']] as const) {
      const options = windowsOptions(item, { platform, architecture })
      await expect(installAntigravityCli(options)).rejects.toThrow('这台电脑的系统或芯片不支持 Antigravity 命令行')
      expect(options.fetchImpl).not.toHaveBeenCalled()
    }
  })
})

describe('Antigravity CLI installation check', () => {
  it('only reports a plain file as installed', () => {
    expect(inspectAntigravityCliInstallation(target)).toEqual({ installed: false })
    fs.mkdirSync(target.executablePath, { recursive: true })
    expect(inspectAntigravityCliInstallation(target)).toEqual({ installed: false })
    fs.rmdirSync(target.executablePath)
    fs.writeFileSync(target.executablePath, 'agy')
    expect(inspectAntigravityCliInstallation(target)).toEqual({ installed: true })
  })
})
