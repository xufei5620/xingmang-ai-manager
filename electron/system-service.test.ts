import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore, defaultAppSettings } from './app-settings'
import { windowsPowerShellExecutable } from './windows-elevation'
import {
  assertNpmPackageLocksEquivalent,
  assertNpmReleaseIntegrityMatches,
  buildCliStatus,
  buildCliMaintenancePlan,
  buildCliUninstallPlan,
  buildCodexDesktopManifestSources,
  buildCodexDesktopLaunchPlan,
  buildCodexDesktopPackageSources,
  buildDesktopUpdateStatus,
  desktopMirrorUpdateAvailable,
  createSystemService,
  downloadCodexDesktopPackage,
  fetchCodexDesktopMirrorRelease,
  inspectCodexDesktopPackageFile,
  interactiveTerminalEnvironment,
  modelAccessCacheKey,
  ManagedNpmRollbackError,
  detectNetworkLocation,
  detectNetworkRegion,
  fetchNpmPackageReleaseMetadata,
  npmInstallRegistries,
  npmPackageLatestUrl,
  npmPackageVersionUrl,
  parseNpmPackageReleaseMetadata,
  parseCloudflareNetworkRegion,
  parseCloudflareNetworkLocation,
  parseGrokLocalVersion,
  parseLatestNpmVersion,
  readGrokLocalVersionForExecutable,
  replaceManagedNpmPrefixAtomically,
  validateCodexDesktopResourceUrl,
  type LatestVersionProbe,
} from './system-service'

const temporaryDirectories: string[] = []

