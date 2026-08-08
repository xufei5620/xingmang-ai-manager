import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore, defaultAppSettings } from './app-settings'
import { providerConfigRoot, type ProviderConfigRoots } from './codex-home'
import { providerConfigPaths } from './config-files'
import type { MacosCodexAppInfo } from './macos-codex-app'
import { managedNpmCacheRoot, managedNpmPrefix } from './managed-cli-paths'
import {
  resolveCliCommand as resolveVerifiedToolCommand,
  resolveCliInstallation as resolveCliInstallationForTest,
} from './tool-installation'
import { windowsPowerShellExecutable } from './windows-elevation'
import {
  assertNpmPackageLocksEquivalent,
  assertNpmReleaseIntegrityMatches,
  assertNpmReleaseMatchesOfficialLock,
  buildCliStatus,
  buildCliMaintenancePlan,
  buildDarwinCliLaunchPlan,
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
  inspectVerifiedDarwinGrokPostInstall,
  interactiveTerminalEnvironment,
  modelAccessCacheKey,
  ManagedNpmRollbackError,
  detectNetworkLocation,
  detectNetworkRegion,
  fetchNpmPackageReleaseMetadata,
  grokInstallStrategyFor,
  grokManualUninstallResult,
  formatElapsedDuration,
  npmDownloadTimeoutMs,
  npmInstallRegistries,
  npmRegistryLabel,
  npmResolutionHeartbeatMessage,
  npmResolutionStartMessage,
  npmResolutionTimeoutMs,
  npmPackageLatestUrl,
  npmPackageVersionUrl,
  parseNpmPackageReleaseMetadata,
  parseCloudflareNetworkRegion,
  parseCloudflareNetworkLocation,
  parseGrokLocalVersion,
  parseLatestNpmVersion,
  providerCommandEnvironment,
  readGrokLocalVersionForExecutable,
  resolveCliInstallRelease,
  replaceManagedNpmPrefixAtomically,
  uninstallVerifiedDarwinGrokInstallation,
  validateCodexDesktopResourceUrl,
  type LatestVersionProbe,
} from './system-service'

const temporaryDirectories: string[] = []

function createService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-system-service-'))
  temporaryDirectories.push(directory)
  return createSystemService(new AppSettingsStore(path.join(directory, 'settings.json'), directory))
}

async function createDarwinService(options: {
  workspace?: string
  configured?: boolean
  codexHome?: string
  macosCodexAppDetector?: () => Promise<MacosCodexAppInfo | null>
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-desktop-'))
  temporaryDirectories.push(directory)
  const workspace = options.workspace ?? directory
  const codexHome = options.codexHome ?? path.join(directory, 'selected-codex-home')
  const codexEnv = { ...process.env, HOME: directory, CODEX_HOME: codexHome }
  const store = new AppSettingsStore(path.join(directory, 'settings.json'), directory)
  await store.write({ ...defaultAppSettings(directory), workspace })
  const resolvedCommand = {
    executable: '/opt/homebrew/bin/node',
    argv: [
      '/Users/tester/.npm-global/lib/node_modules/@openai/codex/bin/codex.js',
      '--existing-flag',
    ],
    release: vi.fn(async () => undefined),
  }
  const resolveCli = vi.fn(async () => resolvedCommand)
  const execute = vi.fn(async (spec: { executable: string; argv: readonly string[] }) => ({
    executable: spec.executable,
    argv: [...spec.argv],
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    outputBytes: 0,
    durationMs: 1,
  }))
  const inspectConfig = vi.fn(() => ({
    baseUrl: 'https://api.solov.cc',
    actualBaseUrl: options.configured === false ? 'https://example.invalid' : 'https://api.solov.cc',
    exists: true,
    hasApiKey: true,
    matchesRelay: options.configured !== false,
    apiKey: 'sk-test-key',
    model: 'gpt-5.6-sol',
    dataDirectory: path.join(directory, '.codex'),
    dataDirectoryExists: true,
    files: [],
    updatedAt: '2026-08-03T00:00:00.000Z',
  }))
  const macosCodexAppDetector = options.macosCodexAppDetector ?? vi.fn(async () => null)
  const service = createSystemService(store, {
    platform: 'darwin',
    providerRoots: { userHome: directory, codexHome },
    codexEnv,
    inspectProviderConfig: inspectConfig,
    resolveCliCommand: resolveCli,
    runCommand: execute,
    macosCodexAppDetector,
  })
  return {
    service,
    workspace,
    codexEnv,
    resolvedCommand,
    resolveCli,
    execute,
    release: resolvedCommand.release,
  }
}

function createDarwinStandaloneMaintenanceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-standalone-maintenance-'))
  temporaryDirectories.push(root)
  const home = path.join(root, "User's Home")
  const codexHome = path.join(root, "Configured Codex Home's Directory")
  const target = process.arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin'
  const version = '0.146.0'
  const standaloneRoot = path.join(codexHome, 'packages', 'standalone')
  const releaseRoot = path.join(standaloneRoot, 'releases', `${version}-${target}`)
  const executablePath = path.join(releaseRoot, 'bin', 'codex')
  const executionMarker = path.join(root, 'post-verifier-version-execution')
  const quotedExecutionMarker = `'${executionMarker.replaceAll("'", `'"'"'`)}'`
  fs.mkdirSync(path.dirname(executablePath), { recursive: true })
  fs.writeFileSync(executablePath, [
    '#!/bin/sh',
    `printf 'executed\\n' >> ${quotedExecutionMarker}`,
    `printf 'codex-cli ${version}\\n'`,
    '',
  ].join('\n'), 'utf8')
  fs.chmodSync(executablePath, 0o700)
  fs.writeFileSync(path.join(releaseRoot, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1,
    version,
    target,
    variant: 'codex',
    entrypoint: 'bin/codex',
  }), 'utf8')
  const currentLink = path.join(standaloneRoot, 'current')
  fs.mkdirSync(path.dirname(currentLink), { recursive: true })
  fs.symlinkSync(path.join('releases', `${version}-${target}`), currentLink)
  const visibleCommand = path.join(home, '.local', 'bin', 'codex')
  fs.mkdirSync(path.dirname(visibleCommand), { recursive: true })
  fs.symlinkSync(path.join(currentLink, 'bin', 'codex'), visibleCommand)
  return { codexHome, executablePath, executionMarker, home, releaseRoot, version, visibleCommand }
}

function createDarwinGrokUninstallFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-grok-uninstall-'))
  temporaryDirectories.push(home)
  const grokRoot = path.join(home, '.grok')
  const bin = path.join(grokRoot, 'bin')
  const downloads = path.join(grokRoot, 'downloads')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(downloads, { recursive: true })
  const grokBinary = path.join(downloads, 'grok-0.2.118-macos-aarch64')
  const agentBinary = path.join(downloads, 'grok-0.2.111-macos-aarch64')
  fs.writeFileSync(grokBinary, 'grok binary', { mode: 0o700 })
  fs.writeFileSync(agentBinary, 'agent binary', { mode: 0o700 })
  const grokTarget = path.join('..', 'downloads', path.basename(grokBinary))
  const agentTarget = path.join('..', 'downloads', path.basename(agentBinary))
  fs.symlinkSync(grokTarget, path.join(bin, 'grok'))
  fs.symlinkSync(agentTarget, path.join(bin, 'agent'))
  fs.writeFileSync(path.join(bin, 'keep.txt'), 'keep')
  const configFile = path.join(grokRoot, 'config.json')
  const sessionFile = path.join(grokRoot, 'sessions', 'session.json')
  const backupFile = path.join(grokRoot, 'backups', 'backup.json')
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
  fs.mkdirSync(path.dirname(backupFile), { recursive: true })
  fs.writeFileSync(configFile, 'config')
  fs.writeFileSync(sessionFile, 'session')
  fs.writeFileSync(backupFile, 'backup')
  return {
    agentBinary,
    agentTarget,
    backupFile,
    bin,
    configFile,
    grokBinary,
    grokTarget,
    home,
    sessionFile,
  }
}

