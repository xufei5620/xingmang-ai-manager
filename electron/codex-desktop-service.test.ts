import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MacosCodexAppInspection } from './macos-codex-app'
import { windowsPowerShellExecutable } from './windows-elevation'
import {
  buildCodexDesktopDarwinStatus,
  buildCodexDesktopLaunchPlan,
  buildCodexDesktopManifestSources,
  buildCodexDesktopPackageSources,
  buildCodexDesktopWindowsProbes,
  buildDesktopUpdateStatus,
  desktopMirrorUpdateAvailable,
  downloadCodexDesktopPackage,
  fetchCodexDesktopMirrorRelease,
  inspectCodexDesktopPackageFile,
  validateCodexDesktopResourceUrl,
  type CodexDesktopWindowsProbes,
} from './codex-desktop-service'

const temporaryDirectories: string[] = []

function createTestMsix(manifest: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-msix-inspect-'))
  temporaryDirectories.push(directory)
  const sourceDirectory = path.join(directory, 'source')
  const zipPath = path.join(directory, 'Codex.zip')
  const packagePath = path.join(directory, 'Codex.msix')
  fs.mkdirSync(sourceDirectory)
  fs.writeFileSync(path.join(sourceDirectory, 'AppxManifest.xml'), manifest, 'utf8')
  fs.writeFileSync(path.join(sourceDirectory, 'AppxSignature.p7x'), 'test-signature', 'utf8')
  execFileSync(windowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-ChildItem -LiteralPath $env:XINGMANG_TEST_MSIX_SOURCE | Compress-Archive -DestinationPath $env:XINGMANG_TEST_MSIX_ZIP',
  ], {
    windowsHide: true,
    env: {
      ...process.env,
      XINGMANG_TEST_MSIX_SOURCE: sourceDirectory,
      XINGMANG_TEST_MSIX_ZIP: zipPath,
    },
  })
  fs.renameSync(zipPath, packagePath)
  return packagePath
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Codex Desktop launch trust', () => {
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

  it.skipIf(process.platform !== 'win32')('reads identity fields and the signature entry from an MSIX archive', async () => {
    const packagePath = createTestMsix([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">',
      '  <Identity Name="OpenAI.Codex" Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" Version="26.721.3996.0" ProcessorArchitecture="x64" />',
      '</Package>',
    ].join('\n'))

    await expect(inspectCodexDesktopPackageFile(packagePath)).resolves.toEqual({
      name: 'OpenAI.Codex',
      version: '26.721.3996.0',
      architecture: 'x64',
      publisher: 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B',
      hasSignature: true,
    })
  }, 180_000)

  it.skipIf(process.platform !== 'win32')('rejects an oversized compressed AppxManifest before XML parsing', async () => {
    const packagePath = createTestMsix([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">',
      `  <!-- ${'x'.repeat(1024 * 1024)} -->`,
      '  <Identity Name="OpenAI.Codex" Publisher="CN=invalid" Version="1.0.0.0" ProcessorArchitecture="x64" />',
      '</Package>',
    ].join('\n'))

    await expect(inspectCodexDesktopPackageFile(packagePath)).rejects.toThrow('1 MiB 安全上限')
  }, 180_000)
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