function createService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-system-service-'))
  temporaryDirectories.push(directory)
  return createSystemService(new AppSettingsStore(path.join(directory, 'settings.json'), directory))
}

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
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('createSystemService', () => {
  it('delegates settings reads and durable writes to AppSettingsStore', async () => {
    const service = createService()
    const initial = service.readStoredConfig()
    expect(initial).toEqual(defaultAppSettings(initial.workspace))

    await service.writeStoredConfig({ ...initial, theme: 'light' })

    expect(service.readStoredConfig()).toMatchObject({ theme: 'light', workspace: initial.workspace })
  })

  it('validates an API key by returning model ids from the relay response', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.fetchAvailableModels('  sk-test-value  ')).resolves.toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.solov.cc/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test-value' }),
        redirect: 'error',
      }),
    )
  })

  it('bounds model responses and stores only a key fingerprint in cache identifiers', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1))))

    await expect(service.fetchAvailableModels('sk-sensitive-value')).rejects.toThrow('响应超过 1024 KB')
    expect(modelAccessCacheKey('sk-sensitive-value')).toMatch(/^[a-f0-9]{64}$/)
    expect(modelAccessCacheKey('sk-sensitive-value')).not.toContain('sk-sensitive-value')
  })

  it('rejects malformed keys before making a network request', async () => {
    const service = createService()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.fetchAvailableModels('bad\nkey')).rejects.toThrow('API Key 格式错误')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('redacts echoed API keys and bounds relay error messages', async () => {
    const service = createService()
    const apiKey = 'license-value-that-must-not-leak'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: `invalid ${apiKey}\n${'detail '.repeat(200)}` },
    }), { status: 401 })))

    let message = ''
    try {
      await service.fetchAvailableModels(apiKey)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(apiKey)
    expect(message).not.toContain('\n')
    expect(message.length).toBeLessThanOrEqual(500)
  })

  it('requires the selected model to be available before saving configuration', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gpt-5.6-sol' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.saveConfig({
      provider: 'codex',
      apiKey: 'sk-model-check',
      model: 'gpt-unsupported',
      mode: 'reset',
    }, true)).rejects.toThrow('当前 API Key 不支持模型 gpt-unsupported')

    await expect(service.saveConfig({
      provider: 'codex',
      apiKey: 'sk-model-check',
      model: 'gpt-5.6-sol',
      mode: 'reset',
    }, true)).resolves.toEqual({ backups: [], files: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
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

describe('npm registry metadata', () => {
  const integrity = `sha512-${Buffer.alloc(64, 0x5a).toString('base64')}`

  it('queries scoped package latest metadata directly over HTTPS', () => {
    expect(npmPackageLatestUrl('https://registry.npmjs.org/', '@openai/codex')).toBe(
      'https://registry.npmjs.org/%40openai%2Fcodex/latest',
    )
    expect(npmPackageVersionUrl('https://registry.npmjs.org/', '@openai/codex', '0.146.0')).toBe(
      'https://registry.npmjs.org/%40openai%2Fcodex/0.146.0',
    )
  })

  it('requires exact package identity, semantic version and SHA-512 integrity metadata', () => {
    const valid = JSON.stringify({
      name: '@openai/codex',
      version: '0.146.0',
      dist: { integrity },
    })
    expect(parseNpmPackageReleaseMetadata(valid, '@openai/codex')).toEqual({
      name: '@openai/codex',
      version: '0.146.0',
      integrity,
    })
    expect(parseNpmPackageReleaseMetadata(valid, '@google/gemini-cli')).toBeNull()
    expect(parseNpmPackageReleaseMetadata(JSON.stringify({
      name: '@openai/codex',
      version: 'latest',
      dist: { integrity },
    }), '@openai/codex')).toBeNull()
    expect(parseNpmPackageReleaseMetadata(JSON.stringify({
      name: '@openai/codex',
      version: '0.146.0',
      dist: { integrity: 'sha512-not-base64' },
    }), '@openai/codex')).toBeNull()
  })

  it('queries with redirects disabled and rejects mirror metadata drift', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      return new Response(JSON.stringify({
        name: '@openai/codex',
        version: '0.146.0',
        dist: { integrity },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const trusted = await fetchNpmPackageReleaseMetadata(
      'https://registry.npmjs.org',
      '@openai/codex',
      'latest',
      fetchMock,
    )
    expect(trusted.version).toBe('0.146.0')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(() => assertNpmReleaseIntegrityMatches(trusted, {
      ...trusted,
      integrity: `sha512-${Buffer.alloc(64, 0x33).toString('base64')}`,
    })).toThrow('与 npm 官方源不一致')
  })

  it('accepts registry host differences only when the complete lock graph matches', () => {
    const dependencyIntegrity = `sha512-${Buffer.alloc(64, 0x31).toString('base64')}`
    const createLock = (registry: string, transitiveIntegrity = dependencyIntegrity) => JSON.stringify({
      name: 'xingmang-cli-resolution',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'xingmang-cli-resolution',
          version: '1.0.0',
          dependencies: { '@openai/codex': '0.146.0' },
        },
        'node_modules/@openai/codex': {
          version: '0.146.0',
          resolved: `${registry}/@openai/codex/-/codex-0.146.0.tgz`,
          integrity,
          dependencies: { transitive: '1.0.0' },
        },
        'node_modules/transitive': {
          version: '1.0.0',
          resolved: `${registry}/transitive/-/transitive-1.0.0.tgz`,
          integrity: transitiveIntegrity,
        },
      },
    })
    const official = createLock('https://registry.npmjs.org')
    const mirror = createLock('https://registry.npmmirror.com')

    expect(() => assertNpmPackageLocksEquivalent(
      official,
      mirror,
      '@openai/codex',
      '0.146.0',
    )).not.toThrow()
    expect(() => assertNpmPackageLocksEquivalent(
      official,
      createLock(
        'https://registry.npmmirror.com',
        `sha512-${Buffer.alloc(64, 0x32).toString('base64')}`,
      ),
      '@openai/codex',
      '0.146.0',
    )).toThrow('完整依赖图、版本或 SHA-512')
  })
})

describe('managed npm transaction', () => {
  function transactionFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-npm-transaction-'))
    temporaryDirectories.push(root)
    const active = path.join(root, 'active')
    const transaction = path.join(root, 'transaction')
    const staged = path.join(transaction, 'staged-prefix')
    fs.mkdirSync(active)
    fs.mkdirSync(staged, { recursive: true })
    fs.writeFileSync(path.join(active, 'version.txt'), 'old', 'utf8')
    fs.writeFileSync(path.join(staged, 'version.txt'), 'new', 'utf8')
    return { active, transaction, staged }
  }

  it('promotes a verified prefix while retaining rollback data until transaction cleanup', async () => {
    const fixture = transactionFixture()
    await replaceManagedNpmPrefixAtomically(
      fixture.active,
      fixture.staged,
      fixture.transaction,
      async () => {
        expect(fs.readFileSync(path.join(fixture.active, 'version.txt'), 'utf8')).toBe('new')
      },
    )
    expect(fs.readFileSync(path.join(fixture.active, 'version.txt'), 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(fixture.transaction, 'previous-prefix', 'version.txt'), 'utf8')).toBe('old')
  })

  it('restores the previous prefix when post-promotion verification fails', async () => {
    const fixture = transactionFixture()
    await expect(replaceManagedNpmPrefixAtomically(
      fixture.active,
      fixture.staged,
      fixture.transaction,
      async () => { throw new Error('verification failed') },
    )).rejects.toThrow('verification failed')
    expect(fs.readFileSync(path.join(fixture.active, 'version.txt'), 'utf8')).toBe('old')
  })

  it('preserves rollback data when restoring the previous prefix also fails', async () => {
    const fixture = transactionFixture()
    let renameCount = 0
    const rename = vi.fn(async (source: string, destination: string) => {
      renameCount += 1
      if (renameCount === 4) throw new Error('rollback destination is locked')
      await fs.promises.rename(source, destination)
    })

    await expect(replaceManagedNpmPrefixAtomically(
      fixture.active,
      fixture.staged,
      fixture.transaction,
      async () => { throw new Error('verification failed') },
      { rename },
    )).rejects.toBeInstanceOf(ManagedNpmRollbackError)
    expect(fs.readFileSync(
      path.join(fixture.transaction, 'previous-prefix', 'version.txt'),
      'utf8',
    )).toBe('old')
    expect(fs.readFileSync(
      path.join(fixture.transaction, 'rejected-prefix', 'version.txt'),
      'utf8',
    )).toBe('new')
  })
})

describe('interactiveTerminalEnvironment', () => {
  it('removes inherited monochrome flags and advertises true color support', () => {
    const env = interactiveTerminalEnvironment({
      PATH: 'C:\\Windows\\System32',
      TERM: 'dumb',
      NO_COLOR: '1',
      NODE_DISABLE_COLORS: '1',
      FORCE_COLOR: '0',
      CLICOLOR: '0',
    })

    expect(env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      CLICOLOR: '1',
      CLICOLOR_FORCE: '1',
    })
    expect(env.NO_COLOR).toBeUndefined()
    expect(env.NODE_DISABLE_COLORS).toBeUndefined()
  })
})

