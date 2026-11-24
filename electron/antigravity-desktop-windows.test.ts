import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAntigravityDesktopArtifactUrl, buildAntigravityDesktopFeedUrl, type AntigravityDesktopPlatform } from './antigravity-desktop-release'
import {
  AntigravityDesktopElevatedSessionError,
  AntigravityDesktopNotOfficialError,
  inspectAntigravityDesktopWindowsInstallation,
  installAntigravityDesktopWindows,
  resolveAntigravityDesktopWindowsExecutable,
  type AntigravityDesktopWindowsProgress,
  type InstallAntigravityDesktopWindowsOptions,
} from './antigravity-desktop-windows'
import { desktopPackageBucketOrigin } from './desktop-package-bucket'
import { NativeCliPublisherMismatchError } from './trusted-native-cli'

// Nothing here reaches Google, the bucket or runs an installer: the feed, the bucket index and the
// downloads come from a fake fetch, the signature check and the installer are injected.
const build = '5887025308631040'
// The feed parser refuses anything under 16 MiB, so the fake installer is a little over that.
const installer = Buffer.concat([Buffer.from('MZ'), randomBytes(16 * 1024 * 1024 + 4094)])

function sha(algorithm: 'sha256' | 'sha512', data: Buffer): string {
  return createHash(algorithm).update(data).digest('hex')
}

type WindowsPlatform = Extract<AntigravityDesktopPlatform, `windows-${string}`>

function feed(platform: WindowsPlatform, data = installer, overrides: { size?: number, url?: string } = {}): string {
  const sha512 = createHash('sha512').update(data).digest('base64')
  return [
    'version: 2.34.0',
    'files:',
    `  - url: ${overrides.url ?? buildAntigravityDesktopArtifactUrl(platform, '2.34.0', build)}`,
    `    sha512: ${sha512}`,
    `    size: ${overrides.size ?? data.length}`,
    `path: ${platform === 'windows-x64' ? 'Antigravity-x64.exe' : 'Antigravity-arm64.exe'}`,
    `sha512: ${sha512}`,
    '',
  ].join('\n')
}

type Route = (init: RequestInit | undefined) => Response | Promise<Response>

function binary(data: Buffer, extra: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(data), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length), ...extra } })
}

function text(body: string, status = 200): Response {
  return new Response(body, { status })
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url })
  return response
}

const bucketPrefix = 'xingmang/offline/antigravity-desktop'
const bucketIndexUrl = `${desktopPackageBucketOrigin}/${bucketPrefix}/windows.json`

/** One file entry in the shape scripts/sync-antigravity-desktop-cos.cjs writes. */
function bucketFile(platform: WindowsPlatform, data = installer, extra: Record<string, unknown> = {}) {
  const sha256 = sha('sha256', data)
  const fileName = platform === 'windows-x64' ? 'Antigravity-x64.exe' : 'Antigravity-arm64.exe'
  const key = `${bucketPrefix}/${platform}/sha256-${sha256}/${fileName}`
  return {
    platformId: platform, platform: 'windows', architecture: platform === 'windows-x64' ? 'x64' : 'arm64', kind: 'installer', format: 'exe', fileName,
    type: 'application/octet-stream', verification: 'windows-authenticode-google', version: '2.34.0', key, url: `${desktopPackageBucketOrigin}/${key}`,
    size: data.length, sha256, sha512: sha('sha512', data), sourceUrl: buildAntigravityDesktopArtifactUrl(platform, '2.34.0', build), cosEtag: '"etag"', ...extra,
  }
}

function bucketIndex(checkedAt = new Date().toISOString(), files: unknown[] = [bucketFile('windows-x64'), bucketFile('windows-arm64')]): string {
  return JSON.stringify({ schemaVersion: 1, product: 'antigravity-desktop', family: 'windows', generatedAt: checkedAt, checkedAt, version: '2.34.0', build, files })
}

function bucketObjectUrl(platform: WindowsPlatform, data = installer): string {
  return bucketFile(platform, data).url
}

