import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildNodeRuntimeInstallPlan,
  buildNodeRuntimeWingetPlan,
  fetchTrustedNodeResource,
  installNodeRuntime,
  nodeRuntimeDownloadSources,
  normalizeNodeRuntimeArchitecture,
  parseAuthenticodeSignature,
  parseNodeReleaseIndex,
  parseNodeShasums,
  parseSystemWingetPackage,
  systemWingetCandidate,
  validateNodeAuthenticodeSignature,
  validateInstalledNodeRuntimeInspection,
  type NodeRuntimeProcessPlan,
} from './node-runtime'
import type { WindowsMachinePaths } from './windows-machine-paths'

const testMachinePaths: WindowsMachinePaths = {
  systemRoot: 'D:\\Windows',
  system32: 'D:\\Windows\\System32',
  programFiles: 'D:\\Program Files',
  programFilesX86: 'D:\\Program Files (x86)',
  programData: 'D:\\ProgramData',
}

function successfulCommand(plan: NodeRuntimeProcessPlan) {
  return Promise.resolve({
    executable: plan.executable,
    argv: [...plan.argv],
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    outputBytes: 0,
    durationMs: 1,
  })
}

describe('Node.js LTS release parsing', () => {
  const index = JSON.stringify([
    { version: 'v23.11.1', lts: false, files: ['win-x64-msi'] },
    { version: 'v22.17.0', lts: 'Jod', files: ['win-x64-msi', 'win-arm64-msi'] },
    { version: 'v20.19.4', lts: 'Iron', files: ['win-x64-msi', 'win-arm64-msi'] },
    { version: 'v22.18.0', lts: 'Jod', files: ['win-x64-zip'] },
  ])

  it('selects the highest LTS release that actually publishes the requested MSI', () => {
    expect(parseNodeReleaseIndex(index, 'x64')).toEqual({
      version: 'v22.17.0',
      lts: 'Jod',
      architecture: 'x64',
      fileName: 'node-v22.17.0-x64.msi',
    })
    expect(parseNodeReleaseIndex(index, 'arm64')).toMatchObject({
      version: 'v22.17.0',
      architecture: 'arm64',
      fileName: 'node-v22.17.0-arm64.msi',
    })
  })

  it('rejects malformed, non-array, non-LTS, and unsupported release indexes', () => {
    expect(parseNodeReleaseIndex('{"version":"v22.0.0"}', 'x64')).toBeNull()
    expect(parseNodeReleaseIndex('[{"version":"latest","lts":"Jod","files":["win-x64-msi"]}]', 'x64')).toBeNull()
    expect(parseNodeReleaseIndex('[{"version":"v22.0.0","lts":false,"files":["win-x64-msi"]}]', 'x64')).toBeNull()
    expect(parseNodeReleaseIndex('[{"version":"v22.0.0","lts":"Jod","files":["win-x64-zip"]}]', 'x64')).toBeNull()
  })

  it('reads exactly one matching SHA-256 and rejects ambiguous or unsafe filenames', () => {
    const hash = 'a'.repeat(64)
    expect(parseNodeShasums(`${hash}  node-v22.17.0-x64.msi\n${'b'.repeat(64)}  other.zip`, 'node-v22.17.0-x64.msi')).toBe(hash)
    expect(parseNodeShasums(`${hash}  node.msi\n${'b'.repeat(64)} *node.msi`, 'node.msi')).toBeNull()
    expect(parseNodeShasums(`${hash}  node.msi`, '..\\node.msi')).toBeNull()
  })
})