describe('npm install network routing', () => {
  it('parses the Cloudflare trace country without retaining the public IP', () => {
    expect(parseCloudflareNetworkRegion('fl=1f72\nh=example\nip=203.0.113.1\nloc=CN\ntls=TLSv1.3\n'))
      .toBe('mainland-china')
    expect(parseCloudflareNetworkRegion('loc=US\n')).toBe('outside-mainland-china')
    expect(parseCloudflareNetworkRegion('ip=203.0.113.1\n')).toBe('unknown')
    expect(parseCloudflareNetworkRegion('loc=CHINA\n')).toBe('unknown')
  })

  it('parses a validated public IP and country for the overview without logging it', () => {
    expect(parseCloudflareNetworkLocation(
      'fl=1f72\nip=203.0.113.8\nloc=CN\ntls=TLSv1.3\n',
      '2026-07-25T00:00:00.000Z',
    )).toEqual({
      publicIp: '203.0.113.8',
      countryCode: 'CN',
      region: 'mainland-china',
      checkedAt: '2026-07-25T00:00:00.000Z',
      error: null,
    })
    expect(parseCloudflareNetworkLocation('ip=not-an-ip\nloc=CHINA\n').error)
      .toContain('缺少有效 IP 和国家代码')
  })

  it('prefers npmmirror in mainland China and keeps bidirectional fallback', () => {
    expect(npmInstallRegistries('mainland-china')).toEqual([
      'https://registry.npmmirror.com',
      'https://registry.npmjs.org',
    ])
    expect(npmInstallRegistries('outside-mainland-china')).toEqual([
      'https://registry.npmjs.org',
      'https://registry.npmmirror.com',
    ])
    expect(npmInstallRegistries('unknown')).toEqual([
      'https://registry.npmjs.org',
      'https://registry.npmmirror.com',
    ])
  })

  it('detects mainland China and degrades to unknown on an unavailable service', async () => {
    const chinaResponse = vi.fn().mockResolvedValue(new Response('loc=CN\n', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }))
    const failedResponse = vi.fn().mockRejectedValue(new Error('network unavailable'))

    await expect(detectNetworkRegion(chinaResponse)).resolves.toBe('mainland-china')
    await expect(detectNetworkRegion(failedResponse)).resolves.toBe('unknown')
    await expect(detectNetworkLocation(failedResponse)).resolves.toMatchObject({
      publicIp: null,
      countryCode: null,
      region: 'unknown',
      error: '无法连接网络位置服务',
    })
  })

  it('bounds a chunked network-location response while it is being read', async () => {
    const oversizedResponse = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(24 * 1024, 0x61))
        controller.enqueue(Buffer.alloc(12 * 1024, 0x62))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/plain' } }))

    await expect(detectNetworkLocation(oversizedResponse)).resolves.toMatchObject({
      publicIp: null,
      countryCode: null,
      region: 'unknown',
      error: '网络位置响应超过 32 KB 安全上限',
    })
  })
})