function fakeFetch(platform: WindowsPlatform, routes: { feed?: Route, installer?: Route, bucketIndex?: Route, bucketObject?: Route } = {}) {
  const table = new Map<string, Route>([
    [buildAntigravityDesktopFeedUrl(platform), routes.feed ?? (() => text(feed(platform)))],
    [buildAntigravityDesktopArtifactUrl(platform, '2.34.0', build), routes.installer ?? (() => binary(installer))],
  ])
  if (routes.bucketIndex) table.set(bucketIndexUrl, routes.bucketIndex)
  table.set(bucketObjectUrl(platform), routes.bucketObject ?? (() => binary(installer)))
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
let cache: string
let executablePath: string

beforeEach(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-agy-desktop-')))
  cache = path.join(workspace, 'cache')
  executablePath = path.join(workspace, 'Programs', 'antigravity', 'Antigravity.exe')
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

interface Harness {
  options: InstallAntigravityDesktopWindowsOptions
  fetch: ReturnType<typeof fakeFetch>
  ran: string[]
  verified: string[]
  progress: AntigravityDesktopWindowsProgress[]
}

/** The fake installer checks it runs exactly the checked bytes, then puts the program in place. */
function harness(platform: WindowsPlatform = 'windows-x64', overrides: Partial<InstallAntigravityDesktopWindowsOptions> = {}, routes: Parameters<typeof fakeFetch>[1] = {}): Harness {
  const fetch = fakeFetch(platform, routes)
  const ran: string[] = []
  const verified: string[] = []
  const progress: AntigravityDesktopWindowsProgress[] = []
  const options: InstallAntigravityDesktopWindowsOptions = {
    executionMode: 'same-user',
    platform: 'win32',
    architecture: platform === 'windows-x64' ? 'x64' : 'arm64',
    executablePath,
    fetchImpl: fetch,
    onProgress: (event) => progress.push(event),
    createTemporaryDirectory: async () => {
      fs.mkdirSync(cache)
      return cache
    },
    verifyInstaller: async (filePath) => {
      verified.push(filePath)
      const data = fs.readFileSync(filePath)
      return { size: data.length, sha256Hex: sha('sha256', data) }
    },
    runInstaller: async (installerPath) => {
      ran.push(installerPath)
      expect(sha('sha256', fs.readFileSync(installerPath))).toBe(sha('sha256', installer))
      fs.mkdirSync(path.dirname(executablePath), { recursive: true })
      fs.writeFileSync(executablePath, 'program')
    },
    ...overrides,
  }
  return { options, fetch, ran, verified, progress }
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`a non-Error was thrown: ${String(error)}`)
  }
  throw new Error('expected a failure')
}

describe('Antigravity desktop install location on Windows', () => {
  it('is the folder the one-click per-user installer always uses', () => {
    expect(resolveAntigravityDesktopWindowsExecutable('win32', { LOCALAPPDATA: 'D:\\Profiles\\ming\\AppData\\Local' }, 'C:\\Users\\ming'))
      .toBe('D:\\Profiles\\ming\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe')
  })

  it.each([{}, { LOCALAPPDATA: '' }, { LOCALAPPDATA: 'AppData\\Local' }])('falls back to the profile when LOCALAPPDATA is %j', (env) => {
    expect(resolveAntigravityDesktopWindowsExecutable('win32', env, 'C:\\Users\\ming'))
      .toBe('C:\\Users\\ming\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe')
  })

  it('has no Windows location on other systems', () => {
    expect(resolveAntigravityDesktopWindowsExecutable('darwin', {}, '/Users/ming')).toBeNull()
    expect(resolveAntigravityDesktopWindowsExecutable('linux', {}, '/home/ming')).toBeNull()
  })

  it('counts only a plain file as installed, without running it', () => {
    expect(inspectAntigravityDesktopWindowsInstallation(executablePath)).toEqual({ installed: false })
    fs.mkdirSync(executablePath, { recursive: true })
    expect(inspectAntigravityDesktopWindowsInstallation(executablePath)).toEqual({ installed: false })
    fs.rmdirSync(executablePath)
    fs.writeFileSync(executablePath, 'program')
    expect(inspectAntigravityDesktopWindowsInstallation(executablePath)).toEqual({ installed: true })
  })

  it.skipIf(process.platform === 'win32')('does not count a link as installed', () => {
    const real = path.join(workspace, 'elsewhere.exe')
    fs.writeFileSync(real, 'program')
    fs.mkdirSync(path.dirname(executablePath), { recursive: true })
    fs.symlinkSync(real, executablePath)
    expect(inspectAntigravityDesktopWindowsInstallation(executablePath)).toEqual({ installed: false })
  })
})