describe('Node.js installer routing and process plans', () => {
  it('prefers the mainland mirror in China and preserves official/mirror fallback elsewhere', () => {
    expect(nodeRuntimeDownloadSources('mainland-china').map((source) => source.id)).toEqual([
      'npmmirror',
      'official',
    ])
    expect(nodeRuntimeDownloadSources('outside-mainland-china').map((source) => source.id)).toEqual([
      'official',
      'npmmirror',
    ])
  })

  it('routes an undetectable region to the mirror first', () => {
    // Same reasoning as npmInstallRegistries: the networks that block the
    // region probe are the ones that cannot reach nodejs.org either.
    expect(nodeRuntimeDownloadSources('unknown').map((source) => source.id)).toEqual([
      'npmmirror',
      'official',
    ])
  })

  it('keeps both download sources reachable from every region', () => {
    for (const region of ['mainland-china', 'outside-mainland-china', 'unknown'] as const) {
      expect(nodeRuntimeDownloadSources(region).map((source) => source.id).sort())
        .toEqual(['npmmirror', 'official'])
    }
  })

  it('supports Windows x64/arm64 and rejects all other architectures', () => {
    expect(normalizeNodeRuntimeArchitecture('x64')).toBe('x64')
    expect(normalizeNodeRuntimeArchitecture('arm64')).toBe('arm64')
    expect(() => normalizeNodeRuntimeArchitecture('ia32')).toThrow('仅支持 Windows x64/arm64')
  })

  it('builds argument arrays without interpolating an MSI path into PowerShell code', () => {
    const msiPath = path.join('C:\\Temp', "Node package 'quoted'; calc.exe.msi")
    const powershell = 'D:\\Program Files\\PowerShell\\7\\pwsh.exe'
    const plan = buildNodeRuntimeInstallPlan(msiPath, powershell, true, testMachinePaths)

    const winget = buildNodeRuntimeWingetPlan(
      'D:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.0.0_x64__8wekyb3d8bbwe\\winget.exe',
    )
    expect(winget).toMatchObject({
      executable: expect.stringMatching(/WindowsApps.+winget\.exe$/),
      argv: [
        'install',
        '--id',
        'OpenJS.NodeJS.LTS',
        '--exact',
        '--source',
        'winget',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
      acceptedExitCodes: [0],
    })
    expect(winget.trustedOnly).toBeUndefined()
    expect(() => buildNodeRuntimeWingetPlan('winget.exe')).toThrow('系统级 winget 路径无效')
    expect(plan.signature.executable).toBe(powershell)
    expect(path.win32.isAbsolute(plan.signature.executable)).toBe(true)
    expect(plan.signature.argv).not.toContain(msiPath)
    expect(plan.signature.env?.XINGMANG_NODE_MSI_PATH).toBe(msiPath)
    expect(plan.signature.env?.PSModulePath).toBe('')
    expect(plan.signature.trustedPaths).toEqual([msiPath])
    const encodedIndex = plan.signature.argv.indexOf('-EncodedCommand') + 1
    const decodedScript = Buffer.from(plan.signature.argv[encodedIndex], 'base64').toString('utf16le')
    expect(decodedScript).toContain('Get-AuthenticodeSignature')
    expect(decodedScript).toContain("$ErrorActionPreference = 'Stop'")
    expect(decodedScript).toContain('Microsoft.PowerShell.Security.psd1')
    expect(decodedScript).toContain('$env:XINGMANG_NODE_MSI_PATH')
    expect(decodedScript).not.toContain(msiPath)
    expect(plan.msi).toMatchObject({
      executable: expect.stringMatching(/System32[\\/]msiexec\.exe$/i),
      argv: ['/i', msiPath, '/qn', '/norestart', 'ADDLOCAL=ALL'],
      acceptedExitCodes: [0, 3010],
      trustedPaths: [msiPath],
    })

    const sameUserPlan = buildNodeRuntimeInstallPlan(msiPath, powershell, false, testMachinePaths)
    expect(sameUserPlan.signature.trustedOnly).toBe(false)
    expect(sameUserPlan.msi.trustedOnly).toBe(false)
  })

  it.runIf(process.platform === 'win32')('isolates signature checks to the real Windows PowerShell module directory', () => {
    const plan = buildNodeRuntimeInstallPlan(
      'C:\Temp\node-runtime.msi',
      'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',
      false,
    )
    expect(plan.signature.env?.PSModulePath).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]Modules$/i)
    expect(plan.signature.env?.PSModulePath).not.toContain('PowerShell\\7')
  })

  it('accepts only the system App Installer package under Program Files WindowsApps', () => {
    const packageInfo = parseSystemWingetPackage(JSON.stringify({
      name: 'Microsoft.DesktopAppInstaller',
      packageFamilyName: 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe',
      installLocation: 'D:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.0.0_x64__8wekyb3d8bbwe',
    }))
    expect(packageInfo).not.toBeNull()
    expect(packageInfo && systemWingetCandidate(packageInfo, testMachinePaths)).toBe(
      'D:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.0.0_x64__8wekyb3d8bbwe\\winget.exe',
    )
    expect(systemWingetCandidate({
      ...packageInfo!,
      installLocation: 'D:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps',
    }, testMachinePaths)).toBeNull()
    expect(systemWingetCandidate({
      ...packageInfo!,
      packageFamilyName: 'Microsoft.DesktopAppInstaller_attacker',
    }, testMachinePaths)).toBeNull()
    expect(parseSystemWingetPackage('not json')).toBeNull()
  })

  it.runIf(process.platform === 'win32')('skips an untrusted winget resolution and falls back to MSI sources', async () => {
    const progress: string[] = []
    const runProcess = vi.fn(successfulCommand)
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    await expect(installNodeRuntime({
      networkRegion: 'unknown',
      onProgress: (event) => progress.push(event.message),
      dependencies: {
        resolveWingetExecutable: async () => ({
          executable: null,
          reason: 'Microsoft App Installer 包身份或安装目录校验失败',
        }),
        runProcess,
        fetch: fetchMock,
        createTemporaryDirectory: async () => 'D:\\ProgramData\\XingMangAI\\InstallerCache\\test',
        removeTemporaryDirectory: async () => undefined,
      },
    })).rejects.toThrow('Node.js LTS 自动安装失败')

    expect(runProcess).not.toHaveBeenCalled()
    expect(progress).toContain(
      '已跳过 winget：Microsoft App Installer 包身份或安装目录校验失败，正在切换到经过校验的 MSI 安装包',
    )
  })

  it.runIf(process.platform === 'win32')('executes the exact verified system winget path', async () => {
    const executable = 'D:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.0.0_x64__8wekyb3d8bbwe\\winget.exe'
    const runProcess = vi.fn(successfulCommand)
    const inspectInstalledNodeRuntime = vi.fn(async () => ({
      executable: 'D:\\Program Files\\nodejs\\node.exe',
      version: 'v22.17.0',
      signature: {
        status: 'Valid',
        subject: 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US',
      },
    }))
    const fetchMock = vi.fn() as unknown as typeof fetch

    await expect(installNodeRuntime({
      networkRegion: 'mainland-china',
      dependencies: {
        resolveWingetExecutable: async () => ({ executable, reason: null }),
        runProcess,
        inspectInstalledNodeRuntime,
        fetch: fetchMock,
        createTemporaryDirectory: async () => 'unused',
        removeTemporaryDirectory: async () => undefined,
      },
    })).resolves.toMatchObject({ method: 'winget', source: 'winget', version: 'v22.17.0' })

    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ executable, trustedOnly: false }),
      undefined,
    )
    expect(inspectInstalledNodeRuntime).toHaveBeenCalledWith(undefined)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'win32')('falls back to verified MSI sources when post-winget inspection fails', async () => {
    const runProcess = vi.fn(successfulCommand)
    const inspectInstalledNodeRuntime = vi.fn(async () => {
      throw new Error('安装后的 Node.js 版本 v18.20.0 低于最低要求 v20.0.0')
    })
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    await expect(installNodeRuntime({
      networkRegion: 'unknown',
      dependencies: {
        resolveWingetExecutable: async () => ({
          executable: 'D:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.0.0_x64__8wekyb3d8bbwe\\winget.exe',
          reason: null,
        }),
        runProcess,
        inspectInstalledNodeRuntime,
        fetch: fetchMock,
        createTemporaryDirectory: async () => 'D:\\ProgramData\\XingMangAI\\InstallerCache\\test',
        removeTemporaryDirectory: async () => undefined,
      },
    })).rejects.toThrow(/winget：安装后的 Node\.js 版本 v18\.20\.0 低于最低要求 v20\.0\.0/)

    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(inspectInstalledNodeRuntime).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalled()
  })
})

