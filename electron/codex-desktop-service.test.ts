import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MacosCodexAppInspection } from './macos-codex-app'
import { scanPowerShell, unbalancedBracket } from './powershell-script-scan.test-support'
import { windowsPowerShellExecutable } from './windows-elevation'
import { AppSettingsStore } from './app-settings'
import { InstallationQueue } from './installation-queue'
import { CommandRunnerError } from './command-runner'
import type { NativeConfigInspection } from './config-files'
import {
  buildCodexDesktopDarwinStatus,
  createCodexDesktopService,
  buildCodexDesktopLaunchPlan,
  buildCodexDesktopManifestSources,
  buildCodexDesktopPreviousManifestSources,
  buildCodexDesktopPackageSources,
  buildCodexDesktopCombinedProbeFailure,
  buildCodexDesktopCombinedProbeScript,
  buildCodexDesktopPackageInspectionScript,
  buildCodexDesktopPackageProbeScript,
  buildCodexDesktopProcessProbeScript,
  buildCodexDesktopWorkspaceLaunchPlan,
  buildCodexDesktopWorkspaceUrl,
  buildCodexDesktopWindowsProbes,
  buildDesktopUpdateStatus,
  canAttemptCodexDesktopFirstInstallFallback,
  describeCodexDesktopLaunchFailure,
  buildCodexDesktopStoreInstallCommand,
  describeCodexDesktopDownloadAttempt,
  describeCodexDesktopStoreFailure,
  parseCodexDesktopStoreProgress,
  shouldTryCodexDesktopStoreUpdate,
  describeCodexDesktopPrimaryMirrorSkip,
  desktopMirrorUpdateAvailable,
  downloadCodexDesktopPackage,
  downloadCodexDesktopPackageFromCandidates,
  fetchCodexDesktopManifestCandidate,
  fetchCodexDesktopMirrorRelease,
  fetchCodexDesktopPreviousManifestCandidates,
  inspectCodexDesktopPackageFile,
  parseCodexDesktopCombinedProbeJson,
  parseCodexDesktopWindowsLaunchContext,
  validateCodexDesktopResourceUrl,
  type CodexDesktopManifestCandidate,
  type CodexDesktopServiceOptions,
  type CodexDesktopWindowsProbes,
} from './codex-desktop-service'

// Windows CI 上六个作业共用一台机器，Defender 在场时 PowerShell 冷启一次可以
// 超过一分钟；起作用的是 execFile 这一层的预算，不是 vitest 的用例超时。
const powerShellStartupTimeoutMs = Number(process.env.XINGMANG_POWERSHELL_TEST_TIMEOUT_MS ?? 90_000)

const temporaryDirectories: string[] = []

function testMirrorManifest(
  version = '26.721.4979.0',
  contentLength = 744072561,
  sha256Base64 = '0a/lZGhbNAxLAd6xFNfKeRJZzzJzNErA1E5IYWnqHjM=',
) {
  return {
    schemaVersion: 5,
    sources: {
      windows: {
        updateManifest: {
          buildVersion: version,
          storeProductId: '9PLM9XGG6VKS',
          packageIdentity: 'OpenAI.Codex',
        },
        architectures: {
          x64: {
            architecture: 'x64',
            status: 'downloadable',
            downloadable: true,
            version,
            contentLength,
            catalog: {
              packageFullName: `OpenAI.Codex_${version}_x64__2p2nqsd0c76g0`,
              hashAlgorithm: 'SHA256',
              hash: sha256Base64,
              contentLength,
            },
          },
        },
      },
    },
  }
}

function testMirrorCandidate(
  label: string,
  packageUrl: string,
  contentLength: number,
  sha256Base64: string,
): CodexDesktopManifestCandidate {
  const version = '26.721.4979.0'
  return {
    source: { kind: 'mirror', label, url: `${new URL(packageUrl).origin}/latest/manifest` },
    version,
    release: { version, architecture: 'x64', contentLength, sha256Base64 },
    packageSource: { label, url: packageUrl },
  }
}

