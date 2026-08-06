import { describe, expect, it, vi } from 'vitest'
import {
  codexDesktopPackageValidationError,
  compareWindowsPackageVersions,
  isCodexDesktopExecutable,
  parseCodexDesktopAppManifest,
  parseCodexDesktopPackageMetadata,
  parseCodexDesktopPackagePath,
  parseCodexDesktopMirrorManifest,
  parseCodexDesktopPackagesJson,
  parseCodexDesktopUpdateManifest,
  parseStartAppsJson,
  parseWindowsProcessesJson,
  selectCodexDesktopApp,
  selectCodexDesktopPackage,
  selectRootProcessIds,
  stopCodexDesktopProcesses,
} from './codex-desktop'

const validPackageMetadata = {
  name: 'OpenAI.Codex',
  version: '26.721.3996.0',
  architecture: 'X64',
  publisher: 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B',
  hasSignature: true,
}

describe('Codex desktop app discovery', () => {
  it('reconstructs package metadata from a running WindowsApps path', () => {
    expect(parseCodexDesktopPackagePath(
      'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe',
    )).toEqual({
      name: 'OpenAI.Codex',
      version: '26.721.4979.0',
      packageFullName: 'OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0',
      packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0',
      installLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0',
    })
    expect(parseCodexDesktopPackagePath('C:\\Users\\tester\\ChatGPT.exe')).toBeNull()
  })
  it('parses the user-facing Codex version from the app manifest', () => {
    const manifest = JSON.stringify({
      name: 'openai-codex-electron',
      productName: 'Codex',
      version: '26.721.31836',
    })

    expect(parseCodexDesktopAppManifest(manifest)).toBe('26.721.31836')
    expect(parseCodexDesktopAppManifest(manifest.replace('Codex', 'Other'))).toBeNull()
    expect(parseCodexDesktopAppManifest(manifest.replace('26.721.31836', 'latest'))).toBeNull()
    expect(parseCodexDesktopAppManifest('<html>not json</html>')).toBeNull()
  })

  it('strictly parses the domestic mirror release for the selected architecture', () => {
    const manifest = {
      schemaVersion: 5,
      sources: {
        windows: {
          updateManifest: {
            buildVersion: '26.721.4979.0',
            storeProductId: '9PLM9XGG6VKS',
            packageIdentity: 'OpenAI.Codex',
          },
          architectures: {
            x64: {
              architecture: 'x64',
              status: 'downloadable',
              downloadable: true,
              version: '26.721.3996.0',
              contentLength: 744072561,
              catalog: {
                packageFullName: 'OpenAI.Codex_26.721.3996.0_x64__2p2nqsd0c76g0',
                hashAlgorithm: 'SHA256',
                hash: '0a/lZGhbNAxLAd6xFNfKeRJZzzJzNErA1E5IYWnqHjM=',
                contentLength: 744072561,
              },
            },
          },
        },
      },
    }
    expect(parseCodexDesktopMirrorManifest(JSON.stringify(manifest), 'x64')).toEqual({
      version: '26.721.3996.0',
      architecture: 'x64',
      contentLength: 744072561,
      sha256Base64: '0a/lZGhbNAxLAd6xFNfKeRJZzzJzNErA1E5IYWnqHjM=',
    })
    expect(parseCodexDesktopMirrorManifest(JSON.stringify(manifest), 'arm64')).toBeNull()
    expect(parseCodexDesktopMirrorManifest(JSON.stringify({
      ...manifest,
      sources: {
        windows: {
          ...manifest.sources.windows,
          updateManifest: { ...manifest.sources.windows.updateManifest, packageIdentity: 'Untrusted.App' },
        },
      },
    }), 'x64')).toBeNull()
  })

  it('parses both a single PowerShell object and an array', () => {
    expect(parseStartAppsJson('{"Name":"ChatGPT","AppID":"OpenAI.Codex_stable!App"}')).toEqual([
      { name: 'ChatGPT', appId: 'OpenAI.Codex_stable!App' },
    ])
    expect(parseStartAppsJson('[{"Name":"ChatGPT (Beta)","AppID":"OpenAI.CodexBeta_beta!App"}]')).toEqual([
      { name: 'ChatGPT (Beta)', appId: 'OpenAI.CodexBeta_beta!App' },
    ])
  })

  it('prefers the stable app and falls back to beta', () => {
    const beta = { name: 'ChatGPT (Beta)', appId: 'OpenAI.CodexBeta_2p2nqsd0c76g0!App' }
    const stable = { name: 'ChatGPT', appId: 'OpenAI.Codex_2p2nqsd0c76g0!App' }

    expect(selectCodexDesktopApp([beta, stable])).toEqual(stable)
    expect(selectCodexDesktopApp([beta])).toEqual(beta)
  })

  it('ignores unrelated Start menu applications and malformed output', () => {
    expect(selectCodexDesktopApp([
      { name: 'Terminal', appId: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' },
    ])).toBeNull()
    expect(parseStartAppsJson('not-json')).toEqual([])
  })

  it('parses Appx package versions and prefers the stable desktop package', () => {
    const packages = parseCodexDesktopPackagesJson(JSON.stringify([
      {
        Name: 'OpenAI.CodexBeta',
        Version: '26.715.9000.0',
        PackageFullName: 'OpenAI.CodexBeta_26.715.9000.0_x64__publisher',
        PackageFamilyName: 'OpenAI.CodexBeta_publisher',
        InstallLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.CodexBeta_26.715.9000.0_x64__publisher',
      },
      {
        Name: 'OpenAI.Codex',
        Version: '26.715.8383.0',
        PackageFullName: 'OpenAI.Codex_26.715.8383.0_x64__publisher',
        PackageFamilyName: 'OpenAI.Codex_publisher',
        InstallLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.8383.0_x64__publisher',
      },
    ]))

    expect(selectCodexDesktopPackage(packages)).toMatchObject({
      name: 'OpenAI.Codex',
      version: '26.715.8383.0',
      packageFamilyName: 'OpenAI.Codex_publisher',
      installLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.8383.0_x64__publisher',
    })
  })

  it('rejects malformed and unrelated Appx package records', () => {
    expect(parseCodexDesktopPackagesJson(JSON.stringify([
      { Name: 'OpenAI.Desktop', Version: '1.0.0.0', PackageFullName: 'other', PackageFamilyName: 'other' },
      { Name: 'OpenAI.Codex', Version: 'not-a-version', PackageFullName: 'bad', PackageFamilyName: 'bad' },
    ]))).toEqual([])
    expect(parseCodexDesktopPackagesJson('<html>not json</html>')).toEqual([])
  })

  it('strictly validates the official Windows update manifest identity', () => {
    const valid = JSON.stringify({
      schemaVersion: 1,
      buildVersion: '26.721.3996.0',
      storeProductId: '9PLM9XGG6VKS',
      packageIdentity: 'OpenAI.Codex',
    })
    expect(parseCodexDesktopUpdateManifest(valid)).toEqual({
      schemaVersion: 1,
      buildVersion: '26.721.3996.0',
      storeProductId: '9PLM9XGG6VKS',
      packageIdentity: 'OpenAI.Codex',
    })
    expect(parseCodexDesktopUpdateManifest(valid.replace('OpenAI.Codex', 'OpenAI.Other'))).toBeNull()
    expect(parseCodexDesktopUpdateManifest(valid.replace('9PLM9XGG6VKS', 'UNTRUSTED'))).toBeNull()
    expect(parseCodexDesktopUpdateManifest(valid.replace('26.721.3996.0', 'latest'))).toBeNull()
    expect(parseCodexDesktopUpdateManifest('<html>not json</html>')).toBeNull()
  })

  it('parses and accepts valid Codex MSIX package metadata', () => {
    const metadata = parseCodexDesktopPackageMetadata(JSON.stringify(validPackageMetadata))

    expect(metadata).toEqual({ ...validPackageMetadata, architecture: 'x64' })
    expect(codexDesktopPackageValidationError(metadata!, '26.721.3996.0', 'x64')).toBeNull()
  })

  it('rejects a Codex MSIX package with the wrong identity', () => {
    const metadata = parseCodexDesktopPackageMetadata(JSON.stringify({
      ...validPackageMetadata,
      name: 'OpenAI.CodexBeta',
    }))

    expect(codexDesktopPackageValidationError(metadata!, '26.721.3996.0', 'x64'))
      .toBe('官方安装包的产品身份不是 OpenAI.Codex')
  })

  it('rejects a Codex MSIX package older than the official manifest', () => {
    const metadata = parseCodexDesktopPackageMetadata(JSON.stringify({
      ...validPackageMetadata,
      version: '26.715.8383.0',
    }))

    expect(codexDesktopPackageValidationError(metadata!, '26.721.3996.0', 'x64'))
      .toBe('官方安装包版本 26.715.8383.0 低于更新清单 26.721.3996.0')
  })

  it('rejects a Codex MSIX package built for another architecture', () => {
    const metadata = parseCodexDesktopPackageMetadata(JSON.stringify({
      ...validPackageMetadata,
      architecture: 'arm64',
    }))

    expect(codexDesktopPackageValidationError(metadata!, '26.721.3996.0', 'x64'))
      .toBe('官方安装包架构 arm64 与本机 x64 不匹配')
  })

  it('rejects a Codex MSIX package from an unexpected publisher', () => {
    const metadata = parseCodexDesktopPackageMetadata(JSON.stringify({
      ...validPackageMetadata,
      publisher: 'CN=Example Corp, O=Example Corp, C=US',
    }))

    expect(codexDesktopPackageValidationError(metadata!, '26.721.3996.0', 'x64'))
      .toBe('官方安装包的发布者身份不匹配')
  })

  it('rejects a friendly publisher name that is not the Store package identity', () => {
    const metadata = parseCodexDesktopPackageMetadata(JSON.stringify({
      ...validPackageMetadata,
      publisher: 'CN=OpenAI, O=OpenAI, C=US',
    }))

    expect(codexDesktopPackageValidationError(metadata!, '26.721.3996.0', 'x64'))
      .toBe('官方安装包的发布者身份不匹配')
  })

  it('rejects a Codex MSIX package without an Appx signature', () => {
    const metadata = parseCodexDesktopPackageMetadata(JSON.stringify({
      ...validPackageMetadata,
      hasSignature: false,
    }))

    expect(codexDesktopPackageValidationError(metadata!, '26.721.3996.0', 'x64'))
      .toBe('官方安装包缺少 Appx 签名')
  })

  it('returns null for malformed Codex MSIX metadata JSON', () => {
    expect(parseCodexDesktopPackageMetadata('{"name":"OpenAI.Codex"')).toBeNull()
    expect(parseCodexDesktopPackageMetadata(JSON.stringify({
      ...validPackageMetadata,
      hasSignature: 'yes',
    }))).toBeNull()
  })

  it('compares all four Windows package version segments', () => {
    expect(compareWindowsPackageVersions('26.715.8383.0', '26.721.3996.0')).toBe(-1)
    expect(compareWindowsPackageVersions('26.721.3996.0', '26.721.3996.0')).toBe(0)
    expect(compareWindowsPackageVersions('26.721.3996.1', '26.721.3996.0')).toBe(1)
    expect(compareWindowsPackageVersions('26.721.3996', '26.721.3996.0')).toBeNull()
  })

  it('recognizes only packaged Codex desktop processes', () => {
    expect(isCodexDesktopExecutable('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\app\\ChatGPT.exe')).toBe(true)
    expect(isCodexDesktopExecutable('C:/Program Files/WindowsApps/OpenAI.CodexBeta_26.715.0.0_x64__id/app/ChatGPT.exe')).toBe(true)
    expect(isCodexDesktopExecutable('C:\\Program Files\\WindowsApps\\OpenAI.CodexTools_26.715.0.0_x64__id\\ChatGPT.exe')).toBe(false)
    expect(isCodexDesktopExecutable('C:\\Program Files\\WindowsApps\\OpenAI.Desktop_1.0.0.0_x64__id\\ChatGPT.exe')).toBe(false)
    expect(isCodexDesktopExecutable('C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd')).toBe(false)
  })

  it('parses Codex desktop process JSON and finds the process-tree root', () => {
    const processes = parseWindowsProcessesJson(JSON.stringify([
      {
        ProcessId: 120,
        ParentProcessId: 80,
        Name: 'ChatGPT.exe',
        ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\app\\ChatGPT.exe',
      },
      {
        ProcessId: 121,
        ParentProcessId: 120,
        Name: 'codex.exe',
        ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\app\\resources\\codex.exe',
      },
      {
        ProcessId: 500,
        ParentProcessId: 80,
        Name: 'ChatGPT.exe',
        ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Desktop_1.0.0.0_x64__id\\ChatGPT.exe',
      },
    ]))

    expect(processes.map((entry) => entry.processId)).toEqual([120, 121])
    expect(selectRootProcessIds(processes)).toEqual([120])
  })

  it('requests a normal close and does not force processes that exit in time', async () => {
    const process = {
      processId: 120,
      parentProcessId: 80,
      name: 'ChatGPT.exe',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\ChatGPT.exe',
    }
    const requestClose = vi.fn().mockResolvedValue(undefined)
    const forceClose = vi.fn().mockResolvedValue(undefined)
    const waitUntilStopped = vi.fn().mockResolvedValue([])

    await stopCodexDesktopProcesses([process], {
      requestClose,
      forceClose,
      waitUntilStopped,
    })

    expect(requestClose).toHaveBeenCalledWith(120)
    expect(waitUntilStopped).toHaveBeenCalledWith(5_000)
    expect(forceClose).not.toHaveBeenCalled()
  })

  it('force-closes only processes left after the graceful timeout', async () => {
    const root = {
      processId: 120,
      parentProcessId: 80,
      name: 'ChatGPT.exe',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\ChatGPT.exe',
    }
    const child = {
      processId: 121,
      parentProcessId: 120,
      name: 'codex.exe',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\codex.exe',
    }
    const requestClose = vi.fn().mockResolvedValue(undefined)
    const forceClose = vi.fn().mockResolvedValue(undefined)
    const waitUntilStopped = vi.fn()
      .mockResolvedValueOnce([root, child])
      .mockResolvedValueOnce([])

    await stopCodexDesktopProcesses([root, child], {
      requestClose,
      forceClose,
      waitUntilStopped,
    })

    expect(requestClose).toHaveBeenCalledTimes(1)
    expect(requestClose).toHaveBeenCalledWith(120)
    expect(forceClose).toHaveBeenCalledTimes(1)
    expect(forceClose).toHaveBeenCalledWith(120)
    expect(waitUntilStopped).toHaveBeenNthCalledWith(2, 4_000)
  })

  it('reports remaining process ids and the last system error', async () => {
    const process = {
      processId: 120,
      parentProcessId: 80,
      name: 'ChatGPT.exe',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\ChatGPT.exe',
    }
    const waitUntilStopped = vi.fn().mockResolvedValue([process])

    await expect(stopCodexDesktopProcesses([process], {
      requestClose: vi.fn().mockRejectedValue(new Error('正常关闭请求失败')),
      forceClose: vi.fn().mockRejectedValue(new Error('访问被拒绝')),
      waitUntilStopped,
    })).rejects.toThrow(/ChatGPT\.exe \(PID 120\).*系统返回：访问被拒绝/)
  })
})
