import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from './command-runner'
import {
  buildGitRuntimeInstallPlan,
  gitForWindowsExpectedSha256,
  gitForWindowsInstallerFileName,
  gitForWindowsTag,
  gitForWindowsVersion,
  gitRuntimeDownloadSources,
  gitRuntimeMissingAfterInstallMessage,
  installGitRuntimeWith,
  normalizeGitRuntimeArchitecture,
  validateGitRuntimeDownloadUrl,
  type GitRuntimeInstallerDependencies,
  type GitRuntimeInstallProgress,
} from './git-runtime-install'
import type { NodeRuntimeProcessPlan } from './node-runtime'

const temporaryDirectories: string[] = []
const machinePaths = {
  systemRoot: 'C:\\Windows',
  system32: 'C:\\Windows\\System32',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  programData: 'C:\\ProgramData',
}
const userEnvironment = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function installerBytes(fill: number): Buffer {
  return Buffer.alloc(21 * 1024 * 1024, fill)
}

function streamResponse(body: Buffer, url: string, status = 200): Response {
  const response = new Response(new Uint8Array(body), {
    status,
    headers: { 'content-length': String(body.byteLength) },
  })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

function redirectResponse(url: string, location: string): Response {
  const response = new Response(null, { status: 302, headers: { location } })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

function dependencies(overrides: Partial<GitRuntimeInstallerDependencies> = {}): GitRuntimeInstallerDependencies & {
  plans: NodeRuntimeProcessPlan[]
} {
  const plans: NodeRuntimeProcessPlan[] = []
  return {
    plans,
    fetch: vi.fn(async () => { throw new Error('unexpected fetch') }) as unknown as typeof globalThis.fetch,
    expectedSha256: gitForWindowsExpectedSha256,
    runProcess: vi.fn(async (plan: NodeRuntimeProcessPlan): Promise<CommandResult> => {
      plans.push(plan)
      return { executable: plan.executable, argv: [...plan.argv], exitCode: 0, signal: null, stdout: '', stderr: '', outputBytes: 0, durationMs: 1 }
    }),
    createTemporaryDirectory: async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-git-runtime-test-'))
      temporaryDirectories.push(directory)
      return directory
    },
    removeTemporaryDirectory: async (directory) => fs.rmSync(directory, { recursive: true, force: true }),
    ...overrides,
  }
}

describe('git-runtime-install', () => {
  it('pins one Git for Windows release with a SHA-256 per architecture', () => {
    expect(gitForWindowsTag).toBe(`v${gitForWindowsVersion.split('.').slice(0, 3).join('.')}.windows.${gitForWindowsVersion.split('.')[3]}`)
    expect(gitForWindowsInstallerFileName('x64')).toBe(`Git-${gitForWindowsVersion}-64-bit.exe`)
    expect(gitForWindowsInstallerFileName('arm64')).toBe(`Git-${gitForWindowsVersion}-arm64.exe`)
    for (const architecture of ['x64', 'arm64'] as const) {
      expect(gitForWindowsExpectedSha256(architecture)).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(gitForWindowsExpectedSha256('x64')).not.toBe(gitForWindowsExpectedSha256('arm64'))
  })

  it('rejects architectures Git for Windows does not ship an installer for', () => {
    expect(normalizeGitRuntimeArchitecture('x64')).toBe('x64')
    expect(normalizeGitRuntimeArchitecture('arm64')).toBe('arm64')
    expect(() => normalizeGitRuntimeArchitecture('ia32')).toThrow('暂时不能自动安装 Git')
  })

  it('tries the domestic mirror first unless the customer is clearly outside mainland China', () => {
    expect(gitRuntimeDownloadSources('mainland-china', 'x64').map((source) => source.id)).toEqual(['npmmirror', 'official'])
    expect(gitRuntimeDownloadSources('unknown', 'x64').map((source) => source.id)).toEqual(['npmmirror', 'official'])
    expect(gitRuntimeDownloadSources('outside-mainland-china', 'x64').map((source) => source.id)).toEqual(['official', 'npmmirror'])
    const [mirror, official] = gitRuntimeDownloadSources('unknown', 'arm64')
    expect(mirror.url).toBe(`https://npmmirror.com/mirrors/git-for-windows/${gitForWindowsTag}/Git-${gitForWindowsVersion}-arm64.exe`)
    expect(official.url).toBe(`https://github.com/git-for-windows/git/releases/download/${gitForWindowsTag}/Git-${gitForWindowsVersion}-arm64.exe`)
  })

  it('keeps downloads on the mirror and GitHub release hosts', () => {
    expect(() => validateGitRuntimeDownloadUrl('https://cdn.npmmirror.com/binaries/git-for-windows/v2/Git.exe')).not.toThrow()
    expect(() => validateGitRuntimeDownloadUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x')).not.toThrow()
    expect(() => validateGitRuntimeDownloadUrl('http://npmmirror.com/mirrors/git-for-windows/v2/Git.exe')).toThrow()
    expect(() => validateGitRuntimeDownloadUrl('https://npmmirror.com.evil.example/mirrors/git-for-windows/v2/Git.exe')).toThrow()
    expect(() => validateGitRuntimeDownloadUrl('https://npmmirror.com/mirrors/node/v2/node.msi')).toThrow()
    expect(() => validateGitRuntimeDownloadUrl('https://github.com/attacker/git/releases/download/v1/Git.exe')).toThrow()
    expect(() => validateGitRuntimeDownloadUrl('https://user:pass@github.com/git-for-windows/git/releases/download/v1/Git.exe')).toThrow()
    expect(() => validateGitRuntimeDownloadUrl('https://npmmirror.com/mirrors/git-for-windows/../node/x.exe')).toThrow()
  })

  it('installs for the current user without asking for administrator rights', () => {
    const plan = buildGitRuntimeInstallPlan(
      'C:\\Temp\\git\\Git.exe',
      false,
      { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', PATH: 'C:\\Windows' },
      machinePaths,
    )
    expect(plan.executable).toBe('C:\\Temp\\git\\Git.exe')
    expect(plan.argv).toEqual([
      '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCANCEL', '/SP-',
      '/DIR=C:\\Users\\tester\\AppData\\Local\\Programs\\Git',
    ])
    expect(plan.trustedOnly).toBe(false)
    expect(plan.elevation).toBeUndefined()
    expect(plan.trustedPaths).toEqual(['C:\\Temp\\git\\Git.exe'])
  })

  it('never points an elevated install at a user-writable directory', () => {
    const plan = buildGitRuntimeInstallPlan(
      'C:\\ProgramData\\Xingmang\\git\\Git.exe',
      true,
      { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      machinePaths,
    )
    expect(plan.argv.some((argument) => argument.startsWith('/DIR='))).toBe(false)
    expect(plan.trustedOnly).toBeUndefined()
  })

  it('refuses relative installer paths', () => {
    expect(() => buildGitRuntimeInstallPlan('Git.exe', false, { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' })).toThrow('路径无效')
  })

  it('downloads from the mirror, checks the digest and runs the installer', async () => {
    const body = installerBytes(1)
    const [mirror] = gitRuntimeDownloadSources('unknown', 'x64')
    const cdn = mirror.url.replace('https://npmmirror.com/mirrors/', 'https://cdn.npmmirror.com/binaries/')
    const fetch = vi.fn(async (url: string) => url === mirror.url ? redirectResponse(url, cdn) : streamResponse(body, url))
    const digest = createHash('sha256').update(body).digest('hex')
    const deps = dependencies({ fetch: fetch as unknown as typeof globalThis.fetch, expectedSha256: () => digest })
    const events: GitRuntimeInstallProgress[] = []

    const result = await installGitRuntimeWith('x64', {
      networkRegion: 'unknown',
      temporaryDirectoryMode: 'same-user',
      environment: userEnvironment,
      onProgress: (event) => events.push(event),
    }, deps)

    expect(result).toEqual({
      installed: true,
      action: 'installed',
      source: 'npmmirror',
      version: gitForWindowsVersion,
      architecture: 'x64',
      pathRefreshRequired: true,
    })
    expect(fetch).toHaveBeenCalledWith(mirror.url, expect.objectContaining({ redirect: 'manual' }))
    expect(fetch).toHaveBeenCalledWith(cdn, expect.objectContaining({ redirect: 'manual' }))
    expect(deps.plans).toHaveLength(1)
    expect(path.basename(deps.plans[0].executable)).toBe(`npmmirror-Git-${gitForWindowsVersion}-64-bit.exe`)
    expect(deps.plans[0].argv.some((argument) => argument.startsWith('/DIR='))).toBe(true)
    expect(events.map((event) => event.phase)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'installing', 'complete']))
    expect(events.every((event) => !/PowerShell|bash|PATH/.test(event.message))).toBe(true)
  })

  it('never runs a download whose digest differs from the pinned one and falls back to the official source', async () => {
    const good = installerBytes(2)
    const tampered = installerBytes(3)
    const digest = createHash('sha256').update(good).digest('hex')
    const [mirror, official] = gitRuntimeDownloadSources('mainland-china', 'x64')
    const fetch = vi.fn(async (url: string) => streamResponse(url === mirror.url ? tampered : good, url))
    const deps = dependencies({ fetch: fetch as unknown as typeof globalThis.fetch, expectedSha256: () => digest })

    const result = await installGitRuntimeWith('x64', { networkRegion: 'mainland-china', temporaryDirectoryMode: 'same-user', environment: userEnvironment }, deps)

    expect(result.source).toBe('official')
    expect(fetch).toHaveBeenCalledWith(official.url, expect.anything())
    expect(deps.plans).toHaveLength(1)
    expect(path.basename(deps.plans[0].executable)).toMatch(/^official-/)
  })

  it('picks a dropped mirror download up where it stopped instead of switching sources', async () => {
    const body = installerBytes(4)
    const cut = 5 * 1024 * 1024
    const [mirror] = gitRuntimeDownloadSources('mainland-china', 'x64')
    const ranges: Array<string | null> = []
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range')
      ranges.push(range)
      if (range) {
        const response = new Response(new Uint8Array(body.subarray(cut)), {
          status: 206,
          headers: { 'content-range': `bytes ${cut}-${body.byteLength - 1}/${body.byteLength}` },
        })
        Object.defineProperty(response, 'url', { value: url })
        return response
      }
      let sent = false
      const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            controller.error(new TypeError('fetch failed'))
            return
          }
          sent = true
          controller.enqueue(new Uint8Array(body.subarray(0, cut)))
        },
      }), { status: 200, headers: { 'content-length': String(body.byteLength), etag: '"git"' } })
      Object.defineProperty(response, 'url', { value: url })
      return response
    })
    const digest = createHash('sha256').update(body).digest('hex')
    const deps = dependencies({
      fetch: fetch as unknown as typeof globalThis.fetch,
      expectedSha256: () => digest,
      waitBeforeResume: async () => undefined,
    })
    const events: GitRuntimeInstallProgress[] = []

    const result = await installGitRuntimeWith('x64', {
      networkRegion: 'mainland-china',
      temporaryDirectoryMode: 'same-user',
      environment: userEnvironment,
      onProgress: (event) => events.push(event),
    }, deps)

    expect(result.source).toBe('npmmirror')
    expect(fetch.mock.calls.every(([url]) => url === mirror.url)).toBe(true)
    expect(ranges).toEqual([null, `bytes=${cut}-`])
    expect(events.some((event) => event.message === '网络断了一下，正在从国内镜像接着下载 Git')).toBe(true)
  })

  it('reports both sources in plain words when neither works', async () => {
    const fetch = vi.fn(async (url: string) => streamResponse(Buffer.alloc(0), url, 404))
    const deps = dependencies({ fetch: fetch as unknown as typeof globalThis.fetch })
    const events: GitRuntimeInstallProgress[] = []

    await expect(installGitRuntimeWith('x64', {
      networkRegion: 'unknown',
      temporaryDirectoryMode: 'same-user',
      environment: userEnvironment,
      onProgress: (event) => events.push(event),
    }, deps)).rejects.toThrow(/^Git 没装上。国内镜像：HTTP 404；Git 官方源：HTTP 404$/)
    expect(deps.plans).toEqual([])
    expect(events.at(-1)).toMatchObject({ phase: 'error' })
  })

  it('refuses a redirect that leaves the approved hosts', async () => {
    const [mirror] = gitRuntimeDownloadSources('unknown', 'x64')
    const fetch = vi.fn(async (url: string) => redirectResponse(url, 'https://evil.example/Git.exe'))
    const deps = dependencies({ fetch: fetch as unknown as typeof globalThis.fetch })

    await expect(installGitRuntimeWith('x64', { networkRegion: 'unknown', temporaryDirectoryMode: 'same-user', environment: userEnvironment }, deps))
      .rejects.toThrow('未经批准的地址')
    expect(fetch).not.toHaveBeenCalledWith('https://evil.example/Git.exe', expect.anything())
    expect(fetch).toHaveBeenCalledWith(mirror.url, expect.anything())
  })

  it('refuses each kind of bad redirect target before following it', async () => {
    const [mirror] = gitRuntimeDownloadSources('mainland-china', 'x64')
    const directory = 'https://cdn.npmmirror.com/binaries/git-for-windows/v2/'
    for (const location of [
      'http://cdn.npmmirror.com/binaries/git-for-windows/v2/Git.exe',
      'https://cdn.npmmirror.com:8443/binaries/git-for-windows/v2/Git.exe',
      'https://user:secret@cdn.npmmirror.com/binaries/git-for-windows/v2/Git.exe',
      `${directory}Git.exe#top`,
      `${directory}Git.exe?sig=1`,
      'https://npmmirror.com/mirrors/git-for-windows/../node/x.exe',
      'https://github.com/attacker/git/releases/download/v1/Git.exe',
      'https://cdn.npmmirror.com.evil.example/binaries/git-for-windows/v2/Git.exe',
    ]) {
      const calls: string[] = []
      const fetch = vi.fn(async (url: string) => {
        calls.push(url)
        return url === mirror.url ? redirectResponse(url, location) : streamResponse(Buffer.alloc(0), url, 404)
      })
      const deps = dependencies({ fetch: fetch as unknown as typeof globalThis.fetch })

      await expect(installGitRuntimeWith('x64', { networkRegion: 'mainland-china', temporaryDirectoryMode: 'same-user', environment: userEnvironment }, deps), location)
        .rejects.toThrow(/^Git 没装上。国内镜像：Git 安装包下载跳转到了未经批准的地址；Git 官方源：HTTP 404$/)
      expect(calls.filter((url) => url !== mirror.url && !url.startsWith('https://github.com/git-for-windows/'))).toEqual([])
    }
  })

  it('stops a redirect loop, a redirect without a target and an endless chain in the words customers already see', async () => {
    const [mirror] = gitRuntimeDownloadSources('mainland-china', 'x64')
    const cdn = mirror.url.replace('https://npmmirror.com/mirrors/', 'https://cdn.npmmirror.com/binaries/')
    const hop = (index: number) => `https://cdn.npmmirror.com/binaries/git-for-windows/hop-${index}.exe`
    const cases: Array<[string, (url: string, calls: string[]) => Response, number]> = [
      ['Git 安装包下载发生了循环跳转', (url) => redirectResponse(url, url === mirror.url ? cdn : mirror.url), 2],
      ['Git 安装包下载跳转缺少目标地址', (url) => {
        const response = new Response(null, { status: 302 })
        Object.defineProperty(response, 'url', { value: url })
        return response
      }, 1],
      ['Git 安装包下载跳转次数过多', (url, calls) => redirectResponse(url, hop(calls.length)), 6],
    ]
    for (const [message, answer, mirrorCalls] of cases) {
      const calls: string[] = []
      const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.startsWith('https://github.com/')) return streamResponse(Buffer.alloc(0), url, 404)
        calls.push(url)
        return answer(url, calls)
      })
      const deps = dependencies({ fetch: fetch as unknown as typeof globalThis.fetch })

      await expect(installGitRuntimeWith('x64', { networkRegion: 'mainland-china', temporaryDirectoryMode: 'same-user', environment: userEnvironment }, deps))
        .rejects.toThrow(`Git 没装上。国内镜像：${message}；Git 官方源：HTTP 404`)
      expect(calls).toHaveLength(mirrorCalls)
      expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true)
    }
  })

  it('follows five redirects and installs, including the GitHub release-asset hop with its signed query', async () => {
    const body = installerBytes(5)
    const digest = createHash('sha256').update(body).digest('hex')
    const [, official] = gitRuntimeDownloadSources('mainland-china', 'x64')
    const asset = 'https://release-assets.githubusercontent.com/github-production-release-asset/1?sp=r&sig=a%2Bb'
    const hop = (index: number) => `https://cdn.npmmirror.com/binaries/git-for-windows/hop-${index}.exe`
    const calls: string[] = []
    const fetch = vi.fn(async (url: string) => {
      calls.push(url)
      if (url === official.url) return redirectResponse(url, asset)
      if (url === asset) return streamResponse(body, url)
      const index = url.startsWith(hop(0).slice(0, -5)) ? Number(url.slice(url.lastIndexOf('-') + 1, -4)) : 0
      return index < 5 ? redirectResponse(url, hop(index + 1)) : streamResponse(body, url)
    })
    const deps = dependencies({ fetch: fetch as unknown as typeof globalThis.fetch, expectedSha256: () => digest })

    const result = await installGitRuntimeWith('x64', { networkRegion: 'mainland-china', temporaryDirectoryMode: 'same-user', environment: userEnvironment }, deps)
    expect(result.source).toBe('npmmirror')
    expect(calls).toHaveLength(6)

    calls.length = 0
    const officialFirst = await installGitRuntimeWith('x64', { networkRegion: 'outside-mainland-china', temporaryDirectoryMode: 'same-user', environment: userEnvironment }, deps)
    expect(officialFirst.source).toBe('official')
    expect(calls).toEqual([official.url, asset])
  })

  it('refuses bytes reported from an unapproved address and accepts the same hop spelled differently', async () => {
    const body = installerBytes(6)
    const digest = createHash('sha256').update(body).digest('hex')
    const [mirror] = gitRuntimeDownloadSources('mainland-china', 'x64')
    const reporting = (reported: string) => vi.fn(async (url: string) => (
      url === mirror.url ? streamResponse(body, reported) : streamResponse(Buffer.alloc(0), url, 404)
    ))

    await expect(installGitRuntimeWith('x64', { networkRegion: 'mainland-china', temporaryDirectoryMode: 'same-user', environment: userEnvironment }, dependencies({
      fetch: reporting('https://evil.example/Git.exe') as unknown as typeof globalThis.fetch,
      expectedSha256: () => digest,
    }))).rejects.toThrow(/^Git 没装上。国内镜像：Git 安装包下载跳转到了未经批准的地址；Git 官方源：HTTP 404$/)

    const spelled = mirror.url.replace('https://npmmirror.com/', 'HTTPS://NPMMIRROR.COM:443/')
    await expect(installGitRuntimeWith('x64', { networkRegion: 'mainland-china', temporaryDirectoryMode: 'same-user', environment: userEnvironment }, dependencies({
      fetch: reporting(spelled) as unknown as typeof globalThis.fetch,
      expectedSha256: () => digest,
    }))).resolves.toMatchObject({ source: 'npmmirror' })
  })
  it('reports the version found after install instead of trusting the installer exit code', async () => {
    const body = installerBytes(4)
    const digest = createHash('sha256').update(body).digest('hex')
    const deps = dependencies({
      fetch: vi.fn(async (url: string) => streamResponse(body, url)) as unknown as typeof globalThis.fetch,
      expectedSha256: () => digest,
    })
    const verifyInstalled = vi.fn(async () => ({ version: '2.55.0' }))
    const events: GitRuntimeInstallProgress[] = []

    const result = await installGitRuntimeWith('x64', {
      networkRegion: 'unknown',
      temporaryDirectoryMode: 'same-user',
      environment: userEnvironment,
      verifyInstalled,
      onProgress: (event) => events.push(event),
    }, deps)

    expect(verifyInstalled).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ installed: true, action: 'installed', version: '2.55.0' })
    const phases = events.map((event) => event.phase)
    expect(phases.lastIndexOf('verifying')).toBeGreaterThan(phases.indexOf('installing'))
    expect(phases.at(-1)).toBe('complete')
  })

  it('fails in plain words when the installer exits 0 but Git still cannot be found', async () => {
    const body = installerBytes(5)
    const digest = createHash('sha256').update(body).digest('hex')
    const fetch = vi.fn(async (url: string) => streamResponse(body, url))
    const deps = dependencies({ fetch: fetch as unknown as typeof globalThis.fetch, expectedSha256: () => digest })
    const events: GitRuntimeInstallProgress[] = []

    await expect(installGitRuntimeWith('x64', {
      networkRegion: 'unknown',
      temporaryDirectoryMode: 'same-user',
      environment: userEnvironment,
      verifyInstalled: async () => null,
      onProgress: (event) => events.push(event),
    }, deps)).rejects.toThrow(gitRuntimeMissingAfterInstallMessage)

    // 再换一个源重下重装也一样被拦，所以只装一次。
    expect(deps.plans).toHaveLength(1)
    expect(events.some((event) => event.phase === 'complete')).toBe(false)
    expect(events.at(-1)).toMatchObject({ phase: 'error', message: gitRuntimeMissingAfterInstallMessage })
    expect(gitRuntimeMissingAfterInstallMessage).not.toMatch(/PowerShell|bash|PATH|环境变量/)
  })

  it('treats a failing recheck the same as Git not being found', async () => {
    const body = installerBytes(6)
    const digest = createHash('sha256').update(body).digest('hex')
    const deps = dependencies({
      fetch: vi.fn(async (url: string) => streamResponse(body, url)) as unknown as typeof globalThis.fetch,
      expectedSha256: () => digest,
    })

    await expect(installGitRuntimeWith('x64', {
      networkRegion: 'unknown',
      temporaryDirectoryMode: 'same-user',
      environment: userEnvironment,
      verifyInstalled: async () => { throw new Error('probe crashed') },
    }, deps)).rejects.toThrow(gitRuntimeMissingAfterInstallMessage)
  })
})