describe('Codex Desktop AppModel launch diagnostics', () => {
  it('recognizes the built-in Administrator SID and numeric UAC values', () => {
    expect(parseCodexDesktopWindowsLaunchContext(
      '{"sid":"S-1-5-21-2548096332-2102100343-2330258446-500","uacEnabled":0,"filterAdministratorToken":0}\n',
    )).toEqual({
      userSid: 'S-1-5-21-2548096332-2102100343-2330258446-500',
      isBuiltInAdministrator: true,
      uacEnabled: false,
      filterAdministratorToken: false,
    })
  })

  it('degrades malformed PowerShell output without exposing arbitrary text', () => {
    expect(parseCodexDesktopWindowsLaunchContext('warning\nnot-json\n')).toEqual({
      userSid: null,
      isBuiltInAdministrator: false,
      uacEnabled: null,
      filterAdministratorToken: null,
    })
  })

  it('gives built-in Administrator users actionable AppModel guidance', () => {
    const message = describeCodexDesktopLaunchFailure({
      userSid: 'S-1-5-21-1-2-3-500',
      isBuiltInAdministrator: true,
      uacEnabled: false,
      filterAdministratorToken: false,
    })
    expect(message).toContain('0xC0EA0001')
    expect(message).toContain('内置 Administrator')
    expect(message).toContain('wsreset.exe')
    expect(message).toContain('普通 Windows 账户')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Codex Desktop launch trust', () => {
  it('encodes a Windows workspace in the official Desktop deep link', () => {
    expect(buildCodexDesktopWorkspaceUrl('C:\\Users\\tester\\My Project')).toBe(
      'codex://threads/new?path=C%3A%5CUsers%5Ctester%5CMy+Project',
    )
    expect(() => buildCodexDesktopWorkspaceUrl('')).toThrow('工作目录无效')
    expect(() => buildCodexDesktopWorkspaceUrl('relative\\project')).toThrow('工作目录无效')
    expect(() => buildCodexDesktopWorkspaceUrl(`C:\\${'x'.repeat(32_767)}`)).toThrow('工作目录无效')
  })

  it.runIf(process.platform === 'win32')('keeps workspace launch on the trusted Explorer path', () => {
    const plan = buildCodexDesktopWorkspaceLaunchPlan(
      'OpenAI.Codex_123!App',
      'C:\\Users\\tester\\My Project',
      {
        ...process.env,
        PATH: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
      },
    )

    expect(path.win32.isAbsolute(plan.executable)).toBe(true)
    expect(plan.executable.toLowerCase()).toMatch(/\\windows\\explorer\.exe$/)
    expect(plan.args).toEqual(['codex://threads/new?path=C%3A%5CUsers%5Ctester%5CMy+Project'])
    expect(plan.env.PATH).not.toContain('C:\\Users\\tester')
  })

  it.runIf(process.platform === 'win32')('uses the canonical SystemRoot Explorer and drops user runtime injection variables', () => {
    const plan = buildCodexDesktopLaunchPlan(
      'OpenAI.Codex_123!App',
      {
        ...process.env,
        PATH: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
        DOTNET_STARTUP_HOOKS: 'C:\\Users\\tester\\payload.dll',
      },
    )

    expect(path.win32.isAbsolute(plan.executable)).toBe(true)
    expect(plan.executable.toLowerCase()).toMatch(/\\windows\\explorer\.exe$/)
    expect(plan.cwd.toLowerCase()).toBe(path.dirname(plan.executable).toLowerCase())
    expect(plan.cwd).not.toContain('C:\\Users\\tester')
    expect(plan.args).toEqual(['shell:AppsFolder\\OpenAI.Codex_123!App'])
    expect(plan.env.PATH).not.toContain('C:\\Users\\tester')
    expect(plan.env.DOTNET_STARTUP_HOOKS).toBeUndefined()
  })
})

describe('Codex Desktop update state', () => {
  it('allows historical fallback only when every local install probe is empty', () => {
    expect(canAttemptCodexDesktopFirstInstallFallback(null, null, [])).toBe(true)
    expect(canAttemptCodexDesktopFirstInstallFallback(null, { name: 'Codex', appId: 'OpenAI.Codex!App' }, [])).toBe(false)
    expect(canAttemptCodexDesktopFirstInstallFallback(
      null,
      { name: '残留入口', appId: 'OpenAI.Codex_2p2nqsd0c76g0!App' },
      [],
      true,
    )).toBe(true)
    expect(canAttemptCodexDesktopFirstInstallFallback(null, null, [{
      processId: 1,
      parentProcessId: 0,
      name: 'Codex.exe',
      executablePath: 'C:\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__abc\\Codex.exe',
    }])).toBe(false)
    expect(canAttemptCodexDesktopFirstInstallFallback({
      name: 'OpenAI.Codex',
      version: '1.0.0.0',
      packageFullName: 'OpenAI.Codex_1.0.0.0_x64__abc',
      packageFamilyName: 'OpenAI.Codex_abc',
      installLocation: 'C:\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__abc',
    }, null, [])).toBe(false)
  })

  it('only enables the domestic mirror when its package is newer', () => {
    expect(desktopMirrorUpdateAvailable(null, '26.721.3996.0')).toBe(true)
    expect(desktopMirrorUpdateAvailable('26.715.8383.0', '26.721.3996.0')).toBe(true)
    expect(desktopMirrorUpdateAvailable('26.721.3996.0', '26.721.3996.0')).toBe(false)
    expect(desktopMirrorUpdateAvailable('26.721.4979.0', '26.721.3996.0')).toBe(false)
    expect(desktopMirrorUpdateAvailable('invalid', '26.721.3996.0')).toBeNull()
    expect(desktopMirrorUpdateAvailable('26.721.3996.0', null)).toBeNull()
  })

  it('uses the fixed AgentsMirror package and manifest endpoints', () => {
    expect(buildCodexDesktopPackageSources('x64')).toEqual([
      {
        label: '国内镜像',
        url: 'https://codexapp.agentsmirror.com/latest/win-x64',
      },
      {
        label: '镜像备用源',
        url: 'https://codexapp-r2.agentsmirror.com/latest/win-x64',
      },
    ])
    expect(buildCodexDesktopPackageSources('arm64')).toEqual([
      {
        label: '国内镜像',
        url: 'https://codexapp.agentsmirror.com/latest/win-arm64',
      },
      {
        label: '镜像备用源',
        url: 'https://codexapp-r2.agentsmirror.com/latest/win-arm64',
      },
    ])
    expect(buildCodexDesktopManifestSources()).toEqual([
      {
        kind: 'mirror',
        label: '国内镜像',
        url: 'https://codexapp.agentsmirror.com/latest/manifest',
      },
      {
        kind: 'mirror',
        label: '镜像备用源',
        url: 'https://codexapp-r2.agentsmirror.com/latest/manifest',
      },
      {
        kind: 'official',
        label: 'OpenAI 官方源',
        url: 'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json',
      },
    ])
  })

  it('keeps both mirror routes and the official manifest endpoint', () => {
    expect([...buildCodexDesktopManifestSources()].map((source) => source.url).sort()).toEqual([
      'https://codexapp-r2.agentsmirror.com/latest/manifest',
      'https://codexapp.agentsmirror.com/latest/manifest',
      'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json',
    ])
    expect(buildCodexDesktopManifestSources().map((source) => source.kind).sort())
      .toEqual(['mirror', 'mirror', 'official'])
  })

  it('keeps the historical manifest routes out of the normal status sources', () => {
    expect(buildCodexDesktopPreviousManifestSources()).toEqual([
      {
        kind: 'mirror-previous',
        label: '国内镜像上一版本',
        url: 'https://codexapp.agentsmirror.com/previous/manifest',
      },
      {
        kind: 'mirror-previous',
        label: '镜像备用源上一版本',
        url: 'https://codexapp-r2.agentsmirror.com/previous/manifest',
      },
    ])
    expect(buildCodexDesktopManifestSources().some((source) => source.kind === 'mirror-previous')).toBe(false)
  })

  it('selects the newer R2 release when the domestic route returns a stale valid manifest', async () => {
    const mirrorManifest = (version: string) => ({
      schemaVersion: 5,
      sources: {
        windows: {
          updateManifest: {
            buildVersion: version,
            storeProductId: '9PLM9XGG6VKS',
            packageIdentity: 'OpenAI.Codex',
          },
          architectures: {
            x64: {
              architecture: 'x64',
              status: 'downloadable',
              downloadable: true,
              version,
              contentLength: 744072561,
              catalog: {
                packageFullName: `OpenAI.Codex_${version}_x64__2p2nqsd0c76g0`,
                hashAlgorithm: 'SHA256',
                hash: '0a/lZGhbNAxLAd6xFNfKeRJZzzJzNErA1E5IYWnqHjM=',
                contentLength: 744072561,
              },
            },
          },
        },
      },
    })
    const storageUrl = [
      'https://fgws3-ocloud.ihep.ac.cn/20830-codex/latest/manifest',
      'X-Amz-Algorithm=AWS4-HMAC-SHA256',
      'X-Amz-Credential=NGhKOR9f3faa01GTyDTX%2F20260802%2Fauto%2Fs3%2Faws4_request',
      'X-Amz-Date=20260802T033923Z',
      'X-Amz-Expires=3600',
      'X-Amz-SignedHeaders=host',
      'response-content-disposition=attachment%3B%20filename%3D%22release-manifest.json%22',
      'response-content-type=application%2Fjson',
      `X-Amz-Signature=${'a'.repeat(64)}`,
    ].join('&').replace('&X-Amz-Algorithm', '?X-Amz-Algorithm')
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: storageUrl },
    })
    Object.defineProperty(redirect, 'url', {
      value: 'https://codexapp.agentsmirror.com/latest/manifest',
    })
    const staleResponse = new Response(JSON.stringify(mirrorManifest('26.721.3996.0')), {
      headers: { 'Content-Type': 'application/json' },
    })
    Object.defineProperty(staleResponse, 'url', {
      value: storageUrl,
    })
    const fallbackUrl = 'https://codexapp-r2.agentsmirror.com/latest/manifest'
    const currentResponse = new Response(JSON.stringify(mirrorManifest('26.721.4979.0')), {
      headers: { 'Content-Type': 'application/json' },
    })
    Object.defineProperty(currentResponse, 'url', { value: fallbackUrl })
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const url = String(value)
      if (url === 'https://codexapp.agentsmirror.com/latest/manifest') return redirect
      if (url === storageUrl) return staleResponse
      if (url === fallbackUrl) return currentResponse
      throw new Error(`unexpected URL ${url}`)
    })

    await expect(fetchCodexDesktopMirrorRelease('x64', fetchMock)).resolves.toEqual({
      version: '26.721.4979.0',
      architecture: 'x64',
      contentLength: 744072561,
      sha256Base64: '0a/lZGhbNAxLAd6xFNfKeRJZzzJzNErA1E5IYWnqHjM=',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://codexapp.agentsmirror.com/latest/manifest',
      expect.objectContaining({ redirect: 'manual' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      fallbackUrl,
      expect.objectContaining({ redirect: 'manual' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      storageUrl,
      expect.objectContaining({ redirect: 'manual' }),
    )
  })

  it('retries mirror manifests when both routes return a transient invalid response', async () => {
    const attempts = new Map<string, number>()
    const fetchMock = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = String(value)
      const parsed = new URL(url)
      const sourceUrl = `${parsed.origin}${parsed.pathname}`
      const count = (attempts.get(sourceUrl) ?? 0) + 1
      attempts.set(sourceUrl, count)
      const response = count === 1
        ? new Response('{"schemaVersion":5}', { headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify(testMirrorManifest()), { headers: { 'Content-Type': 'application/json' } })
      Object.defineProperty(response, 'url', { value: url })
      if (count === 2) {
        expect(init?.headers).toMatchObject({
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
        })
        expect(parsed.searchParams.get('xm_refresh')).toMatch(/^\d+-1$/)
      }
      return response
    })

    await expect(fetchCodexDesktopMirrorRelease('x64', fetchMock)).resolves.toMatchObject({
      version: '26.721.4979.0',
      architecture: 'x64',
    })
    expect([...attempts.values()]).toEqual([2, 2])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('accepts only the bounded mirror-manifest refresh query', () => {
    const base = 'https://codexapp.agentsmirror.com/latest/manifest'
    const refreshed = `${base}?xm_refresh=1788088800000-1`

    expect(validateCodexDesktopResourceUrl(refreshed, refreshed).href).toBe(refreshed)
    expect(() => validateCodexDesktopResourceUrl(`${base}?other=value`, `${base}?other=value`))
      .toThrow('不受信任的查询参数')
    expect(() => validateCodexDesktopResourceUrl(
      'https://codexapp.agentsmirror.com/latest/win-x64?xm_refresh=1788088800000-1',
      'https://codexapp.agentsmirror.com/latest/win-x64?xm_refresh=1788088800000-1',
    )).toThrow('不受信任的查询参数')
  })

  it('accepts the fixed historical package route and rejects route escapes', () => {
    const previous = 'https://codexapp.agentsmirror.com/previous/win-x64'
    expect(validateCodexDesktopResourceUrl(previous, previous).href).toBe(previous)
    expect(() => validateCodexDesktopResourceUrl(
      'https://codexapp.agentsmirror.com/latest/win-x64',
      previous,
    )).toThrow('不受信任的重定向')
    expect(() => validateCodexDesktopResourceUrl(
      'https://codexapp.agentsmirror.com/previous/win-x64?version=old',
      previous,
    )).toThrow('不受信任的重定向')
  })

  it('parses historical mirror candidates using the same package metadata checks', async () => {
    const previousManifestUrl = 'https://codexapp.agentsmirror.com/previous/manifest'
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const url = String(value)
      if (url === previousManifestUrl || url.startsWith(`${previousManifestUrl}?xm_refresh=`)) {
        const response = new Response(JSON.stringify(testMirrorManifest('26.721.4979.0')), {
          headers: { 'Content-Type': 'application/json' },
        })
        Object.defineProperty(response, 'url', { value: url })
        return response
      }
      if (url === 'https://codexapp-r2.agentsmirror.com/previous/manifest'
        || url.startsWith('https://codexapp-r2.agentsmirror.com/previous/manifest?xm_refresh=')) {
        throw new Error('备用历史源不可用')
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const result = await fetchCodexDesktopPreviousManifestCandidates('x64', fetchMock)
    expect(result.errors).toEqual(['镜像备用源上一版本：备用历史源不可用'])
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].packageSource).toEqual({
      label: '国内镜像上一版本',
      url: 'https://codexapp.agentsmirror.com/previous/win-x64',
    })
  })

  it('reports one final error per mirror after retry recovery is exhausted', async () => {
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const response = new Response('{"schemaVersion":5}', {
        headers: { 'Content-Type': 'application/json' },
      })
      Object.defineProperty(response, 'url', { value: String(value) })
      return response
    })

    await expect(fetchCodexDesktopMirrorRelease('x64', fetchMock)).rejects.toThrow(
      '国内镜像：schema、产品 ID、包身份、版本、架构、文件大小或 SHA-256 校验失败；镜像备用源：schema、产品 ID、包身份、版本、架构、文件大小或 SHA-256 校验失败',
    )
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('binds a primary manifest redirected to R2 to the R2 package route', async () => {
    const primaryManifestUrl = 'https://codexapp.agentsmirror.com/latest/manifest'
    const fallbackManifestUrl = 'https://codexapp-r2.agentsmirror.com/latest/manifest'
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: fallbackManifestUrl },
    })
    Object.defineProperty(redirect, 'url', { value: primaryManifestUrl })
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const url = String(value)
      if (url === primaryManifestUrl) return redirect
      if (url === fallbackManifestUrl) {
        const response = new Response(JSON.stringify(testMirrorManifest()), {
          headers: { 'Content-Type': 'application/json' },
        })
        Object.defineProperty(response, 'url', { value: fallbackManifestUrl })
        return response
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const candidate = await fetchCodexDesktopManifestCandidate(
      { kind: 'mirror', label: '国内镜像', url: primaryManifestUrl },
      'x64',
      fetchMock,
    )

    expect(candidate.packageSource).toEqual({
      label: '镜像备用源',
      url: 'https://codexapp-r2.agentsmirror.com/latest/win-x64',
    })
  })

  it('keeps a signed object-storage manifest bound to its originating package route', async () => {
    const primaryManifestUrl = 'https://codexapp.agentsmirror.com/latest/manifest'
    const storageUrl = [
      'https://fgws3-ocloud.ihep.ac.cn/20830-codex/latest/manifest',
      'X-Amz-Algorithm=AWS4-HMAC-SHA256',
      'X-Amz-Credential=NGhKOR9f3faa01GTyDTX%2F20260802%2Fauto%2Fs3%2Faws4_request',
      'X-Amz-Date=20260802T033923Z',
      'X-Amz-Expires=3600',
      'X-Amz-SignedHeaders=host',
      'response-content-disposition=attachment%3B%20filename%3D%22release-manifest.json%22',
      'response-content-type=application%2Fjson',
      `X-Amz-Signature=${'c'.repeat(64)}`,
    ].join('&').replace('&X-Amz-Algorithm', '?X-Amz-Algorithm')
    const redirect = new Response(null, { status: 302, headers: { Location: storageUrl } })
    Object.defineProperty(redirect, 'url', { value: primaryManifestUrl })
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const url = String(value)
      if (url === primaryManifestUrl) return redirect
      if (url === storageUrl) {
        const response = new Response(JSON.stringify(testMirrorManifest()), {
          headers: { 'Content-Type': 'application/json' },
        })
        Object.defineProperty(response, 'url', { value: storageUrl })
        return response
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const candidate = await fetchCodexDesktopManifestCandidate(
      { kind: 'mirror', label: '国内镜像', url: primaryManifestUrl },
      'x64',
      fetchMock,
    )

    expect(candidate.packageSource).toEqual({
      label: '国内镜像',
      url: 'https://codexapp.agentsmirror.com/latest/win-x64',
    })
  })

  it('accepts only the complete signed IHEP package redirect shape', () => {
    const original = 'https://codexapp.agentsmirror.com/latest/win-x64'
    const valid = [
      'https://fgws3-ocloud.ihep.ac.cn/20830-codex/latest/win-x64',
      'X-Amz-Algorithm=AWS4-HMAC-SHA256',
      'X-Amz-Credential=NGhKOR9f3faa01GTyDTX%2F20260802%2Fauto%2Fs3%2Faws4_request',
      'X-Amz-Date=20260802T034034Z',
      'X-Amz-Expires=3600',
      'X-Amz-SignedHeaders=host',
      'response-content-disposition=attachment%3B%20filename%3D%22Codex-Windows-x64.msix%22',
      'response-content-type=application%2Fvnd.ms-appx',
      `X-Amz-Signature=${'b'.repeat(64)}`,
    ].join('&').replace('&X-Amz-Algorithm', '?X-Amz-Algorithm')

    expect(validateCodexDesktopResourceUrl(valid, original).href).toBe(valid)
    expect(() => validateCodexDesktopResourceUrl(
      valid.replace(/&X-Amz-Signature=[a-f0-9]{64}$/i, ''),
      original,
    )).toThrow('不受信任的重定向')
    expect(() => validateCodexDesktopResourceUrl(
      valid.replace('/20830-codex/latest/', '/other-bucket/latest/'),
      original,
    )).toThrow('不受信任的重定向')
  })

  it('rejects an untrusted package redirect before writing a file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-msix-redirect-'))
    temporaryDirectories.push(directory)
    const destination = path.join(directory, 'Codex.msix')
    const response = new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.example/Codex.msix' },
    })
    Object.defineProperty(response, 'url', {
      value: 'https://codexapp.agentsmirror.com/latest/win-x64',
    })
    const fetchMock = vi.fn().mockResolvedValue(response)

    await expect(downloadCodexDesktopPackage(
      { label: '国内镜像', url: 'https://codexapp.agentsmirror.com/latest/win-x64' },
      destination,
      () => undefined,
      fetchMock,
    )).rejects.toThrow('不受信任的重定向')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('streams an MSIX response to disk and reports bounded progress', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-msix-download-'))
    temporaryDirectories.push(directory)
    const destination = path.join(directory, 'Codex.msix')
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x41)
    const response = new Response(bytes, {
      headers: {
        'Content-Type': 'application/vnd.ms-appx',
        'Content-Length': String(bytes.byteLength),
      },
    })
    Object.defineProperty(response, 'url', { value: 'https://mirror.example.cn/Codex.msix' })
    const fetchMock = vi.fn().mockResolvedValue(response)
    const progress: number[] = []

    const result = await downloadCodexDesktopPackage(
      { label: '测试镜像', url: 'https://mirror.example.cn/Codex.msix' },
      destination,
      (value) => progress.push(value.percent),
      fetchMock,
    )

    expect(fs.statSync(destination).size).toBe(bytes.byteLength)
    expect(result).toEqual({
      transferred: bytes.byteLength,
      total: bytes.byteLength,
      sha256Base64: createHash('sha256').update(bytes).digest('base64'),
    })
    expect(progress.at(-1)).toBe(100)
    expect(progress.every((value) => value >= 0 && value <= 100)).toBe(true)
  })

  it('rejects a package whose Content-Length differs from the mirror manifest', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-msix-download-'))
    temporaryDirectories.push(directory)
    const destination = path.join(directory, 'Codex.msix')
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x41)
    const response = new Response(bytes, {
      headers: {
        'Content-Type': 'application/vnd.ms-appx',
        'Content-Length': String(bytes.byteLength),
      },
    })
    Object.defineProperty(response, 'url', { value: 'https://mirror.example.cn/Codex.msix' })

    await expect(downloadCodexDesktopPackage({
      label: '测试镜像',
      url: 'https://mirror.example.cn/Codex.msix',
      expectedContentLength: bytes.byteLength + 1,
    }, destination, () => undefined, vi.fn().mockResolvedValue(response)))
      .rejects.toThrow('Content-Length 与镜像清单不一致')
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('rejects and removes a package whose SHA-256 differs from the mirror manifest', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-msix-download-'))
    temporaryDirectories.push(directory)
    const destination = path.join(directory, 'Codex.msix')
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x41)
    const response = new Response(bytes, {
      headers: {
        'Content-Type': 'application/vnd.ms-appx',
        'Content-Length': String(bytes.byteLength),
      },
    })
    Object.defineProperty(response, 'url', { value: 'https://mirror.example.cn/Codex.msix' })

    await expect(downloadCodexDesktopPackage({
      label: '测试镜像',
      url: 'https://mirror.example.cn/Codex.msix',
      expectedContentLength: bytes.byteLength,
      expectedSha256Base64: Buffer.alloc(32).toString('base64'),
    }, destination, () => undefined, vi.fn().mockResolvedValue(response)))
      .rejects.toThrow('SHA-256 与镜像清单不一致')
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('switches to the next manifest-bound source after a Content-Length mismatch', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-msix-fallback-'))
    temporaryDirectories.push(directory)
    const destination = path.join(directory, 'Codex.msix')
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x42)
    const hash = createHash('sha256').update(bytes).digest('base64')
    const firstUrl = 'https://mirror-one.example/latest/win-x64'
    const secondUrl = 'https://mirror-two.example/latest/win-x64'
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const url = String(value)
      const response = new Response(bytes, {
        headers: {
          'Content-Type': 'application/vnd.ms-appx',
          'Content-Length': String(url === firstUrl ? bytes.byteLength + 1 : bytes.byteLength),
        },
      })
      Object.defineProperty(response, 'url', { value: url })
      return response
    })
    const attempts: string[] = []

    const result = await downloadCodexDesktopPackageFromCandidates([
      testMirrorCandidate('主测试源', firstUrl, bytes.byteLength, hash),
      testMirrorCandidate('备用测试源', secondUrl, bytes.byteLength, hash),
    ], destination, {
      fetchImplementation: fetchMock,
      onAttempt: (candidate) => attempts.push(candidate.packageSource?.label ?? ''),
    })

    expect(result.candidate.packageSource?.url).toBe(secondUrl)
    expect(attempts).toEqual(['主测试源', '备用测试源'])
    expect(fs.statSync(destination).size).toBe(bytes.byteLength)
  })

  it('switches sources after SHA-256 rejection and removes the rejected package', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-msix-fallback-'))
    temporaryDirectories.push(directory)
    const destination = path.join(directory, 'Codex.msix')
    const rejectedBytes = Buffer.alloc(10 * 1024 * 1024, 0x43)
    const acceptedBytes = Buffer.alloc(10 * 1024 * 1024, 0x44)
    const expectedHash = createHash('sha256').update(acceptedBytes).digest('base64')
    const firstUrl = 'https://mirror-one.example/latest/win-x64'
    const secondUrl = 'https://mirror-two.example/latest/win-x64'
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const url = String(value)
      const bytes = url === firstUrl ? rejectedBytes : acceptedBytes
      const response = new Response(bytes, {
        headers: {
          'Content-Type': 'application/vnd.ms-appx',
          'Content-Length': String(bytes.byteLength),
        },
      })
      Object.defineProperty(response, 'url', { value: url })
      return response
    })

    const result = await downloadCodexDesktopPackageFromCandidates([
      testMirrorCandidate('主测试源', firstUrl, acceptedBytes.byteLength, expectedHash),
      testMirrorCandidate('备用测试源', secondUrl, acceptedBytes.byteLength, expectedHash),
    ], destination, { fetchImplementation: fetchMock })

    expect(result.candidate.packageSource?.url).toBe(secondUrl)
    expect(createHash('sha256').update(fs.readFileSync(destination)).digest('base64')).toBe(expectedHash)
  })

  it('leaves no MSIX when every manifest-bound source fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-msix-fallback-'))
    temporaryDirectories.push(directory)
    const destination = path.join(directory, 'Codex.msix')
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x45)
    const expectedHash = Buffer.alloc(32).toString('base64')
    const candidates = [
      testMirrorCandidate('主测试源', 'https://mirror-one.example/latest/win-x64', bytes.byteLength, expectedHash),
      testMirrorCandidate('备用测试源', 'https://mirror-two.example/latest/win-x64', bytes.byteLength, expectedHash),
    ]
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const url = String(value)
      const response = new Response(bytes, {
        headers: {
          'Content-Type': 'application/vnd.ms-appx',
          'Content-Length': String(bytes.byteLength),
        },
      })
      Object.defineProperty(response, 'url', { value: url })
      return response
    })

    await expect(downloadCodexDesktopPackageFromCandidates(
      candidates,
      destination,
      { fetchImplementation: fetchMock },
    )).rejects.toThrow('所有国内镜像均未通过完整校验')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('rejects an HTML mirror response and leaves no partial package', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-msix-download-'))
    temporaryDirectories.push(directory)
    const destination = path.join(directory, 'Codex.msix')
    const response = new Response('<html>site fallback</html>', {
      headers: {
        'Content-Type': 'text/html',
        'Content-Length': '26',
      },
    })
    Object.defineProperty(response, 'url', { value: 'https://mirror.example.cn/Codex.msix' })

    await expect(downloadCodexDesktopPackage(
      { label: '测试镜像', url: 'https://mirror.example.cn/Codex.msix' },
      destination,
      () => undefined,
      vi.fn().mockResolvedValue(response),
    )).rejects.toThrow('返回的不是 MSIX 文件')
    expect(fs.existsSync(destination)).toBe(false)
  })

  // These two used to build a real MSIX with Compress-Archive and hand it to a real
  // powershell.exe, two cold starts per test; on a busy windows-latest runner the inspection
  // was killed at its own 90-second budget (run 35809812859). What they checked is what this
  // module hands PowerShell, what the script does before it touches the manifest, and what
  // comes back, so each of those is checked directly on every platform.
  it('hands PowerShell the package path only as quoted data and reads the metadata it prints', async () => {
    const hostilePath = "D:\\下载缓存\\O'Brien; $(Write-Output XINGMANG_TEST_INJECTION) & Codex.msix"
    const calls: Array<{ executable: string; argv: string[]; options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number } }> = []
    const previousNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--require C:\\Users\\Public\\hook.js'
    let metadata: Awaited<ReturnType<typeof inspectCodexDesktopPackageFile>>
    try {
      metadata = await inspectCodexDesktopPackageFile(hostilePath, {
        resolvePowerShell: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        run: async (executable, argv, options) => {
          calls.push({ executable, argv, options })
          return '{"name":"OpenAI.Codex","version":"26.721.3996.0","architecture":"x64","publisher":"CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B","hasSignature":true}\r\n'
        },
      })
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previousNodeOptions
    }
    expect(metadata).toEqual({
      name: 'OpenAI.Codex',
      version: '26.721.3996.0',
      architecture: 'x64',
      publisher: 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B',
      hasSignature: true,
    })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(call.argv).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', buildCodexDesktopPackageInspectionScript(hostilePath)])
    expect(call.options.env.NODE_OPTIONS).toBeUndefined()
    expect(call.options.timeoutMs).toBe(90_000)
    expect(call.options.maxOutputBytes).toBe(1024 * 1024)

    const scan = scanPowerShell(call.argv[4])
    expect(scan.unterminated).toBe(false)
    expect(unbalancedBracket(scan.code)).toBeNull()
    expect(scan.literals).toContain(hostilePath)
    expect(scan.code).not.toContain('XINGMANG_TEST_INJECTION')
    for (const body of scan.expandable) expect(body).not.toContain('XINGMANG_TEST_INJECTION')
  })

  it('checks the manifest size before decompressing it and parses it without DTDs or resolvers', () => {
    const scan = scanPowerShell(buildCodexDesktopPackageInspectionScript('C:\\Temp\\Codex.msix'))
    expect(scan.code).toContain('$archive = [System.IO.Compression.ZipFile]::OpenRead(\'\')')
    expect(scan.literals).toEqual(expect.arrayContaining(['C:\\Temp\\Codex.msix', 'AppxManifest.xml', 'AppxSignature.p7x']))
    expect(scan.code).toContain("$_.FullName -ieq ''")
    const sizeCheck = scan.code.indexOf('$manifestEntry.Length -gt 1048576')
    const open = scan.code.indexOf('$manifestEntry.Open()')
    const reader = scan.code.indexOf('[System.Xml.XmlReader]::Create($stream, $settings)')
    expect(sizeCheck).toBeGreaterThan(0)
    expect(sizeCheck).toBeLessThan(open)
    expect(scan.code.slice(scan.code.indexOf('$manifestEntry.Length -le 0'), open)).toContain("throw ''")
    for (const setting of [
      '$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit',
      '$settings.XmlResolver = $null',
      '$settings.MaxCharactersInDocument = 1048576',
    ]) {
      const at = scan.code.indexOf(setting)
      expect(at).toBeGreaterThan(open)
      expect(at).toBeLessThan(reader)
    }
    expect(scan.code).toContain('$manifest.XmlResolver = $null')
    expect(scan.literals).toContain('AppxManifest.xml 大小无效或超过 1 MiB 安全上限')
    expect(scan.code).toContain('hasSignature = ($null -ne $signatureEntry)')
    expect(scan.code).toContain('ConvertTo-Json -Compress')
  })

  it('reports an unreadable answer as unreadable and passes a refusal through untouched', async () => {
    const resolvePowerShell = () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    await expect(inspectCodexDesktopPackageFile('C:\\Temp\\Codex.msix', { resolvePowerShell, run: async () => 'not json' }))
      .rejects.toThrow('无法读取 Codex Desktop 安装包元数据')
    await expect(inspectCodexDesktopPackageFile('C:\\Temp\\Codex.msix', {
      resolvePowerShell,
      run: async () => { throw new Error('AppxManifest.xml 大小无效或超过 1 MiB 安全上限') },
    })).rejects.toThrow('1 MiB 安全上限')
  })
})

