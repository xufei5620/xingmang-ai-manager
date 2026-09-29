import { describe, expect, it, vi } from 'vitest'
import {
  codexDesktopPackageValidationError,
  compareWindowsPackageVersions,
  isCodexDesktopExecutable,
  parseCodexDesktopAppManifest,
  parseCodexDesktopPackageMetadata,
  parseCodexDesktopPackagePath,
  parseCodexDesktopPackageProbeJson,
  parseCodexDesktopMirrorManifest,
  parseCodexDesktopPackagesJson,
  parseCodexDesktopUpdateManifest,
  parseStartAppsJson,
  parseWindowsProcessesJson,
  selectCodexDesktopProcessesForPackage,
  selectCodexDesktopApp,
  selectCodexDesktopPackage,
  selectRootProcessIds,
  stableInstallFamilyName,
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
  it('updates Stable when Stable and Beta coexist, and never closes Beta for a Stable install', () => {
    const stable = {
      name: 'OpenAI.Codex', version: '26.715.0.0',
      packageFullName: 'OpenAI.Codex_26.715.0.0_x64__id',
      packageFamilyName: 'OpenAI.Codex_id', installLocation: 'C:\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id',
    }
    const beta = {
      ...stable, name: 'OpenAI.CodexBeta',
      packageFullName: 'OpenAI.CodexBeta_26.715.0.0_x64__id',
      packageFamilyName: 'OpenAI.CodexBeta_id',
      installLocation: 'C:\\WindowsApps\\OpenAI.CodexBeta_26.715.0.0_x64__id',
    }
    expect(selectCodexDesktopPackage([beta, stable])).toEqual(stable)
    expect(stableInstallFamilyName(selectCodexDesktopPackage([beta, stable]))).toBe('OpenAI.Codex_id')
    // Beta-only machines still install Stable like before; nothing of Beta is closed.
    expect(stableInstallFamilyName(selectCodexDesktopPackage([beta]))).toBeNull()
    expect(stableInstallFamilyName(null)).toBeNull()
  })

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

  it('parses a structured current-user Appx probe without requiring all-users access', () => {
    const result = parseCodexDesktopPackageProbeJson(JSON.stringify({
      packages: [{
        Name: 'OpenAI.Codex',
        Version: '26.825.6671.0',
        PackageFullName: 'OpenAI.Codex_26.825.6671.0_x64__publisher',
        PackageFamilyName: 'OpenAI.Codex_publisher',
        InstallLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.825.6671.0_x64__publisher',
      }],
      source: 'current-user',
      confirmedAbsent: false,
      error: null,
    }))

    expect(result).toEqual({
      value: {
        name: 'OpenAI.Codex',
        version: '26.825.6671.0',
        packageFullName: 'OpenAI.Codex_26.825.6671.0_x64__publisher',
        packageFamilyName: 'OpenAI.Codex_publisher',
        installLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.825.6671.0_x64__publisher',
      },
      error: null,
      source: 'current-user',
      confirmedAbsent: false,
    })
  })

  it('keeps a denied all-users probe inconclusive instead of confirming absence', () => {
    expect(parseCodexDesktopPackageProbeJson(JSON.stringify({
      packages: [],
      source: null,
      confirmedAbsent: false,
      error: '当前用户未检测到 Codex Desktop，系统拒绝读取其他用户的安装信息。',
    }))).toEqual({
      value: null,
      error: '当前用户未检测到 Codex Desktop，系统拒绝读取其他用户的安装信息。',
      source: null,
      confirmedAbsent: false,
    })
  })

  it('accepts an authoritative empty all-users result as confirmed absence', () => {
    expect(parseCodexDesktopPackageProbeJson(JSON.stringify({
      packages: [],
      source: null,
      confirmedAbsent: true,
      error: null,
    }))).toEqual({
      value: null,
      error: null,
      source: null,
      confirmedAbsent: true,
    })
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
    const identity = {
      OwnerSid: 'S-1-5-21-1234',
      CurrentOwnerSid: 'S-1-5-21-1234',
      SessionId: 2,
      CurrentSessionId: 2,
      PackageFamilyName: 'OpenAI.Codex_id',
    }
    const processes = parseWindowsProcessesJson(JSON.stringify([
      {
        ...identity,
        ProcessId: 120,
        ParentProcessId: 80,
        Name: 'ChatGPT.exe',
        ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\app\\ChatGPT.exe',
      },
      {
        ...identity,
        ProcessId: 121,
        ParentProcessId: 120,
        Name: 'codex.exe',
        ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\app\\resources\\codex.exe',
      },
      {
        ...identity,
        ProcessId: 500,
        ParentProcessId: 80,
        Name: 'ChatGPT.exe',
        ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Desktop_1.0.0.0_x64__id\\ChatGPT.exe',
      },
    ]))

    expect(processes.map((entry) => entry.processId)).toEqual([120, 121])
    expect(selectRootProcessIds(processes)).toEqual([120])
  })

  it('drops another account, session, unknown owner and mismatched package identity', () => {
    const stablePath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\app\\ChatGPT.exe'
    const own = {
      ProcessId: 120, ParentProcessId: 80, Name: 'ChatGPT.exe', ExecutablePath: stablePath,
      OwnerSid: 'S-1-5-21-1234', CurrentOwnerSid: 'S-1-5-21-1234',
      SessionId: 2, CurrentSessionId: 2, PackageFamilyName: 'OpenAI.Codex_id',
    }
    const processes = parseWindowsProcessesJson(JSON.stringify([
      own,
      { ...own, ProcessId: 121, OwnerSid: 'S-1-5-21-5678' },
      { ...own, ProcessId: 122, SessionId: 3 },
      { ...own, ProcessId: 123, OwnerSid: null },
      { ...own, ProcessId: 124, PackageFamilyName: 'OpenAI.CodexBeta_id' },
      { ...own, ProcessId: 125, SessionId: null },
    ]))
    expect(processes.map((entry) => entry.processId)).toEqual([120])
  })

  it('selects only the target package family and original process ids', () => {
    const identity = {
      OwnerSid: 'S-1-5-21-1234', CurrentOwnerSid: 'S-1-5-21-1234',
      SessionId: 2, CurrentSessionId: 2,
    }
    const stable = {
      ...identity, ProcessId: 120, ParentProcessId: 0, Name: 'ChatGPT.exe',
      ExecutablePath: 'C:\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\ChatGPT.exe',
      PackageFamilyName: 'OpenAI.Codex_id',
    }
    const beta = {
      ...identity, ProcessId: 121, ParentProcessId: 0, Name: 'ChatGPT.exe',
      ExecutablePath: 'C:\\WindowsApps\\OpenAI.CodexBeta_26.715.0.0_x64__id\\ChatGPT.exe',
      PackageFamilyName: 'OpenAI.CodexBeta_id',
    }
    const processes = parseWindowsProcessesJson(JSON.stringify([stable, beta, { ...stable, ProcessId: 122 }]))
    expect(selectCodexDesktopProcessesForPackage(processes, 'OpenAI.Codex_id').map((entry) => entry.processId)).toEqual([120, 122])
    expect(selectCodexDesktopProcessesForPackage(processes, 'OpenAI.Codex_id', new Set([120])).map((entry) => entry.processId)).toEqual([120])
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

    expect(requestClose).toHaveBeenCalledTimes(2)
    expect(requestClose).toHaveBeenCalledWith(120)
    expect(requestClose).toHaveBeenCalledWith(121)
    expect(forceClose).toHaveBeenCalledTimes(2)
    expect(forceClose).toHaveBeenCalledWith(120)
    expect(forceClose).toHaveBeenCalledWith(121)
    expect(waitUntilStopped).toHaveBeenNthCalledWith(2, 4_000)
  })

  it('never force-closes a process that appeared after the initial close request', async () => {
    const original = {
      processId: 120, parentProcessId: 0, name: 'ChatGPT.exe',
      executablePath: 'C:\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\ChatGPT.exe',
      ownerSid: 'S-1-5-21-1234', sessionId: 2, packageFamilyName: 'OpenAI.Codex_id',
    }
    const newlyStarted = { ...original, processId: 121 }
    const requestClose = vi.fn().mockResolvedValue(undefined)
    const forceClose = vi.fn().mockResolvedValue(undefined)
    await stopCodexDesktopProcesses([original], {
      requestClose,
      forceClose,
      waitUntilStopped: vi.fn().mockResolvedValue([newlyStarted]),
    })
    expect(requestClose).toHaveBeenCalledExactlyOnceWith(120)
    expect(forceClose).not.toHaveBeenCalled()
  })

  it('force-closes an original child left after its parent exits', async () => {
    const root = {
      processId: 120, parentProcessId: 0, name: 'ChatGPT.exe',
      executablePath: 'C:\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\ChatGPT.exe',
    }
    const child = {
      ...root, processId: 121, parentProcessId: 120, name: 'Codex.exe',
    }
    const forceClose = vi.fn().mockResolvedValue(undefined)
    await stopCodexDesktopProcesses([root, child], {
      requestClose: vi.fn().mockResolvedValue(undefined),
      forceClose,
      waitUntilStopped: vi.fn()
        .mockResolvedValueOnce([child])
        .mockResolvedValueOnce([]),
    })
    expect(forceClose).toHaveBeenCalledTimes(1)
    expect(forceClose).toHaveBeenCalledWith(121)
  })

  it('does not force-close a reused pid when its package identity changes', async () => {
    const original = {
      processId: 120, parentProcessId: 0, name: 'ChatGPT.exe',
      executablePath: 'C:\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\ChatGPT.exe',
      ownerSid: 'S-1-5-21-1234', sessionId: 2, packageFamilyName: 'OpenAI.Codex_id',
    }
    const replacement = {
      ...original,
      executablePath: 'C:\\WindowsApps\\OpenAI.CodexBeta_26.715.0.0_x64__id\\ChatGPT.exe',
      packageFamilyName: 'OpenAI.CodexBeta_id',
    }
    const forceClose = vi.fn().mockResolvedValue(undefined)
    await stopCodexDesktopProcesses([original], {
      requestClose: vi.fn().mockResolvedValue(undefined),
      forceClose,
      waitUntilStopped: vi.fn().mockResolvedValue([replacement]),
    })
    expect(forceClose).not.toHaveBeenCalled()
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