describe('installed Node.js runtime validation', () => {
  const validInspection = {
    executable: 'D:\\Program Files\\nodejs\\node.exe',
    version: 'v22.17.0',
    signature: {
      status: 'Valid',
      subject: 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US',
    },
  }

  it('accepts a supported, signed Node executable in the protected machine path', () => {
    expect(validateInstalledNodeRuntimeInspection(
      validInspection,
      testMachinePaths,
      () => true,
    )).toBe('v22.17.0')
  })

  it('rejects user-controlled and untrusted executable paths', () => {
    expect(() => validateInstalledNodeRuntimeInspection({
      ...validInspection,
      executable: 'D:\\Users\\tester\\AppData\\Local\\node.exe',
    }, testMachinePaths, () => true)).toThrow('不在预期的系统级安装目录')
    expect(() => validateInstalledNodeRuntimeInspection(
      validInspection,
      testMachinePaths,
      () => false,
    )).toThrow('不在受信任的受保护路径')
  })

  it('rejects Node versions below the supported minimum', () => {
    expect(() => validateInstalledNodeRuntimeInspection({
      ...validInspection,
      version: 'v18.20.0',
    }, testMachinePaths, () => true)).toThrow('低于最低要求 v20.0.0')
  })

  it('rejects invalid signatures and unrelated publishers', () => {
    expect(() => validateInstalledNodeRuntimeInspection({
      ...validInspection,
      signature: { ...validInspection.signature, status: 'HashMismatch' },
    }, testMachinePaths, () => true)).toThrow('数字签名状态不是 Valid')
    expect(() => validateInstalledNodeRuntimeInspection({
      ...validInspection,
      signature: { status: 'Valid', subject: 'CN=Unrelated Software Ltd, C=US' },
    }, testMachinePaths, () => true)).toThrow('数字签名发布者不是')
  })
})