describe('Codex Desktop mirror fallback disclosure', () => {
  it('keeps the primary mirror download message unchanged', () => {
    expect(describeCodexDesktopPrimaryMirrorSkip(
      { label: '国内镜像', url: 'https://codexapp.agentsmirror.com/latest/win-x64' },
      ['镜像备用源：查询超时'],
    )).toBeNull()
  })

  it('explains why the primary mirror was skipped before the fallback download', () => {
    expect(describeCodexDesktopPrimaryMirrorSkip(
      { label: '镜像备用源', url: 'https://codexapp-r2.agentsmirror.com/latest/win-x64' },
      ['国内镜像：查询超时'],
    )).toBe('国内镜像本次不可用（查询超时）')
  })

  it('stays silent when the fallback simply published a newer build', () => {
    expect(describeCodexDesktopPrimaryMirrorSkip(
      { label: '镜像备用源', url: 'https://codexapp-r2.agentsmirror.com/latest/win-x64' },
      ['OpenAI 官方源：返回 HTTP 503'],
    )).toBeNull()
  })

  it('words each download attempt so the reason can stay on screen for the whole download', () => {
    const fallback = { label: '镜像备用源', url: 'https://codexapp-r2.agentsmirror.com/latest/win-x64' }
    expect(describeCodexDesktopDownloadAttempt(fallback, 0, null, ['国内镜像：查询超时']))
      .toBe('国内镜像本次不可用（查询超时），正在从镜像备用源下载')
    expect(describeCodexDesktopDownloadAttempt(fallback, 0, null, []))
      .toBe('正在从镜像备用源下载')
    expect(describeCodexDesktopDownloadAttempt(fallback, 1, '国内镜像（26.917.9434.0）：SHA-256 不一致', ['国内镜像：查询超时']))
      .toBe('前一路镜像未通过校验，已改从镜像备用源下载')
  })

  it('keeps the Microsoft Store failure in front of every mirror attempt', () => {
    const primary = { label: '国内镜像', url: 'https://codexapp.agentsmirror.com/latest/win-x64' }
    expect(describeCodexDesktopDownloadAttempt(primary, 0, null, [], '连不上微软商店'))
      .toBe('微软商店这次没装上（连不上微软商店），正在从国内镜像下载')
  })

  it('reads the failure the historical probe actually produces', async () => {
    const fallbackManifestUrl = 'https://codexapp-r2.agentsmirror.com/previous/manifest'
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const url = String(value)
      if (url.startsWith(fallbackManifestUrl)) {
        const response = new Response(JSON.stringify(testMirrorManifest('26.721.4979.0')), {
          headers: { 'Content-Type': 'application/json' },
        })
        Object.defineProperty(response, 'url', { value: url })
        return response
      }
      throw new Error('连接被拒绝')
    })

    const result = await fetchCodexDesktopPreviousManifestCandidates('x64', fetchMock)
    const packageSource = result.candidates[0]?.packageSource
    expect(packageSource?.label).toBe('镜像备用源上一版本')
    expect(describeCodexDesktopPrimaryMirrorSkip(packageSource!, result.errors))
      .toBe('国内镜像本次不可用（连接被拒绝）')
  })

  it('refuses a service built without the proxy-aware download fetch', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-fetch-'))
    temporaryDirectories.push(directory)
    const { downloadFetch, ...withoutDownloadFetch } = {
      platform: 'linux' as const,
      installationQueue: new InstallationQueue(),
      createInstallTemporaryDirectory: async () => { throw new Error('未使用') },
      detectMacosCodexApp: async () => { throw new Error('未使用') },
      executeCommand: async () => { throw new Error('未使用') },
      codexEnv: {},
      store: new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      inspectNativeProviderConfig: () => relayCodexConfig(directory),
      spawnDetached: async () => { throw new Error('未使用') },
      downloadFetch: async () => { throw new Error('未使用') },
    } satisfies CodexDesktopServiceOptions
    expect(typeof downloadFetch).toBe('function')
    // 全局 fetch 不读系统代理，漏传就等于开着加速也走直连。这一行本该编译不过。
    // @ts-expect-error downloadFetch 是必填项
    const incomplete: CodexDesktopServiceOptions = withoutDownloadFetch
    expect(incomplete.platform).toBe('linux')
  })
})