describe('installAntigravityDesktopWindows', () => {
  it('reads Google\'s feed, downloads the installer, checks it and runs it silently', async () => {
    const h = harness()

    await expect(installAntigravityDesktopWindows(h.options)).resolves.toEqual({ version: '2.34.0', executablePath })

    expect(requested(h.fetch)).toEqual([buildAntigravityDesktopFeedUrl('windows-x64'), buildAntigravityDesktopArtifactUrl('windows-x64', '2.34.0', build)])
    for (const [, init] of h.fetch.mock.calls) {
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' })
    }
    expect(h.verified).toEqual([path.join(cache, 'antigravity-setup.exe')])
    expect(h.ran).toEqual([path.join(cache, 'antigravity-setup.exe')])
    expect(h.progress[0]).toEqual({ phase: 'downloading', percent: 0 })
    expect(h.progress.slice(-2)).toEqual([{ phase: 'verifying', percent: null }, { phase: 'installing', percent: null }])
    expect(fs.existsSync(cache)).toBe(false)
  })

  it('installs the Arm build on Arm Windows', async () => {
    const h = harness('windows-arm64')
    await installAntigravityDesktopWindows(h.options)
    expect(requested(h.fetch)).toEqual([buildAntigravityDesktopFeedUrl('windows-arm64'), buildAntigravityDesktopArtifactUrl('windows-arm64', '2.34.0', build)])
  })

  it('refuses to install from a session running as administrator, before any download', async () => {
    const h = harness('windows-x64', { executionMode: 'trusted-only' })
    expect(await failureOf(installAntigravityDesktopWindows(h.options))).toBeInstanceOf(AntigravityDesktopElevatedSessionError)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.ran).toEqual([])
  })

  it.each([
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'ia32'],
  ] as const)('does not install on %s/%s', async (platform, architecture) => {
    const h = harness('windows-x64', { platform, architecture })
    expect((await failureOf(installAntigravityDesktopWindows(h.options))).message).toBe('当前电脑的系统或处理器不支持 Antigravity')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['a feed for the other chip', () => text(feed('windows-arm64'))],
    ['a feed naming another host', () => text(feed('windows-x64', installer, { url: buildAntigravityDesktopArtifactUrl('windows-x64', '2.34.0', build).replace('storage.googleapis.com', 'storage.example.com') }))],
    ['a missing feed', () => text('not found', 404)],
    ['a feed that was redirected', () => withUrl(text(feed('windows-x64')), 'https://example.com/latest-x64-win.yml')],
    ['a feed that is not the updater\'s format', () => text('{"version":"2.34.0"}')],
  ])('downloads nothing from %s', async (_label, route) => {
    const h = harness('windows-x64', {}, { feed: route })
    const error = await failureOf(installAntigravityDesktopWindows(h.options))
    expect(error.message).toBe('Antigravity 下载未完成或校验未通过，请稍后重试')
    expect(requested(h.fetch)).toEqual([buildAntigravityDesktopFeedUrl('windows-x64')])
    expect(h.ran).toEqual([])
    expect(fs.existsSync(cache)).toBe(false)
  })

  it.each([
    ['is a different size', () => binary(Buffer.concat([installer, Buffer.from('x')])), '版本信息写的是'],
    ['declares no size', () => new Response(new Uint8Array(installer), { status: 200 }), '未知'],
    ['has different bytes', () => binary(Buffer.alloc(installer.length, 7)), 'SHA-512'],
    ['fails', () => text('gone', 404), 'HTTP 404'],
    ['was redirected', () => withUrl(binary(installer), 'https://example.com/Antigravity-x64.exe'), '别的地址'],
  ])('neither checks nor runs an installer that %s', async (_label, route, reason) => {
    const h = harness('windows-x64', {}, { installer: route })
    const error = await failureOf(installAntigravityDesktopWindows(h.options))
    // 客户只看到一句；哪里不对留在 cause 里，随错误进运行日志。
    expect(error.message).toBe('Antigravity 下载未完成或校验未通过，请稍后重试')
    expect((error.cause as Error).message).toContain(reason)
    expect(h.verified).toEqual([])
    expect(h.ran).toEqual([])
    expect(fs.existsSync(cache)).toBe(false)
  })

  it('deletes and refuses an installer Google did not sign', async () => {
    const h = harness('windows-x64', {
      verifyInstaller: async () => {
        throw new NativeCliPublisherMismatchError()
      },
    })
    const error = await failureOf(installAntigravityDesktopWindows(h.options))
    expect(error).toBeInstanceOf(AntigravityDesktopNotOfficialError)
    expect(error.message).toBe('下载的 Antigravity 安装包不是 Google 官方签名版本，已删除，未进行安装')
    expect(h.ran).toEqual([])
    expect(fs.existsSync(cache)).toBe(false)
  })

  it('reports an unreadable signature as a failed check, not as somebody else\'s installer', async () => {
    const h = harness('windows-x64', {
      verifyInstaller: async () => {
        throw new Error('原生 CLI 没有有效的 Authenticode 签名')
      },
    })
    const error = await failureOf(installAntigravityDesktopWindows(h.options))
    expect(error).not.toBeInstanceOf(AntigravityDesktopNotOfficialError)
    expect(error.message).toBe('Antigravity 下载未完成或校验未通过，请稍后重试')
    expect((error.cause as Error).message).toBe('原生 CLI 没有有效的 Authenticode 签名')
    expect(h.ran).toEqual([])
  })

  it('does not run an installer that changed after its signature was checked', async () => {
    const h = harness('windows-x64', {
      verifyInstaller: async (filePath) => {
        const result = { size: installer.length, sha256Hex: sha('sha256', fs.readFileSync(filePath)) }
        fs.writeFileSync(filePath, Buffer.alloc(installer.length, 1))
        return result
      },
    })
    expect((await failureOf(installAntigravityDesktopWindows(h.options))).message).toBe('Antigravity 安装包在校验后被修改，未进行安装')
    expect(h.ran).toEqual([])
    expect(fs.existsSync(cache)).toBe(false)
  })

  it('reports an installer that did not finish', async () => {
    const h = harness('windows-x64', {
      runInstaller: async () => {
        throw new Error('exit code 2')
      },
    })
    const error = await failureOf(installAntigravityDesktopWindows(h.options))
    expect(error.message).toBe('Antigravity 安装未完成，请稍后重试')
    expect((error.cause as Error).message).toBe('exit code 2')
    expect(fs.existsSync(cache)).toBe(false)
  })

  it('does not call it installed when the installer left no program behind', async () => {
    const h = harness('windows-x64', { runInstaller: async () => undefined })
    expect((await failureOf(installAntigravityDesktopWindows(h.options))).message).toBe('Antigravity 安装程序已运行完毕，但未找到安装好的 Antigravity，请稍后重试')
  })

  it('stops at a cancel during the download and never starts the installer', async () => {
    const controller = new AbortController()
    const h = harness('windows-x64', { signal: controller.signal }, {
      installer: (init) => {
        controller.abort()
        init?.signal?.throwIfAborted()
        return binary(installer)
      },
    })
    const error = await failureOf(installAntigravityDesktopWindows(h.options))
    expect(error.name).toBe('AbortError')
    expect(h.ran).toEqual([])
    expect(fs.existsSync(cache)).toBe(false)
  })

  it('does not hand the cancel signal to a running installer', async () => {
    const controller = new AbortController()
    const h = harness('windows-x64', { signal: controller.signal })
    const run = h.options.runInstaller
    h.options.runInstaller = async (installerPath) => {
      controller.abort()
      await run?.(installerPath)
    }
    await expect(installAntigravityDesktopWindows(h.options)).resolves.toEqual({ version: '2.34.0', executablePath })
  })

  it('routes only the talk with Google through the download route, not the install', async () => {
    const order: string[] = []
    const h = harness('windows-x64', {
      withVendorDownloadRoute: async (operation) => {
        order.push('route:start')
        const result = await operation()
        order.push('route:end')
        return result
      },
    })
    const run = h.options.runInstaller
    h.options.runInstaller = async (installerPath) => {
      order.push('install')
      await run?.(installerPath)
    }
    await installAntigravityDesktopWindows(h.options)
    expect(order).toEqual(['route:start', 'route:end', 'install'])
  })
})

