import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore, defaultAppSettings } from './app-settings'
import { providerBaseUrls } from './catalog'
import { providerConfigRoot, type ProviderConfigRoots } from './codex-home'
import {
  findExecutable as productionFindExecutable,
  runCommand,
  trustedCommandEnvironment,
  type runCommand as productionRunCommand,
} from './command-runner'
import type { WindowsMachinePaths } from './windows-machine-paths'
import { providerConfigPaths } from './config-files'
import type { MacosCodexAppInspection } from './macos-codex-app'
import { managedNpmCacheRoot, managedNpmPrefix } from './managed-cli-paths'
import {
  resolveCliCommand as resolveVerifiedToolCommand,
  resolveCliInstallation as resolveCliInstallationForTest,
} from './tool-installation'
import {
  assertNpmPackageLocksEquivalent,
  assertNpmReleaseIntegrityMatches,
  assertNpmReleaseMatchesOfficialLock,
  buildCliStatus,
  buildCliMaintenancePlan,
  buildCliToolStatusFromSettled,
  buildDarwinCliLaunchPlan,
  buildDarwinTrustedVerificationRunner,
  buildCliUninstallPlan,
  buildDesktopAppStatusFromSettled,
  buildNetworkLocationStatusFromSettled,
  buildToolStatusFromSettled,
  createSystemService,
  DarwinGrokRetainedPathsError,
  inspectVerifiedDarwinGrokPostInstall,
  interactiveTerminalEnvironment,
  modelAccessCacheKey,
  ManagedNpmRollbackError,
  detectNetworkLocation,
  detectNetworkRegion,
  fetchNpmPackageReleaseMetadata,
  formatMebibytes,
  grokInstallStrategyFor,
  grokManualUninstallResult,
  formatElapsedDuration,
  networkLocationCacheTtlMs,
  npmDownloadTimeoutMs,
  effectiveNetworkRegion,
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
  type DesktopAppStatus,
  type LatestVersionProbe,
  type NetworkLocationStatus,
  type ToolStatus,
} from './system-service'

const temporaryDirectories: string[] = []

// Fixed roots keep the trusted-environment assertions deterministic on every
// platform instead of depending on the registry of the machine running them.
const testMachinePaths: WindowsMachinePaths = {
  systemRoot: 'D:\\Windows',
  system32: 'D:\\Windows\\System32',
  programFiles: 'D:\\Program Files',
  programFilesX86: 'D:\\Program Files (x86)',
  programData: 'D:\\ProgramData',
}

function createService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-system-service-'))
  temporaryDirectories.push(directory)
  return createSystemService(new AppSettingsStore(path.join(directory, 'settings.json'), directory))
}