describe('Codex Desktop update state', () => {
  it('reports the official newer Windows build as available', () => {
    expect(buildDesktopUpdateStatus('26.715.8383.0', {
      status: 'checked',
      version: '26.721.3996.0',
      source: 'official-manifest',
      checkedAt: '2026-07-24T00:00:00.000Z',
      error: null,
    })).toEqual({
      latestVersion: '26.721.3996.0',
      updateAvailable: true,
      updateSource: 'official-manifest',
      updateCheck: 'checked',
      updateState: 'available',
      updateCheckedAt: '2026-07-24T00:00:00.000Z',
      updateError: null,
    })
  })

  it('keeps manifest failures unknown instead of claiming latest', () => {
    expect(buildDesktopUpdateStatus('26.715.8383.0', {
      status: 'failed',
      version: null,
      source: 'official-manifest',
      checkedAt: '2026-07-24T00:00:00.000Z',
      error: '官方更新清单 schema 校验失败',
    })).toMatchObject({
      latestVersion: null,
      updateAvailable: null,
      updateCheck: 'failed',
      updateState: 'unknown',
      updateError: '官方更新清单 schema 校验失败',
    })
  })
})

describe('buildCodexDesktopWindowsProbes', () => {
  const match = { name: 'Codex', appId: 'OpenAI.Codex!App' }
  const processes = [{
    processId: 1,
    parentProcessId: 0,
    name: 'Codex.exe',
    executablePath: 'C:\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__abc\\Codex.exe',
  }]
  const packageProbe = { value: null, error: null }
  const mirrorProbe = { version: '1.0.0', checkedAt: '2026-08-08T00:00:00.000Z', error: null }

  it('keeps every probe result when all four branches resolve', () => {
    const result: CodexDesktopWindowsProbes = buildCodexDesktopWindowsProbes(
      { status: 'fulfilled', value: match },
      { status: 'fulfilled', value: processes },
      { status: 'fulfilled', value: packageProbe },
      { status: 'fulfilled', value: mirrorProbe },
    )
    expect(result).toEqual({
      match,
      processes,
      packageProbe,
      mirrorProbe,
      detectionFailed: false,
      detectionError: null,
    })
  })

  it('flags detectionFailed when an install-determining probe rejects', () => {
    const result = buildCodexDesktopWindowsProbes(
      { status: 'rejected', reason: new Error('Get-StartApps 超时') },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: packageProbe },
      { status: 'fulfilled', value: mirrorProbe },
    )
    expect(result.match).toBeNull()
    expect(result.detectionFailed).toBe(true)
    expect(result.detectionError).toBe('Get-StartApps 超时')
  })

  it('does not flag detectionFailed when only the mirror probe rejects', () => {
    // The mirror probe already surfaces its own failure through mirrorError;
    // it must not also blank out an otherwise confidently known install state.
    const result = buildCodexDesktopWindowsProbes(
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: packageProbe },
      { status: 'rejected', reason: new Error('镜像清单下载超时') },
      '2026-08-08T00:00:00.000Z',
    )
    expect(result.detectionFailed).toBe(false)
    expect(result.detectionError).toBeNull()
    expect(result.mirrorProbe).toEqual({
      version: null,
      checkedAt: '2026-08-08T00:00:00.000Z',
      error: '镜像清单下载超时',
    })
  })

  it('joins multiple install-detection failures into one message', () => {
    const result = buildCodexDesktopWindowsProbes(
      { status: 'rejected', reason: new Error('Get-StartApps 超时') },
      { status: 'fulfilled', value: [] },
      { status: 'rejected', reason: new Error('Get-AppxPackage 拒绝访问') },
      { status: 'fulfilled', value: mirrorProbe },
    )
    expect(result.detectionFailed).toBe(true)
    expect(result.detectionError).toBe('Get-StartApps 超时；Get-AppxPackage 拒绝访问')
    expect(result.packageProbe).toEqual({ value: null, error: 'Get-AppxPackage 拒绝访问' })
  })

  it('treats a fulfilled but inconclusive Appx probe as a detection failure', () => {
    const result = buildCodexDesktopWindowsProbes(
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: [] },
      {
        status: 'fulfilled',
        value: {
          value: null,
          error: '当前用户未检测到 Codex Desktop，系统拒绝读取其他用户的安装信息。',
          source: null,
          confirmedAbsent: false,
        },
      },
      { status: 'fulfilled', value: mirrorProbe },
    )

    expect(result.detectionFailed).toBe(true)
    expect(result.detectionError).toBe('当前用户未检测到 Codex Desktop，系统拒绝读取其他用户的安装信息。')
  })

  it('does not let an Appx permission warning hide independent process evidence', () => {
    const result = buildCodexDesktopWindowsProbes(
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: processes },
      {
        status: 'fulfilled',
        value: {
          value: null,
          error: '当前用户未检测到 Codex Desktop，系统拒绝读取其他用户的安装信息。',
          source: null,
          confirmedAbsent: false,
        },
      },
      { status: 'fulfilled', value: mirrorProbe },
    )

    expect(result.detectionFailed).toBe(false)
    expect(result.detectionError).toBeNull()
  })
})