function officialDarwinGrokUninstallResult(
  fixture: ReturnType<typeof createDarwinGrokUninstallFixture>,
  spec: { executable: string; argv: readonly string[] },
) {
  if (
    spec.executable === '/usr/bin/codesign'
    && spec.argv[0] === '--verify'
    && spec.argv[1] === '--strict'
  ) {
    return { stdout: '', stderr: '' }
  }
  if (
    spec.executable === '/usr/bin/codesign'
    && spec.argv[0] === '-dv'
    && spec.argv[1] === '--verbose=4'
  ) {
    return {
      stdout: '',
      stderr: [
        'Authority=Developer ID Application: X.AI Corporation (5Y6N3AJ54S)',
        'TeamIdentifier=5Y6N3AJ54S',
      ].join('\n'),
    }
  }
  if (
    spec.argv.length === 1
    && spec.argv[0] === '--version'
  ) {
    const executableName = path.basename(spec.executable)
    const version = executableName === 'agent' || executableName.includes('0.2.111')
      ? '0.2.111'
      : '0.2.118'
    return { stdout: `grok ${version}\n`, stderr: '' }
  }
  throw new Error(`Unexpected Grok verification command: ${spec.executable} ${spec.argv.join(' ')}`)
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('createSystemService', () => {
  it('uses provider roots for config surfaces and codexEnv only for Codex CLI work', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-rooted-system-service-'))
    temporaryDirectories.push(root)
    const userHome = path.join(root, 'home')
    const codexHome = path.join(root, 'custom-codex')
    const providerRoots: ProviderConfigRoots = { userHome, codexHome }
    const codexEnv = { ...process.env, HOME: userHome, CODEX_HOME: codexHome }
    const inspect = vi.fn((provider: Parameters<typeof providerConfigRoot>[0], roots: ProviderConfigRoots) => ({
      baseUrl: 'https://api.solov.cc',
      actualBaseUrl: 'https://api.solov.cc',
      exists: true,
      apiKey: provider === 'codex' ? 'sk-codex' : 'sk-other',
      hasApiKey: true,
      matchesRelay: true,
      model: 'gpt-5.6-sol',
      dataDirectory: providerConfigRoot(provider, roots),
      dataDirectoryExists: true,
      files: providerConfigPaths(provider, roots).map((filePath) => ({ path: filePath, exists: true })),
      updatedAt: '2026-08-03T00:00:00.000Z',
    }))
    const service = createSystemService(
      new AppSettingsStore(path.join(root, 'settings.json'), root),
      { providerRoots, codexEnv, inspectProviderConfig: inspect },
    )

    service.getConfig(false)
    service.inspectCodexReadiness(false)
    expect(service.revealApiKey('codex', false)).toBe('sk-codex')
    expect(inspect).toHaveBeenCalledWith('codex', providerRoots)

    expect(providerCommandEnvironment('codex', { HOME: userHome }, codexEnv)).toMatchObject({
      HOME: userHome,
      CODEX_HOME: codexHome,
    })
    expect(providerCommandEnvironment('grok', { HOME: userHome }, codexEnv).CODEX_HOME).toBeUndefined()
  })

  it('delegates settings reads and durable writes to AppSettingsStore', async () => {
    const service = createService()
    const initial = service.readStoredConfig()
    expect(initial).toEqual(defaultAppSettings(initial.workspace))

    await service.writeStoredConfig({ ...initial, theme: 'light' })

    expect(service.readStoredConfig()).toMatchObject({ theme: 'light', workspace: initial.workspace })
  })

  it('saves provider configuration under the injected roots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-rooted-system-save-'))
    temporaryDirectories.push(root)
    const userHome = path.join(root, 'home')
    const codexHome = path.join(root, 'custom-codex')
    const fallbackCodexHome = path.join(root, 'default-codex-trap')
    vi.stubEnv('HOME', userHome)
    vi.stubEnv('CODEX_HOME', fallbackCodexHome)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gpt-5.6-sol' }],
    }), { status: 200 })))
    const service = createSystemService(
      new AppSettingsStore(path.join(root, 'settings.json'), root),
      {
        providerRoots: { userHome, codexHome },
        codexEnv: { ...process.env, HOME: userHome, CODEX_HOME: codexHome },
      },
    )

    const result = await service.saveConfig({
      provider: 'codex',
      apiKey: 'sk-rooted-save',
      model: 'gpt-5.6-sol',
      mode: 'reset',
    }, false)

    expect(result.files).toEqual(providerConfigPaths('codex', {
      userHome,
      codexHome,
    }))
    expect(fs.existsSync(fallbackCodexHome)).toBe(false)
  })

  it('uses codexEnv for Codex CLI discovery, resolution, and version inspection', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-inspection-env-'))
    temporaryDirectories.push(root)
    const runtimeBin = path.join(root, 'runtime-bin')
    const providerBin = path.join(root, 'provider-bin')
    const fakeNpmRoot = path.join(root, 'npm-root')
    const executionMarker = path.join(root, 'provider-executed')
    fs.mkdirSync(runtimeBin, { recursive: true })
    fs.mkdirSync(providerBin, { recursive: true })
    fs.mkdirSync(fakeNpmRoot, { recursive: true })
    for (const executable of ['node', 'npm']) {
      const executablePath = path.join(runtimeBin, executable)
      fs.writeFileSync(executablePath, executable === 'npm'
        ? '#!/bin/sh\nprintf "%s\\n" "$XINGMANG_FAKE_NPM_ROOT"\n'
        : '#!/bin/sh\nexit 0\n')
      fs.chmodSync(executablePath, 0o700)
    }
    const codexExecutable = path.join(providerBin, 'codex')
    fs.writeFileSync(codexExecutable, `#!/bin/sh\nprintf executed > '${executionMarker}'\nexit 99\n`)
    fs.chmodSync(codexExecutable, 0o700)
    vi.stubEnv('PATH', runtimeBin)
    vi.stubEnv('XINGMANG_FAKE_NPM_ROOT', fakeNpmRoot)
    vi.stubEnv('CODEX_HOME', '')
    const userHome = path.join(root, 'home')
    const codexHome = path.join(root, 'custom-codex')
    const codexEnv = {
      ...process.env,
      HOME: userHome,
      CODEX_HOME: codexHome,
      PATH: `${providerBin}${path.delimiter}${runtimeBin}`,
    }
    const resolveCli = vi.fn(async () => ({ executable: codexExecutable, argv: [] }))
    const execute = vi.fn(async (spec: { executable: string; argv: readonly string[] }) => ({
      executable: spec.executable,
      argv: [...spec.argv],
      exitCode: 0,
      signal: null,
      stdout: spec.executable === codexExecutable ? 'codex-cli 1.2.3\n' : '1.2.3\n',
      stderr: '',
      outputBytes: 16,
      durationMs: 1,
    }))
    const service = createSystemService(
      new AppSettingsStore(path.join(root, 'settings.json'), root),
      {
        platform: 'linux',
        providerRoots: { userHome, codexHome },
        codexEnv,
        resolveCliCommand: resolveCli,
        runCommand: execute,
        macosCodexAppDetector: async () => null,
      },
    )

    const setup = await service.inspectCodexSetupStatus()

    expect(setup.cli).toMatchObject({ installed: true, path: codexExecutable })
    expect(resolveCli.mock.calls[0]?.[1]).toMatchObject({
      HOME: userHome,
      CODEX_HOME: codexHome,
    })
    const versionCall = execute.mock.calls.find(([spec]) => spec.executable === codexExecutable)
    expect(versionCall?.[1]).toMatchObject({
      env: expect.objectContaining({ HOME: userHome, CODEX_HOME: codexHome }),
    })
    expect(fs.existsSync(executionMarker)).toBe(false)
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

describe.runIf(process.platform === 'darwin')('Darwin Grok automatic uninstall integration', () => {
  it('inspects a postinstall Grok only through a released private staged executable', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    const specs: Array<{ executable: string; argv: readonly string[] }> = []

    const inspected = await inspectVerifiedDarwinGrokPostInstall({
      homeDirectory: fixture.home,
      expectedVersion: '0.2.118',
      runCommand: async (spec) => {
        specs.push(spec)
        return officialDarwinGrokUninstallResult(fixture, spec)
      },
    })

    const sourceExecutable = fs.realpathSync(fixture.grokBinary)
    const stagedExecutable = specs[0]?.argv[2]
    expect(stagedExecutable).toEqual(expect.any(String))
    expect(stagedExecutable).not.toBe(sourceExecutable)
    expect(specs).toEqual([
      { executable: '/usr/bin/codesign', argv: ['--verify', '--strict', stagedExecutable!] },
      { executable: '/usr/bin/codesign', argv: ['-dv', '--verbose=4', stagedExecutable!] },
      { executable: stagedExecutable!, argv: ['--version'] },
    ])
    expect(inspected).toMatchObject({
      status: {
        installed: true,
        version: '0.2.118',
        path: sourceExecutable,
        installDirectory: fs.realpathSync(fixture.bin),
      },
      installation: {
        commandPath: path.join(fixture.bin, 'grok'),
        installDirectory: fs.realpathSync(fixture.bin),
        source: 'native',
      },
    })
    expect(fs.existsSync(path.dirname(stagedExecutable!))).toBe(false)
  })

  it('reports retained verified program paths after removing only the command entries', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    const specs: Array<{ executable: string; argv: readonly string[] }> = []
    const sourceExecutables = [
      fs.realpathSync(fixture.grokBinary),
      fs.realpathSync(fixture.agentBinary),
    ]

    await expect(uninstallVerifiedDarwinGrokInstallation({
      homeDirectory: fixture.home,
      installDirectory: fs.realpathSync(fixture.bin),
      runCommand: async (spec) => {
        specs.push(spec)
        return officialDarwinGrokUninstallResult(fixture, spec)
      },
    })).rejects.toThrow(/自动卸载未完整完成.*\.removing.*grok-0\.2\.118/s)

    expect(fs.existsSync(path.join(fixture.bin, 'grok'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.bin, 'agent'))).toBe(false)
    expect(fs.readFileSync(fixture.grokBinary, 'utf8')).toBe('grok binary')
    expect(fs.readFileSync(fixture.agentBinary, 'utf8')).toBe('agent binary')
    expect(fs.readdirSync(fixture.bin).filter((name) => name.endsWith('.removing'))).toHaveLength(2)
    expect(fs.readFileSync(path.join(fixture.bin, 'keep.txt'), 'utf8')).toBe('keep')
    expect(fs.readFileSync(fixture.configFile, 'utf8')).toBe('config')
    expect(fs.readFileSync(fixture.sessionFile, 'utf8')).toBe('session')
    expect(fs.readFileSync(fixture.backupFile, 'utf8')).toBe('backup')
    expect(specs.some((spec) => sourceExecutables.includes(spec.executable)
      || spec.argv.some((argument) => sourceExecutables.includes(argument)))).toBe(false)
    const stagedExecutables = specs
      .filter((spec) => spec.argv[0] === '--version')
      .map((spec) => spec.executable)
    expect(stagedExecutables.map((executable) => path.basename(executable))).toEqual(['grok', 'agent'])
    expect(stagedExecutables.every((executable) => !fs.existsSync(path.dirname(executable)))).toBe(true)
  })

  it.each([
    ['missing link', 'Grok automatic uninstall requires both grok and agent verified symbolic links'],
    ['escaped target', 'Grok agent link target must remain under ~/.grok'],
    ['wrong owner', 'Grok CLI 符号链接 agent 所有者与卸载计划不一致'],
    ['wrong type', 'Grok canonical link must be a symbolic link'],
    ['link identity replacement', 'Grok CLI 符号链接 grok 身份与卸载计划不一致'],
    ['quarantine race', 'Grok CLI 隔离文件 grok 在最终删除前发生变化'],
  ])('returns manual help after %s validation failure', (_case, message) => {
    expect(grokManualUninstallResult('0.2.118', new Error(message))).toEqual({
      outcome: 'manual-required',
      previousVersion: '0.2.118',
      error: message,
      manualHelp: {
        reason: `自动卸载安全验证失败：${message}`,
        manualCommand: null,
      },
    })
  })

  it('returns manual-required from the public service after automatic validation fails', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    fs.unlinkSync(path.join(fixture.bin, 'agent'))
    vi.stubEnv('HOME', fs.realpathSync(fixture.home))
    vi.stubEnv('PATH', fixture.bin)
    const store = new AppSettingsStore(
      path.join(fixture.home, 'settings.json'),
      fixture.home,
    )
    const service = createSystemService(store, {
      platform: 'darwin',
      runCommand: async (spec) => {
        const result = officialDarwinGrokUninstallResult(fixture, spec)
        return {
          ...result,
          executable: spec.executable,
          argv: [...spec.argv],
          exitCode: 0,
          signal: null,
          outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
          durationMs: 1,
        }
      },
    })

    await expect(service.uninstallCli('grok')).resolves.toMatchObject({
      outcome: 'manual-required',
      manualHelp: { manualCommand: null },
      error: expect.stringContaining('both grok and agent'),
    })
    expect(fs.readlinkSync(path.join(fixture.bin, 'grok'))).toBe(fixture.grokTarget)
  })

  it('returns manual-required and restores links when a target changes after quarantine starts', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    vi.stubEnv('HOME', fs.realpathSync(fixture.home))
    vi.stubEnv('PATH', fixture.bin)
    const store = new AppSettingsStore(
      path.join(fixture.home, 'settings.json'),
      fixture.home,
    )
    let targetReplaced = false
    const grokLink = path.join(fixture.bin, 'grok')
    const agentLink = path.join(fixture.bin, 'agent')
    const canonicalBin = fs.realpathSync(fixture.bin)
    const rename = fs.promises.rename.bind(fs.promises)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
      await rename(oldPath, newPath)
      if (
        !targetReplaced
        && path.dirname(String(oldPath)) === canonicalBin
        && path.basename(String(oldPath)) === 'grok'
      ) {
        targetReplaced = true
        fs.unlinkSync(fixture.grokBinary)
        fs.writeFileSync(fixture.grokBinary, 'replacement', { mode: 0o700 })
      }
    })
    const service = createSystemService(store, {
      platform: 'darwin',
      runCommand: async (spec) => {
        const result = officialDarwinGrokUninstallResult(fixture, spec)
        return {
          ...result,
          executable: spec.executable,
          argv: [...spec.argv],
          exitCode: 0,
          signal: null,
          outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
          durationMs: 1,
        }
      },
    })

    await expect(service.uninstallCli('grok')).resolves.toMatchObject({
      outcome: 'manual-required',
      manualHelp: { manualCommand: null },
      error: expect.stringContaining('目标'),
    })
    expect(targetReplaced).toBe(true)
    expect(fs.readlinkSync(grokLink)).toBe(fixture.grokTarget)
    expect(fs.readlinkSync(agentLink)).toBe(fixture.agentTarget)
  })

  it('returns manual-required instead of uninstalled while verified program paths remain', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    vi.stubEnv('HOME', fs.realpathSync(fixture.home))
    vi.stubEnv('PATH', fixture.bin)
    const store = new AppSettingsStore(
      path.join(fixture.home, 'settings.json'),
      fixture.home,
    )
    const service = createSystemService(store, {
      platform: 'darwin',
      runCommand: async (spec) => {
        const result = officialDarwinGrokUninstallResult(fixture, spec)
        return {
          ...result,
          executable: spec.executable,
          argv: [...spec.argv],
          exitCode: 0,
          signal: null,
          outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
          durationMs: 1,
        }
      },
    })

    await expect(service.uninstallCli('grok')).resolves.toMatchObject({
      outcome: 'manual-required',
      previousVersion: '0.2.118',
      error: expect.stringMatching(/自动卸载未完整完成.*\.removing.*grok-0\.2\.118/s),
      manualHelp: { manualCommand: null },
    })
    expect(fs.existsSync(path.join(fixture.bin, 'grok'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.bin, 'agent'))).toBe(false)
    const retainedNames = fs.readdirSync(fixture.bin)
      .filter((name) => /^\.(?:grok|agent)-.+\.removing$/.test(name))
    expect(retainedNames).toHaveLength(2)
    expect(fs.readFileSync(fixture.grokBinary, 'utf8')).toBe('grok binary')
    expect(fs.readFileSync(fixture.agentBinary, 'utf8')).toBe('agent binary')
    expect(fs.readFileSync(fixture.configFile, 'utf8')).toBe('config')
    expect(fs.readFileSync(fixture.sessionFile, 'utf8')).toBe('session')
    expect(fs.readFileSync(fixture.backupFile, 'utf8')).toBe('backup')
  })

  it('requires both official links and leaves the canonical link untouched when agent is absent', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    fs.unlinkSync(path.join(fixture.bin, 'agent'))

    await expect(uninstallVerifiedDarwinGrokInstallation({
      homeDirectory: fixture.home,
      installDirectory: fs.realpathSync(fixture.bin),
      runCommand: async (spec) => officialDarwinGrokUninstallResult(fixture, spec),
    })).rejects.toThrow('both grok and agent')

    expect(fs.readlinkSync(path.join(fixture.bin, 'grok'))).toBe(fixture.grokTarget)
    expect(fs.readFileSync(fixture.grokBinary, 'utf8')).toBe('grok binary')
  })

  it('leaves the official bin directory in place when it contains only the verified links', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    fs.unlinkSync(path.join(fixture.bin, 'keep.txt'))

    await expect(uninstallVerifiedDarwinGrokInstallation({
      homeDirectory: fixture.home,
      installDirectory: fs.realpathSync(fixture.bin),
      runCommand: async (spec) => officialDarwinGrokUninstallResult(fixture, spec),
    })).rejects.toThrow('自动卸载未完整完成')

    expect(fs.statSync(fixture.bin).isDirectory()).toBe(true)
    expect(fs.readFileSync(fixture.grokBinary, 'utf8')).toBe('grok binary')
    expect(fs.readFileSync(fixture.agentBinary, 'utf8')).toBe('agent binary')
  })

  it('fails closed without moving links when an official-looking target escapes the Grok root', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    const outside = path.join(fixture.home, 'outside', path.basename(fixture.agentBinary))
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    fs.writeFileSync(outside, 'outside', { mode: 0o700 })
    fs.unlinkSync(path.join(fixture.bin, 'agent'))
    fs.symlinkSync(path.join('..', '..', 'outside', path.basename(outside)), path.join(fixture.bin, 'agent'))

    await expect(uninstallVerifiedDarwinGrokInstallation({
      homeDirectory: fixture.home,
      installDirectory: fs.realpathSync(fixture.bin),
      runCommand: async (spec) => officialDarwinGrokUninstallResult(fixture, spec),
    })).rejects.toThrow(/official uninstall layout|under ~\/\.grok|remain under/)

    expect(fs.readlinkSync(path.join(fixture.bin, 'grok'))).toBe(fixture.grokTarget)
    expect(fs.readlinkSync(path.join(fixture.bin, 'agent'))).toContain('outside')
    expect(fs.readFileSync(fixture.grokBinary, 'utf8')).toBe('grok binary')
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

  it('uses the xAI stable manifest release as the exact Darwin Grok npm pin', async () => {
    const requestedVersions: string[] = []
    const release = await resolveCliInstallRelease('grok', 'darwin-official-npm', {
      fetchGrokStableVersion: async () => ({
        version: '0.2.118',
        sourceUrl: 'https://x.ai/cli/stable',
      }),
      fetchNpmRelease: async (_registry, _packageName, version) => {
        requestedVersions.push(version)
        return { name: '@xai-official/grok', version: '0.2.118', integrity }
      },
    })

    expect(requestedVersions).toEqual(['0.2.118'])
    expect(release).toMatchObject({ name: '@xai-official/grok', version: '0.2.118' })
  })

  it('rejects a Darwin Grok npm response that differs from the xAI stable manifest', async () => {
    await expect(resolveCliInstallRelease('grok', 'darwin-official-npm', {
      fetchGrokStableVersion: async () => ({
        version: '0.2.118',
        sourceUrl: 'https://x.ai/cli/stable',
      }),
      fetchNpmRelease: async () => ({
        name: '@xai-official/grok',
        version: '0.2.119',
        integrity,
      }),
    })).rejects.toThrow('官方稳定版本')
  })

  it('keeps other npm providers on their latest npm release selector', async () => {
    const requestedVersions: string[] = []
    await resolveCliInstallRelease('codex', null, {
      fetchGrokStableVersion: async () => {
        throw new Error('must not query Grok stable metadata')
      },
      fetchNpmRelease: async (_registry, _packageName, version) => {
        requestedVersions.push(version)
        return { name: '@openai/codex', version: '0.146.0', integrity }
      },
    })

    expect(requestedVersions).toEqual(['latest'])
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

  it('rejects an official lock whose direct package integrity differs from release metadata', () => {
    const lockIntegrity = `sha512-${Buffer.alloc(64, 0x31).toString('base64')}`
    const releaseIntegrity = `sha512-${Buffer.alloc(64, 0x32).toString('base64')}`
    const officialLock = JSON.stringify({
      name: 'xingmang-cli-resolution',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          dependencies: { '@xai-official/grok': '0.2.118' },
        },
        'node_modules/@xai-official/grok': {
          version: '0.2.118',
          integrity: lockIntegrity,
        },
      },
    })

    expect(() => assertNpmReleaseMatchesOfficialLock({
      name: '@xai-official/grok',
      version: '0.2.118',
      integrity: releaseIntegrity,
    }, officialLock)).toThrow('官方 package-lock')
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

describe.runIf(process.platform === 'darwin')('Darwin managed npm update integration', () => {
  it('preserves the previous CLI when post-promotion verification fails', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-npm-update-'))
    temporaryDirectories.push(temporaryRoot)
    const root = fs.realpathSync(temporaryRoot)
    const homeDirectory = path.join(root, 'home')
    const runtimeBin = path.join(homeDirectory, '.local', 'bin')
    fs.mkdirSync(runtimeBin, { recursive: true })
    vi.stubEnv('HOME', homeDirectory)
    vi.stubEnv('PATH', runtimeBin)

    const env = { ...process.env, HOME: homeDirectory }
    const activePrefix = managedNpmPrefix(env, 'darwin')
    const cacheRoot = managedNpmCacheRoot(env, 'darwin')
    const activePackageRoot = path.join(activePrefix, 'lib', 'node_modules', '@openai', 'codex')
    const activeCommand = path.join(activePrefix, 'bin', 'codex')
    fs.mkdirSync(activePackageRoot, { recursive: true })
    fs.mkdirSync(path.dirname(activeCommand), { recursive: true })
    fs.writeFileSync(path.join(activePackageRoot, 'package.json'), JSON.stringify({
      name: '@openai/codex',
      version: '0.145.0',
    }))
    fs.writeFileSync(activeCommand, '#!/bin/sh\nprintf old-cli\\n')
    fs.chmodSync(activeCommand, 0o700)

    const npmExecutable = path.join(runtimeBin, 'npm')
    fs.writeFileSync(npmExecutable, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(npmExecutable, 0o700)
    const expectedVersion = '0.146.0'
    const integrity = `sha512-${Buffer.alloc(64, 0x31).toString('base64')}`
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('cloudflare.com/cdn-cgi/trace')) {
        return new Response('ip=203.0.113.8\nloc=US\n', { status: 200 })
      }
      if (url === npmPackageLatestUrl('https://registry.npmjs.org', '@openai/codex')) {
        return new Response(JSON.stringify({
          name: '@openai/codex',
          version: expectedVersion,
          dist: { integrity },
        }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    let lifecyclePrefix: string | null = null
    const runCommand = vi.fn(async (
      spec: { executable: string; argv: readonly string[] },
      options: { cwd?: string } = {},
    ) => {
      if (spec.executable !== npmExecutable) {
        throw new Error(`Unexpected command: ${spec.executable}`)
      }
      const cwd = options.cwd
      if (!cwd) throw new Error('Fake npm requires cwd')
      if (spec.argv.includes('--package-lock-only')) {
        const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
          name: string
          version: string
          dependencies: Record<string, string>
        }
        const [[packageName, version]] = Object.entries(manifest.dependencies)
        fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          lockfileVersion: 3,
          packages: {
            '': { dependencies: manifest.dependencies },
            [`node_modules/${packageName}`]: { version, integrity },
          },
        }))
      } else if (spec.argv[0] === 'install' && spec.argv.includes('--global')) {
        const prefixArgument = spec.argv.find((argument) => argument.startsWith('--prefix='))
        if (!prefixArgument) throw new Error('Managed install omitted --prefix')
        lifecyclePrefix = prefixArgument.slice('--prefix='.length)
        const packageRoot = path.join(
          lifecyclePrefix,
          'lib',
          'node_modules',
          '@openai',
          'codex',
        )
        fs.rmSync(packageRoot, { recursive: true, force: true })
        fs.mkdirSync(packageRoot, { recursive: true })
        fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
          name: '@openai/codex',
          version: expectedVersion,
        }))
        fs.rmSync(path.join(lifecyclePrefix, 'bin', 'codex'), { force: true })
      }
      return {
        executable: spec.executable,
        argv: [...spec.argv],
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        outputBytes: 0,
        durationMs: 1,
      }
    })
    const target = { isDestroyed: () => false, send: vi.fn() }
    const resolveCliInstallation = vi.fn<typeof resolveCliInstallationForTest>(async (
      provider,
      options,
    ) => {
      expect(provider).toBe('codex')
      expect(options.npmGlobalRoot).toBe(path.join(activePrefix, 'lib', 'node_modules'))
      return null
    })
    const service = createSystemService(
      new AppSettingsStore(path.join(root, 'settings.json'), root),
      {
        platform: 'darwin',
        runCommand,
        resolveCliInstallation,
      },
    )

    await expect(service.installCli('codex', target)).rejects.toThrow()

    expect(JSON.parse(fs.readFileSync(
      path.join(activePackageRoot, 'package.json'),
      'utf8',
    ))).toMatchObject({ version: '0.145.0' })
    expect(fs.readFileSync(activeCommand, 'utf8')).toContain('old-cli')
    expect(lifecyclePrefix).not.toBe(activePrefix)
    expect(path.relative(cacheRoot, lifecyclePrefix!)).not.toMatch(/^\.\.(?:[/\\]|$)/)
    expect(resolveCliInstallation).toHaveBeenCalledTimes(1)
    expect(target.send).not.toHaveBeenCalledWith(
      'cli:install-progress',
      expect.objectContaining({ state: 'success' }),
    )
  })
})