describe('Node.js Authenticode validation', () => {
  it('accepts only a valid OpenJS or legacy Node.js Foundation signature', () => {
    const openJs = parseAuthenticodeSignature(JSON.stringify({
      status: 'Valid',
      subject: 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US',
    }))
    const legacy = parseAuthenticodeSignature(JSON.stringify({
      status: 'Valid',
      subject: 'CN=Node.js Foundation, O=Node.js Foundation, C=US',
    }))
    expect(openJs && validateNodeAuthenticodeSignature(openJs)).toBeNull()
    expect(legacy && validateNodeAuthenticodeSignature(legacy)).toBeNull()
  })

  it('rejects invalid status, malformed JSON, and unrelated publishers', () => {
    expect(parseAuthenticodeSignature('not json')).toBeNull()
    expect(validateNodeAuthenticodeSignature({
      status: 'HashMismatch',
      subject: 'CN=OpenJS Foundation, O=OpenJS Foundation, C=US',
    })).toContain('不是 Valid')
    expect(validateNodeAuthenticodeSignature({
      status: 'Valid',
      subject: 'CN=Unrelated Software Ltd, C=US',
    })).toContain('发布者不是')
  })
})

describe('Node.js response URL validation', () => {
  it('rejects redirects to another host or non-standard port', async () => {
    const { validateNodeResponseUrl } = await import('./node-runtime')
    expect(() => validateNodeResponseUrl(
      'https://evil.example/dist/index.json',
      'https://nodejs.org/dist/index.json',
    )).toThrow('未经批准')
    expect(() => validateNodeResponseUrl(
      'https://nodejs.org:8443/dist/index.json',
      'https://nodejs.org/dist/index.json',
    )).toThrow('未经批准')
    expect(() => validateNodeResponseUrl(
      'https://nodejs.org/dist/index.json',
      'https://nodejs.org/dist/index.json',
    )).not.toThrow()
    expect(() => validateNodeResponseUrl(
      'https://cdn.npmmirror.com/binaries/node/index.json',
      'https://npmmirror.com/mirrors/node/index.json',
    )).not.toThrow()
    expect(() => validateNodeResponseUrl(
      'https://cdn.npmmirror.com/binaries/node/other.json',
      'https://npmmirror.com/mirrors/node/index.json',
    )).toThrow('资源路径')
  })

  it('follows only the fixed npmmirror CDN mapping with manual redirects', async () => {
    const source = 'https://npmmirror.com/mirrors/node/index.json'
    const cdn = 'https://cdn.npmmirror.com/binaries/node/index.json'
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      if (String(url) === source) {
        return new Response(null, { status: 302, headers: { Location: cdn } })
      }
      return new Response('[]', { status: 200 })
    }) as typeof fetch

    await expect(fetchTrustedNodeResource(source, { method: 'GET' }, fetchMock))
      .resolves.toMatchObject({ status: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const hostileFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://127.0.0.1/internal' },
    })) as typeof fetch
    await expect(fetchTrustedNodeResource(source, { method: 'GET' }, hostileFetch))
      .rejects.toThrow('未经批准')
    expect(hostileFetch).toHaveBeenCalledOnce()
  })
})