describe('Codex Desktop Appx probe script', () => {
  it('uses only the current-user result so another account cannot block first install', () => {
    const script = buildCodexDesktopPackageProbeScript()
    const currentProbe = script.indexOf("Get-AppxPackage -Name 'OpenAI.Codex*'")

    expect(currentProbe).toBeGreaterThanOrEqual(0)
    expect(script).not.toContain("Get-AppxPackage -AllUsers -Name 'OpenAI.Codex*'")
    expect(script).toContain('$packages = $currentPackages')
    expect(script).toContain("$source = if ($currentPackages.Count -gt 0) { 'current-user' } else { $null }")
    expect(script).toContain('$currentProbeSucceeded = $null -eq $currentError')
    expect(script).toContain('$confirmedAbsent = $currentProbeSucceeded -and $currentPackages.Count -eq 0')
  })

  it('recovers a packaged process path from its command line when WMI omits ExecutablePath', () => {
    const script = buildCodexDesktopProcessProbeScript()
    expect(script).toContain('$_.CommandLine')
    expect(script).toContain("@('ChatGPT.exe', 'Codex.exe')")
    expect(script).toContain('WindowsApps\\\\OpenAI.Codex')
    expect(script).toContain('ExecutablePath = $path')
  })

  it('keeps the three merged segments byte-identical to the standalone probe scripts', () => {
    const combined = buildCodexDesktopCombinedProbeScript()

    expect(combined).toContain("Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex*!App' }")
    expect(combined).toContain('Get-CimInstance Win32_Process')
    expect(combined).toContain("Get-AppxPackage -Name 'OpenAI.Codex*' -ErrorAction Stop")
    expect(combined).not.toContain("Get-AppxPackage -AllUsers")
    // 每段各自 try/catch，任一段失败只写自己的 error 字段
    expect(combined).toContain('catch { $startAppsError = $_.Exception.Message }')
    expect(combined).toContain('catch { $processesError = $_.Exception.Message }')
    expect(combined).toContain('catch { $packageError = $_.Exception.Message }')
    // 嵌套一层后默认的 Depth 2 会把包条目压成字符串
    expect(combined).toContain('ConvertTo-Json -Compress -Depth 6')
  })

  it.runIf(process.platform === 'win32')('executes the process probe on Windows and emits bounded JSON', () => {
    const output = execFileSync(windowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildCodexDesktopProcessProbeScript(),
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
    if (output.trim()) expect(() => JSON.parse(output)).not.toThrow()
  })

  it.runIf(process.platform === 'win32')('executes the merged probe on Windows and emits the three segments', () => {
    const output = execFileSync(windowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildCodexDesktopCombinedProbeScript(),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: powerShellStartupTimeoutMs,
    })

    const parsed = JSON.parse(output.trim()) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(parsed, 'startApps')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(parsed, 'processes')).toBe(true)
    expect(parsed.package).toBeTruthy()
    // Appx 段在任何账户下都必须给出结论：要么有包、要么确认没有、要么报错
    const probe = parseCodexDesktopCombinedProbeJson(output)
    expect(
      probe.packageProbe.value !== null
      || probe.packageProbe.confirmedAbsent === true
      || probe.packageProbe.error !== null,
    ).toBe(true)
  }, 180_000)
})

