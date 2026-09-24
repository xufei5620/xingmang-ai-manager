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
})