async function createDarwinService(options: {
  workspace?: string
  configured?: boolean
  codexHome?: string
  macosCodexAppDetector?: () => Promise<MacosCodexAppInspection>
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
  const resolveCli = vi.fn<typeof resolveVerifiedToolCommand>(async () => resolvedCommand)
  const execute = vi.fn<typeof productionRunCommand>(async (spec: { executable: string; argv: readonly string[] }) => ({
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
    baseUrl: 'https://xm.solov.cc/v1',
    actualBaseUrl: options.configured === false ? 'https://example.invalid' : 'https://xm.solov.cc/v1',
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
  const macosCodexAppDetector = options.macosCodexAppDetector
    ?? vi.fn(async () => ({ app: null, detectionFailed: false, detectionError: null }))
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
    const inspect = vi.fn((provider: Parameters<typeof providerConfigRoot>[0], roots: ProviderConfigRoots = providerRoots) => ({
      baseUrl: providerBaseUrls[provider],
      actualBaseUrl: providerBaseUrls[provider],
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
    expect(inspect).toHaveBeenCalledWith('codex', providerRoots, providerBaseUrls)

    expect(providerCommandEnvironment('codex', { HOME: userHome }, codexEnv)).toMatchObject({
      HOME: userHome,
      CODEX_HOME: codexHome,
    })
    expect(providerCommandEnvironment('grok', { HOME: userHome }, codexEnv).CODEX_HOME).toBeUndefined()
  })

  it('delegates settings reads and merged durable updates to AppSettingsStore', async () => {
    const service = createService()
    const initial = service.readStoredConfig()
    expect(initial).toEqual(defaultAppSettings(initial.workspace))

    const merged = await service.updateStoredConfig({ version: 2, theme: 'light' })

    expect(merged).toMatchObject({ theme: 'light', workspace: initial.workspace })
    expect(service.readStoredConfig()).toMatchObject({ theme: 'light', workspace: initial.workspace })
  })

  it('does not let a settings update revert fields it does not mention (①栏11 regression)', async () => {
    // Two concurrent single-intent updates, fired without awaiting the first:
    // the second one's merge base must be the record the first one actually
    // produced, so BOTH survive regardless of queue order. Before the
    // field-wise merge, whichever whole-record write landed second silently
    // reverted the other's fields.
    const service = createService()

    const first = service.updateStoredConfig({ version: 2, relaySiteId: 'sub2api' })
    const second = service.updateStoredConfig({ version: 2, sidebarMoreExpanded: true })
    await Promise.all([first, second])

    expect(service.readStoredConfig()).toMatchObject({
      relaySiteId: 'sub2api',
      sidebarMoreExpanded: true,
    })
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
    vi.stubEnv('USERPROFILE', userHome)
    vi.stubEnv('APPDATA', path.join(userHome, 'AppData', 'Roaming'))
    vi.stubEnv('LOCALAPPDATA', path.join(userHome, 'AppData', 'Local'))
    const codexHome = path.join(root, 'custom-codex')
    const codexEnv = {
      ...process.env,
      HOME: userHome,
      CODEX_HOME: codexHome,
      PATH: `${providerBin}${path.delimiter}${runtimeBin}`,
    }
    const resolveCli = vi.fn<typeof resolveVerifiedToolCommand>(async () => ({ executable: codexExecutable, argv: [] }))
    const execute = vi.fn<typeof productionRunCommand>(async (spec: { executable: string; argv: readonly string[] }) => ({
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
        macosCodexAppDetector: async () => ({ app: null, detectionFailed: false, detectionError: null }),
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

  it('degrades a CLI resolution failure to detectionFailed instead of rejecting the whole setup status', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-setup-status-cli-failure-'))
    temporaryDirectories.push(directory)
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'linux',
        resolveCliInstallation: async () => { throw new Error('注册表读取失败') },
      },
    )

    const setup = await service.inspectCodexSetupStatus()

    expect(setup.cli).toEqual({
      installed: false,
      version: null,
      path: null,
      installDirectory: null,
      detectionFailed: true,
      detectionError: '注册表读取失败',
    })
    // The runtime probes run through their own independent allSettled step
    // above the CLI probe; a CLI-only failure must not bleed into them.
    expect(setup.runtime.node.detectionFailed).not.toBe(true)
    expect(setup.runtime.npm.detectionFailed).not.toBe(true)
  })

  it('preserves CLI probe failures in a full maintenance scan instead of reporting not installed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-full-scan-cli-failure-'))
    temporaryDirectories.push(directory)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'linux',
        findExecutable: async () => null,
        resolveCliInstallation: async () => { throw new Error('CLI 注册信息读取失败') },
      },
    )

    const snapshot = await service.scanSystem(false)

    for (const provider of ['claude', 'codex', 'gemini', 'grok'] as const) {
      expect(snapshot.clis[provider]).toMatchObject({
        installed: false,
        detectionFailed: true,
        detectionError: 'CLI 注册信息读取失败',
        updateState: 'unknown',
      })
    }
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
      'https://xm.solov.cc/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test-value' }),
        redirect: 'error',
      }),
    )
  })

  it('bypasses the model cache when credentials are being revalidated', async () => {
    const service = createService()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'cached-model' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'fresh-model' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.fetchAvailableModels('sk-bypass-cache-key')).resolves.toEqual(['cached-model'])
    await expect(service.fetchAvailableModels('sk-bypass-cache-key')).resolves.toEqual(['cached-model'])
    await expect(service.fetchAvailableModels('sk-bypass-cache-key', { bypassCache: true }))
      .resolves.toEqual(['fresh-model'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
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
    expect(message).toContain('模型查询失败，服务返回 401')
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
    const stagedExecutable = specs[0]?.argv.at(-1)
    expect(stagedExecutable).toEqual(expect.any(String))
    expect(stagedExecutable).not.toBe(sourceExecutable)
    expect(specs).toEqual([
      {
        executable: '/usr/bin/codesign',
        argv: [
          '--verify',
          '--strict',
          '-R=anchor apple generic'
            + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
            + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
            + ' and certificate leaf[subject.OU] = "5Y6N3AJ54S"',
          stagedExecutable!,
        ],
      },
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

  it('ensures the agent link exists before verifying a postinstall grok selection (internal #16)', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    fs.unlinkSync(path.join(fixture.bin, 'agent'))
    const specs: Array<{ executable: string; argv: readonly string[] }> = []

    const inspected = await inspectVerifiedDarwinGrokPostInstall({
      homeDirectory: fixture.home,
      expectedVersion: '0.2.118',
      runCommand: async (spec) => {
        specs.push(spec)
        return officialDarwinGrokUninstallResult(fixture, spec)
      },
    })

    const agentLink = path.join(fixture.bin, 'agent')
    expect(fs.readlinkSync(agentLink)).toBe(fixture.grokTarget)
    expect(fs.realpathSync(agentLink)).toBe(fs.realpathSync(fixture.grokBinary))
    // Ensuring the link is pure filesystem work — it must not itself trigger a
    // codesign/version verification pass against the freshly created agent.
    expect(specs.every((spec) => path.basename(spec.executable) !== 'agent')).toBe(true)
    expect(inspected.status.version).toBe('0.2.118')
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

  it('provides a ready-to-run cleanup command alongside the retained-paths error (internal #18)', async () => {
    const fixture = createDarwinGrokUninstallFixture()

    let caught: unknown
    try {
      await uninstallVerifiedDarwinGrokInstallation({
        homeDirectory: fixture.home,
        installDirectory: fs.realpathSync(fixture.bin),
        runCommand: async (spec) => officialDarwinGrokUninstallResult(fixture, spec),
      })
      throw new Error('expected uninstallVerifiedDarwinGrokInstallation to reject')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DarwinGrokRetainedPathsError)
    const retained = caught as DarwinGrokRetainedPathsError
    expect(retained.manualCommand).toContain('rm -f')
    expect(retained.manualCommand).toContain('grok-0.2.118-macos-aarch64')
    expect(retained.manualCommand).toContain('grok-0.2.111-macos-aarch64')
    const quarantineNames = fs.readdirSync(fixture.bin).filter((name) => name.endsWith('.removing'))
    expect(quarantineNames).toHaveLength(2)
    for (const name of quarantineNames) {
      expect(retained.manualCommand).toContain(name)
    }
  })

  it('mentions unreferenced legacy binaries under downloads/ without deleting them (internal #18)', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    const downloadsDirectory = path.dirname(fixture.grokBinary)
    const orphanBinary = path.join(downloadsDirectory, 'grok-0.2.100-macos-aarch64')
    fs.writeFileSync(orphanBinary, 'y'.repeat(4096), { mode: 0o700 })

    let caught: unknown
    try {
      await uninstallVerifiedDarwinGrokInstallation({
        homeDirectory: fixture.home,
        installDirectory: fs.realpathSync(fixture.bin),
        runCommand: async (spec) => officialDarwinGrokUninstallResult(fixture, spec),
      })
      throw new Error('expected uninstallVerifiedDarwinGrokInstallation to reject')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DarwinGrokRetainedPathsError)
    const retained = caught as DarwinGrokRetainedPathsError
    expect(retained.message).toContain('grok-0.2.100-macos-aarch64')
    expect(retained.message).toContain('~/.grok/downloads/')
    // Advisory only — internal #18 explicitly keeps automatic deletion of
    // legacy orphans out of scope, so the executable command must not touch them.
    expect(retained.manualCommand).not.toContain('grok-0.2.100-macos-aarch64')
    expect(fs.existsSync(orphanBinary)).toBe(true)
  })

  it('sums a shared target once when grok and agent resolve to the same binary (internal #16 byte fix)', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    // Real hardware (internal #16) hit this after a same-version reinstall:
    // both links pointing at the exact same release. A tiny fixture binary
    // would round to "1 MiB" either way, so this uses a large enough shared
    // file that a double count is observable at MiB granularity (2 vs 4).
    const sharedBinary = Buffer.alloc(2 * 1024 * 1024, 0x41)
    fs.writeFileSync(fixture.grokBinary, sharedBinary, { mode: 0o700 })
    fs.unlinkSync(path.join(fixture.bin, 'agent'))
    fs.symlinkSync(fixture.grokTarget, path.join(fixture.bin, 'agent'))

    let caught: unknown
    try {
      await uninstallVerifiedDarwinGrokInstallation({
        homeDirectory: fixture.home,
        installDirectory: fs.realpathSync(fixture.bin),
        // Both links now resolve to the same 0.2.118 file, so both staged
        // copies (named "grok" and "agent") must report that same version —
        // officialDarwinGrokUninstallResult's canned "agent" reply is tuned
        // for the fixture's default *distinct* agent target and does not fit here.
        runCommand: async (spec) => {
          if (spec.executable === '/usr/bin/codesign') return { stdout: '', stderr: '' }
          if (spec.argv.length === 1 && spec.argv[0] === '--version') {
            return { stdout: 'grok 0.2.118\n', stderr: '' }
          }
          throw new Error(`Unexpected Grok verification command: ${spec.executable} ${spec.argv.join(' ')}`)
        },
      })
      throw new Error('expected uninstallVerifiedDarwinGrokInstallation to reject')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DarwinGrokRetainedPathsError)
    const retained = caught as DarwinGrokRetainedPathsError
    expect(retained.message).toContain(`共约 ${formatMebibytes(sharedBinary.byteLength)}`)
    expect(retained.message).toContain('共约 2 MiB')
    // Before the fix this counted the one shared file twice.
    expect(retained.message).not.toContain('共约 4 MiB')
  })

  it('folds earlier uninstall rounds\' leftover quarantine files into the list and cleanup command (internal #20)', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    const historicalGrokQuarantine = path.join(fixture.bin, `.grok-${randomUUID()}.removing`)
    const historicalAgentQuarantine = path.join(fixture.bin, `.agent-${randomUUID()}.removing`)
    // One as a renamed symlink (the common shape) and one as a plain file
    // (uninstallVerifiedNativeCliFiles' locked-file rm-then-retain fallback) —
    // both are equally provable by name alone, neither by file type.
    fs.symlinkSync(fixture.grokTarget, historicalGrokQuarantine)
    fs.writeFileSync(historicalAgentQuarantine, 'locked leftover from an earlier uninstall')
    // A decoy that must never be swept in: right shape, wrong provenance.
    const unrelatedDotfile = path.join(fixture.bin, '.DS_Store')
    fs.writeFileSync(unrelatedDotfile, 'not ours')

    let caught: unknown
    try {
      await uninstallVerifiedDarwinGrokInstallation({
        homeDirectory: fixture.home,
        installDirectory: fs.realpathSync(fixture.bin),
        runCommand: async (spec) => officialDarwinGrokUninstallResult(fixture, spec),
      })
      throw new Error('expected uninstallVerifiedDarwinGrokInstallation to reject')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DarwinGrokRetainedPathsError)
    const retained = caught as DarwinGrokRetainedPathsError
    expect(retained.message).toContain(path.basename(historicalGrokQuarantine))
    expect(retained.message).toContain(path.basename(historicalAgentQuarantine))
    expect(retained.message).toContain('以前几次卸载遗留的隔离文件')
    expect(retained.manualCommand).toContain(path.basename(historicalGrokQuarantine))
    expect(retained.manualCommand).toContain(path.basename(historicalAgentQuarantine))
    expect(retained.manualCommand).not.toContain('.DS_Store')
    expect(retained.message).not.toContain('.DS_Store')
    // Neither historical file is ever touched by this call — the command is
    // handed to the user to run, never executed by the app itself.
    expect(fs.existsSync(historicalGrokQuarantine)).toBe(true)
    expect(fs.existsSync(historicalAgentQuarantine)).toBe(true)
  })

  it('single-quote-escapes every path in the cleanup command, including historical quarantine files (internal #20)', async () => {
    const baseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-grok-quote-'))
    temporaryDirectories.push(baseDirectory)
    const home = path.join(baseDirectory, "o'brien")
    const bin = path.join(home, '.grok', 'bin')
    const downloads = path.join(home, '.grok', 'downloads')
    fs.mkdirSync(bin, { recursive: true })
    fs.mkdirSync(downloads, { recursive: true })
    const grokBinary = path.join(downloads, 'grok-0.2.118-macos-aarch64')
    fs.writeFileSync(grokBinary, 'grok binary', { mode: 0o700 })
    const grokTarget = path.join('..', 'downloads', path.basename(grokBinary))
    fs.symlinkSync(grokTarget, path.join(bin, 'grok'))
    // A historical leftover under the same quote-containing home, so the
    // escaping must hold for both this round's and earlier rounds' paths.
    fs.symlinkSync(grokTarget, path.join(bin, `.grok-${randomUUID()}.removing`))

    let caught: unknown
    try {
      await uninstallVerifiedDarwinGrokInstallation({
        homeDirectory: home,
        installDirectory: fs.realpathSync(bin),
        runCommand: async (spec) => {
          if (spec.executable === '/usr/bin/codesign') return { stdout: '', stderr: '' }
          if (spec.argv.length === 1 && spec.argv[0] === '--version') {
            return { stdout: 'grok 0.2.118\n', stderr: '' }
          }
          throw new Error(`Unexpected Grok verification command: ${spec.executable} ${spec.argv.join(' ')}`)
        },
      })
      throw new Error('expected uninstallVerifiedDarwinGrokInstallation to reject')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DarwinGrokRetainedPathsError)
    const retained = caught as DarwinGrokRetainedPathsError
    // shellSingleQuote's scheme: close the quote, emit a literal escaped
    // quote, reopen — 'o'"'"'brien' — once per path under the home directory.
    const escapedQuote = `o'"'"'brien`
    expect(retained.manualCommand).toContain(escapedQuote)
    const occurrences = retained.manualCommand.split(escapedQuote).length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  it.each([
    ['missing link', 'Grok automatic uninstall requires a verified grok symbolic link'],
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

  it('repairs a missing agent link before uninstalling through the public service', async () => {
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
        const result = spec.argv.length === 1 && spec.argv[0] === '--version'
          ? { stdout: 'grok 0.2.118\n', stderr: '' }
          : officialDarwinGrokUninstallResult(fixture, spec)
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

    // inspectCliTool repairs the missing agent link before uninstall planning.
    // Both names now select the same 0.2.118 executable, so both staged copies
    // must report that version and both links reach the quarantine phase.
    await expect(service.uninstallCli('grok')).resolves.toMatchObject({
      outcome: 'manual-required',
      previousVersion: '0.2.118',
      manualHelp: { manualCommand: expect.stringContaining('rm -f') },
      error: expect.not.stringContaining('version different from the pinned release'),
    })
    expect(fs.existsSync(path.join(fixture.bin, 'grok'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.bin, 'agent'))).toBe(false)
    const quarantineNames = fs.readdirSync(fixture.bin).filter((name) => name.endsWith('.removing'))
    expect(quarantineNames).toHaveLength(2)
    expect(quarantineNames).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\.grok-/),
      expect.stringMatching(/^\.agent-/),
    ]))
    expect(fs.readFileSync(fixture.grokBinary, 'utf8')).toBe('grok binary')
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
      manualHelp: {
        reason: expect.stringMatching(/自动卸载未完整完成.*\.removing.*grok-0\.2\.118/s),
        manualCommand: expect.stringContaining('rm -f'),
      },
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

  it('uninstalls grok alone when the agent link is absent instead of blocking on it (internal #16)', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    fs.unlinkSync(path.join(fixture.bin, 'agent'))

    await expect(uninstallVerifiedDarwinGrokInstallation({
      homeDirectory: fixture.home,
      installDirectory: fs.realpathSync(fixture.bin),
      runCommand: async (spec) => officialDarwinGrokUninstallResult(fixture, spec),
    })).rejects.toThrow(DarwinGrokRetainedPathsError)

    // grok's command entry is gone; darwin's always-retain-the-program-file
    // step (internal #18) is the only reason this still isn't a clean
    // 'uninstalled' outcome — not the missing agent link.
    expect(fs.existsSync(path.join(fixture.bin, 'grok'))).toBe(false)
    const quarantineNames = fs.readdirSync(fixture.bin).filter((name) => name.endsWith('.removing'))
    expect(quarantineNames).toHaveLength(1)
    expect(quarantineNames[0]).toMatch(/^\.grok-/)
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

  // Every case above injects its own runCommand stub, so none of them would have
  // caught buildDarwinTrustedVerificationRunner reverting to commandEnvironment()'s
  // plain pass-through. This calls the real, production runCommand directly instead,
  // the same way macos-codex-app.ts's equivalent #37 fix is verified.
  it('gives the darwin trusted verification runner env stripped of inherited injection variables', async () => {
    const previousInsert = process.env.DYLD_INSERT_LIBRARIES
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/xingmang-not-a-real.dylib'
    process.env.XINGMANG_SYSTEM_SERVICE_SENTINEL = 'ordinary-value'
    try {
      const runner = buildDarwinTrustedVerificationRunner(runCommand)
      const result = await runner({ executable: '/usr/bin/env', argv: [] })

      expect(result.stdout).not.toContain('DYLD_INSERT_LIBRARIES')
      expect(result.stdout).not.toContain('xingmang-not-a-real.dylib')
      expect(result.stdout).toContain('XINGMANG_SYSTEM_SERVICE_SENTINEL=ordinary-value')
    } finally {
      delete process.env.XINGMANG_SYSTEM_SERVICE_SENTINEL
      if (previousInsert === undefined) delete process.env.DYLD_INSERT_LIBRARIES
      else process.env.DYLD_INSERT_LIBRARIES = previousInsert
    }
  })

  // Confirms the wiring at the uninstallNativeGrok call site, not just the helper it
  // calls: a future edit could revert that one call to commandEnvironment() again
  // without this catching it, since buildDarwinTrustedVerificationRunner would still
  // pass in isolation.
  it('does not let inherited injection variables reach the uninstall codesign verification', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    vi.stubEnv('HOME', fs.realpathSync(fixture.home))
    vi.stubEnv('PATH', fixture.bin)
    vi.stubEnv('DYLD_INSERT_LIBRARIES', '/tmp/xingmang-not-a-real.dylib')
    vi.stubEnv('XINGMANG_SYSTEM_SERVICE_SENTINEL', 'ordinary-value')
    const store = new AppSettingsStore(
      path.join(fixture.home, 'settings.json'),
      fixture.home,
    )
    const codesignEnvironments: Array<NodeJS.ProcessEnv | undefined> = []
    const service = createSystemService(store, {
      platform: 'darwin',
      runCommand: async (spec, options) => {
        if (spec.executable === '/usr/bin/codesign') codesignEnvironments.push(options?.env)
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

    await service.uninstallCli('grok')

    expect(codesignEnvironments.length).toBeGreaterThan(0)
    for (const environment of codesignEnvironments) {
      expect(environment?.DYLD_INSERT_LIBRARIES).toBeUndefined()
      expect(environment?.XINGMANG_SYSTEM_SERVICE_SENTINEL).toBe('ordinary-value')
    }
  })
})

describe.runIf(process.platform === 'darwin')('Darwin Grok readiness self-heal (internal #20)', () => {
  // Real-hardware testing (internal #20) found a session where grok read as
  // installed and up to date but agent was missing, and no in-app action —
  // "安装全部缺失项", the per-card install button, or the maintenance page's
  // batch action — offered any way to repair it, because every one of them
  // only offers to (re)install when `status.installed` is false. That status
  // has only ever come from the canonical grok link; nothing ever asked
  // whether agent existed too. These tests exercise the fix from the public
  // service surface — scanSystem and checkCliUpdate both resolve through
  // inspectCliTool — rather than by calling ensureDarwinGrokAgentLink
  // directly, because the bug was never in that function (it already had its
  // own coverage); it was that nothing outside a fresh install ever called it.
  it('repairs a missing agent link the next time anything probes whether grok is installed', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    fs.unlinkSync(path.join(fixture.bin, 'agent'))
    vi.stubEnv('HOME', fs.realpathSync(fixture.home))
    vi.stubEnv('PATH', fixture.bin)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests') }))
    const store = new AppSettingsStore(path.join(fixture.home, 'settings.json'), fixture.home)
    const service = createSystemService(store, {
      platform: 'darwin',
      runCommand: async (spec) => {
        throw new Error(`Unexpected command during a readiness probe: ${spec.executable} ${spec.argv.join(' ')}`)
      },
    })
    expect(fs.existsSync(path.join(fixture.bin, 'agent'))).toBe(false)

    const status = await service.inspectCliUpdate('grok', false)

    expect(status.installed).toBe(true)
    expect(status.version).toBe('0.2.118')
    expect(fs.readlinkSync(path.join(fixture.bin, 'agent'))).toBe(fixture.grokTarget)
  })

  it('repairs the same gap through a full system scan, not just the single-CLI update check', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    fs.unlinkSync(path.join(fixture.bin, 'agent'))
    vi.stubEnv('HOME', fs.realpathSync(fixture.home))
    vi.stubEnv('PATH', fixture.bin)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests') }))
    const store = new AppSettingsStore(path.join(fixture.home, 'settings.json'), fixture.home)
    const service = createSystemService(store, {
      platform: 'darwin',
      runCommand: async (spec) => {
        throw new Error(`Unexpected command during a readiness probe: ${spec.executable} ${spec.argv.join(' ')}`)
      },
      // scanSystem also probes the Codex Desktop app; keep that hermetic
      // (matching createDarwinService's default elsewhere in this file)
      // instead of letting the real detector touch this machine.
      macosCodexAppDetector: async () => ({ app: null, detectionFailed: false, detectionError: null }),
    })

    const snapshot = await service.scanSystem(false)

    expect(snapshot.clis.grok.installed).toBe(true)
    expect(fs.readlinkSync(path.join(fixture.bin, 'agent'))).toBe(fixture.grokTarget)
  })

  it('never turns a healthy grok status into a false negative when the repair itself fails', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    fs.unlinkSync(path.join(fixture.bin, 'agent'))
    vi.stubEnv('HOME', fs.realpathSync(fixture.home))
    vi.stubEnv('PATH', fixture.bin)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests') }))
    vi.spyOn(fs.promises, 'symlink').mockRejectedValueOnce(new Error('EACCES: permission denied, symlink'))
    const store = new AppSettingsStore(path.join(fixture.home, 'settings.json'), fixture.home)
    const service = createSystemService(store, {
      platform: 'darwin',
      runCommand: async (spec) => {
        throw new Error(`Unexpected command during a readiness probe: ${spec.executable} ${spec.argv.join(' ')}`)
      },
    })

    const status = await service.inspectCliUpdate('grok', false)

    // inspectCliTool's contract is to probe state, not throw — a failed
    // best-effort repair must read as "still installed", not as a detection
    // failure or a false "not installed" that would misdirect the user to a
    // reinstall they do not need.
    expect(status.installed).toBe(true)
    expect(status.version).toBe('0.2.118')
    expect(fs.existsSync(path.join(fixture.bin, 'agent'))).toBe(false)
  })

  it('leaves a pre-existing, non-canonical occupant of the agent path untouched', async () => {
    const fixture = createDarwinGrokUninstallFixture()
    fs.unlinkSync(path.join(fixture.bin, 'agent'))
    fs.writeFileSync(path.join(fixture.bin, 'agent'), 'a fuller official install put this here')
    vi.stubEnv('HOME', fs.realpathSync(fixture.home))
    vi.stubEnv('PATH', fixture.bin)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests') }))
    const store = new AppSettingsStore(path.join(fixture.home, 'settings.json'), fixture.home)
    const service = createSystemService(store, {
      platform: 'darwin',
      runCommand: async (spec) => {
        throw new Error(`Unexpected command during a readiness probe: ${spec.executable} ${spec.argv.join(' ')}`)
      },
    })

    const status = await service.inspectCliUpdate('grok', false)

    expect(status.installed).toBe(true)
    expect(fs.readFileSync(path.join(fixture.bin, 'agent'), 'utf8')).toBe('a fuller official install put this here')
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
      expect(options?.npmGlobalRoot).toBe(path.join(activePrefix, 'lib', 'node_modules'))
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

describe('Python runtime installation', () => {
  it.runIf(process.platform === 'win32')('does not reinstall a PATH-visible Python 3.12 runtime', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-existing-python-runtime-'))
    temporaryDirectories.push(directory)
    const pythonExecutable = 'D:\Python312\python.exe'
    const installPythonRuntime = vi.fn(async () => ({
      installed: true as const,
      action: 'installed' as const,
      method: 'winget' as const,
      source: 'winget' as const,
      version: 'Python 3.12',
      architecture: 'x64' as const,
      pathRefreshRequired: true,
    }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable: async (command) => command === 'python' ? pythonExecutable : null,
        runCommand: async (spec) => ({
          executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null,
          stdout: 'Python 3.12.9\n', stderr: '', outputBytes: 14, durationMs: 1,
        }),
        installPythonRuntime,
        inspectInstalledPythonRuntime: async () => { throw new Error('fixed probe must not run') },
      },
    )
    const target = { isDestroyed: () => false, send: vi.fn() }

    await expect(service.installPythonRuntime(target)).resolves.toMatchObject({
      action: 'unchanged',
      version: 'Python 3.12.9',
      pathRefreshRequired: false,
    })
    expect(installPythonRuntime).not.toHaveBeenCalled()
    expect(target.send).toHaveBeenCalledWith(
      'runtime:python-install-progress',
      expect.objectContaining({ phase: 'complete', message: expect.stringContaining('无需重复安装') }),
    )
  })

  it.runIf(process.platform === 'win32')('reuses a PATH-visible Python 3.11 runtime', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-old-python-runtime-'))
    temporaryDirectories.push(directory)
    const pythonExecutable = 'D:\Python311\python.exe'
    const installPythonRuntime = vi.fn(async () => ({
      installed: true as const,
      action: 'installed' as const,
      method: 'winget' as const,
      source: 'winget' as const,
      version: 'Python 3.12',
      architecture: 'x64' as const,
      pathRefreshRequired: true,
    }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable: async (command) => command === 'python' ? pythonExecutable : null,
        runCommand: async (spec) => ({
          executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null,
          stdout: 'Python 3.11.9\n', stderr: '', outputBytes: 14, durationMs: 1,
        }),
        installPythonRuntime,
        inspectInstalledPythonRuntime: async () => { throw new Error('Python 3.12 fixed install not found') },
      },
    )

    await expect(service.installPythonRuntime({ isDestroyed: () => false, send: vi.fn() })).resolves.toMatchObject({
      action: 'unchanged',
      version: 'Python 3.11.9',
      pathRefreshRequired: false,
    })
    expect(installPythonRuntime).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'win32')('installs Python 3.12 only when no usable Python is visible', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-missing-python-runtime-'))
    temporaryDirectories.push(directory)
    const installPythonRuntime = vi.fn(async () => ({
      installed: true as const,
      action: 'installed' as const,
      method: 'winget' as const,
      source: 'winget' as const,
      version: 'Python 3.12',
      architecture: 'x64' as const,
      pathRefreshRequired: true,
    }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable: async () => null,
        installPythonRuntime,
        inspectInstalledPythonRuntime: async () => { throw new Error('Python 3.12 fixed install not found') },
      },
    )

    await expect(service.installPythonRuntime({ isDestroyed: () => false, send: vi.fn() })).resolves.toMatchObject({
      action: 'installed',
      version: 'Python 3.12',
    })
    expect(installPythonRuntime).toHaveBeenCalledWith(expect.objectContaining({ architecture: process.arch }))
  })
})

describe('Windows restart handoff', () => {
  it('uses the fixed system shutdown command with a delayed restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-windows-restart-'))
    temporaryDirectories.push(directory)
    const runCommand = vi.fn<typeof productionRunCommand>(async (spec: { executable: string; argv: readonly string[] }) => ({
      executable: spec.executable,
      argv: [...spec.argv],
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      outputBytes: 0,
      durationMs: 1,
    }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      { platform: 'win32', runCommand, resolveWindowsMachinePaths: () => testMachinePaths },
    )

    await service.restartWindows()

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: expect.stringMatching(/System32[\\/]shutdown\.exe$/i),
        argv: ['/r', '/t', '15', '/d', 'p:0:0', '/c', 'XingMang AI requires a restart to finish Windows updates'],
      }),
      expect.objectContaining({ trustedOnly: true, timeoutMs: 10_000 }),
    )
  })

  it('does not expose a restart operation on non-Windows platforms', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-non-windows-restart-'))
    temporaryDirectories.push(directory)
    const runCommand = vi.fn<typeof productionRunCommand>()
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      { platform: 'darwin', runCommand },
    )

    await expect(service.restartWindows()).rejects.toThrow('系统重启仅支持 Windows')
    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('npm install progress reporting', () => {
  it.runIf(process.platform === 'win32')('does not reinstall a supported PATH-visible Node.js and npm runtime', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-existing-node-runtime-'))
    temporaryDirectories.push(directory)
    const nodeExecutable = 'D:\\nodejs\\node.exe'
    const npmExecutable = 'D:\\nodejs\\npm.cmd'
    const findExecutable = vi.fn<typeof productionFindExecutable>(async (command) => {
      if (command === 'node') return nodeExecutable
      if (command === 'npm') return npmExecutable
      return null
    })
    const runCommand = vi.fn(async (spec: { executable: string; argv: readonly string[] }) => ({
      executable: spec.executable,
      argv: [...spec.argv],
      exitCode: 0,
      signal: null,
      stdout: spec.executable === nodeExecutable ? 'v24.19.0\n' : '11.17.0\n',
      stderr: '',
      outputBytes: 10,
      durationMs: 1,
    }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const target = { isDestroyed: () => false, send: vi.fn() }
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable,
        runCommand,
      },
    )

    await expect(service.installNodeRuntime(target)).resolves.toMatchObject({
      action: 'unchanged',
      method: null,
      source: null,
      version: 'v24.19.0',
      pathRefreshRequired: false,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(target.send).toHaveBeenCalledWith(
      'runtime:node-install-progress',
      expect.objectContaining({ phase: 'complete', message: expect.stringContaining('无需重复安装') }),
    )
  })

  it.runIf(process.platform === 'win32')('does not reinstall Node.js when elevated mode sees only a user-scoped npm', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-elevated-npm-'))
    temporaryDirectories.push(directory)
    const userNpm = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\npm.cmd'
    const findExecutable = vi.fn<typeof productionFindExecutable>(async (command, options = {}) => {
      if (command !== 'npm') return null
      return options.trustedOnly ? null : userNpm
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const target = { isDestroyed: () => false, send: vi.fn() }
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'trusted-only',
        findExecutable,
      },
    )

    await expect(service.installCli('codex', target)).rejects.toThrow(
      '当前会话经过了显式提权或权限状态无法确认',
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(target.send).not.toHaveBeenCalledWith(
      'cli:install-progress',
      expect.objectContaining({ message: expect.stringContaining('自动安装 Node.js') }),
    )
  })

  it.runIf(process.platform === 'win32')('blocks Node.js installation before MSI when Windows has a pending reboot', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-pending-reboot-node-runtime-'))
    temporaryDirectories.push(directory)
    const target = { isDestroyed: () => false, send: vi.fn() }
    const installNodeRuntime = vi.fn()
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable: async () => null,
        inspectWindowsRestartRequired: async () => ({
          required: true,
          reasons: ['Windows Update 待重启', '安装文件替换待重启'],
        }),
        installNodeRuntime,
      },
    )

    await expect(service.installNodeRuntime(target)).rejects.toThrow(
      '检测到 Windows 有待完成的系统更新（Windows Update 待重启、安装文件替换待重启）',
    )
    expect(installNodeRuntime).not.toHaveBeenCalled()
    expect(target.send).toHaveBeenCalledWith(
      'runtime:node-install-progress',
      expect.objectContaining({ phase: 'error', message: expect.stringContaining('请先重启电脑') }),
    )
  })

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

  it('keeps the unsanitized base for callers that stay at the current integrity level', () => {
    const env = interactiveTerminalEnvironment({
      PATH: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
      NODE_OPTIONS: '--require=C:\\Users\\tester\\hook.js',
    })

    // same-user launches never cross an integrity boundary, so narrowing PATH
    // here would only break globally installed tools in the default scenario.
    expect(env.NODE_OPTIONS).toBe('--require=C:\\Users\\tester\\hook.js')
    expect(env.PATH).toContain('C:\\Users\\tester\\AppData\\Roaming\\npm')
  })

  it('strips injection variables from an elevated base while keeping the color layer', () => {
    const env = interactiveTerminalEnvironment(
      {
        PATH: ['C:\\Users\\tester\\AppData\\Roaming\\npm', 'D:\\Windows\\System32'].join(';'),
        TERM: 'dumb',
        NO_COLOR: '1',
        NODE_OPTIONS: '--require=C:\\Users\\tester\\payload.js',
        NODE_PATH: 'C:\\Users\\tester\\modules',
        BROWSER: 'C:\\Users\\tester\\evil.exe',
        GIT_ASKPASS: 'C:\\Users\\tester\\steal.exe',
        DOTNET_STARTUP_HOOKS: 'C:\\Users\\tester\\hook.dll',
        PSModulePath: 'C:\\Users\\tester\\Documents\\WindowsPowerShell\\Modules',
        CODEX_HOME: 'C:\\Users\\tester\\.codex',
      },
      (baseEnv) => trustedCommandEnvironment(baseEnv, testMachinePaths),
    )

    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.NODE_PATH).toBeUndefined()
    expect(env.BROWSER).toBeUndefined()
    expect(env.GIT_ASKPASS).toBeUndefined()
    expect(env.DOTNET_STARTUP_HOOKS).toBeUndefined()
    expect(env.PSModulePath).not.toContain('tester')
    expect(env.PATH).not.toContain('C:\\Users\\tester')
    expect(env.PATH).toContain(testMachinePaths.system32)
    // The CLI still needs its own configuration root; sanitizing must not
    // reach beyond the documented injection variables.
    expect(env.CODEX_HOME).toBe('C:\\Users\\tester\\.codex')
    expect(env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      CLICOLOR: '1',
      CLICOLOR_FORCE: '1',
    })
    expect(env.NO_COLOR).toBeUndefined()
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
      // A confirmed absence, not merely the absence of a positive result.
      detectionFailed: false,
      detectionError: null,
    })
  })

  it('reports a detected Codex App as an installed externally managed desktop app', async () => {
    const { service } = await createDarwinService({
      macosCodexAppDetector: async () => ({
        app: {
          path: '/Applications/Codex.app',
          version: '26.727.51351',
          running: true,
        },
        detectionFailed: false,
        detectionError: null,
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
      detectionFailed: false,
    })
  })

  it('degrades a rejected Codex App detector to detectionFailed, not to a confirmed not-installed status', async () => {
    const { service } = await createDarwinService({
      macosCodexAppDetector: async () => { throw new Error('inspection unavailable') },
    })

    await expect(service.inspectCodexDesktop()).resolves.toMatchObject({
      // `installed: false` alone would tell the renderer to offer an install
      // button for something that may already be on the user's machine —
      // detectionFailed is what keeps this reading as "retry", not "install".
      installed: false,
      version: null,
      appVersion: null,
      path: null,
      installDirectory: null,
      running: false,
      updateCheck: 'skipped',
      updateError: null,
      detectionFailed: true,
      detectionError: 'inspection unavailable',
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
      macosCodexAppDetector: async () => ({ app: null, detectionFailed: false, detectionError: null }),
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
    const stagedExecutable = verificationSpecs[0]?.argv.at(-1)

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
        argv: [
          '--verify',
          '--strict',
          '-R=anchor apple generic'
            + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
            + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
            + ' and certificate leaf[subject.OU] = "2DC432GLL2"',
          stagedExecutable!,
        ],
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
        macosCodexAppDetector: async () => ({ app: null, detectionFailed: false, detectionError: null }),
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
        macosCodexAppDetector: async () => ({ app: null, detectionFailed: false, detectionError: null }),
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
  })

  it('reduces a pinned mirror policy to the region yielding that order, passing auto through (2.4)', () => {
    expect(effectiveNetworkRegion('mirror-first', 'outside-mainland-china')).toBe('mainland-china')
    expect(effectiveNetworkRegion('official-first', 'mainland-china')).toBe('outside-mainland-china')
    expect(effectiveNetworkRegion('auto', 'outside-mainland-china')).toBe('outside-mainland-china')
    expect(effectiveNetworkRegion(undefined, 'unknown')).toBe('unknown')
  })

  it('routes an undetectable region to the mirror first', () => {
    // The probe fails on exactly the networks that also cannot reach
    // registry.npmjs.org, so official-first stranded the users it was meant to
    // serve. A wrong guess overseas costs seconds; a wrong guess in the
    // mainland costs the whole install.
    expect(npmInstallRegistries('unknown')).toEqual([
      'https://registry.npmmirror.com',
      'https://registry.npmjs.org',
    ])
  })

  it('keeps both registries reachable from every region', () => {
    // Reordering must never drop a fallback: whichever host is wrong for the
    // user, the other one is still attempted.
    for (const region of ['mainland-china', 'outside-mainland-china', 'unknown'] as const) {
      expect([...npmInstallRegistries(region)].sort()).toEqual([
        'https://registry.npmjs.org',
        'https://registry.npmmirror.com',
      ])
    }
  })

  it('stops re-probing a blocked region every minute', () => {
    // Each failed probe costs a 2.5s timeout, and it used to be repeated every
    // 60s on the slowest networks. With unknown now routing to the mirror there
    // is nothing to regain by retrying sooner; a manual rescan still clears it.
    expect(networkLocationCacheTtlMs).toBeGreaterThanOrEqual(10 * 60_000)
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

  it('uses the country-only fallback when Cloudflare trace is blocked', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).includes('cloudflare.com/cdn-cgi/trace')) {
        throw new Error('network unavailable')
      }
      if (String(input).includes('myip.ipip.net')) {
        return new Response('当前 IP：203.0.113.8 来自于：中国', { status: 200 })
      }
      return new Response(JSON.stringify({ ip: '203.0.113.8', country_code: 'CN' }), { status: 200 })
    })

    await expect(detectNetworkLocation(fetchMock, 1_000)).resolves.toMatchObject({
      publicIp: '203.0.113.8',
      countryCode: 'CN',
      region: 'mainland-china',
      error: null,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses a fallback provider when Cloudflare returns country without an IP', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('cloudflare.com/cdn-cgi/trace')) return new Response('loc=CN\n', { status: 200 })
      if (url.includes('ipapi.co')) return new Response('', { status: 403 })
      return new Response('当前 IP：106.117.85.131 来自于：中国 河北 石家庄 电信', { status: 200 })
    })

    await expect(detectNetworkLocation(fetchMock, 1_000)).resolves.toMatchObject({
      publicIp: '106.117.85.131',
      countryCode: 'CN',
      region: 'mainland-china',
      error: null,
    })
  })

  it('parses an IPIP fallback response with both IP and country', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('cloudflare.com/cdn-cgi/trace')) throw new Error('blocked')
      if (url.includes('ipapi.co')) return new Response('', { status: 403 })
      return new Response('当前 IP：106.117.85.131 来自于：中国 河北 石家庄 电信', { status: 200 })
    })

    await expect(detectNetworkLocation(fetchMock, 1_000)).resolves.toMatchObject({
      publicIp: '106.117.85.131',
      countryCode: 'CN',
      region: 'mainland-china',
      error: null,
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
      installDirectory: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
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
      installDirectory: null,
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
      installDirectory: 'C:\\Users\\tester\\.grok\\bin',
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
      installDirectory: null,
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

describe('scan probe degradation', () => {
  it('passes a fulfilled tool status through unchanged', () => {
    const value: ToolStatus = {
      installed: true,
      version: '20.11.0',
      path: 'C:\\Program Files\\nodejs\\node.exe',
      installDirectory: 'C:\\Program Files\\nodejs',
    }
    expect(buildToolStatusFromSettled({ status: 'fulfilled', value })).toBe(value)
  })

  it('degrades a rejected tool probe to detectionFailed instead of not-installed', () => {
    const result = buildToolStatusFromSettled({
      status: 'rejected',
      reason: new Error('机器级 PATH 校验失败'),
    })
    expect(result).toEqual({
      installed: false,
      version: null,
      path: null,
      installDirectory: null,
      detectionFailed: true,
      detectionError: '机器级 PATH 校验失败',
    })
  })

  it('passes a fulfilled network location through unchanged', () => {
    const value: NetworkLocationStatus = {
      publicIp: '1.2.3.4',
      countryCode: 'CN',
      region: 'mainland-china',
      checkedAt: '2026-08-08T00:00:00.000Z',
      error: null,
    }
    expect(buildNetworkLocationStatusFromSettled({ status: 'fulfilled', value })).toBe(value)
  })

  it('degrades a rejected network probe to an unknown region carrying the failure reason', () => {
    const result = buildNetworkLocationStatusFromSettled(
      { status: 'rejected', reason: new Error('网络位置检测超时') },
      '2026-08-08T00:00:00.000Z',
    )
    expect(result).toEqual({
      publicIp: null,
      countryCode: null,
      region: 'unknown',
      checkedAt: '2026-08-08T00:00:00.000Z',
      error: '网络位置检测超时',
    })
  })

  it('passes a fulfilled desktop app status through unchanged', () => {
    const value: DesktopAppStatus = {
      installed: true,
      version: '1.0.0',
      path: 'OpenAI.Codex!App',
      installDirectory: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex',
      appVersion: '1.0.0',
      mirrorVersion: '1.0.0',
      mirrorUpdateAvailable: false,
      mirrorError: null,
      running: false,
    }
    expect(buildDesktopAppStatusFromSettled({ status: 'fulfilled', value })).toBe(value)
  })

  it('degrades a rejected Codex Desktop probe to detectionFailed with a failed update check', () => {
    const result = buildDesktopAppStatusFromSettled({
      status: 'rejected',
      reason: new Error('PowerShell 启动失败'),
    })
    expect(result).toMatchObject({
      installed: false,
      version: null,
      path: null,
      installDirectory: null,
      appVersion: null,
      mirrorVersion: null,
      mirrorUpdateAvailable: null,
      mirrorError: null,
      running: false,
      detectionFailed: true,
      detectionError: 'PowerShell 启动失败',
      updateCheck: 'failed',
      updateError: 'PowerShell 启动失败',
    })
  })

  it('passes a fulfilled CLI tool status through unchanged', () => {
    const value: ToolStatus = {
      installed: true,
      version: '0.145.0',
      path: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd',
      installDirectory: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
    }
    expect(buildCliToolStatusFromSettled({ status: 'fulfilled', value: { status: value } })).toBe(value)
  })

  it('degrades a rejected CLI probe to detectionFailed instead of not-installed', () => {
    const result = buildCliToolStatusFromSettled({
      status: 'rejected',
      reason: new Error('npm 全局包目录解析失败'),
    })
    expect(result).toEqual({
      installed: false,
      version: null,
      path: null,
      installDirectory: null,
      detectionFailed: true,
      detectionError: 'npm 全局包目录解析失败',
    })
  })
})