describe('parseCodexDesktopCombinedProbeJson', () => {
  const startApp = { Name: 'ChatGPT', AppID: 'OpenAI.Codex_stable!App' }
  const packageEntry = {
    Name: 'OpenAI.Codex',
    Version: '26.721.4979.0',
    PackageFullName: 'OpenAI.Codex_26.721.4979.0_x64__abc123',
    PackageFamilyName: 'OpenAI.Codex_abc123',
    InstallLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__abc123',
  }
  const processEntry = {
    ProcessId: 4242,
    ParentProcessId: 1,
    Name: 'ChatGPT.exe',
    ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__abc123\\ChatGPT.exe',
  }

  function combinedOutput(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      startApps: [startApp],
      startAppsError: null,
      processes: [processEntry],
      processesError: null,
      package: {
        packages: [packageEntry],
        source: 'current-user',
        confirmedAbsent: false,
        error: null,
      },
      packageError: null,
      ...overrides,
    })
  }

  it('splits a complete result back into the three original shapes', () => {
    const probe = parseCodexDesktopCombinedProbeJson(combinedOutput())

    expect(probe.match).toEqual({ name: 'ChatGPT', appId: 'OpenAI.Codex_stable!App' })
    expect(probe.processes).toEqual([{
      processId: 4242,
      parentProcessId: 1,
      name: 'ChatGPT.exe',
      executablePath: processEntry.ExecutablePath,
    }])
    expect(probe.packageProbe).toMatchObject({
      value: { name: 'OpenAI.Codex', version: '26.721.4979.0' },
      error: null,
      source: 'current-user',
      confirmedAbsent: false,
    })
  })

  it('reads a confirmed absence as a conclusive, error-free package probe', () => {
    const probe = parseCodexDesktopCombinedProbeJson(combinedOutput({
      startApps: [],
      processes: [],
      package: { packages: [], source: null, confirmedAbsent: true, error: null },
    }))

    expect(probe.match).toBeNull()
    expect(probe.processes).toEqual([])
    expect(probe.packageProbe).toMatchObject({ value: null, error: null, confirmedAbsent: true })
  })

  it('isolates a failed process segment without losing the other two', () => {
    const probe = parseCodexDesktopCombinedProbeJson(combinedOutput({
      processes: null,
      processesError: 'WMI 查询失败',
    }))

    expect(probe.processes).toEqual([])
    expect(probe.match).toEqual({ name: 'ChatGPT', appId: 'OpenAI.Codex_stable!App' })
    expect(probe.packageProbe.value?.version).toBe('26.721.4979.0')
  })

  it('isolates a failed Appx segment and keeps its message on the package probe', () => {
    const probe = parseCodexDesktopCombinedProbeJson(combinedOutput({
      package: null,
      packageError: 'Get-AppxPackage 被拒绝',
    }))

    expect(probe.packageProbe).toEqual({
      value: null,
      error: 'Get-AppxPackage 被拒绝',
      source: null,
      confirmedAbsent: false,
    })
    expect(probe.match).toEqual({ name: 'ChatGPT', appId: 'OpenAI.Codex_stable!App' })
    expect(probe.processes).toHaveLength(1)
  })

  it('isolates a failed start-menu segment', () => {
    const probe = parseCodexDesktopCombinedProbeJson(combinedOutput({
      startApps: null,
      startAppsError: 'Get-StartApps 不可用',
    }))

    expect(probe.match).toBeNull()
    expect(probe.processes).toHaveLength(1)
    expect(probe.packageProbe.value?.version).toBe('26.721.4979.0')
  })

  it('never reports a confirmed absence from output it could not parse', () => {
    const invalid = parseCodexDesktopCombinedProbeJson('not-json')
    expect(invalid).toEqual({
      match: null,
      processes: [],
      packageProbe: {
        value: null,
        error: 'Windows Appx 探测返回数据格式无效',
        source: null,
        confirmedAbsent: false,
      },
    })

    const empty = parseCodexDesktopCombinedProbeJson('   ')
    expect(empty.packageProbe).toEqual({
      value: null,
      error: 'Windows Appx 探测没有返回结果',
      source: null,
      confirmedAbsent: false,
    })
    expect(empty.processes).toEqual([])
  })

  it('treats a whole-script failure as inconclusive, not as "not installed"', () => {
    const timedOut = buildCodexDesktopCombinedProbeFailure(new Error('spawn powershell.exe ETIMEDOUT'))

    expect(timedOut).toEqual({
      match: null,
      processes: [],
      packageProbe: {
        value: null,
        error: 'spawn powershell.exe ETIMEDOUT',
        source: null,
        confirmedAbsent: false,
      },
    })
    expect(buildCodexDesktopCombinedProbeFailure(null).packageProbe.error)
      .toBe('无法读取 Windows Appx 包信息')
    // detectionFailed 必须亮起来，界面才不会把「没看成」显示成「没装」
    const probes = buildCodexDesktopWindowsProbes(
      { status: 'fulfilled', value: timedOut.match },
      { status: 'fulfilled', value: timedOut.processes },
      { status: 'fulfilled', value: timedOut.packageProbe },
      { status: 'fulfilled', value: { version: null, checkedAt: '2026-09-22T00:00:00.000Z', error: null } },
    )
    expect(probes.detectionFailed).toBe(true)
    expect(probes.detectionError).toContain('ETIMEDOUT')
  })
})