describe('npm install progress reporting', () => {
  it('separates the resolution budget from the download budget', () => {
    // Sharing one budget let a slow official resolution eat the time the
    // download still needed, and killed a slow-but-working resolution at 5min.
    expect(npmResolutionTimeoutMs).toBeGreaterThan(npmDownloadTimeoutMs)
    expect(npmDownloadTimeoutMs).toBe(5 * 60_000)
  })

  it('keeps the resolution ceiling within a range a user will actually wait out', () => {
    // Measured on Windows: every managed CLI resolves 7-12 packages in 1-4s.
    // A long wait means a struggling connection, not a large graph, so the
    // ceiling exists to avoid killing slow-but-progressing resolutions rather
    // than to accommodate expected work.
    expect(npmResolutionTimeoutMs).toBeLessThanOrEqual(10 * 60_000)
  })

  it('tells the user why the official source cannot be replaced by a mirror', () => {
    const message = npmResolutionStartMessage('https://registry.npmjs.org')

    expect(message).toContain('官方源')
    expect(message).toContain('镜像无法代替')
    // Managing the expectation is the whole point: a wait is possible and does
    // not slow down what comes after. It must not promise a duration - measured
    // resolution is 1-4s on a healthy link, so "takes minutes" would be false.
    expect(message).toContain('不影响后续下载速度')
    expect(message).not.toMatch(/通常需要|大约|预计/)
  })

  it('names the mirror when the graph is resolved against it', () => {
    expect(npmResolutionStartMessage('https://registry.npmmirror.com')).toContain('国内 npm 镜像')
    expect(npmRegistryLabel('https://registry.npmmirror.com')).toBe('国内 npm 镜像')
    expect(npmRegistryLabel('https://registry.npmjs.org')).toBe('npm 官方源')
  })

  it('reports elapsed time without inventing a completion estimate', () => {
    const early = npmResolutionHeartbeatMessage('https://registry.npmjs.org', 15_000)
    const later = npmResolutionHeartbeatMessage('https://registry.npmjs.org', 125_000)

    expect(early).toContain('15 秒')
    expect(later).toContain('2 分 05 秒')
    // No percentage or ETA: npm gives no signal that could support one, and a
    // fabricated bar is worse than an honest clock.
    expect(early).not.toMatch(/%|预计|剩余/)
    expect(later).not.toMatch(/%|预计|剩余/)
  })

  it('formats durations either side of a minute', () => {
    expect(formatElapsedDuration(0)).toBe('0 秒')
    expect(formatElapsedDuration(59_400)).toBe('59 秒')
    expect(formatElapsedDuration(60_000)).toBe('1 分 00 秒')
    expect(formatElapsedDuration(3_723_000)).toBe('62 分 03 秒')
    expect(formatElapsedDuration(-5_000)).toBe('0 秒')
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

describe('Darwin CLI launch planning', () => {
  it('keeps the selected absolute CLI command in the Terminal launch plan', () => {
    const env = {
      HOME: '/Users/tester',
      CODEX_HOME: '/Users/tester/custom-codex',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    }
    expect(buildDarwinCliLaunchPlan({
      executable: '/opt/homebrew/bin/node',
      argv: ['/Users/tester/.npm-global/lib/node_modules/@openai/codex/bin/codex.js', '--dangerously-skip-permissions'],
    }, '/Users/tester/project', env)).toEqual({
      executable: '/opt/homebrew/bin/node',
      argv: ['/Users/tester/.npm-global/lib/node_modules/@openai/codex/bin/codex.js', '--dangerously-skip-permissions'],
      workspace: '/Users/tester/project',
      env,
    })
  })
})

describe('Darwin Codex Desktop integration', () => {
  it('reports externally managed updates without claiming an AppX or MSIX version', async () => {
    const { service } = await createDarwinService()

    await expect(service.inspectCodexDesktop()).resolves.toMatchObject({
      installed: false,
      version: null,
      appVersion: null,
      mirrorVersion: null,
      mirrorUpdateAvailable: null,
      mirrorError: null,
      path: null,
      installDirectory: null,
      running: false,
      latestVersion: null,
      updateAvailable: null,
      updateSource: null,
      updateCheck: 'skipped',
      updateState: 'unknown',
      updateError: null,
    })
  })

  it('reports a detected Codex App as an installed externally managed desktop app', async () => {
    const { service } = await createDarwinService({
      macosCodexAppDetector: async () => ({
        path: '/Applications/Codex.app',
        version: '26.727.51351',
        running: true,
      }),
    })

    await expect(service.inspectCodexDesktop()).resolves.toMatchObject({
      installed: true,
      version: '26.727.51351',
      appVersion: '26.727.51351',
      path: '/Applications/Codex.app',
      installDirectory: '/Applications/Codex.app',
      running: true,
      mirrorVersion: null,
      mirrorUpdateAvailable: null,
      mirrorError: null,
      latestVersion: null,
      updateAvailable: null,
      updateSource: null,
      updateCheck: 'skipped',
      updateState: 'unknown',
      updateError: null,
    })
  })

  it('degrades a rejected Codex App detector to a not-installed status', async () => {
    const { service } = await createDarwinService({
      macosCodexAppDetector: async () => { throw new Error('inspection unavailable') },
    })

    await expect(service.inspectCodexDesktop()).resolves.toMatchObject({
      installed: false,
      version: null,
      appVersion: null,
      path: null,
      installDirectory: null,
      running: false,
      updateCheck: 'skipped',
      updateError: null,
    })
  })

  it.runIf(process.platform === 'darwin')('uses the fully verified standalone selection for Maintenance uninstall help', async () => {
    const fixture = createDarwinStandaloneMaintenanceFixture()
    vi.stubEnv('HOME', fixture.home)
    vi.stubEnv('CODEX_HOME', fixture.codexHome)
    vi.stubEnv('PATH', path.dirname(fixture.visibleCommand))
    const verificationSpecs: Array<{ executable: string; argv: readonly string[] }> = []
    let resolutionError: unknown = null
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-maintenance-service-'))
    temporaryDirectories.push(directory)
    const store = new AppSettingsStore(path.join(directory, 'settings.json'), directory)
    const service = createSystemService(store, {
      platform: 'darwin',
      macosCodexAppDetector: async () => null,
      resolveCliCommand: async (provider, env, windowsExecutionMode, resolutionOptions) => {
        try {
          return await resolveVerifiedToolCommand(
            provider,
            env,
            windowsExecutionMode,
            {
              ...resolutionOptions,
              arch: process.arch,
              platform: 'darwin',
              runCommand: async (spec) => {
                verificationSpecs.push(spec)
                if (spec.executable === '/usr/bin/codesign' && spec.argv[0] === '-dv') {
                  return {
                    stdout: '',
                    stderr: [
                      'Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)',
                      'TeamIdentifier=2DC432GLL2',
                    ].join('\n'),
                  }
                }
                if (spec.argv[0] === '--version') {
                  return { stdout: `codex-cli ${fixture.version}\n`, stderr: '' }
                }
                return { stdout: '', stderr: '' }
              }
            },
          )
        } catch (error) {
          resolutionError = error
          throw error
        }
      },
    })

    const setup = await service.inspectCodexSetupStatus()
    const stagedExecutable = verificationSpecs[0]?.argv[2]

    expect(resolutionError).toBeNull()
    expect(fs.existsSync(fixture.executionMarker)).toBe(false)
    expect(stagedExecutable).toEqual(expect.any(String))
    expect(stagedExecutable).not.toBe(fs.realpathSync(fixture.executablePath))
    expect(fs.existsSync(path.dirname(stagedExecutable!))).toBe(false)
    expect(setup.cli).toMatchObject({
      installed: true,
      version: fixture.version,
      path: fs.realpathSync(fixture.executablePath),
      uninstall: {
        available: false,
        reason: expect.stringContaining('standalone'),
        manualCommand: expect.any(String),
      },
    })
    expect(verificationSpecs).toEqual([
      {
        executable: '/usr/bin/codesign',
        argv: ['--verify', '--strict', stagedExecutable!],
      },
      {
        executable: '/usr/bin/codesign',
        argv: ['-dv', '--verbose=4', stagedExecutable!],
      },
      {
        executable: stagedExecutable!,
        argv: ['--version'],
      },
    ])
  })

  it.runIf(process.platform === 'darwin')('fails closed when standalone command verification rejects during Maintenance inspection', async () => {
    const fixture = createDarwinStandaloneMaintenanceFixture()
    vi.stubEnv('HOME', fixture.home)
    vi.stubEnv('CODEX_HOME', fixture.codexHome)
    vi.stubEnv('PATH', path.dirname(fixture.visibleCommand))
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-maintenance-reject-'))
    temporaryDirectories.push(directory)
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'darwin',
        macosCodexAppDetector: async () => null,
        resolveCliCommand: async () => { throw new Error('standalone verification rejected') },
      },
    )

    const setup = await service.inspectCodexSetupStatus()

    expect(setup.cli).toMatchObject({
      installed: true,
      version: null,
      path: null,
      uninstall: { available: false, manualCommand: null },
    })
    expect(fs.existsSync(fixture.executionMarker)).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('withholds uninstall help when a Maintenance resolver returns no verified selection', async () => {
    const fixture = createDarwinStandaloneMaintenanceFixture()
    vi.stubEnv('HOME', fixture.home)
    vi.stubEnv('CODEX_HOME', fixture.codexHome)
    vi.stubEnv('PATH', path.dirname(fixture.visibleCommand))
    const executable = fs.realpathSync(fixture.executablePath)
    const execute = vi.fn(async (spec: { executable: string; argv: readonly string[] }) => ({
      executable: spec.executable,
      argv: [...spec.argv],
      exitCode: 0,
      signal: null,
      stdout: spec.executable === executable && spec.argv[0] === '--version'
        ? `codex-cli ${fixture.version}\n`
        : '',
      stderr: '',
      outputBytes: 0,
      durationMs: 1,
    }))
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-maintenance-unmarked-'))
    temporaryDirectories.push(directory)
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'darwin',
        macosCodexAppDetector: async () => null,
        resolveCliCommand: async () => ({ executable, argv: [] }),
        runCommand: execute,
      },
    )

    const setup = await service.inspectCodexSetupStatus()

    expect(setup.cli).toMatchObject({
      installed: true,
      version: `codex-cli ${fixture.version}`,
      path: executable,
      uninstall: { available: false, manualCommand: null },
    })
    expect(fs.existsSync(fixture.executionMarker)).toBe(false)
  })

  it('rejects managed install operations with actionable macOS guidance', async () => {
    const { service } = await createDarwinService()
    const target = { isDestroyed: () => false, send: vi.fn() }

    await expect(service.installCodexDesktop(target)).rejects.toThrow('由 Codex App 管理')
  })

  it('rejects managed uninstall operations with actionable macOS guidance', async () => {
    const { service } = await createDarwinService()

    await expect(service.uninstallCodexDesktop()).rejects.toThrow('由 Codex App 管理')
  })

  it('preserves the XingMang Codex readiness check before resolving or running the CLI', async () => {
    const { service, resolveCli, execute } = await createDarwinService({ configured: false })

    await expect(service.launchCodexDesktop('open', {
      isDestroyed: () => false,
      send: vi.fn(),
    })).rejects.toThrow('Codex 当前不是星芒 AI 配置')
    expect(resolveCli).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a stored workspace that is not an existing directory', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-missing-workspace-'))
    temporaryDirectories.push(directory)
    const missingWorkspace = path.join(directory, 'missing')
    const { service, execute, release } = await createDarwinService({ workspace: missingWorkspace })

    await expect(service.launchCodexDesktop('open', {
      isDestroyed: () => false,
      send: vi.fn(),
    })).rejects.toThrow('工作目录不存在，请重新选择')
    expect(execute).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('opens Codex on Darwin with the verified CLI and stored workspace as literal argv', async () => {
    const { service, workspace, resolvedCommand, resolveCli, execute, release } = await createDarwinService()

    const result = await service.launchCodexDesktop('open', {
      isDestroyed: () => false,
      send: vi.fn(),
    })

    expect(resolveCli).toHaveBeenCalledWith('codex', expect.any(Object), 'trusted-only', {
      darwinStagingRetention: 'ephemeral',
    })
    expect(execute).toHaveBeenCalledWith({
      executable: resolvedCommand.executable,
      argv: [...resolvedCommand.argv, 'app', workspace],
    }, expect.objectContaining({ cwd: workspace }))
    expect(release).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      restarted: false,
      status: {
        version: null,
        appVersion: null,
        updateCheck: 'skipped',
      },
    })
  })

  it('uses codexEnv for Darwin Codex Desktop command resolution and launch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-codex-env-'))
    temporaryDirectories.push(root)
    const codexHome = path.join(root, 'selected-codex-home')
    const { service, codexEnv, resolveCli, execute } = await createDarwinService({ codexHome })

    await service.launchCodexDesktop('open', {
      isDestroyed: () => false,
      send: vi.fn(),
    })

    expect(resolveCli.mock.calls[0]?.[1]).toMatchObject({ CODEX_HOME: codexHome })
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      env: expect.objectContaining({
        HOME: codexEnv.HOME,
        CODEX_HOME: codexHome,
      }),
    })
  })

  it('releases the verified Darwin CLI when opening Codex fails', async () => {
    const { service, execute, release } = await createDarwinService()
    execute.mockRejectedValueOnce(new Error('codex app failed'))

    await expect(service.launchCodexDesktop('open', {
      isDestroyed: () => false,
      send: vi.fn(),
    })).rejects.toThrow('codex app failed')

    expect(release).toHaveBeenCalledOnce()
  })

  it('fails closed for Darwin Codex restart without resolving or running a command', async () => {
    const { service, resolveCli, execute } = await createDarwinService()

    await expect(service.launchCodexDesktop('restart', {
      isDestroyed: () => false,
      send: vi.fn(),
    })).rejects.toThrow('macOS 不支持重启')
    expect(resolveCli).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a bare Codex command instead of resolving it through PATH', async () => {
    const fixture = await createDarwinService()
    fixture.resolveCli.mockResolvedValueOnce({ executable: 'codex', argv: [] })

    await expect(fixture.service.launchCodexDesktop('open', {
      isDestroyed: () => false,
      send: vi.fn(),
    })).rejects.toThrow('未解析为绝对路径')
    expect(fixture.execute).not.toHaveBeenCalled()
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
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-version-')))
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

  it('selects the Grok installer appropriate to each platform', () => {
    expect(grokInstallStrategyFor('win32')).toBe('windows-native')
    expect(grokInstallStrategyFor('darwin')).toBe('darwin-official-npm')
    expect(grokInstallStrategyFor('linux')).toBe('external')
  })

  it('allows Grok npm maintenance only after Darwin integrity verification', () => {
    expect(buildCliMaintenancePlan(
      'grok',
      '/Users/tester/.local/bin/npm',
      null,
      '0.2.118',
      true,
      'darwin',
    )).toEqual({
      kind: 'npm-install',
      executable: '/Users/tester/.local/bin/npm',
      argv: [
        'ci',
        '--omit=dev',
      ],
      windowsPackageManager: 'npm',
    })
    const darwinGrokPlan = buildCliMaintenancePlan(
      'grok',
      '/Users/tester/.local/bin/npm',
      '/tmp/ignored-prefix',
      '0.2.118',
      true,
      'darwin',
    )
    expect(darwinGrokPlan.argv).not.toContain('--global')
    expect(darwinGrokPlan.argv).not.toContain('--ignore-scripts')
    expect(darwinGrokPlan.argv).not.toContain('--force')
    expect(darwinGrokPlan.argv.some((argument) => argument.startsWith('--prefix='))).toBe(false)

    expect(() => buildCliMaintenancePlan(
      'grok',
      '/Users/tester/.local/bin/npm',
      null,
      '0.2.118',
      false,
      'darwin',
    )).toThrow('完整性校验')

    expect(() => buildCliMaintenancePlan(
      'grok',
      'C:\\Program Files\\nodejs\\npm.cmd',
      null,
      '0.2.118',
      true,
      'win32',
    )).toThrow('已签名二进制')

    expect(() => buildCliMaintenancePlan(
      'grok',
      '/usr/bin/npm',
      null,
      '0.2.118',
      true,
      'linux',
    )).toThrow('不支持')
  })

  it('uses npm maintenance for npm providers', () => {
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

    expect(() => buildCliMaintenancePlan(
      'codex',
      '/usr/local/bin/npm',
      null,
      '0.146.0',
      true,
      'darwin',
    )).toThrow('macOS 用户级 npm 前缀')
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