describe('CLI latest version state', () => {
  const latest = (version: string): LatestVersionProbe => ({
    status: 'checked',
    version,
    source: 'npm',
    checkedAt: '2026-07-24T00:00:00.000Z',
    error: null,
  })

  it('parses npm JSON/plain versions and rejects ambiguous output', () => {
    expect(parseLatestNpmVersion('"0.145.0"\n')).toBe('0.145.0')
    expect(parseLatestNpmVersion('{"name":"@openai/codex","version":"0.145.0"}'))
      .toBe('0.145.0')
    expect(parseLatestNpmVersion('2.1.218')).toBe('2.1.218')
    expect(parseLatestNpmVersion('["1.0.0","2.0.0"]')).toBeNull()
    expect(parseLatestNpmVersion('{"version":"latest"}')).toBeNull()
    expect(parseLatestNpmVersion('{"version":["1.0.0"]}')).toBeNull()
    expect(parseLatestNpmVersion('<html>registry error</html>')).toBeNull()
  })

  it('reads a strictly validated local Grok version metadata file', () => {
    expect(parseGrokLocalVersion('{"version":"0.2.112","stable_version":"0.2.111"}'))
      .toBe('0.2.112')
    expect(parseGrokLocalVersion('{"stable_version":"0.2.112"}')).toBe('0.2.112')
    expect(parseGrokLocalVersion('{"version":"latest"}')).toBeNull()
    expect(parseGrokLocalVersion('{"version":["0.2.112"]}')).toBeNull()
    expect(parseGrokLocalVersion('<html>')).toBeNull()
  })

  it('prefers Grok metadata beside the executable over stale root metadata', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-version-'))
    temporaryDirectories.push(home)
    const bin = path.join(home, '.grok', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const executable = path.join(bin, 'grok.exe')
    fs.writeFileSync(executable, 'test-binary')
    fs.writeFileSync(path.join(home, '.grok', 'version.json'), '{"version":"0.2.112"}\n', 'utf8')
    fs.writeFileSync(path.join(bin, 'version.json'), '{"version":"0.2.118"}\n', 'utf8')

    await expect(readGrokLocalVersionForExecutable(executable, {
      platform: 'win32',
      homeDirectory: home,
      managedDirectory: null,
    })).resolves.toBe('0.2.118')
  })

  it('distinguishes available and latest CLI versions', () => {
    expect(buildCliStatus({
      installed: true,
      version: 'codex-cli 0.145.0',
      path: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd',
    }, latest('0.146.0'))).toMatchObject({
      latestVersion: '0.146.0',
      updateAvailable: true,
      updateCheck: 'checked',
      updateState: 'available',
      updateError: null,
    })

    expect(buildCliStatus({
      installed: true,
      version: '2.1.218 (Claude Code)',
      path: 'claude.cmd',
    }, latest('2.1.218'))).toMatchObject({
      updateAvailable: false,
      updateCheck: 'checked',
      updateState: 'latest',
    })
  })

  it('uses the Grok official stable feed instead of the unrelated npm package', () => {
    expect(buildCliStatus({
      installed: true,
      version: 'grok 0.2.106 (bde89716f6)',
      path: 'C:\\Users\\tester\\.grok\\bin\\grok.exe',
    }, {
      ...latest('0.2.111'),
      source: 'official-manifest',
    })).toMatchObject({
      latestVersion: '0.2.111',
      updateAvailable: true,
      updateSource: 'official-manifest',
      updateCheck: 'checked',
      updateState: 'available',
      updateError: null,
    })
  })

  it('preserves npm query failures instead of treating them as latest', () => {
    expect(buildCliStatus({
      installed: true,
      version: '0.52.0',
      path: 'gemini.cmd',
    }, {
      status: 'failed',
      version: null,
      source: 'npm',
      checkedAt: '2026-07-24T00:00:00.000Z',
      error: 'npm latest 查询超时',
    })).toMatchObject({
      latestVersion: null,
      updateAvailable: false,
      updateCheck: 'failed',
      updateState: 'unknown',
      updateError: 'npm latest 查询超时',
    })
  })

  it('keeps skipped update checks quiet for tools that are not installed', () => {
    expect(buildCliStatus({
      installed: false,
      version: null,
      path: null,
      installDirectory: null,
    }, {
      status: 'skipped',
      version: null,
      source: 'npm',
      checkedAt: '2026-07-24T00:00:00.000Z',
      error: null,
    })).toMatchObject({
      installed: false,
      updateCheck: 'skipped',
      updateState: 'unknown',
      updateError: null,
    })
  })

  it('uses npm maintenance only for npm providers and rejects Grok bootstrap plans', () => {
    expect(() => buildCliMaintenancePlan('grok', null)).toThrow('已签名二进制')
    expect(buildCliMaintenancePlan(
      'codex',
      'C:\\Program Files\\nodejs\\npm.cmd',
      'C:\\ProgramData\\XingMangAI\\Cli\\npm',
    )).toEqual({
      kind: 'npm-install',
      executable: 'C:\\Program Files\\nodejs\\npm.cmd',
      argv: [
        'install',
        '--global',
        '--prefix=C:\\ProgramData\\XingMangAI\\Cli\\npm',
        '--ignore-scripts',
        '--omit=dev',
        '--package-lock=false',
        '@openai/codex@latest',
      ],
      windowsPackageManager: 'npm',
    })
    expect(buildCliMaintenancePlan(
      'claude',
      'C:\\Program Files\\nodejs\\npm.cmd',
      'C:\\ProgramData\\XingMangAI\\Cli\\npm',
      '2.1.220',
      true,
    ).argv).not.toContain('--ignore-scripts')
  })

  it('builds source-owned uninstall plans without deleting shared prefixes', () => {
    const npmInstallation = {
      commandPath: 'C:\\Users\\tester\\AppData\\Local\\hermes\\node\\codex.cmd',
      installDirectory: 'C:\\Users\\tester\\AppData\\Local\\hermes\\node\\node_modules\\@openai\\codex',
      packageRoot: 'C:\\Users\\tester\\AppData\\Local\\hermes\\node\\node_modules\\@openai\\codex',
      npmPrefix: 'C:\\Users\\tester\\AppData\\Local\\hermes\\node',
      source: 'npm' as const,
    }
    expect(buildCliUninstallPlan('codex', npmInstallation, 'C:\\Users\\tester\\AppData\\Local\\hermes\\node\\npm.cmd')).toEqual({
      kind: 'npm-uninstall',
      executable: 'C:\\Users\\tester\\AppData\\Local\\hermes\\node\\npm.cmd',
      argv: [
        'uninstall',
        '--global',
        '--prefix=C:\\Users\\tester\\AppData\\Local\\hermes\\node',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '@openai/codex',
      ],
      windowsPackageManager: 'npm',
      packageRoot: npmInstallation.packageRoot,
    })
    expect(buildCliUninstallPlan('grok', {
      commandPath: 'C:\\Users\\tester\\.grok\\bin\\grok.exe',
      installDirectory: 'C:\\Users\\tester\\.grok\\bin',
      packageRoot: null,
      npmPrefix: null,
      source: 'native',
    }, null)).toEqual({ kind: 'grok-native' })
    expect(buildCliUninstallPlan('claude', {
      commandPath: 'C:\\Users\\tester\\.local\\bin\\claude.exe',
      installDirectory: 'C:\\Users\\tester\\.local\\bin',
      packageRoot: null,
      npmPrefix: null,
      source: 'native',
    }, null)).toEqual({ kind: 'claude-native' })
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
    ])
    expect(buildCodexDesktopPackageSources('arm64')).toEqual([
      {
        label: '国内镜像',
        url: 'https://codexapp.agentsmirror.com/latest/win-arm64',
      },
    ])
    expect(buildCodexDesktopManifestSources()).toEqual([
      {
        kind: 'official',
        label: 'OpenAI 官方源',
        url: 'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json',
      },
      {
        kind: 'mirror',
        label: '国内镜像',
        url: 'https://codexapp.agentsmirror.com/latest/manifest',
      },
    ])
  })

  it('reads and validates the selected architecture from the AgentsMirror manifest', async () => {
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
    const response = new Response(JSON.stringify(manifest), {
      headers: { 'Content-Type': 'application/json' },
    })
    Object.defineProperty(response, 'url', {
      value: storageUrl,
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(response)

    await expect(fetchCodexDesktopMirrorRelease('x64', fetchMock)).resolves.toEqual({
      version: '26.721.3996.0',
      architecture: 'x64',
      contentLength: 744072561,
      sha256Base64: '0a/lZGhbNAxLAd6xFNfKeRJZzzJzNErA1E5IYWnqHjM=',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://codexapp.agentsmirror.com/latest/manifest',
      expect.objectContaining({ redirect: 'manual' }),
    )
    expect(fetchMock.mock.calls[1][0]).toBe(storageUrl)
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
  }, 15_000)

  it.skipIf(process.platform !== 'win32')('rejects an oversized compressed AppxManifest before XML parsing', async () => {
    const packagePath = createTestMsix([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">',
      `  <!-- ${'x'.repeat(1024 * 1024)} -->`,
      '  <Identity Name="OpenAI.Codex" Publisher="CN=invalid" Version="1.0.0.0" ProcessorArchitecture="x64" />',
      '</Package>',
    ].join('\n'))

    await expect(inspectCodexDesktopPackageFile(packagePath)).rejects.toThrow('1 MiB 安全上限')
  }, 15_000)

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