describe('buildCodexDesktopDarwinStatus', () => {
  const installedApp: MacosCodexAppInspection = {
    app: { path: '/Applications/Codex.app', version: '26.727.51351', running: true },
    detectionFailed: false,
    detectionError: null,
  }
  const confirmedAbsent: MacosCodexAppInspection = {
    app: null,
    detectionFailed: false,
    detectionError: null,
  }

  it('reports a confirmed, signature-verified app as installed', () => {
    const result = buildCodexDesktopDarwinStatus({ status: 'fulfilled', value: installedApp })
    expect(result).toMatchObject({
      installed: true,
      version: '26.727.51351',
      appVersion: '26.727.51351',
      path: '/Applications/Codex.app',
      installDirectory: '/Applications/Codex.app',
      running: true,
      mirrorVersion: null,
      mirrorUpdateAvailable: null,
      mirrorError: null,
      updateCheck: 'skipped',
      updateError: null,
      detectionFailed: false,
      detectionError: null,
    })
  })

  it('reports a confirmed absence as installed: false with detectionFailed: false', () => {
    // The three states this maps: this is the "confirmed not installed" one —
    // distinct from both a confirmed install and an inconclusive scan below.
    const result = buildCodexDesktopDarwinStatus({ status: 'fulfilled', value: confirmedAbsent })
    expect(result).toMatchObject({
      installed: false,
      version: null,
      path: null,
      running: false,
      detectionFailed: false,
      detectionError: null,
    })
  })

  it('reports an inconclusive scan as detectionFailed, never as a confirmed absence', () => {
    // The third state: inspectMacosCodexApp itself could not finish (e.g. a
    // codesign timeout deep inside the scan) — `installed: false` alone would
    // read identically to a real "not installed", which is exactly the bug
    // this type exists to prevent.
    const result = buildCodexDesktopDarwinStatus({
      status: 'fulfilled',
      value: { app: null, detectionFailed: true, detectionError: 'codesign 超时' },
    })
    expect(result).toMatchObject({
      installed: false,
      path: null,
      detectionFailed: true,
      detectionError: 'codesign 超时',
    })
  })

  it('does not let detectionFailed survive alongside a confirmed install', () => {
    // inspectMacosCodexApp's own contract guarantees this never actually
    // happens (a definitive match always carries detectionFailed: false), but
    // the mapping itself must not introduce a way to violate it either.
    const result = buildCodexDesktopDarwinStatus({
      status: 'fulfilled',
      value: { ...installedApp, detectionFailed: true, detectionError: 'stale probe' },
    })
    expect(result.installed).toBe(true)
    expect(result.detectionFailed).toBe(true)
    expect(result.detectionError).toBe('stale probe')
  })

  it('degrades a rejected detector promise to detectionFailed instead of a confirmed absence', () => {
    // The detector is caller-injectable (CodexDesktopServiceOptions.detectMacosCodexApp);
    // a substitute that throws outright — as system-service.test.ts's darwin
    // fixtures do — must not be misread as "not installed" either.
    const result = buildCodexDesktopDarwinStatus({
      status: 'rejected',
      reason: new Error('detector crashed'),
    })
    expect(result).toMatchObject({
      installed: false,
      path: null,
      detectionFailed: true,
      detectionError: 'detector crashed',
    })
  })
})


function relayCodexConfig(dataDirectory: string): NativeConfigInspection {
  return {
    baseUrl: 'https://relay.example/v1',
    actualBaseUrl: 'https://relay.example/v1',
    exists: true,
    hasApiKey: true,
    matchesRelay: true,
    apiKey: 'sk-test',
    model: 'gpt-5-codex',
    dataDirectory,
    dataDirectoryExists: true,
    files: [],
    updatedAt: null,
  }
}

function queuedCodexDesktopFixture(installationQueue = new InstallationQueue()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-queue-'))
  temporaryDirectories.push(directory)
  const inspectNativeProviderConfig = vi.fn(() => relayCodexConfig(directory))
  const service = createCodexDesktopService({
    // Only the queue ordering is under test, so the launch stops at the
    // platform gate before any Windows or macOS dependency is reached.
    platform: 'linux',
    installationQueue,
    createInstallTemporaryDirectory: async () => { throw new Error('未使用') },
    detectMacosCodexApp: async () => { throw new Error('未使用') },
    executeCommand: async () => { throw new Error('未使用') },
    codexEnv: {},
    store: new AppSettingsStore(path.join(directory, 'settings.json'), directory),
    inspectNativeProviderConfig,
    spawnDetached: async () => { throw new Error('未使用') },
    downloadFetch: async () => { throw new Error('未使用') },
  })
  return { service, installationQueue, inspectNativeProviderConfig, target: { isDestroyed: () => false, send: vi.fn() } }
}