describe('installAntigravityDesktopWindows from the bucket', () => {
  function bucketHarness(platform: WindowsPlatform = 'windows-x64', overrides: Partial<InstallAntigravityDesktopWindowsOptions> = {}, routes: Parameters<typeof fakeFetch>[1] = {}) {
    const fallbacks: string[] = []
    const routed: string[] = []
    const h = harness(platform, {
      bucket: { onFallback: (detail) => fallbacks.push(detail) },
      withVendorDownloadRoute: async (operation) => {
        routed.push('google')
        return operation()
      },
      ...overrides,
    }, { bucketIndex: () => text(bucketIndex()), ...routes })
    return { ...h, fallbacks, routed }
  }

  it('installs the Google-signed installer from the bucket without asking Google', async () => {
    const h = bucketHarness()
    await expect(installAntigravityDesktopWindows(h.options)).resolves.toEqual({ version: '2.34.0', executablePath })
    expect(requested(h.fetch)).toEqual([bucketIndexUrl, bucketObjectUrl('windows-x64')])
    for (const [, init] of h.fetch.mock.calls) expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit' })
    // The bucket copy gets the same signature check and the same last look before it runs.
    expect(h.verified).toEqual([path.join(cache, 'antigravity-setup.exe')])
    expect(h.ran).toEqual([path.join(cache, 'antigravity-setup.exe')])
    expect(h.routed).toEqual([])
    expect(h.fallbacks).toEqual([])
    expect(h.progress[0]).toEqual({ phase: 'downloading', percent: 0 })
    expect(h.progress.slice(-2)).toEqual([{ phase: 'verifying', percent: null }, { phase: 'installing', percent: null }])
    expect(fs.existsSync(cache)).toBe(false)
  })

  it('reads the Arm entry on Arm Windows', async () => {
    const h = bucketHarness('windows-arm64')
    await installAntigravityDesktopWindows(h.options)
    expect(requested(h.fetch)).toEqual([bucketIndexUrl, bucketObjectUrl('windows-arm64')])
  })

  it.each([
    ['no index', () => text('missing', 404), '存储桶清单返回 HTTP 404'],
    ['an index without this chip', () => text(bucketIndex(undefined, [bucketFile('windows-arm64')])), '清单格式对不上'],
    ['an entry outside the Antigravity folder', () => text(bucketIndex(undefined, [bucketFile('windows-x64', installer, { key: `xingmang/offline/claude/windows-x64/sha256-${sha('sha256', installer)}/Antigravity-x64.exe` }), bucketFile('windows-arm64')])), '清单格式对不上'],
    ['an index that was redirected', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), '跳转'],
  ])('goes to Google when the bucket has %s, and only logs why', async (_label, route, reason) => {
    const h = bucketHarness('windows-x64', {}, { bucketIndex: route })
    await expect(installAntigravityDesktopWindows(h.options)).resolves.toEqual({ version: '2.34.0', executablePath })
    expect(requested(h.fetch)).toEqual([bucketIndexUrl, buildAntigravityDesktopFeedUrl('windows-x64'), buildAntigravityDesktopArtifactUrl('windows-x64', '2.34.0', build)])
    expect(h.routed).toEqual(['google'])
    expect(h.fallbacks).toHaveLength(1)
    expect(h.fallbacks[0]).toMatch(/^antigravity-windows-x64：/)
    expect(h.fallbacks[0]).toContain(reason)
  })

  it('goes to Google when the bucket serves other bytes than its index names', async () => {
    const h = bucketHarness('windows-x64', {}, { bucketObject: () => binary(Buffer.alloc(installer.length, 3)) })
    await installAntigravityDesktopWindows(h.options)
    expect(h.fallbacks[0]).toContain('SHA-256')
    expect(h.verified).toEqual([path.join(cache, 'antigravity-setup.exe')])
    expect(requested(h.fetch).slice(-1)).toEqual([buildAntigravityDesktopArtifactUrl('windows-x64', '2.34.0', build)])
  })

  it('deletes a bucket installer Google did not sign and fetches Google\'s own', async () => {
    let checks = 0
    const verify = harness().options.verifyInstaller
    const h = bucketHarness('windows-x64', {
      verifyInstaller: async (filePath) => {
        checks += 1
        if (checks === 1) throw new NativeCliPublisherMismatchError()
        return verify!(filePath)
      },
    })
    await expect(installAntigravityDesktopWindows(h.options)).resolves.toEqual({ version: '2.34.0', executablePath })
    expect(checks).toBe(2)
    expect(h.fallbacks).toHaveLength(1)
    expect(requested(h.fetch)).toEqual([bucketIndexUrl, bucketObjectUrl('windows-x64'), buildAntigravityDesktopFeedUrl('windows-x64'), buildAntigravityDesktopArtifactUrl('windows-x64', '2.34.0', build)])
  })

  it('asks Google first when the bucket index is over a day old, and does not use the bucket when Google works', async () => {
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()
    const h = bucketHarness('windows-x64', {}, { bucketIndex: () => text(bucketIndex(stale)) })
    await installAntigravityDesktopWindows(h.options)
    expect(requested(h.fetch)).toEqual([bucketIndexUrl, buildAntigravityDesktopFeedUrl('windows-x64'), buildAntigravityDesktopArtifactUrl('windows-x64', '2.34.0', build)])
    expect(h.fallbacks[0]).toContain('超过 24 小时')
  })

  it('falls back to a day-old bucket copy when Google cannot be reached either', async () => {
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()
    const h = bucketHarness('windows-x64', {}, {
      bucketIndex: () => text(bucketIndex(stale)),
      feed: () => {
        throw new TypeError('fetch failed')
      },
    })
    await expect(installAntigravityDesktopWindows(h.options)).resolves.toEqual({ version: '2.34.0', executablePath })
    expect(requested(h.fetch)).toEqual([bucketIndexUrl, buildAntigravityDesktopFeedUrl('windows-x64'), bucketIndexUrl, bucketObjectUrl('windows-x64')])
    // The second bucket attempt is not routed and not wrapped in the Google route.
    expect(h.routed).toEqual(['google'])
    expect(h.ran).toEqual([path.join(cache, 'antigravity-setup.exe')])
  })

  it('reports Google\'s failure when neither Google nor a fresh bucket works', async () => {
    const h = bucketHarness('windows-x64', {}, {
      bucketIndex: () => text('missing', 404),
      feed: () => {
        throw new TypeError('fetch failed')
      },
    })
    const error = await failureOf(installAntigravityDesktopWindows(h.options))
    expect(error.message).toBe('Antigravity 下载未完成或校验未通过，请稍后重试')
    // A bucket that is simply missing is not tried a second time.
    expect(requested(h.fetch)).toEqual([bucketIndexUrl, buildAntigravityDesktopFeedUrl('windows-x64')])
    expect(h.ran).toEqual([])
    expect(fs.existsSync(cache)).toBe(false)
  })

  it('stops at a cancel during the bucket download without falling back to Google', async () => {
    const controller = new AbortController()
    const h = bucketHarness('windows-x64', { signal: controller.signal }, {
      bucketObject: (init) => {
        controller.abort()
        init?.signal?.throwIfAborted()
        return binary(installer)
      },
    })
    const error = await failureOf(installAntigravityDesktopWindows(h.options))
    expect(error.name).toBe('AbortError')
    expect(requested(h.fetch)).toEqual([bucketIndexUrl, bucketObjectUrl('windows-x64')])
    expect(h.fallbacks).toEqual([])
    expect(h.ran).toEqual([])
    expect(fs.existsSync(cache)).toBe(false)
  })
})

describe('installAntigravityDesktopWindows with random inputs', () => {
  it('never runs an installer whose bytes are not the ones the feed and the check agreed on', async () => {
    await fc.assert(fc.asyncProperty(fc.nat({ max: installer.length - 1 }), fc.integer({ min: 1, max: 255 }), async (offset, flip) => {
      fs.rmSync(cache, { recursive: true, force: true })
      const tampered = Buffer.from(installer)
      tampered[offset] ^= flip
      const h = harness('windows-x64', {}, { installer: () => binary(tampered) })
      const error = await failureOf(installAntigravityDesktopWindows(h.options))
      expect(error.message).toBe('Antigravity 下载未完成或校验未通过，请稍后重试')
      expect((error.cause as Error).message).toContain('SHA-512')
      expect(h.ran).toEqual([])
    }), { numRuns: 8 })
  })
})