describe('Codex Desktop install disk space precheck', () => {
  function diskSpaceFixture(assertInstallDiskSpace: (subject: string) => Promise<void>) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-disk-'))
    temporaryDirectories.push(directory)
    const service = createCodexDesktopService({
      // 预检跑在平台门之前，所以 linux 上「仅支持 Windows」那句正好当作
      // 「预检放行了」的证据。
      platform: 'linux',
      installationQueue: new InstallationQueue(),
      createInstallTemporaryDirectory: async () => { throw new Error('未使用') },
      detectMacosCodexApp: async () => { throw new Error('未使用') },
      executeCommand: async () => { throw new Error('未使用') },
      codexEnv: {},
      store: new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      inspectNativeProviderConfig: vi.fn(() => relayCodexConfig(directory)),
      spawnDetached: async () => { throw new Error('未使用') },
      downloadFetch: async () => { throw new Error('未使用') },
      assertInstallDiskSpace: vi.fn(assertInstallDiskSpace),
    })
    return { service, target: { isDestroyed: () => false, send: vi.fn() } }
  }

  it('stops before downloading anything when the install disk is nearly full', async () => {
    const fixture = diskSpaceFixture(async (subject) => {
      throw new Error(`${subject}：安装目录所在磁盘空间不足，只剩 300 MB，至少需要 1.0 GB，请先清理磁盘再试`)
    })

    await expect(fixture.service.installCodexDesktop(fixture.target)).rejects.toThrow('磁盘空间不足')
  })

  it('goes on with the install when the precheck lets it through', async () => {
    const fixture = diskSpaceFixture(async () => undefined)

    await expect(fixture.service.installCodexDesktop(fixture.target)).rejects.toThrow('仅支持 Windows')
  })
})

describe('Codex Desktop launch queueing', () => {
  it('starts no launch while an install is still waiting in the shared queue', async () => {
    const queue = new InstallationQueue()
    let releaseBlocker = (): void => {}
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve })
    const blocking = queue.enqueue('runtime:node', () => blocker)
    const install = queue.enqueue('desktop:codex:install', async () => undefined)
    const fixture = queuedCodexDesktopFixture(queue)

    const launch = fixture.service.launchCodexDesktop('open', fixture.target)
    await new Promise<void>((resolve) => setImmediate(resolve))
    // The busy flag an install sets when it begins running cannot describe an
    // install that is only enqueued; the queue itself has to hold the launch.
    expect(fixture.inspectNativeProviderConfig).not.toHaveBeenCalled()

    releaseBlocker()
    await blocking
    await install
    await expect(launch).rejects.toThrow('仅支持 Windows')
    expect(fixture.inspectNativeProviderConfig).toHaveBeenCalledWith('codex')
  })

  it('merges a repeated identical launch but keeps a different mode or locale intent separate', async () => {
    const fixture = queuedCodexDesktopFixture()
    const requests = [
      fixture.service.launchCodexDesktop('open', fixture.target),
      fixture.service.launchCodexDesktop('open', fixture.target),
      fixture.service.launchCodexDesktop('open', fixture.target, { injectChinese: true }),
      fixture.service.launchCodexDesktop('restart', fixture.target),
    ]
    for (const request of requests) await expect(request).rejects.toThrow('仅支持 Windows')
    expect(fixture.inspectNativeProviderConfig).toHaveBeenCalledTimes(3)
  })
})

describe('Codex Desktop launch acceleration', () => {
  function darwinLaunchFixture(prepareAcceleration?: () => Promise<void>) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-accel-'))
    temporaryDirectories.push(directory)
    const order: string[] = []
    const service = createCodexDesktopService({
      // 桌面端只认系统代理，macOS 与 Windows 同理；这里用 macOS 那条路，因为
      // 它不需要 Windows 专用的进程探测就能走到真正的拉起。
      platform: 'darwin',
      installationQueue: new InstallationQueue(),
      createInstallTemporaryDirectory: async () => { throw new Error('未使用') },
      detectMacosCodexApp: async () => ({
        app: { path: '/Applications/Codex.app', version: '1.0.0', running: false },
        detectionFailed: false,
        detectionError: null,
      }),
      executeCommand: async () => {
        order.push('launch')
        return {
          executable: '/usr/bin/open', argv: [], exitCode: 0, signal: null,
          stdout: '', stderr: '', outputBytes: 0, durationMs: 1,
        }
      },
      codexEnv: {},
      store: new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      inspectNativeProviderConfig: vi.fn(() => relayCodexConfig(directory)),
      spawnDetached: async () => { throw new Error('未使用') },
      downloadFetch: async () => { throw new Error('未使用') },
      ...(prepareAcceleration
        ? { prepareAcceleration: async () => { order.push('accelerate'); await prepareAcceleration() } }
        : {}),
    })
    return { service, order, target: { isDestroyed: () => false, send: vi.fn() } }
  }

  it('connects acceleration before the desktop app is started', async () => {
    const fixture = darwinLaunchFixture(async () => undefined)

    await fixture.service.launchCodexDesktop('open', fixture.target)

    expect(fixture.order).toEqual(['accelerate', 'launch'])
  })

  it('still opens the desktop app when connecting acceleration fails', async () => {
    // 加速是加分项：连不上只能少一层加速，绝不能变成打不开。
    const fixture = darwinLaunchFixture(async () => { throw new Error('加速连接失败') })

    await fixture.service.launchCodexDesktop('open', fixture.target)

    expect(fixture.order).toEqual(['accelerate', 'launch'])
  })

  it('launches unchanged when no acceleration hook is wired', async () => {
    const fixture = darwinLaunchFixture()

    await fixture.service.launchCodexDesktop('open', fixture.target)

    expect(fixture.order).toEqual(['launch'])
  })
})

describe('Codex Desktop Microsoft Store install', () => {
  const winget = 'C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.0_x64__8wekyb3d8bbwe\\winget.exe'

  function storeError(overrides: Partial<ConstructorParameters<typeof CommandRunnerError>[1]> = {}) {
    return new CommandRunnerError('命令执行失败：winget.exe', {
      code: 'EXIT_NON_ZERO', executable: winget, argv: ['install'], exitCode: 1, signal: null,
      stdout: '', stderr: '', outputBytes: 0, maxOutputBytes: 1024, durationMs: 1, ...overrides,
    })
  }

  it('installs the Store product with a fixed argv and no interactive prompts', () => {
    expect(buildCodexDesktopStoreInstallCommand(winget)).toEqual({
      executable: winget,
      argv: [
        'install', '--id', '9PLM9XGG6VKS', '--exact', '--source', 'msstore', '--silent',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
      ],
    })
  })

  it('refuses anything that is not an absolute winget.exe path', () => {
    expect(() => buildCodexDesktopStoreInstallCommand('winget.exe')).toThrow('路径无效')
    expect(() => buildCodexDesktopStoreInstallCommand('C:\\Temp\\evil.exe')).toThrow('路径无效')
    expect(() => buildCodexDesktopStoreInstallCommand(`${winget}\0`)).toThrow('路径无效')
  })

  it('explains Store failures in plain words', () => {
    expect(describeCodexDesktopStoreFailure(storeError({ exitCode: 0x80072efd | 0 }))).toBe('连不上微软商店')
    expect(describeCodexDesktopStoreFailure(storeError({ exitCode: 0x8a15002b | 0 }))).toBe('商店里暂时还没有更新的版本')
    expect(describeCodexDesktopStoreFailure(storeError({ exitCode: 0x8a150014 | 0 }))).toBe('商店里没找到 Codex 桌面端')
    expect(describeCodexDesktopStoreFailure(storeError({ code: 'TIMED_OUT', exitCode: null }))).toBe('等了很久还没装完')
    expect(describeCodexDesktopStoreFailure(storeError({ exitCode: 0x8a150084 | 0 }))).toBe('错误码 0x8a150084')
    expect(describeCodexDesktopStoreFailure(new Error('spawn failed'))).toBe('安装没有完成')
  })

  it('reads the last percentage from Store progress output', () => {
    expect(parseCodexDesktopStoreProgress('  ██████      12%\r  ████████████  48%')).toBe(48)
    expect(parseCodexDesktopStoreProgress('已找到 Codex [9PLM9XGG6VKS]')).toBeNull()
    expect(parseCodexDesktopStoreProgress('999%')).toBeNull()
  })

  it('tries the Store for an update unless the official feed says nothing newer exists', () => {
    expect(shouldTryCodexDesktopStoreUpdate('26.900.1.0', '26.917.9434.0')).toBe(true)
    expect(shouldTryCodexDesktopStoreUpdate('26.917.9434.0', '26.917.9434.0')).toBe(false)
    expect(shouldTryCodexDesktopStoreUpdate('26.917.9434.0', null)).toBe(true)
  })
})
