import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import * as TOML from '@iarna/toml'
import { classifyNetworkFailure } from './network-failure'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore, defaultAppSettings } from './app-settings'
import { InstallationQueue } from './installation-queue'
import { ToolConfigOwnershipStore } from './tool-config-ownership'
import { resolveInterruptibleInstallTask } from './quit-blocking-tasks'
import { providerBaseUrls, type ProviderId } from './catalog'
import { createRelayEndpointRoutingSnapshot, relayProviderBaseUrls } from './relay-sites'
import type { RunningToolsReport } from './running-tools'
import { providerConfigRoot, type ProviderConfigRoots } from './codex-home'
import {
  CommandRunnerError,
  findExecutable as productionFindExecutable,
  runCommand,
  trustedCommandEnvironment,
  type runCommand as productionRunCommand,
} from './command-runner'
import type { WindowsMachinePaths } from './windows-machine-paths'
import type { NodeRuntimeInstallResult } from './node-runtime'
import { codexAuthSnapshotPaths, codexConfigSnapshotPaths, inspectProviderConfig, providerConfigPaths, saveProviderConfig } from './config-files'
import { resolveBundledCodexModelCatalogPath, type CodexDesktopCatalogProbe } from './codex-model-catalog'
import type { MacosCodexAppInspection } from './macos-codex-app'
import { managedCliPackageDirectory, probeRunningCliProcesses } from './cli-process-probe'
import { classifyOperationError } from '../src/renderer-v2/operation-error'
import { managedNodeRuntimeBinDirectory, managedNpmCacheRoot, managedNpmPrefix } from './managed-cli-paths'
import { ensureManagedNpmLayout } from './managed-cli'
import { installLeftoverMinimumAgeMs, sweepInstallLeftovers, type InstallLeftoverLocation } from './install-leftovers'
import { LinuxTerminalLaunchError, linuxTerminalFailureMessages } from './linux-terminal'
import { WindowsCliLaunchError } from './windows-elevation'
import type { installMacGitRuntime as installMacGitRuntimeType } from './macos-git-install'
import {
  resolveCliCommand as resolveVerifiedToolCommand,
  resolveCliInstallation as resolveCliInstallationForTest,
  type CliInstallation,
} from './tool-installation'
import { buildCliVersionAdvice, cliVerifiedVersions } from './cli-verified-versions'
import {
  assertNpmPackageLocksEquivalent,
  assertNpmReleaseIntegrityMatches,
  assertNpmReleaseMatchesOfficialLock,
  buildCliLaunchQueueKey,
  buildCliStatus,
  cliHooksAutoRepairedField,
  cliHooksSummaryFields,
  grokCliHooksMissing,
  shouldAutoRepairCliHooks,
  externalCliInstallRefusal,
  buildCliMaintenancePlan,
  buildCliToolStatusFromSettled,
  buildDarwinCliLaunchPlan,
  buildDarwinTrustedVerificationRunner,
  buildCliUninstallPlan,
  buildDesktopAppStatusFromSettled,
  buildNetworkLocationStatusFromSettled,
  buildToolStatusFromSettled,
  installGitAlongsideClaude,
  buildUncheckedLatestVersion,
  latestVersionUncheckedMessage,
  networkProbeSuggestsOffline,
  offlineLatestVersionBudgetMs,
  settleLatestVersionProbes,
  createSystemService,
  codexDesktopCatalogProbeFromMacosApp,
  codexDesktopCatalogProbeFromPackage,
  createCachedProbe,
  settleWithin,
  unlessStopped,
  nodeStillOutdatedAfterReplaceMessage,
  shouldReplaceNodeForCertificates,
  DarwinGrokRetainedPathsError,
  inspectVerifiedDarwinGrokPostInstall,
  interactiveTerminalEnvironment,
  modelAccessCacheKey,
  ManagedNpmRollbackError,
  detectNetworkLocation,
  detectNetworkRegion,
  fetchNpmPackageReleaseMetadata,
  formatMebibytes,
  cliInstallTargetDirectory,
  cliLatestVersionSource,
  grokInstallStrategyFor,
  grokManualUninstallResult,
  formatElapsedDuration,
  networkLocationCacheTtlMs,
  npmDownloadTimeoutMs,
  effectiveNetworkRegion,
  npmInstallRegistries,
  npmRegistryLabel,
  describeNpmCommandFailure,
  describeNpmUninstallFailure,
  grokDownloadStallHeartbeatMs,
  grokDownloadStallMessage,
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
  createScanCoalescer,
  scanProbeConcurrency,
  readGrokLocalVersionForExecutable,
  resolveCliInstallRelease,
  replaceManagedNpmPrefixAtomically,
  uninstallVerifiedDarwinGrokInstallation,
  type DesktopAppStatus,
  type LatestVersionProbe,
  type NetworkLocationStatus,
  type SystemServiceOptions,
  type ToolStatus,
} from './system-service'

// 卸载失败时要数这个工具的进程（第三十三批 C）。默认照真的跑；Linux 上真的那份
// 一律回 unsupported，所以要「数到进程」的用例临时换掉一次结果。
vi.mock('./cli-process-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cli-process-probe')>()
  return { ...actual, probeRunningCliProcesses: vi.fn(actual.probeRunningCliProcesses) }
})

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

// api.solov.cc(sub2api 站点)写进 CLI 配置的 base URL,按 relay-sites.ts 的
// solov-api 条目逐字抄写。故意不 import 那张表:测试要钉住的正是这四个取值,
// 从表里读回来就等于什么都没验。
const sub2ApiProviderBaseUrls: Record<ProviderId, string> = {
  claude: 'https://api.solov.cc',
  codex: 'https://api.solov.cc/v1',
  grok: 'https://api.solov.cc/v1',
  gemini: 'https://api.solov.cc',
}

function createService(options: SystemServiceOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-system-service-'))
  temporaryDirectories.push(directory)
  return createSystemService(new AppSettingsStore(path.join(directory, 'settings.json'), directory), options)
}

async function createDarwinService(options: {
  workspace?: string
  configured?: boolean
  accountMode?: 'relay' | 'official' | 'unknown'
  codexHome?: string
  macosCodexAppDetector?: () => Promise<MacosCodexAppInspection>
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-desktop-'))
  temporaryDirectories.push(directory)
  const workspace = options.workspace ?? directory
  const codexHome = options.codexHome ?? path.join(directory, 'selected-codex-home')
  const codexEnv: NodeJS.ProcessEnv = { ...process.env, HOME: directory, CODEX_HOME: codexHome }
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
  const accountMode = options.accountMode ?? (options.configured === false ? 'unknown' : 'relay')
  const inspectConfig = vi.fn(() => ({
    baseUrl: 'https://xm.solov.cc/v1',
    actualBaseUrl: accountMode === 'relay' ? 'https://xm.solov.cc/v1' : 'https://example.invalid',
    exists: true,
    hasApiKey: accountMode !== 'official',
    matchesRelay: accountMode === 'relay',
    apiKey: accountMode === 'official' ? '' : 'sk-test-key',
    model: 'gpt-5.6-sol',
    dataDirectory: path.join(directory, '.codex'),
    dataDirectoryExists: true,
    files: [],
    updatedAt: '2026-08-03T00:00:00.000Z',
  }))
  const macosCodexAppDetector = options.macosCodexAppDetector
    ?? vi.fn(async () => ({ app: { path: '/Applications/Codex.app', version: '26.727.51351', running: true }, detectionFailed: false, detectionError: null }))
  const findExecutable = vi.fn(async () => null)
  const service = createSystemService(store, {
    platform: 'darwin',
    providerRoots: { userHome: directory, codexHome },
    codexEnv,
    inspectProviderConfig: inspectConfig,
    resolveCliCommand: resolveCli,
    runCommand: execute,
    macosCodexAppDetector,
    findExecutable,
  })
  return {
    service,
    workspace,
    codexEnv,
    resolvedCommand,
    resolveCli,
    execute,
    findExecutable,
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  // restoreAllMocks 不碰 vi.fn：换回真的进程检测，用例里排着没用掉的结果也一并清掉。
  vi.mocked(probeRunningCliProcesses).mockReset()
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

  it('removes stale Gemini gateway variables so the CLI loads the managed home env file', () => {
    const userHome = path.join(os.tmpdir(), 'xingmang-gemini-env-home')
    const environment = providerCommandEnvironment('gemini', {
      HOME: userHome,
      GEMINI_API_KEY: 'old-key',
      GOOGLE_GEMINI_BASE_URL: 'https://old.example.test',
      GEMINI_MODEL: 'old-model',
      GOOGLE_GENAI_API_VERSION: 'v1alpha',
      GOOGLE_GENAI_USE_VERTEXAI: 'false',
      KEEP_THIS: 'yes',
    }, { HOME: '/codex-home' })
    expect(environment).toMatchObject({ HOME: userHome, KEEP_THIS: 'yes' })
    for (const key of ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_MODEL', 'GOOGLE_GENAI_API_VERSION']) {
      expect(environment[key]).toBeUndefined()
    }
  })

  it('refreshes only location through its proxy-aware fetch and reloads proxy configuration first', async () => {
    const sequence: string[] = []
    const globalFetch = vi.fn(async () => { throw new Error('Node fetch must not inspect the desktop route') })
    vi.stubGlobal('fetch', globalFetch)
    const inspect = vi.fn()
    const execute = vi.fn()
    const relayFetch = vi.fn()
    const reload = vi.fn(async () => { sequence.push('reload') })
    let count = 0
    const networkFetch = vi.fn<typeof fetch>(async () => {
      sequence.push('fetch')
      return new Response(`ip=203.0.113.${++count}\nloc=JP\n`, { status: 200 })
    })
    const service = createService({
      findExecutable: inspect, runCommand: execute, relayFetch,
      networkLocationFetch: networkFetch, reloadNetworkProxyConfig: reload,
    })
    await expect(service.refreshNetworkLocation()).resolves.toMatchObject({ publicIp: '203.0.113.1', countryCode: 'JP' })
    await expect(service.refreshNetworkLocation()).resolves.toMatchObject({ publicIp: '203.0.113.2', countryCode: 'JP' })
    expect(sequence).toEqual(['reload', 'fetch', 'reload', 'fetch'])
    expect(networkFetch).toHaveBeenCalledWith('https://www.cloudflare.com/cdn-cgi/trace', expect.objectContaining({
      method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal),
    }))
    expect(globalFetch).not.toHaveBeenCalled()
    expect(relayFetch).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not probe a stale route when Chromium proxy reload fails', async () => {
    const networkFetch = vi.fn<typeof fetch>()
    const service = createService({
      networkLocationFetch: networkFetch,
      reloadNetworkProxyConfig: async () => { throw new Error('proxy service unavailable') },
    })
    await expect(service.refreshNetworkLocation()).rejects.toThrow('无法刷新当前网络代理配置')
    expect(networkFetch).not.toHaveBeenCalled()
  })

  it('refreshes official ChatGPT usage through the injected fetch and skips Xingmang keys', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-official-usage-refresh-'))
    temporaryDirectories.push(root)
    const usage = {
      planLabel: 'Pro 5x',
      renewsAt: '2026-09-22T11:32:00.000Z',
      resetCredits: 1,
      windows: [],
      checkedAt: '2026-08-24T00:00:00.000Z',
    }
    const fetchUsage = vi.fn(async () => usage)
    let hasApiKey = false
    const inspect = vi.fn((provider: Parameters<typeof providerConfigRoot>[0]) => ({
      baseUrl: providerBaseUrls[provider],
      actualBaseUrl: providerBaseUrls[provider],
      exists: true,
      apiKey: hasApiKey ? 'sk-xingmang' : '',
      hasApiKey,
      matchesRelay: hasApiKey,
      model: 'gpt-5.3-codex-spark',
      officialAccountPlan: 'Pro 5x',
      officialAccountRenewsAt: '2026-09-22T11:32:00.000Z',
      dataDirectory: root,
      dataDirectoryExists: true,
      files: [],
      updatedAt: '2026-08-24T00:00:00.000Z',
    }))
    const service = createSystemService(
      new AppSettingsStore(path.join(root, 'settings.json'), root),
      { inspectProviderConfig: inspect, fetchOfficialChatGptUsage: fetchUsage },
    )

    expect(await service.refreshOfficialChatGptUsage()).toEqual(usage)
    expect(await service.refreshOfficialChatGptUsage()).toEqual(usage)
    expect(fetchUsage).toHaveBeenCalledTimes(2)

    hasApiKey = true
    fetchUsage.mockClear()
    expect(await service.refreshOfficialChatGptUsage()).toBeNull()
    expect(fetchUsage).not.toHaveBeenCalled()
  })

  it('delegates settings reads and merged durable updates to AppSettingsStore', async () => {
    const service = createService()
    const initial = service.readStoredConfig()
    expect(initial).toEqual({ ...defaultAppSettings(initial.workspace),
      activeRelayEndpointIds: { solov: 'primary', 'solov-api': 'primary' } })

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

    const first = service.updateStoredConfig({ version: 2, relaySiteId: 'solov-api' })
    const second = service.updateStoredConfig({ version: 2, sidebarMoreExpanded: true })
    await Promise.all([first, second])

    expect(service.readStoredConfig()).toMatchObject({
      relaySiteId: 'solov-api',
      sidebarMoreExpanded: true,
    })
  })

  it('persists pending endpoint preferences without changing live transport or snapshot', async () => {
    const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
    const service = createService({ relayFetch })
    const saved = await service.updateStoredConfig({ version: 2, relayEndpointIds: { solov: 'direct' } })
    expect(saved.relayEndpointIds).toEqual({ solov: 'direct' })
    expect(saved.activeRelayEndpointIds).toEqual({ solov: 'primary', 'solov-api': 'primary' })
    expect(service.readStoredConfig().activeRelayEndpointIds).toEqual(saved.activeRelayEndpointIds)
    await service.fetchAvailableModels('sk-fixture')
    expect(relayFetch.mock.calls[0][0]).toBe('https://xm.solov.cc/v1/models')
  })

  it.each(['claude', 'codex', 'gemini', 'grok'] satisfies ProviderId[])(
    'uses one selected origin for the %s write and its model probe after restart', async (provider) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-selected-endpoint-'))
      temporaryDirectories.push(root)
      const providerRoots = { userHome: root, codexHome: path.join(root, '.codex') }
      const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
      const service = createService({ providerRoots, relayFetch,
        relayEndpointRouting: createRelayEndpointRoutingSnapshot({ solov: 'direct' }) })
      await service.saveConfig({ provider, apiKey: 'sk-fixture', model: 'fixture-model', mode: 'reset' }, false)
      const direct = relayProviderBaseUrls('solov', 'direct')
      expect(relayFetch.mock.calls[0][0]).toBe(`${direct.claude}/v1/models`)
      const written = inspectProviderConfig(provider, providerRoots, providerBaseUrls)
      expect(written.actualBaseUrl).toBe(direct[provider])
      expect(written.matchesRelay).toBe(true)
      expect(inspectProviderConfig(provider, providerRoots, sub2ApiProviderBaseUrls).matchesRelay).toBe(false)
    },
  )

  it('keeps a recognized existing native endpoint during an ordinary save with no line preference', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-preserved-endpoint-'))
    temporaryDirectories.push(root)
    const providerRoots = { userHome: root, codexHome: path.join(root, '.codex') }
    const direct = relayProviderBaseUrls('solov', 'direct')
    saveProviderConfig('codex', 'sk-fixture', 'fixture-model', 'reset', providerRoots, {}, direct)
    const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
    const service = createService({ providerRoots, relayFetch })
    await service.saveConfig({ provider: 'codex', apiKey: '', model: 'fixture-model', mode: 'merge' }, false)
    expect(inspectProviderConfig('codex', providerRoots, providerBaseUrls).actualBaseUrl).toBe(direct.codex)
    expect(relayFetch.mock.calls[0][0]).toBe(`${direct.claude}/v1/models`)
  })

  it('applies an explicit primary preference through the normal config ownership flow', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-explicit-endpoint-'))
    temporaryDirectories.push(root)
    const providerRoots = { userHome: root, codexHome: path.join(root, '.codex') }
    saveProviderConfig('codex', 'sk-fixture', 'fixture-model', 'reset', providerRoots, {}, relayProviderBaseUrls('solov', 'direct'))
    const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
    const service = createService({ providerRoots, relayFetch,
      relayEndpointRouting: createRelayEndpointRoutingSnapshot({ solov: 'primary' }) })
    await service.saveConfig({ provider: 'codex', apiKey: '', model: 'fixture-model', mode: 'merge' }, false)
    const written = service.getConfig(false).providers.codex
    expect(written.actualBaseUrl).toBe(providerBaseUrls.codex)
    expect(written.configurationOwnership).not.toBe('account')
    expect(relayFetch.mock.calls[0][0]).toBe('https://xm.solov.cc/v1/models')
  })

  async function automaticRouteFixture(options: {
    provider?: ProviderId
    source?: 'primary' | 'direct' | 'historical'
    explicit?: boolean
    report?: RunningToolsReport | Error
  } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-route-migration-'))
    temporaryDirectories.push(root)
    const provider = options.provider ?? 'codex'
    const roots = { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') }
    const sourceUrls = options.source === 'historical'
      ? { claude: 'https://38.147.105.28:8443', codex: 'https://38.147.105.28:8443/v1',
        gemini: 'https://38.147.105.28:8443', grok: 'https://38.147.105.28:8443/v1' }
      : relayProviderBaseUrls('solov', options.source ?? 'primary')
    saveProviderConfig(provider, 'sk-migration-fixture', 'fixture-model', 'reset', roots, {}, sourceUrls)
    const owner = JSON.stringify(['solov', 9])
    const account = { owner: owner as string | null }
    const ownership = new ToolConfigOwnershipStore(path.join(root, 'tool-config-ownership'))
    await ownership.write(provider, inspectProviderConfig(provider, roots, sourceUrls), 'account', owner)
    let modelsReturned = false
    const relayFetch = vi.fn<typeof fetch>(async () => {
      modelsReturned = true
      return Response.json({ data: [{ id: 'fixture-model' }] })
    })
    const inspectRunning = vi.fn(async () => {
      expect(modelsReturned).toBe(true)
      if (options.report instanceof Error) throw options.report
      return options.report ?? { running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false }
    })
    const service = createSystemService(new AppSettingsStore(path.join(root, 'settings.json'), root), {
      managerDataDirectory: root, providerRoots: roots, getExternalClientAccountId: () => account.owner,
      relayEndpointRouting: createRelayEndpointRoutingSnapshot(options.explicit === false ? {} : { solov: 'direct' }),
      relayFetch, inspectRunningToolsForTemplateFill: inspectRunning,
      resolveCliInstallation: async () => null,
      inspectCodexDesktopForModelCatalog: async () => ({ installed: false, version: null }),
    })
    function files(): Record<string, string> {
      const result: Record<string, string> = {}
      function collect(directory: string): void {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) collect(file)
          else result[path.relative(root, file)] = fs.readFileSync(file).toString('base64')
        }
      }
      collect(root)
      return result
    }
    return { provider, service, inspectRunning, files, account,
      save: (automatic = true) => service.saveConfig({ provider, apiKey: '', model: 'fixture-model', mode: 'merge' },
        false, undefined, { source: 'account', automatic }) }
  }

  it.each([
    { label: 'a CLI starts during the model query', report: { running: ['codex'], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false } },
    { label: 'the CLI state becomes unknown', report: { running: [], unknown: ['codex'], codexDesktopRunning: false, canRestartCodexDesktop: false } },
    { label: 'Codex desktop starts during the model query', report: { running: [], unknown: [], codexDesktopRunning: true, canRestartCodexDesktop: false } },
    { label: 'Codex desktop cannot be checked', report: { running: [], unknown: [], codexDesktopRunning: null, canRestartCodexDesktop: false } },
    { label: 'the process probe fails', report: new Error('fixture process probe failed') },
  ] satisfies Array<{ label: string; report: RunningToolsReport | Error }>)(
    'retains native files and ownership during automatic route migration when $label', async ({ report }) => {
      const f = await automaticRouteFixture({ report })
      const before = f.files()
      await expect(f.save()).rejects.toThrow('已保留原配置')
      expect(f.inspectRunning).toHaveBeenCalledWith(['codex'])
      expect(f.files()).toEqual(before)
      expect(f.service.getConfig(false).providers.codex.configurationOwnership).toBe('account')
    },
  )

  it.each(['claude', 'codex', 'gemini', 'grok'] satisfies ProviderId[])(
    'checks that %s stayed closed before committing an explicit automatic route migration', async (provider) => {
      const f = await automaticRouteFixture({ provider })
      await f.save()
      expect(f.inspectRunning).toHaveBeenCalledWith([provider])
      expect(f.service.getConfig(false).providers[provider].actualBaseUrl).toBe(relayProviderBaseUrls('solov', 'direct')[provider])
      expect(f.service.getConfig(false).providers[provider].configurationOwnership).toBe('account')
    },
  )

  it('moves a CLI still on the retired IP test entry to the direct domain', async () => {
    const f = await automaticRouteFixture({ source: 'historical' })
    await f.save()
    expect(f.inspectRunning).toHaveBeenCalledWith(['codex'])
    expect(f.service.getConfig(false).providers.codex.actualBaseUrl).toBe('https://xm-direct.solov.cc/v1')
    expect(f.service.getConfig(false).providers.codex.configurationOwnership).toBe('account')
  })

  it('protects the retired IP test entry before changing it to the direct domain', async () => {
    const f = await automaticRouteFixture({ source: 'historical', report: {
      running: [], unknown: [], codexDesktopRunning: true, canRestartCodexDesktop: false,
    } })
    const before = f.files()
    await expect(f.save()).rejects.toThrow('已保留原配置')
    expect(f.files()).toEqual(before)
  })

  it('revalidates the account after the final automatic route migration process probe', async () => {
    const f = await automaticRouteFixture()
    const before = f.files()
    f.inspectRunning.mockImplementationOnce(async () => {
      f.account.owner = JSON.stringify(['solov', 10])
      return { running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false }
    })
    await expect(f.save()).rejects.toThrow('账号已变化')
    expect(f.files()).toEqual(before)
  })

  it.each([
    { label: 'manual account configuration', source: 'primary' as const, explicit: true, automatic: false },
    { label: 'ordinary account refresh on the active route', source: 'direct' as const, explicit: true, automatic: true },
    { label: 'a known native route without an explicit line choice', source: 'direct' as const, explicit: false, automatic: true },
  ])('keeps existing $label outside the migration-only running gate', async ({ source, explicit, automatic }) => {
    const f = await automaticRouteFixture({ source, explicit, report: new Error('must not be used') })
    await f.save(automatic)
    expect(f.inspectRunning).not.toHaveBeenCalled()
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

    const configSnapshots = codexConfigSnapshotPaths({ userHome, codexHome })
    const authSnapshots = codexAuthSnapshotPaths({ userHome, codexHome })
    expect(result.files).toEqual([
      configSnapshots.relay,
      configSnapshots.active,
      authSnapshots.apikey,
      authSnapshots.active,
    ])
    expect(fs.existsSync(fallbackCodexHome)).toBe(false)
  })

  function codexCatalogFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-catalog-save-'))
    temporaryDirectories.push(root)
    const roots = { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') }
    const packageRoot = path.join(root, 'npm', 'lib', 'node_modules', '@openai', 'codex')
    // 测试中途换成别的版本或「读不出来」，看同一个服务下一次保存怎么处理那一行。
    const cli: { installation: CliInstallation | null | Error } = { installation: null }
    // 桌面端自带的那份 Codex：缺省是没装；真去探在 Windows / Mac CI 上会问到 runner 自己的系统。
    const desktop: { probe: CodexDesktopCatalogProbe } = { probe: { installed: false, version: null } }
    const account = { models: ['gpt-5.5', 'claude-opus-5', 'gpt-6.1-sol'] }
    const fetchModels = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      data: account.models.map((id) => ({ id })),
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchModels)
    const running = vi.fn(async () => ({ running: [] as ProviderId[], unknown: [] as ProviderId[], codexDesktopRunning: false as boolean | null, canRestartCodexDesktop: false }))
    const session = { account: JSON.stringify(['solov', 36]) as string | null }
    const desktopProbe = vi.fn(async () => desktop.probe)
    const service = createSystemService(new AppSettingsStore(path.join(root, 'settings.json'), root), {
      providerRoots: roots,
      bundledCodexModelCatalogPath: resolveBundledCodexModelCatalogPath(path.resolve(__dirname, '..')),
      resolveCliInstallation: async () => {
        if (cli.installation instanceof Error) throw cli.installation
        return cli.installation
      },
      inspectCodexDesktopForModelCatalog: desktopProbe,
      inspectRunningToolsForTemplateFill: running,
      getExternalClientAccountId: () => session.account,
    })
    function installCodexCli(version: string): void {
      cli.installation = {
        commandPath: path.join(root, 'npm', 'bin', 'codex'),
        installDirectory: packageRoot,
        packageRoot,
        npmPrefix: path.join(root, 'npm'),
        packageVersion: version,
        source: 'npm',
      }
    }
    function save(model = 'gpt-6.1-sol') {
      return service.saveConfig({ provider: 'codex', apiKey: 'sk-catalog', model, mode: 'merge' }, false)
    }
    function catalogSetting(): unknown {
      return asTomlRecord(TOML.parse(fs.readFileSync(providerConfigPaths('codex', roots)[0], 'utf8'))).model_catalog_json
    }
    function storedRelaySetting(): unknown {
      return asTomlRecord(TOML.parse(fs.readFileSync(codexConfigSnapshotPaths(roots).relay, 'utf8'))).model_catalog_json
    }
    return {
      cli, desktop, desktopProbe, account, session, fetchModels, running, roots, service, installCodexCli, save, catalogSetting, storedRelaySetting,
      catalogPath: path.join(roots.codexHome, 'xingmang-models.json'),
      catalogSlugs: () => (JSON.parse(fs.readFileSync(path.join(roots.codexHome, 'xingmang-models.json'), 'utf8')) as { models: Array<{ slug: string }> })
        .models.map((model) => model.slug),
    }
  }

  function asTomlRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }

  /** 本机版本探测 30 秒内复用；测试里让时间走过去，下一次保存才会重新探。 */
  function letCatalogReaderProbesExpire(): void {
    vi.setSystemTime(Date.now() + 31_000)
  }

  // 开机那轮在后台跑，测试只能等结果落盘。Windows CI 上保存一次配置就要 0.8 秒上下，
  // waitFor 缺省的 1 秒连一次保存都等不完。
  const backgroundStartupWait = { timeout: 10_000 }

  it('writes the official Codex entries for the models the account can use, so the desktop menu lists GPT-6.1 Sol', async () => {
    const f = codexCatalogFixture()
    f.installCodexCli('0.156.1')

    const result = await f.save()

    expect(result.files[0]).toBe(f.catalogPath)
    expect(f.catalogSetting()).toBe('xingmang-models.json')
    const written = JSON.parse(fs.readFileSync(f.catalogPath, 'utf8')) as { models: Array<{ slug: string }> }
    expect(written.models.map((model) => model.slug)).toEqual(['gpt-6.1-sol', 'gpt-5.5'])
  })

  it('writes the catalog when only a Codex desktop app from a release that reads it is on this computer', async () => {
    const f = codexCatalogFixture()
    f.desktop.probe = { installed: true, version: '26.930.2377.0' }

    await f.save()

    expect(f.catalogSetting()).toBe('xingmang-models.json')
  })

  it('does not write the catalog for a Codex desktop app from a release that predates it', async () => {
    const f = codexCatalogFixture()
    f.desktop.probe = { installed: true, version: '26.909.1234.0' }

    const result = await f.save()

    expect(f.catalogSetting()).toBeUndefined()
    expect(result.files).not.toContain(f.catalogPath)
    expect(fs.existsSync(f.catalogPath)).toBe(false)
  })

  it('does not write a catalog that would leave out the configured default model', async () => {
    const f = codexCatalogFixture()

    await f.save('claude-opus-5')

    expect(f.catalogSetting()).toBeUndefined()
    expect(fs.existsSync(f.catalogPath)).toBe(false)
  })

  it('takes its catalog back once the Codex CLI on this computer is too old to read it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = codexCatalogFixture()
    await f.save()
    f.installCodexCli('0.150.0')
    letCatalogReaderProbesExpire()

    await f.save()

    expect(f.catalogSetting()).toBeUndefined()
  })

  it('leaves the catalog as it is when the Codex CLI version cannot be read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = codexCatalogFixture()
    await f.save()
    f.cli.installation = new Error('注册表读取失败')
    letCatalogReaderProbesExpire()

    await f.save()

    expect(f.catalogSetting()).toBe('xingmang-models.json')
  })

  it('leaves the catalog as it is when it cannot tell whether the Codex desktop app is installed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = codexCatalogFixture()
    await f.save()
    f.desktop.probe = { installed: null, version: null }
    letCatalogReaderProbesExpire()

    await f.save()

    expect(f.catalogSetting()).toBe('xingmang-models.json')
  })

  it('takes the catalog back on this computer before a launch once the Codex CLI was swapped for an older one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = codexCatalogFixture()
    await f.save()
    f.installCodexCli('0.146.1')
    letCatalogReaderProbesExpire()

    expect(await f.service.checkToolModels!('codex')).toEqual({ status: 'skipped' })

    expect(f.catalogSetting()).toBeUndefined()
    expect(f.storedRelaySetting()).toBeUndefined()
    // 名单文件留着：星芒的快照和旧备份可能还指向它。
    expect(fs.existsSync(f.catalogPath)).toBe(true)
  })

  it('takes the catalog back before a launch when its file went missing', async () => {
    const f = codexCatalogFixture()
    await f.save()
    fs.rmSync(f.catalogPath)

    await f.service.checkToolModels!('codex')

    expect(f.catalogSetting()).toBeUndefined()
  })

  it('keeps a readable catalog before a launch while the Codex CLI still reads it', async () => {
    const f = codexCatalogFixture()
    f.installCodexCli('0.156.1')
    await f.save()
    const before = fs.readFileSync(providerConfigPaths('codex', f.roots)[0], 'utf8')

    await f.service.checkToolModels!('codex')

    expect(fs.readFileSync(providerConfigPaths('codex', f.roots)[0], 'utf8')).toBe(before)
  })

  it('brings the catalog up to the account at startup, backing the config up first, once Codex is closed', async () => {
    const f = codexCatalogFixture()
    await f.service.saveConfig({ provider: 'codex', apiKey: 'sk-catalog', model: 'gpt-6.1-sol', mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    expect(f.catalogSlugs()).toEqual(['gpt-6.1-sol', 'gpt-5.5'])
    f.account.models.push('gpt-6-astra')
    const backups: Array<{ provider: ProviderId; slugs: string[] }> = []

    expect(await f.service.fillToolTemplateDefaults!((provider) => { backups.push({ provider, slugs: f.catalogSlugs() }) })).toEqual({ filled: [] })

    // 名单落盘之后来源记录还要再写一次才改回「账号」，两样都到位才算这次同步做完。
    await vi.waitFor(() => {
      expect(f.catalogSlugs()).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.5'])
      expect(f.service.getConfig(false).providers.codex.configurationOwnership).toBe('account')
    }, backgroundStartupWait)
    expect(backups).toEqual([{ provider: 'codex', slugs: ['gpt-6.1-sol', 'gpt-5.5'] }])
    expect(f.running).toHaveBeenCalledWith(['codex'])
  })

  it('refreshes the Claude Code menu before a launch and keeps the account as the source of the config', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-picker-refresh-'))
    temporaryDirectories.push(root)
    const roots = { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') }
    const account = { models: ['claude-opus-5', 'claude-sonnet-5'] }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      data: account.models.map((id) => ({ id })),
    }), { status: 200 })))
    const service = createSystemService(new AppSettingsStore(path.join(root, 'settings.json'), root), {
      providerRoots: roots,
      getExternalClientAccountId: () => JSON.stringify(['solov', 36]),
    })
    await service.saveConfig({ provider: 'claude', apiKey: 'sk-claude', model: 'claude-opus-5', mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    account.models.push('claude-haiku-5')

    // 刷新那次写入会先把来源记录改成「手动」再写：按记录认人的话写到一半就作废，记录还留在「手动」。
    expect(await service.checkToolModels!('claude')).toEqual({ status: 'ok', pickerRefreshed: true })

    expect(service.getConfig(false).providers.claude.configurationOwnership).toBe('account')
  })

  it('leaves the catalog for a later try while Codex may still be open, and says it is still owed', async () => {
    const f = codexCatalogFixture()
    await f.service.saveConfig({ provider: 'codex', apiKey: 'sk-catalog', model: 'gpt-6.1-sol', mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    f.account.models.push('gpt-6-astra')
    f.running.mockResolvedValue({ running: [], unknown: [], codexDesktopRunning: null, canRestartCodexDesktop: false })
    const requests = f.fetchModels.mock.calls.length
    const backup = vi.fn()

    expect(await f.service.fillToolTemplateDefaults!(backup)).toEqual({ filled: [], pending: ['codex'] })
    expect(f.running).toHaveBeenCalledWith(['codex'])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(f.fetchModels.mock.calls.length).toBe(requests)
    expect(backup).not.toHaveBeenCalled()
    expect(f.catalogSlugs()).toEqual(['gpt-6.1-sol', 'gpt-5.5'])
  })

  it('brings the catalog up to the account on a later try once Codex has been closed', async () => {
    const f = codexCatalogFixture()
    await f.service.saveConfig({ provider: 'codex', apiKey: 'sk-catalog', model: 'gpt-6.1-sol', mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    f.account.models.push('gpt-6-astra')
    f.running.mockResolvedValue({ running: [], unknown: [], codexDesktopRunning: true, canRestartCodexDesktop: false })
    const backups: Array<{ provider: ProviderId; slugs: string[] }> = []
    function backup(provider: ProviderId): void { backups.push({ provider, slugs: f.catalogSlugs() }) }
    await f.service.fillToolTemplateDefaults!(backup)

    expect(await f.service.fillToolTemplateDefaults!(backup, true)).toEqual({ filled: [], pending: ['codex'] })
    f.running.mockResolvedValue({ running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false })
    expect(await f.service.fillToolTemplateDefaults!(backup, true)).toEqual({ filled: [] })

    await vi.waitFor(() => {
      expect(f.catalogSlugs()).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.5'])
      expect(f.service.getConfig(false).providers.codex.configurationOwnership).toBe('account')
    }, backgroundStartupWait)
    expect(backups).toEqual([{ provider: 'codex', slugs: ['gpt-6.1-sol', 'gpt-5.5'] }])
    // 核对过就不欠了：再来要不再起进程看 Codex 开没开，也不再问中转。
    const probes = f.running.mock.calls.length
    const requests = f.fetchModels.mock.calls.length
    expect(await f.service.fillToolTemplateDefaults!(backup, true)).toEqual({ filled: [] })
    expect(f.running.mock.calls.length).toBe(probes)
    expect(f.fetchModels.mock.calls.length).toBe(requests)
  })

  it('stops waiting for the Codex check once an account change begins, and still owes the catalog', async () => {
    const f = codexCatalogFixture()
    await f.service.saveConfig({ provider: 'codex', apiKey: 'sk-catalog', model: 'gpt-6.1-sol', mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    f.account.models.push('gpt-6-astra')
    // 安全软件拖住了 PowerShell：看 Codex 开没开这一下迟迟没有回音。
    f.running.mockImplementation(() => new Promise<never>(() => undefined))
    const requests = f.fetchModels.mock.calls.length
    const backups: Array<{ provider: ProviderId; slugs: string[] }> = []
    function backup(provider: ProviderId): void { backups.push({ provider, slugs: f.catalogSlugs() }) }

    const startup = f.service.fillToolTemplateDefaults!(backup)
    await vi.waitFor(() => expect(f.running).toHaveBeenCalledWith(['codex']), backgroundStartupWait)
    const resume = f.service.stopTemplateFillWaits!()

    expect(await startup).toEqual({ filled: [], pending: ['codex'] })
    expect(f.fetchModels.mock.calls.length).toBe(requests)
    expect(backups).toEqual([])
    expect(f.catalogSlugs()).toEqual(['gpt-6.1-sol', 'gpt-5.5'])

    // 换账号那段等完了、没换成，还是这个账号：再来要时照常看，Codex 关着就按账号核对。
    resume()
    f.running.mockResolvedValue({ running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false })
    expect(await f.service.fillToolTemplateDefaults!(backup, true)).toEqual({ filled: [] })
    await vi.waitFor(() => {
      expect(f.catalogSlugs()).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.5'])
      expect(f.service.getConfig(false).providers.codex.configurationOwnership).toBe('account')
    }, backgroundStartupWait)
    expect(backups).toEqual([{ provider: 'codex', slugs: ['gpt-6.1-sol', 'gpt-5.5'] }])
  })

  it('stops waiting for the startup check of the catalog once an account change begins', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = codexCatalogFixture()
    await f.service.saveConfig({ provider: 'codex', apiKey: 'sk-catalog', model: 'gpt-6.1-sol', mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    // 开机那次本机核对要重新问桌面端是哪一版，这一问迟迟没有回音。
    letCatalogReaderProbesExpire()
    f.desktopProbe.mockImplementation(() => new Promise<never>(() => undefined))
    const desktopProbes = f.desktopProbe.mock.calls.length

    const startup = f.service.fillToolTemplateDefaults!(() => undefined)
    await vi.waitFor(() => expect(f.desktopProbe.mock.calls.length).toBeGreaterThan(desktopProbes), backgroundStartupWait)
    f.service.stopTemplateFillWaits!()

    expect(await startup).toEqual({ filled: [], pending: ['codex'] })
    expect(f.running).not.toHaveBeenCalled()
  })

  it('owes nothing for a Codex config the account did not write, even while Codex is open', async () => {
    const f = codexCatalogFixture()
    await f.save()
    f.running.mockResolvedValue({ running: [], unknown: [], codexDesktopRunning: true, canRestartCodexDesktop: false })

    expect(await f.service.fillToolTemplateDefaults!(() => undefined)).toEqual({ filled: [] })
    expect(f.running).not.toHaveBeenCalled()
  })

  it('takes the catalog back at startup once the Codex desktop app turns out to predate it, without an account', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = codexCatalogFixture()
    await f.save()
    f.desktop.probe = { installed: true, version: '26.827.5501.0' }
    letCatalogReaderProbesExpire()

    expect(await f.service.fillToolTemplateDefaults!(() => undefined)).toEqual({ filled: [] })

    await vi.waitFor(() => expect(f.catalogSetting()).toBeUndefined(), backgroundStartupWait)
  })

  it('takes the catalog back at startup while logged out, once for the whole startup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = codexCatalogFixture()
    await f.save()
    f.session.account = null
    f.desktop.probe = { installed: true, version: '26.827.5501.0' }
    letCatalogReaderProbesExpire()

    const startup = f.service.guardCodexModelCatalogAtStartup!()
    await startup

    expect(f.catalogSetting()).toBeUndefined()
    // 登录状态下开机那轮按账号同步也走这一次，不再问一遍。
    expect(f.service.guardCodexModelCatalogAtStartup!()).toBe(startup)
  })

  it('does not hold a launch behind another config write while the catalog is readable', async () => {
    const f = codexCatalogFixture()
    f.installCodexCli('0.156.1')
    await f.save()
    // 另一次保存（换了一把 Key，模型列表不在缓存里）卡在问中转：它拿着写配置的锁。
    let answer!: () => void
    f.fetchModels.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      answer = () => resolve(new Response(JSON.stringify({ data: f.account.models.map((id) => ({ id })) }), { status: 200 }))
    }))
    const pendingSave = f.service.saveConfig({ provider: 'codex', apiKey: 'sk-catalog-next', model: 'gpt-6.1-sol', mode: 'merge' }, false)
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))

    // 排在锁后面的话要等到打开前那 3 秒上限才放行：给慢机器留些余量，但不能放到 3 秒。
    const launch = await Promise.race([
      f.service.checkToolModels!('codex').then(() => 'checked'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 2_000)),
    ])

    expect(launch).toBe('checked')
    answer()
    await pendingSave
    expect(f.catalogSetting()).toBe('xingmang-models.json')
  })

  function claudeConsoleKeyFixture(prefix: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    temporaryDirectories.push(root)
    const roots = { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') }
    fs.mkdirSync(roots.userHome, { recursive: true })
    const rootConfigPath = path.join(roots.userHome, '.claude.json')
    const snapshotPath = path.join(providerConfigRoot('claude', roots), 'xingmang-claude-console-key.json')
    const [settingsPath] = providerConfigPaths('claude', roots)
    const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'claude-sonnet-5' }],
    }), { status: 200 })))
    const service = createSystemService(store, { providerRoots: roots })
    const payload = { provider: 'claude' as const, apiKey: 'sk-relay', model: 'claude-sonnet-5', mode: 'merge' as const }
    return { root, roots, rootConfigPath, snapshotPath, settingsPath, store, service, payload }
  }

  it('moves the Claude Console key aside before writing the relay config', async () => {
    const f = claudeConsoleKeyFixture('xingmang-console-key-move-')
    fs.writeFileSync(f.rootConfigPath, JSON.stringify({ primaryApiKey: 'sk-ant-console', theme: 'dark' }), 'utf8')

    await f.service.saveConfig(f.payload, false)

    expect(JSON.parse(fs.readFileSync(f.rootConfigPath, 'utf8'))).toEqual({ theme: 'dark' })
    expect(JSON.parse(fs.readFileSync(f.snapshotPath, 'utf8'))).toEqual({ primaryApiKey: 'sk-ant-console' })
    expect(inspectProviderConfig('claude', f.roots, providerBaseUrls).apiKey).toBe('sk-relay')
  })

  it('refuses to save Claude when the Console key cannot be moved aside', async () => {
    const f = claudeConsoleKeyFixture('xingmang-console-key-move-fail-')
    fs.writeFileSync(f.rootConfigPath, '{ not json', 'utf8')
    await f.store.setOfficialProvider('claude', true)

    await expect(f.service.saveConfig(f.payload, false)).rejects.toThrow(/官方 Key 没能挪开，配置没有改动/)

    expect(fs.existsSync(f.settingsPath)).toBe(false)
    expect(fs.readFileSync(f.rootConfigPath, 'utf8')).toBe('{ not json')
    expect(f.store.read().officialProviders).toContain('claude')
  })

  it('puts the Console key back when the Claude relay config write fails', async () => {
    const f = claudeConsoleKeyFixture('xingmang-console-key-undo-')
    fs.writeFileSync(f.rootConfigPath, JSON.stringify({ primaryApiKey: 'sk-ant-console' }), 'utf8')
    fs.mkdirSync(path.dirname(f.settingsPath), { recursive: true })
    fs.writeFileSync(f.settingsPath, '{ broken', 'utf8')

    const error = await f.service.saveConfig(f.payload, false).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toMatch(/官方 Key/)

    expect(JSON.parse(fs.readFileSync(f.rootConfigPath, 'utf8'))).toEqual({ primaryApiKey: 'sk-ant-console' })
    expect(fs.readFileSync(f.snapshotPath, 'utf8')).toBe('')
  })

  it('reports a failed Console key restore instead of swallowing it', async () => {
    const f = claudeConsoleKeyFixture('xingmang-console-key-restore-fail-')
    fs.writeFileSync(f.rootConfigPath, JSON.stringify({ primaryApiKey: 'sk-ant-console' }), 'utf8')
    await f.service.saveConfig(f.payload, false)
    fs.writeFileSync(f.rootConfigPath, '{ not json', 'utf8')

    await expect(f.service.restoreOfficialCredentials?.('claude')).rejects.toThrow(/官方 Key 没能放回原处/)
    await expect(f.service.switchToOfficialAccount('claude')).rejects.toThrow(/官方 Key 没能放回原处/)

    expect(inspectProviderConfig('claude', f.roots, providerBaseUrls).apiKey).toBe('sk-relay')
    expect(f.store.read().officialProviders ?? []).not.toContain('claude')
    expect(JSON.parse(fs.readFileSync(f.snapshotPath, 'utf8'))).toEqual({ primaryApiKey: 'sk-ant-console' })
  })

  it('restores the Console key when switching Claude back to the official account', async () => {
    const f = claudeConsoleKeyFixture('xingmang-console-key-official-')
    fs.writeFileSync(f.rootConfigPath, JSON.stringify({ primaryApiKey: 'sk-ant-console' }), 'utf8')
    await f.service.saveConfig(f.payload, false)

    await f.service.switchToOfficialAccount('claude')

    expect(JSON.parse(fs.readFileSync(f.rootConfigPath, 'utf8'))).toEqual({ primaryApiKey: 'sk-ant-console' })
    expect(f.store.read().officialProviders).toContain('claude')
  })

  it('passes official reset through to the selected Codex root and persists its account source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-official-reset-'))
    temporaryDirectories.push(root)
    const roots = { userHome: path.join(root, 'home'), codexHome: path.join(root, 'selected-codex') }
    const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
    const service = createSystemService(store, { providerRoots: roots })
    saveProviderConfig('codex', 'sk-relay', 'gpt-5.6-sol', 'reset', roots, {}, providerBaseUrls)
    const auth = codexAuthSnapshotPaths(roots)
    const configs = codexConfigSnapshotPaths(roots)
    const login = { auth_mode: 'chatgpt', tokens: { id_token: 'fixture-id', access_token: 'fixture-access' } }
    fs.writeFileSync(auth.chatgpt, JSON.stringify(login), 'utf8')
    fs.writeFileSync(configs.chatgpt, 'custom_setting = "old-official"\n', 'utf8')

    const result = await service.switchToOfficialAccount('codex', 'reset')

    const active = TOML.parse(fs.readFileSync(configs.active, 'utf8'))
    expect(active.custom_setting).toBeUndefined()
    expect(active.model_provider).toBeUndefined()
    expect(active.approval_policy).toBe('on-request')
    expect(active.skills).toMatchObject({ config: [expect.objectContaining({ enabled: false })] })
    expect(TOML.parse(fs.readFileSync(configs.chatgpt, 'utf8')).custom_setting).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual(login)
    expect(store.read().officialProviders).toContain('codex')
    expect(result.backups.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(roots.userHome, '.codex'))).toBe(false)

    fs.appendFileSync(configs.active, '\n[custom_after_switch]\nenabled = true\n')
    await service.switchToOfficialAccount('codex', 'reset')
    expect(TOML.parse(fs.readFileSync(configs.active, 'utf8')).custom_after_switch).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual(login)
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

  it('records the install source per CLI and leaves Grok unlabelled', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-install-source-scan-'))
    temporaryDirectories.push(directory)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'linux',
        findExecutable: async () => null,
        resolveCliInstallation: async (provider) => {
          if (provider === 'claude') {
            const packageRoot = path.join(directory, 'npm', 'lib', 'node_modules', '@anthropic-ai', 'claude-code')
            return {
              commandPath: path.join(directory, 'npm', 'bin', 'claude'),
              installDirectory: packageRoot,
              packageRoot,
              npmPrefix: path.join(directory, 'npm'),
              packageVersion: '2.1.300',
              source: 'npm',
            }
          }
          if (provider === 'gemini') return null
          // codex + grok: 非 npm，装在 ~/.local/bin 之外 → 归类 path。
          return {
            commandPath: `/opt/tools/${provider}`,
            installDirectory: '/opt/tools',
            packageRoot: null,
            npmPrefix: null,
            packageVersion: null,
            source: 'native',
          }
        },
      },
    )

    const snapshot = await service.scanSystem(false)

    expect(snapshot.clis.claude).toMatchObject({ installed: true, installSource: 'npm' })
    expect(snapshot.clis.codex).toMatchObject({ installed: true, installSource: 'path' })
    // Grok 的安装/更新走原生通道，首页对它不做来源标注，保留既有形态。
    expect(snapshot.clis.grok.installed).toBe(true)
    expect(snapshot.clis.grok.installSource).toBeUndefined()
    // 没装的工具不带来源。
    expect(snapshot.clis.gemini).toMatchObject({ installed: false })
    expect(snapshot.clis.gemini.installSource).toBeUndefined()
  })

  // 断网开应用时，四家 CLI 的最新版探测会一个个耗满自己的超时（npm 8 秒、Grok
  // 清单 10 秒），首屏要十几秒才出来，而已装版本其实一瞬间就从本地读到了。
  it('stops waiting on the npm latest probes when the network location probe says the machine is offline', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-offline-latest-budget-'))
    temporaryDirectories.push(directory)
    // 网络位置探测立刻失败（离线），最新版探测永不返回（半开网络里就是这样）。
    // 挂住的那几次请求留着句柄，断言跑完后由测试自己打掉，好让探测在本用例内走完。
    const hangingProbeRequests: Array<() => void> = []
    const probeFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('registry') && !url.includes('npmmirror') && !url.includes('x.ai')) {
        return Promise.reject(new Error('offline'))
      }
      return new Promise((_resolve, reject) => {
        function failRequest(): void {
          reject(new Error('aborted'))
        }
        hangingProbeRequests.push(failRequest)
        init?.signal?.addEventListener('abort', failRequest)
      })
    })
    vi.stubGlobal('fetch', probeFetch)
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'linux',
        findExecutable: async () => null,
        resolveCliInstallation: async (provider) => ({
          commandPath: path.join(directory, 'npm', 'bin', provider),
          installDirectory: path.join(directory, 'npm', 'lib'),
          packageRoot: path.join(directory, 'npm', 'lib'),
          npmPrefix: path.join(directory, 'npm'),
          packageVersion: '1.2.3',
          source: 'npm',
        }),
      },
    )

    const startedAt = Date.now()
    const snapshot = await service.scanSystem(false)
    const elapsed = Date.now() - startedAt

    expect(elapsed).toBeLessThan(offlineLatestVersionBudgetMs + 4_000)
    for (const provider of ['claude', 'codex', 'gemini', 'grok'] as const) {
      // 只有「最新版」这一格说没检查成：已装状态照常，也不谎报有新版本。
      expect(snapshot.clis[provider]).toMatchObject({
        installed: true,
        updateCheck: 'failed',
        updateAvailable: false,
        latestVersion: null,
      })
      expect(snapshot.clis[provider].updateError).toBe(latestVersionUncheckedMessage)
    }
    // 已装版本来自本地包清单，不受最新版探测影响（grok 的版本读本地二进制，
    // 这个夹具里没有真文件，所以只看那三个走 npm 包清单的）。
    for (const provider of ['claude', 'codex', 'gemini'] as const) {
      expect(snapshot.clis[provider].version).toBe('1.2.3')
    }

    // 预算到点后这批探测的结果已经没人要了，它们不许再往备用源发请求：那次请求
    // 会在本用例结束之后才出网，落进后面用例的 fetch 桩里（#326 的 Windows 分片
    // 就中过一次，三条 `/latest` 串进了一条断言「不该发请求」的安装用例）。
    const requestsBeforeUnblocking = probeFetch.mock.calls.length
    for (const failRequest of hangingProbeRequests.splice(0)) failRequest()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(probeFetch.mock.calls.length).toBe(requestsBeforeUnblocking)
  }, 20_000)

  // 联网时不许有预算：网络位置探测拿到了结果，就照旧等最新版探测出结果，
  // 否则慢一点的网络会平白丢掉「有新版本」。
  it('still waits past the offline budget for the npm latest probes when the network location probe succeeds', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-online-latest-wait-'))
    temporaryDirectories.push(directory)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('cdn-cgi/trace')) return new Response('ip=203.0.113.9\nloc=US\n', { status: 200 })
      if (url.includes('registry.npmjs.org') || url.includes('registry.npmmirror.com')) {
        await new Promise((resolve) => setTimeout(resolve, offlineLatestVersionBudgetMs + 500))
        return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 })
      }
      throw new Error('offline')
    }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'linux',
        findExecutable: async () => null,
        resolveCliInstallation: async (provider) => provider === 'grok' ? null : ({
          commandPath: path.join(directory, 'npm', 'bin', provider),
          installDirectory: path.join(directory, 'npm', 'lib'),
          packageRoot: path.join(directory, 'npm', 'lib'),
          npmPrefix: path.join(directory, 'npm'),
          packageVersion: '1.2.3',
          source: 'npm',
        }),
      },
    )

    const snapshot = await service.scanSystem(false)

    for (const provider of ['claude', 'codex', 'gemini'] as const) {
      expect(snapshot.clis[provider]).toMatchObject({
        installed: true,
        updateCheck: 'checked',
        latestVersion: '9.9.9',
      })
    }
  }, 20_000)

  it('reports Git with only its version number when it is installed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-git-present-'))
    temporaryDirectories.push(directory)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'linux',
        findExecutable: async (command) => command === 'git' ? '/usr/bin/git' : null,
        runCommand: async (spec) => ({
          executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null,
          // 真实的 git 会打「git version 2.43.0.windows.1」，运行环境行里只留版本号。
          stdout: 'git version 2.43.0.windows.1\n', stderr: '', outputBytes: 28, durationMs: 1,
        }),
        resolveCliInstallation: async () => null,
      },
    )

    const snapshot = await service.scanSystem(false)

    expect(snapshot.runtime.git).toMatchObject({ installed: true, version: '2.43.0', path: '/usr/bin/git' })
    expect(snapshot.runtime.git.detectionFailed).not.toBe(true)
  })

  it('reports Git as not installed when the probe finds nothing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-git-missing-'))
    temporaryDirectories.push(directory)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      { platform: 'linux', findExecutable: async () => null, resolveCliInstallation: async () => null },
    )

    const snapshot = await service.scanSystem(false)

    expect(snapshot.runtime.git).toMatchObject({ installed: false, version: null })
    // 缺 Git 与探不到 Git 是两件事：没装不能被伪装成检测失败。
    expect(snapshot.runtime.git.detectionFailed).not.toBe(true)
  })

  it('never runs the macOS git/python3 shims when the command line developer tools are missing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-clt-missing-'))
    temporaryDirectories.push(directory)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const executed: string[] = []
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'darwin',
        findExecutable: async (command) =>
          command === 'git' ? '/usr/bin/git' : command === 'python3' ? '/usr/bin/python3' : null,
        runCommand: async (spec) => {
          executed.push(spec.executable)
          // 没装命令行开发者工具时 xcode-select -p 以退出码 2 失败。
          throw Object.assign(new Error('xcode-select: error: unable to get active developer directory'), {
            stdout: '', stderr: 'xcode-select: error: unable to get active developer directory',
          })
        },
        resolveCliInstallation: async () => null,
        macosCodexAppDetector: async () => ({ app: null, detectionFailed: false, detectionError: null }),
      },
    )

    const snapshot = await service.scanSystem(false)

    expect(executed).not.toContain('/usr/bin/git')
    expect(executed).not.toContain('/usr/bin/python3')
    expect(executed).toContain('/usr/bin/xcode-select')
    expect(snapshot.runtime.git).toMatchObject({ installed: false, version: null, path: null })
    expect(snapshot.runtime.git.detectionFailed).not.toBe(true)
    expect(snapshot.runtime.python).toMatchObject({ installed: false, version: null, path: null })
  })

  // xcode-select 只会打印 POSIX 路径；Windows runner 上临时目录是盘符路径，造不出这份夹具。
  it.skipIf(process.platform === 'win32')('probes the macOS git shim normally once the developer tools behind it exist', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-clt-present-'))
    temporaryDirectories.push(directory)
    const developerDirectory = path.join(directory, 'CommandLineTools')
    fs.mkdirSync(path.join(developerDirectory, 'usr', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(developerDirectory, 'usr', 'bin', 'git'), '')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const executed: string[] = []
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'darwin',
        findExecutable: async (command) => command === 'git' ? '/usr/bin/git' : null,
        runCommand: async (spec) => {
          executed.push(spec.executable)
          const stdout = spec.executable === '/usr/bin/xcode-select'
            ? `${developerDirectory}\n`
            : 'git version 2.39.5 (Apple Git-154)\n'
          return {
            executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null,
            stdout, stderr: '', outputBytes: stdout.length, durationMs: 1,
          }
        },
        resolveCliInstallation: async () => null,
        macosCodexAppDetector: async () => ({ app: null, detectionFailed: false, detectionError: null }),
      },
    )

    const snapshot = await service.scanSystem(false)

    expect(executed).toContain('/usr/bin/git')
    expect(snapshot.runtime.git).toMatchObject({ installed: true, version: '2.39.5', path: '/usr/bin/git' })
  })

  // 同上，夹具要 POSIX 路径。
  it.skipIf(process.platform === 'win32')('treats the macOS shims as not installed while the Xcode license is not agreed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-xcode-license-'))
    temporaryDirectories.push(directory)
    const developerDirectory = path.join(directory, 'Xcode.app', 'Contents', 'Developer')
    fs.mkdirSync(path.join(developerDirectory, 'usr', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(developerDirectory, 'usr', 'bin', 'git'), '')
    fs.writeFileSync(path.join(developerDirectory, 'usr', 'bin', 'python3'), '')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const license = "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license."
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'darwin',
        findExecutable: async (command) =>
          command === 'git' ? '/usr/bin/git' : command === 'python3' ? '/usr/bin/python3' : null,
        runCommand: async (spec) => {
          if (spec.executable === '/usr/bin/xcode-select') {
            const stdout = `${developerDirectory}\n`
            return {
              executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null,
              stdout, stderr: '', outputBytes: stdout.length, durationMs: 1,
            }
          }
          throw Object.assign(new Error('Command failed with exit code 69'), { stdout: '', stderr: `${license}\n` })
        },
        resolveCliInstallation: async () => null,
        macosCodexAppDetector: async () => ({ app: null, detectionFailed: false, detectionError: null }),
      },
    )

    const snapshot = await service.scanSystem(false)

    // 以前这句英文被当成 Python 的版本号整段上了首页。
    expect(snapshot.runtime.python).toMatchObject({ installed: false, version: null, path: null })
    expect(snapshot.runtime.git).toMatchObject({ installed: false, version: null, path: null })
    expect(snapshot.runtime.git.detectionFailed).not.toBe(true)
  })

  it('keeps a Git probe failure distinguishable from "not installed"', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-git-failure-'))
    temporaryDirectories.push(directory)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'linux',
        findExecutable: async (command) => { if (command === 'git') throw new Error('Git 探测失败'); return null },
        resolveCliInstallation: async () => null,
      },
    )

    const snapshot = await service.scanSystem(false)

    expect(snapshot.runtime.git).toMatchObject({ installed: false, detectionFailed: true, detectionError: 'Git 探测失败' })
    // A CLI/Git probe failure must not bleed into the independent runtime probes.
    expect(snapshot.runtime.node.detectionFailed).not.toBe(true)
    expect(snapshot.runtime.npm.detectionFailed).not.toBe(true)
  })

  it('validates an API key by returning model ids from the relay response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }],
    }), { status: 200 }))
    const service = createService({ relayFetch: fetchMock as typeof fetch })

    await expect(service.fetchAvailableModels('  sk-test-value  ')).resolves.toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://xm.solov.cc/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test-value' }),
        credentials: 'omit',
        redirect: 'error',
      }),
    )
  })

  it('rejects reusing a configured key from a different realm before any network request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-realm-config-'))
    temporaryDirectories.push(root)
    const providerRoots = { userHome: root, codexHome: path.join(root, '.codex') }
    saveProviderConfig('codex', 'sk-xm-only', 'fixture-model', 'reset', providerRoots, {}, providerBaseUrls)
    const relayFetch = vi.fn<typeof fetch>()
    const service = createService({ providerRoots, getRelaySiteId: () => 'solov-api', relayFetch })
    await expect(service.saveConfig({ provider: 'codex', apiKey: '', model: 'fixture-model', mode: 'merge' }, false))
      .rejects.toThrow('已保存的 Key 属于其他账号')
    expect(relayFetch).not.toHaveBeenCalled()
  })

  // D-02: 从 relay-sites.ts 的站点表到 CLI 配置文件之间那一段此前无人验证。
  // saveProviderConfig 的 siteBaseUrlsInput 刻意不给默认值(config-files.ts
  // 的长注释),这四条就是那个设计约束的回归网:换账号站点后写进四个 CLI 的
  // base URL 必须整体换掉,而不是继续指向 xm。字面量刻意写死,改动站点表时
  // 必须同步改这里。
  it.each([
    { provider: 'claude', expected: 'https://api.solov.cc' },
    { provider: 'codex', expected: 'https://api.solov.cc/v1' },
    { provider: 'grok', expected: 'https://api.solov.cc/v1' },
    { provider: 'gemini', expected: 'https://api.solov.cc' },
  ] satisfies Array<{ provider: ProviderId; expected: string }>)(
    'writes $expected into the $provider config file while the sub2api site is active',
    async ({ provider, expected }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-sub2api-save-'))
      temporaryDirectories.push(root)
      const providerRoots = { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') }
      const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
      const service = createService({ providerRoots, getRelaySiteId: () => 'solov-api', relayFetch })

      await service.saveConfig({
        provider,
        apiKey: `sk-sub2api-${provider}-fixture`,
        model: 'fixture-model',
        mode: 'reset',
      }, false)

      // The model probe must leave the xm relay too, otherwise a model list
      // from one site would authorize a config written for the other.
      expect(relayFetch.mock.calls[0][0]).toBe('https://api.solov.cc/v1/models')
      const written = inspectProviderConfig(provider, providerRoots, sub2ApiProviderBaseUrls)
      expect(written.actualBaseUrl).toBe(expected)
      expect(written.matchesRelay).toBe(true)
      // The xm base URLs must no longer reconcile against this file.
      expect(inspectProviderConfig(provider, providerRoots, providerBaseUrls).matchesRelay).toBe(false)
    },
  )

  it('rejects a site change between model validation and CLI config commit', async () => {
    let siteId = 'solov'
    const relayFetch = vi.fn<typeof fetch>(async () => {
      siteId = 'solov-api'
      return Response.json({ data: [{ id: 'fixture-model' }] })
    })
    const service = createService({ getRelaySiteId: () => siteId, relayFetch })
    await expect(service.saveConfig({ provider: 'codex', apiKey: 'sk-xm-only', model: 'fixture-model', mode: 'merge' }, false))
      .rejects.toThrow('账号已变化')
    expect(relayFetch.mock.calls[0][0]).toBe('https://xm.solov.cc/v1/models')
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

  it('says the service is unavailable when the model list answers with a maintenance page', async () => {
    // 盲点 1：写入 Key 与 AI 对话都经过这一步，「服务返回 503」会被渲染层猜成 Key 或分组的问题。
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>维护中</html>', { status: 503, headers: { 'content-type': 'text/html' } })))

    const error = await service.fetchAvailableModels('sk-maintenance-probe').catch((cause: unknown) => cause)
    expect(classifyNetworkFailure(error)).toBe('serviceUnavailable')
    expect((error as Error).message).toContain('HTTP 503')
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
    })).rejects.toThrow('要安装的 xAI 官方版本')
  })

  it('takes Linux Grok straight from npm without asking x.ai for its stable version', async () => {
    const requestedVersions: string[] = []
    const release = await resolveCliInstallRelease('grok', 'linux-official-npm', {
      version: '1.0.44',
      fetchGrokStableVersion: async () => {
        throw new Error('must not query Grok stable metadata')
      },
      fetchNpmRelease: async (_registry, _packageName, version) => {
        requestedVersions.push(version)
        return { name: '@xai-official/grok', version, integrity }
      },
    })

    expect(requestedVersions).toEqual(['1.0.44'])
    expect(release.version).toBe('1.0.44')
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

  it('pins the npm release query to the version the verified list selected', async () => {
    const requestedVersions: string[] = []
    await resolveCliInstallRelease('claude', null, {
      version: '2.1.277',
      fetchGrokStableVersion: async () => {
        throw new Error('must not query Grok stable metadata')
      },
      fetchNpmRelease: async (_registry, _packageName, version) => {
        requestedVersions.push(version)
        return { name: '@anthropic-ai/claude-code', version: '2.1.277', integrity }
      },
    })

    expect(requestedVersions).toEqual(['2.1.277'])
  })

  it('installs a named Darwin Grok version that is not newer than the xAI stable manifest', async () => {
    const requestedVersions: string[] = []
    const release = await resolveCliInstallRelease('grok', 'darwin-official-npm', {
      version: '0.2.100',
      fetchGrokStableVersion: async () => ({ version: '0.2.118', sourceUrl: 'https://x.ai/cli/stable' }),
      fetchNpmRelease: async (_registry, _packageName, version) => {
        requestedVersions.push(version)
        return { name: '@xai-official/grok', version, integrity }
      },
    })

    expect(requestedVersions).toEqual(['0.2.100'])
    expect(release.version).toBe('0.2.100')
  })

  it('caps a named Darwin Grok version at the xAI stable manifest', async () => {
    const requestedVersions: string[] = []
    await resolveCliInstallRelease('grok', 'darwin-official-npm', {
      version: '0.2.119',
      fetchGrokStableVersion: async () => ({ version: '0.2.118', sourceUrl: 'https://x.ai/cli/stable' }),
      fetchNpmRelease: async (_registry, _packageName, version) => {
        requestedVersions.push(version)
        return { name: '@xai-official/grok', version, integrity }
      },
    })

    expect(requestedVersions).toEqual(['0.2.118'])
  })

  it('rejects a Darwin Grok npm response that differs from the named version', async () => {
    await expect(resolveCliInstallRelease('grok', 'darwin-official-npm', {
      version: '0.2.100',
      fetchGrokStableVersion: async () => ({ version: '0.2.118', sourceUrl: 'https://x.ai/cli/stable' }),
      fetchNpmRelease: async () => ({ name: '@xai-official/grok', version: '0.2.118', integrity }),
    })).rejects.toThrow('要安装的 xAI 官方版本')
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

  it('promotes a verified prefix and keeps the old copy, marked as superseded, until transaction cleanup', async () => {
    const fixture = transactionFixture()
    await expect(replaceManagedNpmPrefixAtomically(
      fixture.active,
      fixture.staged,
      fixture.transaction,
      async () => {
        expect(fs.readFileSync(path.join(fixture.active, 'version.txt'), 'utf8')).toBe('new')
        // Until the new version has been verified, the old copy keeps the name recovery rolls back to.
        expect(fs.readFileSync(path.join(fixture.transaction, 'previous-prefix', 'version.txt'), 'utf8')).toBe('old')
      },
    )).resolves.toEqual({ backupRetired: true })
    expect(fs.readFileSync(path.join(fixture.active, 'version.txt'), 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(fixture.transaction, 'superseded-prefix', 'version.txt'), 'utf8')).toBe('old')
    expect(fs.existsSync(path.join(fixture.transaction, 'previous-prefix'))).toBe(false)
  })

  it('retries marking the old copy superseded while something briefly holds it', async () => {
    const fixture = transactionFixture()
    let busy = 2
    const rename = vi.fn(async (source: string, destination: string) => {
      if (path.basename(destination) === 'superseded-prefix' && busy > 0) {
        busy -= 1
        throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
      }
      await fs.promises.rename(source, destination)
    })

    await expect(replaceManagedNpmPrefixAtomically(
      fixture.active,
      fixture.staged,
      fixture.transaction,
      async () => undefined,
      { rename },
    )).resolves.toEqual({ backupRetired: true })
    expect(rename).toHaveBeenCalledTimes(5)
    expect(fs.readFileSync(path.join(fixture.transaction, 'superseded-prefix', 'version.txt'), 'utf8')).toBe('old')
  })

  it('still reports the verified update when the old copy cannot be marked superseded', async () => {
    const fixture = transactionFixture()
    const rename = vi.fn(async (source: string, destination: string) => {
      if (path.basename(destination) === 'superseded-prefix') {
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
      }
      await fs.promises.rename(source, destination)
    })

    await expect(replaceManagedNpmPrefixAtomically(
      fixture.active,
      fixture.staged,
      fixture.transaction,
      async () => undefined,
      { rename },
    )).resolves.toEqual({ backupRetired: false })
    // A non-transient failure is not retried; the old copy stays where it was, as before.
    expect(rename).toHaveBeenCalledTimes(3)
    expect(fs.readFileSync(path.join(fixture.active, 'version.txt'), 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(fixture.transaction, 'previous-prefix', 'version.txt'), 'utf8')).toBe('old')
  })

  it('gives up marking the old copy superseded after a bounded number of transient failures', async () => {
    const fixture = transactionFixture()
    const rename = vi.fn(async (source: string, destination: string) => {
      if (path.basename(destination) === 'superseded-prefix') {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }
      await fs.promises.rename(source, destination)
    })

    await expect(replaceManagedNpmPrefixAtomically(
      fixture.active,
      fixture.staged,
      fixture.transaction,
      async () => undefined,
      { rename },
    )).resolves.toEqual({ backupRetired: false })
    expect(rename.mock.calls.filter(([, destination]) => path.basename(destination) === 'superseded-prefix')).toHaveLength(5)
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
    expect(fs.existsSync(path.join(fixture.transaction, 'superseded-prefix'))).toBe(false)
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
    // Codex 现在有推荐版本(cli-verified-versions.ts),所以托管安装钉版本、走
    // 按版本号的 npm 元数据端点,而不是 latest。断言跟着名单走,抬版本的 PR
    // 只改名单即可,不必回来改这个夹具。
    const expectedVersion = recommendedCodexVersion()
    const integrity = `sha512-${Buffer.alloc(64, 0x31).toString('base64')}`
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('cloudflare.com/cdn-cgi/trace')) {
        return new Response('ip=203.0.113.8\nloc=US\n', { status: 200 })
      }
      if (url === npmPackageVersionUrl('https://registry.npmjs.org', '@openai/codex', expectedVersion)) {
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
    // 一次是安装前确认现有那份归 npm 通道管（#481），一次是装完后的校验；
    // 两次都对着托管 npm 全局根（见 resolveCliInstallation 里的断言）。
    expect(resolveCliInstallation).toHaveBeenCalledTimes(2)
    expect(target.send).not.toHaveBeenCalledWith(
      'cli:install-progress',
      expect.objectContaining({ state: 'success' }),
    )
  })
})

// Linux installs into the same per-user managed layout as macOS (Linux 版拆分 ②), so the
// user's own ~/.npmrc no longer decides where the CLIs land. These run only on Linux,
// where the fake npm below is a plain POSIX script.
describe.runIf(process.platform === 'linux')('Linux managed npm install', () => {
  interface LinuxInstallFixture {
    root: string
    homeDirectory: string
    userPrefix: string
    npmExecutable: string
    expectedVersion: string
    integrity: string
  }

  function linuxInstallFixture(npmrc: (userPrefix: string) => string): LinuxInstallFixture {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-linux-managed-npm-'))
    temporaryDirectories.push(temporaryRoot)
    const root = fs.realpathSync(temporaryRoot)
    const homeDirectory = path.join(root, 'home')
    const userPrefix = path.join(root, 'npm-global')
    const runtimeBin = path.join(root, 'runtime-bin')
    fs.mkdirSync(homeDirectory, { recursive: true })
    fs.mkdirSync(path.join(userPrefix, 'bin'), { recursive: true })
    fs.mkdirSync(runtimeBin, { recursive: true })
    fs.writeFileSync(path.join(homeDirectory, '.npmrc'), npmrc(userPrefix))
    const npmExecutable = path.join(runtimeBin, 'npm')
    fs.writeFileSync(npmExecutable, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(npmExecutable, 0o700)
    vi.stubEnv('HOME', homeDirectory)
    vi.stubEnv('XDG_DATA_HOME', undefined)
    vi.stubEnv('PATH', `${runtimeBin}${path.delimiter}${path.join(userPrefix, 'bin')}`)
    // `npm test` exports these to its children; the desktop app never inherits them.
    vi.stubEnv('npm_config_prefix', undefined)
    vi.stubEnv('npm_config_userconfig', undefined)

    const expectedVersion = recommendedCodexVersion()
    const integrity = `sha512-${Buffer.alloc(64, 0x32).toString('base64')}`
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('cloudflare.com/cdn-cgi/trace')) {
        return new Response('ip=203.0.113.8\nloc=US\n', { status: 200 })
      }
      if (url === npmPackageVersionUrl('https://registry.npmjs.org', '@openai/codex', expectedVersion)) {
        return new Response(JSON.stringify({
          name: '@openai/codex',
          version: expectedVersion,
          dist: { integrity },
        }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))
    return { root, homeDirectory, userPrefix, npmExecutable, expectedVersion, integrity }
  }

  function fakeNpm(
    fixture: LinuxInstallFixture,
    onGlobalInstall: (prefix: string, argv: readonly string[]) => void,
  ) {
    return vi.fn(async (
      spec: { executable: string; argv: readonly string[] },
      options: { cwd?: string; onOutput?: (event: { stream: 'stdout' | 'stderr'; text: string }) => void } = {},
    ) => {
      if (spec.executable !== fixture.npmExecutable) throw new Error(`Unexpected command: ${spec.executable}`)
      if (spec.argv[0] === 'ci') options.onOutput?.({ stream: 'stdout', text: 'added 12 packages in 3s\n' })
      if (spec.argv.includes('--package-lock-only')) {
        const cwd = options.cwd
        if (!cwd) throw new Error('Fake npm requires cwd')
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
            [`node_modules/${packageName}`]: { version, integrity: fixture.integrity },
          },
        }))
      } else if (spec.argv[0] === 'install' && spec.argv.includes('--global')) {
        const prefixArgument = spec.argv.find((argument) => argument.startsWith('--prefix='))
        if (!prefixArgument) throw new Error('Managed install omitted --prefix')
        onGlobalInstall(prefixArgument.slice('--prefix='.length), spec.argv)
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
  }

  function writeCodexPackage(prefix: string, version: string, withNative: boolean): void {
    const packageRoot = path.join(prefix, 'lib', 'node_modules', '@openai', 'codex')
    fs.rmSync(packageRoot, { recursive: true, force: true })
    fs.mkdirSync(packageRoot, { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@openai/codex',
      version,
      optionalDependencies: { '@openai/codex-linux-x64': `npm:@openai/codex@${version}-linux-x64` },
    }))
    if (withNative) {
      fs.mkdirSync(path.join(packageRoot, 'node_modules', '@openai', 'codex-linux-x64'), { recursive: true })
      fs.writeFileSync(path.join(packageRoot, 'node_modules', '@openai', 'codex-linux-x64', 'package.json'), '{}')
    }
  }

  function managedResolution(fixture: LinuxInstallFixture) {
    const managedPrefix = path.join(fixture.homeDirectory, '.local', 'share', 'XingMangAI', 'Cli', 'npm')
    const packageRoot = path.join(managedPrefix, 'lib', 'node_modules', '@openai', 'codex')
    return vi.fn<typeof resolveCliInstallationForTest>(async () => fs.existsSync(path.join(packageRoot, 'package.json'))
      ? {
          commandPath: path.join(managedPrefix, 'bin', 'codex'),
          installDirectory: packageRoot,
          packageRoot,
          npmPrefix: managedPrefix,
          packageVersion: fixture.expectedVersion,
          source: 'npm',
        }
      : null)
  }

  it('installs into the per-user managed prefix and ignores both the prefix and the registry in ~/.npmrc', async () => {
    const fixture = linuxInstallFixture((userPrefix) => `registry=https://example.invalid/\nprefix=${userPrefix}\n`)
    let installArgv: readonly string[] | null = null
    let stagedPrefix: string | null = null
    const runCommand = fakeNpm(fixture, (prefix, argv) => {
      installArgv = argv
      stagedPrefix = prefix
      writeCodexPackage(prefix, fixture.expectedVersion, true)
    })
    const target = { isDestroyed: () => false, send: vi.fn() }
    const service = createSystemService(
      new AppSettingsStore(path.join(fixture.root, 'settings.json'), fixture.root),
      { platform: 'linux', runCommand, resolveCliInstallation: managedResolution(fixture) },
    )

    await service.installCli('codex', target)

    const productRoot = path.join(fixture.homeDirectory, '.local', 'share', 'XingMangAI')
    const argv = installArgv!
    expect(argv.filter((argument) => argument.startsWith('--prefix='))).toEqual([`--prefix=${stagedPrefix}`])
    // The lifecycle runs against a staged copy inside the managed cache, never the user's prefix.
    expect(path.relative(path.join(productRoot, 'Cli', 'npm-cache'), stagedPrefix!)).not.toMatch(/^\.\.(?:[/\\]|$)/)
    expect(argv.some((argument) => argument.includes(fixture.userPrefix))).toBe(false)
    expect(argv).toContain(`--userconfig=${path.join(productRoot, 'Cli', 'npmrc')}`)
    expect(argv.some((argument) => argument.includes('example.invalid'))).toBe(false)
    // The staged prefix was promoted into place.
    expect(JSON.parse(fs.readFileSync(
      path.join(productRoot, 'Cli', 'npm', 'lib', 'node_modules', '@openai', 'codex', 'package.json'),
      'utf8',
    ))).toMatchObject({ version: fixture.expectedVersion })
    expect(fs.existsSync(path.join(fixture.userPrefix, 'lib'))).toBe(false)
    expect(target.send).toHaveBeenCalledWith(
      'cli:install-progress',
      expect.objectContaining({ state: 'success' }),
    )
    // 界面按阶段换白话：每一句技术原话都要带阶段，npm 自己的输出标成原始输出。
    const progress = target.send.mock.calls
      .filter(([channel]) => channel === 'cli:install-progress')
      .map(([, event]) => event as { state: string; message: string; stage?: string })
    expect(progress).toContainEqual(expect.objectContaining({ message: 'added 12 packages in 3s', stage: 'raw-output' }))
    const stages = progress.flatMap((event) => event.stage && event.stage !== 'raw-output' ? [event.stage] : [])
    expect(stages.filter((stage, index) => stage !== stages[index - 1]))
      .toEqual(['version', 'download', 'verify', 'install', 'final-check'])
    expect(progress.filter((event) => event.state !== 'success' && !event.stage)).toEqual([])
  })

  it('keeps a verified update when the cleanup after it was cut short, and sweeps the leftover later', async () => {
    const fixture = linuxInstallFixture(() => '')
    const productRoot = path.join(fixture.homeDirectory, '.local', 'share', 'XingMangAI')
    const managedPrefix = path.join(productRoot, 'Cli', 'npm')
    const cacheRoot = path.join(productRoot, 'Cli', 'npm-cache')
    const managedManifest = path.join(managedPrefix, 'lib', 'node_modules', '@openai', 'codex', 'package.json')
    writeCodexPackage(managedPrefix, '0.1.0', true)
    const runCommand = fakeNpm(fixture, (prefix) => writeCodexPackage(prefix, fixture.expectedVersion, true))
    // 星芒在「完成」之后、临时文件夹删完之前被关掉：收尾那一下删除没有做成。
    const realRm = fs.promises.rm
    const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      // Only the transaction folder itself, as the final cleanup removes it; whatever the install does inside runs for real.
      if (path.dirname(String(target)) === cacheRoot && path.basename(String(target)).startsWith('npm-transaction-')) {
        throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
      }
      return realRm(target, options)
    })
    let sweepNow: number | null = null
    const sweep = vi.fn(async (locations: readonly InstallLeftoverLocation[]) => sweepNow === null
      ? { removed: 0, freedBytes: 0, failed: 0 }
      // Only the managed npm cache: never touch whatever sits in this machine's own temp directory.
      : sweepInstallLeftovers(locations.filter((location) => location.directory === cacheRoot), { now: sweepNow }))
    const runtimeLog = { log: vi.fn() }
    const service = createSystemService(
      new AppSettingsStore(path.join(fixture.root, 'settings.json'), fixture.root),
      {
        platform: 'linux',
        runCommand,
        resolveCliInstallation: managedResolution(fixture),
        sweepInstallLeftovers: sweep,
        runtimeLog,
      },
    )

    await service.installCli('codex', { isDestroyed: () => false, send: vi.fn() })
    // The sweep queued after every successful install; it must be done before the later one is queued.
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(service.inspectInstallationQueue().activeKey).toBeNull())
    rm.mockRestore()

    expect(runtimeLog.log).toHaveBeenCalledWith('warn', 'install', 'cli.install.transaction-cleanup-failed', expect.any(String), expect.objectContaining({ provider: 'codex' }))
    const leftovers = fs.readdirSync(cacheRoot).filter((name) => name.startsWith('npm-transaction-'))
    expect(leftovers).toHaveLength(1)
    const leftover = path.join(cacheRoot, leftovers[0])
    expect(fs.existsSync(path.join(leftover, 'superseded-prefix'))).toBe(true)
    expect(fs.existsSync(path.join(leftover, 'previous-prefix'))).toBe(false)

    // Every later install, update or uninstall starts by preparing the managed layout.
    await ensureManagedNpmLayout({ platform: 'linux', env: process.env })
    expect(JSON.parse(fs.readFileSync(managedManifest, 'utf8'))).toMatchObject({ version: fixture.expectedVersion })

    sweepNow = Date.now() + installLeftoverMinimumAgeMs + 60_000
    await expect(service.cleanupInstallLeftovers()).resolves.toMatchObject({ removed: 1, failed: 0 })
    expect(fs.existsSync(leftover)).toBe(false)
    expect(JSON.parse(fs.readFileSync(managedManifest, 'utf8'))).toMatchObject({ version: fixture.expectedVersion })
  })

  it('brings the terminal commands in line after an install and again after the uninstall', async () => {
    const fixture = linuxInstallFixture((userPrefix) => `prefix=${userPrefix}\n`)
    const managedPackage = path.join(
      fixture.homeDirectory, '.local', 'share', 'XingMangAI', 'Cli', 'npm', 'lib', 'node_modules', '@openai', 'codex',
    )
    const runCommand = fakeNpm(fixture, (prefix) => writeCodexPackage(prefix, fixture.expectedVersion, true))
    // The uninstall spawns npm for real rather than through the injected runner.
    fs.writeFileSync(fixture.npmExecutable, `#!/bin/sh\nif [ "$1" = uninstall ]; then rm -rf '${managedPackage}'; fi\nexit 0\n`)
    const syncLinuxTerminalCommands = vi.fn(async () => ({ outcome: 'added' as const, launchers: ['codex'], skipped: [] }))
    const service = createSystemService(
      new AppSettingsStore(path.join(fixture.root, 'settings.json'), fixture.root),
      { platform: 'linux', runCommand, resolveCliInstallation: managedResolution(fixture), syncLinuxTerminalCommands },
    )

    await service.installCli('codex', { isDestroyed: () => false, send: vi.fn() })
    await vi.waitFor(() => expect(syncLinuxTerminalCommands).toHaveBeenCalledWith('install'))

    await expect(service.uninstallCli('codex')).resolves.toMatchObject({ outcome: 'uninstalled' })
    await vi.waitFor(() => expect(syncLinuxTerminalCommands).toHaveBeenLastCalledWith('uninstall'))
    expect(syncLinuxTerminalCommands).toHaveBeenCalledTimes(2)
  })

  // 卸载那一步的 npm 是真起的子进程：换成照 npm 原样报错、什么都没删的脚本。
  function failNpmUninstall(fixture: LinuxInstallFixture, npmErrorLines: readonly string[]): void {
    fs.writeFileSync(fixture.npmExecutable, [
      '#!/bin/sh',
      'if [ "$1" = uninstall ]; then',
      "  /bin/cat >&2 <<'EOF'",
      ...npmErrorLines,
      'EOF',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'))
  }

  // 包目录直接写好，不先走一遍安装。
  function failingCodexUninstall(fixture: LinuxInstallFixture, npmErrorLines: readonly string[]) {
    const managedPrefix = path.join(fixture.homeDirectory, '.local', 'share', 'XingMangAI', 'Cli', 'npm')
    writeCodexPackage(managedPrefix, fixture.expectedVersion, true)
    failNpmUninstall(fixture, npmErrorLines)
    const runtimeLog = { log: vi.fn() }
    const service = createSystemService(
      new AppSettingsStore(path.join(fixture.root, 'settings.json'), fixture.root),
      { platform: 'linux', resolveCliInstallation: managedResolution(fixture), runtimeLog },
    )
    return { service, runtimeLog, packageRoot: path.join(managedPrefix, 'lib', 'node_modules', '@openai', 'codex') }
  }

  const npmRenameDenied = [
    'npm error code EPERM',
    'npm error syscall rename',
    'npm error errno -1',
    "npm error Error: EPERM: operation not permitted, rename '/npm/@openai/codex' -> '/npm/@openai/.codex-x'",
  ]
  const npmRenameDeniedDetail = "命令执行失败（退出码 1）：npm（EPERM；Error: EPERM: operation not permitted, rename '/npm/@openai/codex' -> '/npm/@openai/.codex-x'）"

  it('names the tool that failed to uninstall and keeps npm\'s EPERM when none of its processes is running', async () => {
    const { service, packageRoot } = failingCodexUninstall(linuxInstallFixture(() => ''), npmRenameDenied)

    const failure: unknown = await service.uninstallCli('codex').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      message: `Codex CLI 卸载失败：${npmRenameDeniedDetail}`,
      cause: expect.any(CommandRunnerError),
    })
    // EPERM by itself reads the same as a folder the user cannot write to, so it
    // stays a permission problem until a process of this tool is actually found.
    expect(probeRunningCliProcesses).toHaveBeenCalledWith(packageRoot)
    expect(classifyOperationError(`Codex CLI 卸载失败：${npmRenameDeniedDetail}`)).toBe('permission')
    // The runtime log keeps only enumerable fields, and npm's raw output is what
    // support reads there.
    expect(Object.prototype.propertyIsEnumerable.call(failure, 'cause')).toBe(true)
    expect(fs.existsSync(path.join(packageRoot, 'package.json'))).toBe(true)
  })

  it('tells the customer to close the tool when one of its processes holds the folder', async () => {
    const { service, runtimeLog, packageRoot } = failingCodexUninstall(linuxInstallFixture(() => ''), npmRenameDenied)
    vi.mocked(probeRunningCliProcesses).mockResolvedValueOnce({
      status: 'checked',
      processes: [{ processId: 4242, name: 'codex', executablePath: path.join(packageRoot, 'bin', 'codex') }],
    })

    const failure: unknown = await service.uninstallCli('codex').catch((error: unknown) => error)

    const message = 'Codex CLI 卸载失败：文件被占用，检测到 Codex CLI 正在运行（1 个进程），请关掉它的窗口再试。'
      + `原始报错：${npmRenameDeniedDetail}`
    expect(failure).toMatchObject({ message })
    expect(probeRunningCliProcesses).toHaveBeenCalledTimes(1)
    expect(probeRunningCliProcesses).toHaveBeenCalledWith(packageRoot)
    expect(classifyOperationError(message)).toBe('toolRunning')
    expect(runtimeLog.log).toHaveBeenCalledWith('warn', 'install', 'cli.file-locked', 'Codex CLI 卸载时文件被占用', {
      provider: 'codex',
      probeStatus: 'checked',
      processes: 1,
    })
  })

  it('still points at the running tool when npm says the folder is busy but no process was counted', async () => {
    const { service } = failingCodexUninstall(linuxInstallFixture(() => ''), [
      'npm error code EBUSY',
      'npm error syscall rename',
      'npm error errno -16',
      "npm error Error: EBUSY: resource busy or locked, rename '/npm/@openai/codex' -> '/npm/@openai/.codex-x'",
    ])

    const failure: unknown = await service.uninstallCli('codex').catch((error: unknown) => error)

    const message = 'Codex CLI 卸载失败：文件被占用，Codex CLI 可能正在运行，请关掉正在使用它的窗口再试。'
      + "原始报错：命令执行失败（退出码 1）：npm（EBUSY；Error: EBUSY: resource busy or locked, rename '/npm/@openai/codex' -> '/npm/@openai/.codex-x'）"
    expect(failure).toMatchObject({ message })
    expect(classifyOperationError(message)).toBe('toolRunning')
  })

  it('keeps a Mac permission failure a permission problem even while the tool is running', async () => {
    // Mac 挪得动正开着的程序文件，npm 在那边报 EACCES 只会是权限不够，比如用 sudo 装进
    // /usr/local 的那份。这时就算数得到进程也不能叫客户去关窗口：关了照样卸不掉。
    const fixture = linuxInstallFixture(() => '')
    writeCodexPackage(fixture.userPrefix, fixture.expectedVersion, false)
    const packageRoot = path.join(fixture.userPrefix, 'lib', 'node_modules', '@openai', 'codex')
    failNpmUninstall(fixture, [
      'npm error code EACCES',
      'npm error syscall rename',
      'npm error path /usr/local/lib/node_modules/@openai/codex',
      'npm error errno -13',
      "npm error Error: EACCES: permission denied, rename '/usr/local/lib/node_modules/@openai/codex' -> '/usr/local/lib/node_modules/@openai/.codex-x'",
    ])
    vi.mocked(probeRunningCliProcesses).mockResolvedValue({
      status: 'checked',
      processes: [{ processId: 4242, name: 'codex', executablePath: path.join(packageRoot, 'bin', 'codex') }],
    })
    const service = createSystemService(
      new AppSettingsStore(path.join(fixture.root, 'settings.json'), fixture.root),
      {
        platform: 'darwin',
        windowsExecutionMode: 'same-user',
        resolveCliInstallation: vi.fn<typeof resolveCliInstallationForTest>(async () => ({
          commandPath: path.join(fixture.userPrefix, 'bin', 'codex'),
          installDirectory: packageRoot,
          packageRoot,
          npmPrefix: fixture.userPrefix,
          packageVersion: fixture.expectedVersion,
          source: 'npm',
        })),
      },
    )

    const failure: unknown = await service.uninstallCli('codex').catch((error: unknown) => error)

    const message = 'Codex CLI 卸载失败：命令执行失败（退出码 1）：npm（EACCES；Error: EACCES: permission denied, '
      + "rename '/usr/local/lib/node_modules/@openai/codex' -> '/usr/local/lib/node_modules/@openai/.codex-x'）"
    expect(failure).toMatchObject({ message })
    expect(probeRunningCliProcesses).not.toHaveBeenCalled()
    expect(classifyOperationError(message)).toBe('permission')
  })

  it('fails the install when npm silently skipped the platform build and keeps nothing half-installed', async () => {
    const fixture = linuxInstallFixture((userPrefix) => `prefix=${userPrefix}\n`)
    let withNative = false
    const runCommand = fakeNpm(fixture, (prefix) => {
      // npm exits 0 after dropping an optional dependency whose download failed.
      writeCodexPackage(prefix, fixture.expectedVersion, withNative)
    })
    const target = { isDestroyed: () => false, send: vi.fn() }
    const service = createSystemService(
      new AppSettingsStore(path.join(fixture.root, 'settings.json'), fixture.root),
      { platform: 'linux', runCommand, resolveCliInstallation: managedResolution(fixture) },
    )
    const managedPackage = path.join(
      fixture.homeDirectory, '.local', 'share', 'XingMangAI', 'Cli', 'npm', 'lib', 'node_modules', '@openai', 'codex',
    )

    await expect(service.installCli('codex', target)).rejects.toThrow('Codex CLI 的主程序没有下载完整')
    expect(target.send).not.toHaveBeenCalledWith(
      'cli:install-progress',
      expect.objectContaining({ state: 'success' }),
    )
    // Each attempt failed inside its own staged prefix, so the managed prefix was never touched.
    expect(fs.existsSync(managedPackage)).toBe(false)

    withNative = true
    await service.installCli('codex', target)
    expect(fs.existsSync(path.join(managedPackage, 'node_modules', '@openai', 'codex-linux-x64', 'package.json'))).toBe(true)
    expect(target.send).toHaveBeenCalledWith(
      'cli:install-progress',
      expect.objectContaining({ state: 'success' }),
    )
  })
})

describe.runIf(process.platform === 'linux')('Linux Grok install from npm', () => {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'

  function recommendedGrokVersion(): string {
    const recommended = cliVerifiedVersions.grok.recommended
    if (!recommended) throw new Error('cliVerifiedVersions.grok 必须有推荐版本')
    return recommended.version
  }

  interface GrokFixture {
    root: string
    homeDirectory: string
    npmExecutable: string
    version: string
    binary: Buffer
  }

  function grokFixture(): GrokFixture {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-linux-grok-install-'))
    temporaryDirectories.push(temporaryRoot)
    const root = fs.realpathSync(temporaryRoot)
    const homeDirectory = path.join(root, 'home')
    const runtimeBin = path.join(root, 'runtime-bin')
    fs.mkdirSync(homeDirectory, { recursive: true })
    fs.mkdirSync(runtimeBin, { recursive: true })
    const npmExecutable = path.join(runtimeBin, 'npm')
    fs.writeFileSync(npmExecutable, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(npmExecutable, 0o700)
    vi.stubEnv('HOME', homeDirectory)
    vi.stubEnv('XDG_DATA_HOME', undefined)
    vi.stubEnv('PATH', runtimeBin)
    vi.stubEnv('npm_config_prefix', undefined)
    vi.stubEnv('npm_config_userconfig', undefined)
    const version = recommendedGrokVersion()
    const integrity = `sha512-${Buffer.alloc(64, 0x47).toString('base64')}`
    // Anything aimed at x.ai (the stable manifest Windows and macOS use) fails the test.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('cloudflare.com/cdn-cgi/trace')) {
        return new Response('ip=203.0.113.8\nloc=US\n', { status: 200 })
      }
      if (url === npmPackageVersionUrl('https://registry.npmjs.org', '@xai-official/grok', version)) {
        return new Response(JSON.stringify({ name: '@xai-official/grok', version, dist: { integrity } }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))
    const binary = Buffer.concat([Buffer.from('\x7fELF grok '), Buffer.alloc(70_000, 0x61)])
    return { root, homeDirectory, npmExecutable, version, binary }
  }

  /**
   * Stands in for npm and for the installed program. `npm ci --ignore-scripts` unpacks the
   * packages into the resolution directory; the lifecycle run is where xAI's postinstall
   * writes ~/.grok/bin, so that is where `installedBytes` lands.
   */
  function grokCommands(fixture: GrokFixture, installedBytes: () => Buffer) {
    const calls: Array<{ executable: string; argv: readonly string[] }> = []
    const runCommand = vi.fn(async (
      spec: { executable: string; argv: readonly string[] },
      options: { cwd?: string } = {},
    ) => {
      calls.push(spec)
      let stdout = ''
      if (spec.argv.length === 1 && spec.argv[0] === '--version') {
        if (path.dirname(spec.executable) !== path.join(fixture.homeDirectory, '.grok', 'bin')) {
          throw new Error(`Unexpected command: ${spec.executable}`)
        }
        stdout = `grok ${fixture.version} (6b2c1a0)\n`
      } else if (spec.executable !== fixture.npmExecutable) {
        throw new Error(`Unexpected command: ${spec.executable}`)
      } else if (spec.argv.includes('--package-lock-only')) {
        const cwd = options.cwd
        if (!cwd) throw new Error('Fake npm requires cwd')
        const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
          name: string
          version: string
          dependencies: Record<string, string>
        }
        fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          lockfileVersion: 3,
          packages: {
            '': { dependencies: manifest.dependencies },
            'node_modules/@xai-official/grok': {
              version: fixture.version,
              integrity: `sha512-${Buffer.alloc(64, 0x47).toString('base64')}`,
            },
          },
        }))
      } else if (spec.argv[0] === 'ci' && spec.argv.includes('--ignore-scripts')) {
        const cwd = options.cwd
        if (!cwd) throw new Error('Fake npm requires cwd')
        const platformPackage = path.join(cwd, 'node_modules', '@xai-official', `grok-linux-${architecture}`)
        fs.mkdirSync(path.join(platformPackage, 'bin'), { recursive: true })
        fs.writeFileSync(path.join(platformPackage, 'package.json'), JSON.stringify({
          name: `@xai-official/grok-linux-${architecture}`,
          version: fixture.version,
        }))
        fs.writeFileSync(path.join(platformPackage, 'bin', 'grok.br'), zlib.brotliCompressSync(fixture.binary))
      } else if (spec.argv[0] === 'ci') {
        const bin = path.join(fixture.homeDirectory, '.grok', 'bin')
        fs.mkdirSync(bin, { recursive: true })
        fs.writeFileSync(path.join(bin, `grok-${fixture.version}`), installedBytes(), { mode: 0o755 })
        fs.rmSync(path.join(bin, 'grok'), { force: true })
        fs.symlinkSync(`grok-${fixture.version}`, path.join(bin, 'grok'))
      }
      return {
        executable: spec.executable,
        argv: [...spec.argv],
        exitCode: 0,
        signal: null,
        stdout,
        stderr: '',
        outputBytes: Buffer.byteLength(stdout),
        durationMs: 1,
      }
    })
    return { runCommand, calls }
  }

  it('installs Grok with the lifecycle run, checks it byte for byte and never asks x.ai', async () => {
    const fixture = grokFixture()
    const { runCommand, calls } = grokCommands(fixture, () => fixture.binary)
    const target = { isDestroyed: () => false, send: vi.fn() }
    const service = createSystemService(
      new AppSettingsStore(path.join(fixture.root, 'settings.json'), fixture.root),
      { platform: 'linux', runCommand },
    )

    await service.installCli('grok', target)

    const bin = path.join(fixture.homeDirectory, '.grok', 'bin')
    expect(fs.readlinkSync(path.join(bin, 'grok'))).toBe(`grok-${fixture.version}`)
    expect(fs.readlinkSync(path.join(bin, 'agent'))).toBe(`grok-${fixture.version}`)
    expect(target.send).toHaveBeenCalledWith('cli:install-progress', expect.objectContaining({ state: 'success' }))
    const npmRuns = calls.filter((call) => call.executable === fixture.npmExecutable && call.argv[0] === 'ci')
    expect(npmRuns.map((call) => call.argv.includes('--ignore-scripts'))).toEqual([true, false])
    // The lifecycle run installs the resolved lock in place: no global install, no prefix.
    expect(npmRuns[1].argv.some((argument) => argument === '--global' || argument.startsWith('--prefix='))).toBe(false)
    expect(calls).toContainEqual({ executable: path.join(bin, `grok-${fixture.version}`), argv: ['--version'] })
  })

  it('uninstalls what it installed and leaves the Grok settings alone', async () => {
    const fixture = grokFixture()
    const { runCommand } = grokCommands(fixture, () => fixture.binary)
    const target = { isDestroyed: () => false, send: vi.fn() }
    const service = createSystemService(
      new AppSettingsStore(path.join(fixture.root, 'settings.json'), fixture.root),
      { platform: 'linux', runCommand },
    )
    await service.installCli('grok', target)
    const grokRoot = path.join(fixture.homeDirectory, '.grok')
    fs.writeFileSync(path.join(grokRoot, 'config.toml'), 'model = "grok"\n')

    await expect(service.uninstallCli('grok')).resolves.toMatchObject({
      outcome: 'uninstalled',
      previousVersion: fixture.version,
    })
    expect(fs.readdirSync(path.join(grokRoot, 'bin'))).toEqual([])
    expect(fs.readFileSync(path.join(grokRoot, 'config.toml'), 'utf8')).toBe('model = "grok"\n')
  })

  it('rolls the command back and reports failure when the installed program is not the verified one', async () => {
    const fixture = grokFixture()
    const { runCommand } = grokCommands(fixture, () => Buffer.from('some other program'))
    const target = { isDestroyed: () => false, send: vi.fn() }
    const service = createSystemService(
      new AppSettingsStore(path.join(fixture.root, 'settings.json'), fixture.root),
      { platform: 'linux', runCommand },
    )

    await expect(service.installCli('grok', target)).rejects.toThrow('Grok CLI 装好的程序文件和官方发布的不一致')
    expect(target.send).not.toHaveBeenCalledWith('cli:install-progress', expect.objectContaining({ state: 'success' }))
    const bin = path.join(fixture.homeDirectory, '.grok', 'bin')
    expect(fs.existsSync(path.join(bin, 'grok'))).toBe(false)
    expect(fs.existsSync(path.join(bin, 'agent'))).toBe(false)
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

describe('Git runtime installation', () => {
  function gitInstaller() {
    return vi.fn(async () => ({
      installed: true as const,
      action: 'installed' as const,
      source: 'npmmirror' as const,
      version: '2.55.0.5',
      architecture: 'x64' as const,
      pathRefreshRequired: true,
    }))
  }

  it('installs Git on Windows for the current user when none is visible', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-missing-git-runtime-'))
    temporaryDirectories.push(directory)
    const installGitRuntime = gitInstaller()
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable: async () => null,
        networkLocationFetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
        installGitRuntime,
      },
    )
    const target = { isDestroyed: () => false, send: vi.fn() }

    await expect(service.installGitRuntime(target)).resolves.toMatchObject({ action: 'installed', version: '2.55.0.5' })
    expect(installGitRuntime).toHaveBeenCalledWith(expect.objectContaining({ temporaryDirectoryMode: 'same-user' }))
    const options = (installGitRuntime.mock.calls[0] as unknown as [{ onProgress(progress: unknown): void }])[0]
    options.onProgress({ phase: 'downloading', source: 'npmmirror', message: '正在从国内镜像下载 Git', percent: 10 })
    expect(target.send).toHaveBeenCalledWith('runtime:git-install-progress', expect.objectContaining({ phase: 'downloading' }))
  })

  it('does not reinstall a Git that is already visible', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-existing-git-runtime-'))
    temporaryDirectories.push(directory)
    const installGitRuntime = gitInstaller()
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable: async (command) => command === 'git' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : null,
        runCommand: async (spec) => ({
          executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null,
          stdout: 'git version 2.43.0.windows.1\n', stderr: '', outputBytes: 29, durationMs: 1,
        }),
        installGitRuntime,
      },
    )
    const target = { isDestroyed: () => false, send: vi.fn() }

    await expect(service.installGitRuntime(target)).resolves.toMatchObject({
      action: 'unchanged',
      version: '2.43.0',
      pathRefreshRequired: false,
    })
    expect(installGitRuntime).not.toHaveBeenCalled()
    expect(target.send).toHaveBeenCalledWith(
      'runtime:git-install-progress',
      expect.objectContaining({ phase: 'complete', message: expect.stringContaining('不用重复安装') }),
    )
  })

  it('notes a Git that came along with Claude Code and stays quiet when it was already there', async () => {
    const notes: string[] = []
    await installGitAlongsideClaude(async () => ({ action: 'installed' }), (message) => notes.push(message))
    await installGitAlongsideClaude(async () => ({ action: 'unchanged' }), (message) => notes.push(message))
    expect(notes).toEqual(['Git 也顺带装好了'])
  })

  it('never lets a failed Git install fail the Claude Code install', async () => {
    const notes: string[] = []
    await expect(installGitAlongsideClaude(
      async () => { throw new Error('Git 没装上。国内镜像：HTTP 404；Git 官方源：下载超时') },
      (message) => notes.push(message),
    )).resolves.toBeUndefined()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('不影响使用 Claude Code')
    expect(notes[0]).toContain('「安装 Git」')
  })

  it('refuses to install Git outside Windows and macOS', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-linux-git-runtime-'))
    temporaryDirectories.push(directory)
    const installGitRuntime = gitInstaller()
    const installMacGitRuntime = vi.fn()
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      { platform: 'linux', findExecutable: async () => null, installGitRuntime, installMacGitRuntime },
    )

    await expect(service.installGitRuntime({ isDestroyed: () => false, send: vi.fn() }))
      .rejects.toThrow('仅支持 Windows')
    expect(installGitRuntime).not.toHaveBeenCalled()
    expect(installMacGitRuntime).not.toHaveBeenCalled()
  })

  it('hands macOS to the Apple installer path and shares one wait between double clicks', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-mac-git-runtime-'))
    temporaryDirectories.push(directory)
    const installGitRuntime = gitInstaller()
    let finish: (value: Awaited<ReturnType<typeof installMacGitRuntimeType>>) => void = () => undefined
    const installMacGitRuntime = vi.fn(() => new Promise<Awaited<ReturnType<typeof installMacGitRuntimeType>>>((resolve) => { finish = resolve }))
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      { platform: 'darwin', findExecutable: async () => null, installGitRuntime, installMacGitRuntime },
    )
    const target = { isDestroyed: () => false, send: vi.fn() }

    const first = service.installGitRuntime(target)
    const second = service.installGitRuntime(target)
    finish({ installed: false, action: 'cancelled', source: null, version: null, architecture: 'arm64', pathRefreshRequired: false, message: '没有装 Git。' })
    await expect(first).resolves.toMatchObject({ installed: false, action: 'cancelled' })
    await expect(second).resolves.toMatchObject({ installed: false, action: 'cancelled' })
    expect(installMacGitRuntime).toHaveBeenCalledTimes(1)
    expect(installGitRuntime).not.toHaveBeenCalled()
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

  it('refuses to restart while an installation is still running', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-windows-restart-busy-'))
    temporaryDirectories.push(directory)
    let finishInstall: () => void = () => undefined
    let installStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => { installStarted = resolve })
    const installPythonRuntime = vi.fn(async () => {
      installStarted()
      await new Promise<void>((resolve) => { finishInstall = resolve })
      return {
        installed: true as const,
        action: 'installed' as const,
        method: 'winget' as const,
        source: 'winget' as const,
        version: 'Python 3.12',
        architecture: 'x64' as const,
        pathRefreshRequired: true,
      }
    })
    const runCommand = vi.fn<typeof productionRunCommand>()
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        runCommand,
        findExecutable: async () => null,
        resolveWindowsMachinePaths: () => testMachinePaths,
        installPythonRuntime,
        inspectInstalledPythonRuntime: async () => { throw new Error('Python 3.12 fixed install not found') },
      },
    )

    const install = service.installPythonRuntime({ isDestroyed: () => false, send: vi.fn() })
    await started
    await expect(service.restartWindows()).rejects.toThrow('等它做完再重启电脑')
    expect(runCommand).not.toHaveBeenCalled()
    finishInstall()
    await expect(install).resolves.toMatchObject({ action: 'installed' })
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

  it.runIf(process.platform === 'win32')('installs the ARM Node.js on an ARM laptop that has none yet', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-arm-node-runtime-'))
    temporaryDirectories.push(directory)
    const target = { isDestroyed: () => false, send: vi.fn() }
    const installNodeRuntime = vi.fn(async (): Promise<NodeRuntimeInstallResult> => ({
      installed: true,
      action: 'installed',
      method: 'msi',
      source: 'official',
      version: 'v24.19.0',
      architecture: 'arm64',
      pathRefreshRequired: true,
      systemRestartRequired: false,
    }))
    const inspectWindowsProcessor = vi.fn(async () => 'arm64' as const)
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable: async () => null,
        inspectWindowsRestartRequired: async () => ({ required: false, reasons: [] }),
        inspectWindowsProcessor,
        installNodeRuntime,
      },
    )

    await service.installNodeRuntime(target)
    expect(installNodeRuntime).toHaveBeenCalledWith(expect.objectContaining({ architecture: 'arm64' }))
    if (process.arch !== 'arm64') {
      expect(target.send).toHaveBeenCalledWith(
        'runtime:node-install-progress',
        expect.objectContaining({ message: expect.stringContaining('这台电脑是 ARM 芯片') }),
      )
    }
    await service.inspectWindowsProcessor()
    expect(inspectWindowsProcessor).toHaveBeenCalledTimes(1)
  })

  it.runIf(process.platform === 'win32')('keeps an outdated Node.js on its own build when replacing it on an ARM laptop', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-arm-old-node-runtime-'))
    temporaryDirectories.push(directory)
    const nodeExecutable = 'D:\\nodejs\\node.exe'
    const target = { isDestroyed: () => false, send: vi.fn() }
    const installNodeRuntime = vi.fn(async (): Promise<NodeRuntimeInstallResult> => ({
      installed: true,
      action: 'installed',
      method: 'msi',
      source: 'official',
      version: 'v24.19.0',
      architecture: 'x64',
      pathRefreshRequired: true,
      systemRestartRequired: false,
    }))
    const inspectExecutableMachine = vi.fn(async () => 'x64' as const)
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable: async (command) => command === 'node' ? nodeExecutable : null,
        runCommand: vi.fn(async (spec: { executable: string; argv: readonly string[] }) => ({
          executable: spec.executable,
          argv: [...spec.argv],
          exitCode: 0,
          signal: null,
          stdout: 'v16.20.2\n',
          stderr: '',
          outputBytes: 10,
          durationMs: 1,
        })),
        inspectWindowsRestartRequired: async () => ({ required: false, reasons: [] }),
        inspectWindowsProcessor: async () => 'arm64',
        inspectExecutableMachine,
        installNodeRuntime,
      },
    )

    await service.installNodeRuntime(target)
    expect(inspectExecutableMachine).toHaveBeenCalledWith(nodeExecutable)
    expect(installNodeRuntime).toHaveBeenCalledWith(expect.objectContaining({ architecture: 'x64' }))
    expect(target.send).not.toHaveBeenCalledWith(
      'runtime:node-install-progress',
      expect.objectContaining({ message: expect.stringContaining('ARM 芯片') }),
    )
  })

  it('replaces a working Node.js only when the customer asked for it because of company certificates on Windows and Linux', () => {
    const old = { installed: true, version: 'v20.11.1' }
    const certificate = { reason: 'certificate' as const }
    expect(shouldReplaceNodeForCertificates({ platform: 'win32', request: certificate, node: old })).toBe(true)
    expect(shouldReplaceNodeForCertificates({ platform: 'win32', request: certificate, node: { installed: true, version: 'v22.18.0' } })).toBe(true)
    // 缺省请求就是旧行为：够装工具就不动。
    expect(shouldReplaceNodeForCertificates({ platform: 'win32', request: {}, node: old })).toBe(false)
    // 已经认得证书的、读不出版本的、没装的，都不换。
    expect(shouldReplaceNodeForCertificates({ platform: 'win32', request: certificate, node: { installed: true, version: 'v22.19.0' } })).toBe(false)
    expect(shouldReplaceNodeForCertificates({ platform: 'win32', request: certificate, node: { installed: true, version: null } })).toBe(false)
    expect(shouldReplaceNodeForCertificates({ platform: 'win32', request: certificate, node: { installed: false, version: null } })).toBe(false)
    // Mac 上代下的那份排在客户自己的后面，换了也用不上。
    expect(shouldReplaceNodeForCertificates({ platform: 'darwin', request: certificate, node: old })).toBe(false)
    // Linux 上代下的那份在软件里排在最前，装上就是它（linux-platform.ts）。
    expect(shouldReplaceNodeForCertificates({ platform: 'linux', request: certificate, node: { installed: true, version: 'v22.10.0' } })).toBe(true)
    expect(shouldReplaceNodeForCertificates({ platform: 'linux', request: {}, node: old })).toBe(false)
  })

  function outdatedNodeService(directory: string, versions: string[], installNodeRuntime: () => Promise<NodeRuntimeInstallResult>) {
    const nodeExecutable = 'C:\\Program Files\\nodejs\\node.exe'
    const npmExecutable = 'C:\\Program Files\\nodejs\\npm.cmd'
    let nodeReads = 0
    const runCommand = vi.fn(async (spec: { executable: string; argv: readonly string[] }) => {
      const stdout = spec.executable === nodeExecutable
        ? `${versions[Math.min(nodeReads++, versions.length - 1)]}\n`
        : '10.9.3\n'
      return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: 10, durationMs: 1 }
    })
    return createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable: async (command) => command === 'node' ? nodeExecutable : command === 'npm' ? npmExecutable : null,
        runCommand,
        inspectWindowsRestartRequired: async () => ({ required: false, reasons: [] }),
        inspectWindowsProcessor: async () => 'x64',
        inspectExecutableMachine: async () => 'x64',
        installNodeRuntime,
      },
    )
  }

  const installedLts: NodeRuntimeInstallResult = {
    installed: true,
    action: 'installed',
    method: 'msi',
    source: 'official',
    version: 'v24.19.0',
    architecture: 'x64',
    pathRefreshRequired: true,
    systemRestartRequired: false,
  }

  it('installs a new Node.js over one that cannot read company certificates once the customer confirmed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-node-certificate-replace-'))
    temporaryDirectories.push(directory)
    const target = { isDestroyed: () => false, send: vi.fn() }
    const installNodeRuntime = vi.fn(async () => installedLts)

    // 没说原因：还是那句「无需重复安装」，行为不变。
    await expect(outdatedNodeService(directory, ['v20.11.1'], installNodeRuntime).installNodeRuntime(target))
      .resolves.toMatchObject({ action: 'unchanged' })
    expect(installNodeRuntime).not.toHaveBeenCalled()

    await expect(outdatedNodeService(directory, ['v20.11.1', 'v24.19.0'], installNodeRuntime).installNodeRuntime(target, { reason: 'certificate' }))
      .resolves.toMatchObject({ action: 'installed', version: 'v24.19.0' })
    expect(installNodeRuntime).toHaveBeenCalledTimes(1)
  })

  it('says so when an older Node.js still wins after the replacement', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-node-certificate-shadowed-'))
    temporaryDirectories.push(directory)
    const target = { isDestroyed: () => false, send: vi.fn() }
    const service = outdatedNodeService(directory, ['v20.11.1'], vi.fn(async () => installedLts))
    await expect(service.installNodeRuntime(target, { reason: 'certificate' })).rejects.toThrow(nodeStillOutdatedAfterReplaceMessage)
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

  it('carries npm\'s own failure lines into the install error instead of only the exit code', async () => {
    // A real child process writing what npm prints when the disk is full: the
    // runner keeps it on error.stderr, and the install error must repeat the
    // code so the renderer can tell a full disk from a dropped connection.
    const script = [
      "process.stderr.write('npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported\\n')",
      "process.stderr.write('npm error code ENOSPC\\n')",
      "process.stderr.write('npm error syscall write\\n')",
      "process.stderr.write('npm error errno -28\\n')",
      "process.stderr.write('npm error nospc ENOSPC: no space left on device, write\\n')",
      "process.stderr.write('npm error nospc There appears to be insufficient space on your system to finish.\\n')",
      "process.stderr.write('npm error A complete log of this run can be found in: /home/alice/.npm/_logs/debug-0.log\\n')",
      'process.exit(1)',
    ].join(';')
    const failure = await runCommand({ executable: process.execPath, argv: ['-e', script] }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CommandRunnerError)
    const detail = describeNpmCommandFailure(failure)
    expect(detail).toContain('退出码 1')
    expect(detail).toContain('ENOSPC；nospc ENOSPC: no space left on device, write')
    expect(detail).not.toContain('complete log')
    expect(detail).not.toContain('deprecated')
  })

  it('keeps the last npm lines when npm printed no error code', () => {
    const failure = new CommandRunnerError('命令执行失败（退出码 1）：node', {
      code: 'EXIT_NON_ZERO',
      executable: 'node',
      argv: [],
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'first\nrequest to https://registry.npmjs.org/x failed, reason: connect ETIMEDOUT 1.2.3.4:443\nAuthorization: Bearer sk-secret-value-1234567890\n',
      outputBytes: 0,
      maxOutputBytes: 0,
      durationMs: 0,
    })

    const detail = describeNpmCommandFailure(failure)
    expect(detail).toContain('ETIMEDOUT')
    expect(detail).not.toContain('first')
    expect(detail).not.toContain('sk-secret-value')
  })

  it('says a timed-out npm step is a download timeout', () => {
    const failure = new CommandRunnerError('命令执行时间过长，已中止：node', {
      code: 'TIMED_OUT',
      executable: 'node',
      argv: [],
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      outputBytes: 0,
      maxOutputBytes: 0,
      durationMs: npmDownloadTimeoutMs,
    })

    expect(describeNpmCommandFailure(failure)).toContain('下载超时')
    expect(describeNpmCommandFailure(new Error('plain'))).toBe('plain')
  })

  it('never calls a stuck uninstall a download timeout, but keeps the code npm printed', () => {
    // 卸载不下载东西。借安装那句「下载超时」的话，渲染层会叫客户换源重试（第三十三批 C）。
    const timedOut = new CommandRunnerError('命令执行时间过长，已中止：node.exe', {
      code: 'TIMED_OUT',
      executable: 'node.exe',
      argv: [],
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      outputBytes: 0,
      maxOutputBytes: 0,
      durationMs: 2 * 60_000,
    })
    expect(describeNpmUninstallFailure(timedOut)).toBe('命令执行时间过长，已中止：node.exe')
    expect(classifyOperationError(`Codex CLI 卸载失败：${describeNpmUninstallFailure(timedOut)}`)).toBe('unknown')

    const locked = new CommandRunnerError('命令执行失败（退出码 1）：node.exe', {
      code: 'EXIT_NON_ZERO',
      executable: 'node.exe',
      argv: [],
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: [
        'npm error code EPERM',
        'npm error syscall rename',
        'npm error path C:\\Users\\a\\AppData\\Local\\XingMangAI\\Cli\\npm\\node_modules\\@openai\\codex',
        'npm error errno -4048',
        "npm error Error: EPERM: operation not permitted, rename 'C:\\npm\\@openai\\codex' -> 'C:\\npm\\@openai\\.codex-x'",
        'npm error A complete log of this run can be found in: C:\\Users\\a\\AppData\\Local\\npm-cache\\_logs\\debug-0.log',
      ].join('\n'),
      outputBytes: 0,
      maxOutputBytes: 0,
      durationMs: 0,
    })
    expect(describeNpmUninstallFailure(locked)).toBe(
      "命令执行失败（退出码 1）：node.exe（EPERM；Error: EPERM: operation not permitted, rename 'C:\\npm\\@openai\\codex' -> 'C:\\npm\\@openai\\.codex-x'）",
    )
    expect(describeNpmUninstallFailure(new Error('plain'))).toBe('plain')
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

  it('names how long a stalled Grok download has been idle', () => {
    expect(grokDownloadStallHeartbeatMs).toBeGreaterThanOrEqual(5_000)
    const message = grokDownloadStallMessage(45_000)

    expect(message).toContain('45 秒')
    // The percentage stays where it stopped, so the heartbeat has to carry the
    // one fact the progress line cannot: nothing arrived.
    expect(message).toContain('没有新数据')
    expect(message).not.toMatch(/%|预计|剩余/)
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

describe('CLI launch queue key', () => {
  it('merges only identical launches and keeps different workspaces or modes apart', async () => {
    const first = path.join(os.tmpdir(), 'project-a')
    expect(buildCliLaunchQueueKey('codex', first, 'new')).toBe(buildCliLaunchQueueKey('codex', path.join(first, '.'), 'new'))
    expect(buildCliLaunchQueueKey('codex', first, 'new')).not.toBe(buildCliLaunchQueueKey('codex', path.join(os.tmpdir(), 'project-b'), 'new'))
    expect(buildCliLaunchQueueKey('codex', first, 'new')).not.toBe(buildCliLaunchQueueKey('codex', first, 'resumeLast'))
    expect(buildCliLaunchQueueKey('codex', first, 'new')).not.toBe(buildCliLaunchQueueKey('claude', first, 'new'))
    // 同一文件夹里按 id 接两条不同的 Codex 对话，是两次打开。
    expect(buildCliLaunchQueueKey('codex', first, 'resumeLast', '0199a3c2-7b1e-7d40-9f5a-2c3d4e5f6a7b'))
      .not.toBe(buildCliLaunchQueueKey('codex', first, 'resumeLast', '1a2b3c4d-0000-4000-8000-000000000000'))
    expect(buildCliLaunchQueueKey('codex', first, 'resumeLast', '0199a3c2-7b1e-7d40-9f5a-2c3d4e5f6a7b')).not.toBe(buildCliLaunchQueueKey('codex', first, 'resumeLast'))
    expect(buildCliLaunchQueueKey('codex', first, 'resumeLast', null)).toBe(buildCliLaunchQueueKey('codex', first, 'resumeLast'))

    const queue = new InstallationQueue()
    const ran: string[] = []
    let releaseInstall: () => void = () => {}
    const install = queue.enqueue('cli:install:codex', () => new Promise<void>((resolve) => { releaseInstall = resolve }))
    const home = queue.enqueue(buildCliLaunchQueueKey('codex', first, 'new'), async () => { ran.push('home'); return 'home' })
    const doubleClick = queue.enqueue(buildCliLaunchQueueKey('codex', first, 'new'), async () => { ran.push('duplicate'); return 'duplicate' })
    const resume = queue.enqueue(buildCliLaunchQueueKey('codex', first, 'resumeLast'), async () => { ran.push('resume'); return 'resume' })
    releaseInstall()
    await install
    await expect(Promise.all([home, doubleClick, resume])).resolves.toEqual(['home', 'home', 'resume'])
    expect(ran).toEqual(['home', 'resume'])
    expect(resolveInterruptibleInstallTask({ activeKey: buildCliLaunchQueueKey('codex', first, 'new'), pendingKeys: [] })).toBeNull()
  })
})

describe('externalCliInstallRefusal', () => {
  it('refuses the npm channel only for CLIs installed some other way', () => {
    expect(externalCliInstallRefusal('claude', 'native')).toMatch(/官方安装器管理，这里不会再另装一份/)
    expect(externalCliInstallRefusal('codex', 'path')).toMatch(/不是通过本工具安装的/)
    expect(externalCliInstallRefusal('gemini', 'npm')).toBeNull()
    expect(externalCliInstallRefusal('claude', undefined)).toBeNull()
    expect(externalCliInstallRefusal('grok', 'native')).toBeNull()
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

describe('reminder settings pointing at an old location', () => {
  it('flags a Codex notify whose script is gone and takes it back when no hook can be written here', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-stale-hooks-'))
    temporaryDirectories.push(directory)
    const codexHome = path.join(directory, '.codex')
    fs.mkdirSync(codexHome)
    const gone = path.join(directory, 'old install', 'bundled-catalog', 'cli-hooks', 'xingmang-hook.cjs')
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "gpt-5.5"\nnotify = [${JSON.stringify(process.execPath)}, ${JSON.stringify(gone)}, "codex", ${JSON.stringify(directory)}]\n`, 'utf8')
    const service = createService({ providerRoots: { userHome: directory, codexHome } })

    expect(service.getConfig(false).providers.codex.cliHooksStale).toBe(true)
    expect(service.getConfig(false).providers.claude.cliHooksStale).toBe(false)
    expect(service.getConfig(true).providers.codex.cliHooksStale).toBe(false)

    const result = await service.repairCliHooks!('codex')
    expect(result.backups).toHaveLength(1)
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')
    expect(config).not.toContain('notify')
    expect(config).toContain('gpt-5.5')
    expect(service.getConfig(false).providers.codex.cliHooksStale).toBe(false)
  })
})

// 第十八批 1b：开机后第一次读配置时，本账号写的旧钩子不等客户点就改好。
describe('reminder settings fixed on their own after startup', () => {
  async function staleCodexFixture(options: { owner: string | null; recordOwnership: boolean }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-auto-hooks-'))
    temporaryDirectories.push(directory)
    const codexHome = path.join(directory, '.codex')
    fs.mkdirSync(codexHome)
    const gone = path.join(directory, 'old install', 'bundled-catalog', 'cli-hooks', 'xingmang-hook.cjs')
    const configPath = path.join(codexHome, 'config.toml')
    fs.writeFileSync(configPath, `model = "gpt-5.5"\nnotify = [${JSON.stringify(process.execPath)}, ${JSON.stringify(gone)}, "codex", ${JSON.stringify(directory)}]\n`, 'utf8')
    const roots = { userHome: directory, codexHome }
    const managerDataDirectory = path.join(directory, 'manager')
    // Ownership is keyed on the key and endpoint; pretend every tool carries a key so the record can bind to it.
    const inspect: NonNullable<SystemServiceOptions['inspectProviderConfig']> = (provider, providerRoots, urls) => ({
      ...inspectProviderConfig(provider, providerRoots, urls), hasApiKey: true, apiKey: 'sk-auto-hooks',
    })
    if (options.recordOwnership) {
      await new ToolConfigOwnershipStore(path.join(managerDataDirectory, 'tool-config-ownership'))
        .write('codex', inspect('codex', roots, providerBaseUrls), 'account', 'user-1')
    }
    const runtimeLog = { log: vi.fn(), exception: vi.fn() }
    const service = createService({
      providerRoots: roots,
      managerDataDirectory,
      inspectProviderConfig: inspect,
      getExternalClientAccountId: () => options.owner,
      runtimeLog: runtimeLog as unknown as SystemServiceOptions['runtimeLog'],
    })
    return { service, configPath, runtimeLog }
  }

  it('fixes the account\'s own stale hooks once and says so in the summary', async () => {
    const { service, configPath, runtimeLog } = await staleCodexFixture({ owner: 'user-1', recordOwnership: true })
    expect(service.getConfig(false).providers.codex.cliHooksStale).toBe(true)
    expect(service.getConfig(false).providers.codex.cliHooksAutoRepaired).toBeUndefined()

    expect(await service.autoRepairStaleCliHooks!()).toEqual(['codex'])
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('notify')
    expect(fs.readFileSync(configPath, 'utf8')).toContain('gpt-5.5')
    expect(service.getConfig(false).providers.codex).toMatchObject({ cliHooksStale: false, cliHooksAutoRepaired: true })
    expect(service.getConfig(false).providers.claude.cliHooksAutoRepaired).toBeUndefined()
    expect(service.getConfig(true).providers.codex.cliHooksAutoRepaired).toBeUndefined()
    expect(runtimeLog.log).toHaveBeenCalledWith('info', 'config', 'cli-hooks.auto-repaired', expect.any(String), { provider: 'codex' })

    // Only once per launch: a later read does not touch the files again.
    expect(await service.autoRepairStaleCliHooks!()).toEqual([])
  })

  it('leaves hooks alone when nobody is signed in', async () => {
    const { service, configPath } = await staleCodexFixture({ owner: null, recordOwnership: true })
    expect(await service.autoRepairStaleCliHooks!()).toEqual([])
    expect(fs.readFileSync(configPath, 'utf8')).toContain('notify')
    expect(service.getConfig(false).providers.codex.cliHooksStale).toBe(true)
  })

  it('leaves hooks alone in a config the current account did not write, so the home page still offers the fix', async () => {
    const { service, configPath } = await staleCodexFixture({ owner: 'user-1', recordOwnership: false })
    expect(await service.autoRepairStaleCliHooks!()).toEqual([])
    expect(fs.readFileSync(configPath, 'utf8')).toContain('notify')
    expect(service.getConfig(false).providers.codex).toMatchObject({ cliHooksStale: true })
    expect(service.getConfig(false).providers.codex.cliHooksAutoRepaired).toBeUndefined()
  })

  it('serializes concurrent calls so the same file is fixed only once', async () => {
    const { service } = await staleCodexFixture({ owner: 'user-1', recordOwnership: true })
    const [first, second] = await Promise.all([service.autoRepairStaleCliHooks!(), service.autoRepairStaleCliHooks!()])
    expect([...first, ...second]).toEqual(['codex'])
  })
})

describe('shouldAutoRepairCliHooks', () => {
  it('only fixes stale hooks in the account\'s own config that were not tried yet this launch', () => {
    expect(shouldAutoRepairCliHooks({ stale: true, ownership: 'account', attempted: false })).toBe(true)
    expect(shouldAutoRepairCliHooks({ stale: false, ownership: 'account', attempted: false })).toBe(false)
    expect(shouldAutoRepairCliHooks({ stale: true, ownership: 'account', attempted: true })).toBe(false)
    for (const ownership of ['manual', 'unknown', 'missing', 'changed'] as const) {
      expect(shouldAutoRepairCliHooks({ stale: true, ownership, attempted: false })).toBe(false)
    }
  })
})

describe('cliHooksAutoRepairedField', () => {
  it('only reports a fix that still holds', () => {
    expect(cliHooksAutoRepairedField(true, false)).toEqual({ cliHooksAutoRepaired: true })
    expect(cliHooksAutoRepairedField(true, true)).toEqual({})
    expect(cliHooksAutoRepairedField(false, false)).toEqual({})
  })
})

describe('Grok hooks after the customer installs Git or PowerShell 7 themselves', () => {
  function grokHookToml(command: string): string {
    const events = ['UserPromptSubmit', 'Stop', 'StopFailure', 'StopCancelled', 'Notification', 'SessionEnd']
    return ['[compat.claude]', 'hooks = false', ...events.flatMap((event) => [
      '', `[[hooks.${event}]]`, '', `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${JSON.stringify(command)}`, 'timeout = 10',
    ])].join('\n') + '\n'
  }

  it('flags Grok hooks written for Git Bash once Grok would run them in PowerShell, and fixes them', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-shell-'))
    temporaryDirectories.push(directory)
    const script = path.join(directory, 'bundled-catalog', 'cli-hooks', 'xingmang-hook.cjs')
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.writeFileSync(script, '', 'utf8')
    const grokHome = path.join(directory, '.grok')
    fs.mkdirSync(grokHome)
    const configPath = path.join(grokHome, 'config.toml')
    // Written in the Git Bash form; this runner has no Git Bash at Grok's three fixed places, so Grok would pick PowerShell.
    fs.writeFileSync(configPath, grokHookToml(`'${process.execPath}' '${script}' grok '${directory}'`), 'utf8')
    const readWindowsLivePath = vi.fn(async () => 'C:\\Windows\\System32')
    const service = createService({
      platform: 'win32',
      providerRoots: { userHome: directory, codexHome: path.join(directory, '.codex') },
      readWindowsLivePath,
      resolveWindowsMachinePaths: () => ({ system32: 'C:\\Windows\\System32' }) as ReturnType<NonNullable<SystemServiceOptions['resolveWindowsMachinePaths']>>,
    })

    expect(service.getConfig(false).providers.grok).toMatchObject({ cliHooksStale: true, cliHooksShellChanged: true })
    expect(service.getConfig(true).providers.grok.cliHooksStale).toBe(false)
    expect(service.getConfig(false).providers.claude.cliHooksShellChanged).toBeUndefined()

    // No hook can be written here (no bundled script configured), so the repair takes ours back instead of leaving them red.
    const result = await service.repairCliHooks!('grok')
    expect(result.backups).toHaveLength(1)
    expect(readWindowsLivePath).toHaveBeenCalledWith('C:\\Windows\\System32', process.env)
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('xingmang-hook.cjs')
    expect(service.getConfig(false).providers.grok).toMatchObject({ cliHooksStale: false })
    expect(service.getConfig(false).providers.grok.cliHooksShellChanged).toBeUndefined()
  })

  it('leaves Grok hooks alone when they are written for the shell Grok will use', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-shell-'))
    temporaryDirectories.push(directory)
    const script = path.join(directory, 'xingmang-hook.cjs')
    fs.writeFileSync(script, '', 'utf8')
    fs.mkdirSync(path.join(directory, '.grok'))
    fs.writeFileSync(path.join(directory, '.grok', 'config.toml'), grokHookToml(`& '${process.execPath}' '${script}' grok '${directory}'`), 'utf8')
    const service = createService({ platform: 'win32', providerRoots: { userHome: directory, codexHome: path.join(directory, '.codex') } })
    expect(service.getConfig(false).providers.grok.cliHooksStale).toBe(false)
    expect(service.getConfig(false).providers.grok.cliHooksShellChanged).toBeUndefined()
  })
})

describe('cliHooksSummaryFields', () => {
  it('only adds the shell-changed flag when the shell really changed', () => {
    expect(cliHooksSummaryFields(null)).toEqual({ cliHooksStale: false })
    expect(cliHooksSummaryFields({ stale: false, shellChanged: false })).toEqual({ cliHooksStale: false })
    expect(cliHooksSummaryFields({ stale: true, shellChanged: false })).toEqual({ cliHooksStale: true })
    expect(cliHooksSummaryFields({ stale: true, shellChanged: true })).toEqual({ cliHooksStale: true, cliHooksShellChanged: true })
  })

  it('reports missing hooks only when nothing needs repairing first', () => {
    expect(cliHooksSummaryFields({ stale: false, shellChanged: false, missing: true })).toEqual({ cliHooksStale: false, cliHooksMissing: true })
    expect(cliHooksSummaryFields({ stale: true, shellChanged: false, missing: true })).toEqual({ cliHooksStale: true })
    expect(cliHooksSummaryFields({ stale: false, shellChanged: false, missing: false })).toEqual({ cliHooksStale: false })
  })
})

describe('grokCliHooksMissing', () => {
  const base = { platform: 'win32' as const, provider: 'grok' as const, managedTargets: 0, relayConfigured: true, shell: 'powershell' as const }

  it('flags a Windows Grok relay config that has none of our hooks', () => {
    expect(grokCliHooksMissing(base)).toBe(true)
    expect(grokCliHooksMissing({ ...base, shell: 'bash' })).toBe(true)
  })

  it('ignores configs that already have hooks, are not ours, or other tools and platforms', () => {
    expect(grokCliHooksMissing({ ...base, managedTargets: 6 })).toBe(false)
    expect(grokCliHooksMissing({ ...base, relayConfigured: false })).toBe(false)
    expect(grokCliHooksMissing({ ...base, provider: 'claude' })).toBe(false)
    expect(grokCliHooksMissing({ ...base, platform: 'darwin' })).toBe(false)
  })

  it('does not treat a cmd shell as missing because hooks are never written there', () => {
    expect(grokCliHooksMissing({ ...base, shell: 'cmd' })).toBe(false)
    expect(grokCliHooksMissing({ ...base, shell: null })).toBe(false)
  })
})

describe('Darwin Codex Desktop integration', () => {
  it('detects the installed desktop independently of missing or manually created Codex configuration files', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-no-config-'))
    temporaryDirectories.push(directory)
    const codexHome = path.join(directory, '.codex')
    const macosCodexAppDetector = vi.fn(async () => ({
      app: { path: '/Applications/Codex.app', version: '26.915.3509', running: false },
      detectionFailed: false, detectionError: null,
    }))
    const service = createService({ platform: 'darwin', providerRoots: { userHome: directory, codexHome }, macosCodexAppDetector })

    expect(service.getConfig(false).providers.codex).toMatchObject({ exists: false, hasApiKey: false })
    await expect(service.inspectCodexDesktop()).resolves.toMatchObject({ installed: true, path: '/Applications/Codex.app', detectionFailed: false })
    expect(fs.existsSync(codexHome)).toBe(false)

    fs.mkdirSync(codexHome)
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '# no account configured\n', 'utf8')
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}\n', 'utf8')
    expect(service.getConfig(false).providers.codex).toMatchObject({ exists: true, hasApiKey: false })
    await expect(service.inspectCodexDesktop()).resolves.toMatchObject({ installed: true, path: '/Applications/Codex.app', detectionFailed: false })
    expect(macosCodexAppDetector).toHaveBeenCalledTimes(2)
  })

  it('reports externally managed updates without claiming an AppX or MSIX version', async () => {
    const { service } = await createDarwinService({
      macosCodexAppDetector: async () => ({ app: null, detectionFailed: false, detectionError: null }),
    })

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

  it('sends a macOS Codex desktop install to the Mac installer, which leaves an app that is already there alone', async () => {
    // 以前 Mac 上这一步直接拒绝（「由 Codex App 管理」）；现在走 Mac 安装器，认得出的那份不重装。
    const { service, execute } = await createDarwinService()
    const target = { isDestroyed: () => false, send: vi.fn() }

    await expect(service.installCodexDesktop(target))
      .resolves.toEqual({ action: 'unchanged', previousVersion: '26.727.51351', installedVersion: '26.727.51351' })
    expect(target.send).toHaveBeenCalledWith('desktop:codex-install-progress', { phase: 'completed', percent: 100, message: 'Codex 桌面端已经装好了，不用重复安装' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects managed uninstall operations with actionable macOS guidance', async () => {
    const { service } = await createDarwinService()

    await expect(service.uninstallCodexDesktop()).rejects.toThrow('由 Codex App 管理')
  })

  it('preserves the XingMang Codex readiness check before opening the desktop app', async () => {
    const { service, resolveCli, execute } = await createDarwinService({ configured: false })

    await expect(service.launchCodexDesktop('open', {
      isDestroyed: () => false,
      send: vi.fn(),
    })).rejects.toThrow('ChatGPT 账号')
    expect(resolveCli).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('lets a ChatGPT official account pass the desktop launch readiness check', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-official-workspace-'))
    temporaryDirectories.push(directory)
    const missingWorkspace = path.join(directory, 'missing')
    const { service, resolveCli, execute } = await createDarwinService({
      workspace: missingWorkspace,
      accountMode: 'official',
    })

    await expect(service.launchCodexDesktop('open', {
      isDestroyed: () => false,
      send: vi.fn(),
    })).rejects.toThrow('工作目录不存在，请重新选择')
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
    expect(release).not.toHaveBeenCalled()
  })

  it('opens the verified Darwin desktop app without CLI, Node, or npm installed', async () => {
    const { service, workspace, codexEnv, resolveCli, execute, findExecutable, release } = await createDarwinService()
    resolveCli.mockRejectedValue(new Error('未检测到 Codex CLI'))
    const target = { isDestroyed: () => false, send: vi.fn() }

    const result = await service.launchCodexDesktop('open', target)

    const workspaceUrl = new URL('codex://threads/new')
    workspaceUrl.searchParams.set('path', workspace)
    expect(execute).toHaveBeenCalledWith({
      executable: '/usr/bin/open',
      argv: ['-a', '/Applications/Codex.app', '--env', `CODEX_HOME=${codexEnv.CODEX_HOME}`, workspaceUrl.href],
    }, expect.objectContaining({ cwd: workspace, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 }))
    expect(resolveCli).not.toHaveBeenCalled()
    expect(findExecutable).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      restarted: false,
      status: {
        installed: true,
        version: '26.727.51351',
        appVersion: '26.727.51351',
        running: true,
        updateCheck: 'skipped',
      },
    })
    expect(target.send).toHaveBeenCalledWith('desktop:codex-status-changed', { phase: 'running', status: result.status })
  })

  it('passes the selected CODEX_HOME through LaunchServices with a sanitized environment', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-codex-env-'))
    temporaryDirectories.push(root)
    const codexHome = path.join(root, 'selected-codex-home')
    const { service, codexEnv, resolveCli, execute } = await createDarwinService({ codexHome })
    codexEnv.NODE_OPTIONS = '--require=/tmp/unwanted-hook.js'
    codexEnv.BROWSER = '/tmp/unwanted-browser'

    await service.launchCodexDesktop('open', {
      isDestroyed: () => false,
      send: vi.fn(),
    })

    expect(resolveCli).not.toHaveBeenCalled()
    expect(execute.mock.calls[0]?.[0].argv).toContain(`CODEX_HOME=${codexHome}`)
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      env: expect.objectContaining({
        HOME: codexEnv.HOME,
        CODEX_HOME: codexHome,
      }),
    })
    expect(execute.mock.calls[0]?.[1]?.env?.NODE_OPTIONS).toBeUndefined()
    expect(execute.mock.calls[0]?.[1]?.env?.BROWSER).toBeUndefined()
  })

  it('propagates LaunchServices failures without running a CLI or reporting a running app', async () => {
    const { service, execute, release } = await createDarwinService()
    execute.mockRejectedValueOnce(new Error('macOS 打开应用失败'))
    const target = { isDestroyed: () => false, send: vi.fn() }

    await expect(service.launchCodexDesktop('open', target)).rejects.toThrow('macOS 打开应用失败')

    expect(release).not.toHaveBeenCalled()
    expect(target.send).not.toHaveBeenCalled()
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

  it('rejects an unbound app name instead of letting LaunchServices select an arbitrary bundle', async () => {
    const fixture = await createDarwinService({
      macosCodexAppDetector: async () => ({ app: { path: 'Codex.app', version: null, running: false }, detectionFailed: false, detectionError: null }),
    })

    await expect(fixture.service.launchCodexDesktop('open', {
      isDestroyed: () => false,
      send: vi.fn(),
    })).rejects.toThrow('路径')
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it.each([false, true])('refuses to open an app when detection cannot provide a verified bundle (failed=%s)', async (failed) => {
    const fixture = await createDarwinService({
      macosCodexAppDetector: async () => ({ app: null, detectionFailed: failed, detectionError: failed ? 'codesign timed out' : null }),
    })
    await expect(fixture.service.launchCodexDesktop('open', { isDestroyed: () => false, send: vi.fn() }))
      .rejects.toThrow(failed ? '检测未完成' : '未检测到 Codex 桌面端')
    expect(fixture.execute).not.toHaveBeenCalled()
    expect(fixture.resolveCli).not.toHaveBeenCalled()
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

// N1 的名单每周都可能往前抬一格,而抬版本的 PR 只该改
// electron/cli-verified-versions.ts。下面两个取值器让这一节的断言跟着名单走。
function recommendedClaudeVersion(): string {
  const recommended = cliVerifiedVersions.claude.recommended
  // Claude Code is the one provider the list has always pinned; if it ever
  // goes back to `null` these two assertions stop testing the pinned-install
  // behaviour entirely, so fail loudly rather than silently assert nothing.
  if (!recommended) throw new Error('cliVerifiedVersions.claude 必须有推荐版本')
  return recommended.version
}

function recommendedCodexVersion(): string {
  const recommended = cliVerifiedVersions.codex.recommended
  // Codex was pinned on 2026-09-21 to escape the 0.155.0 reasoning-summary
  // regression. If it ever goes back to `null` the managed install falls back
  // to the latest endpoint and this fixture's version-URL mock stops matching,
  // so fail loudly rather than mock a request the code no longer makes.
  if (!recommended) throw new Error('cliVerifiedVersions.codex 必须有推荐版本')
  return recommended.version
}

/** 一个必定比推荐版本新的版本号,用来扮演「npm 上有更新版」。 */
function versionAboveRecommended(version: string): string {
  return `${Number.parseInt(version, 10) + 1}.0.0`
}

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

  it.runIf(process.platform === 'linux')('reads the Linux Grok version from the link npm postinstall made', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-version-')))
    temporaryDirectories.push(home)
    const bin = path.join(home, '.grok', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'grok-1.0.44'), 'test-binary', { mode: 0o755 })
    fs.symlinkSync('grok-1.0.44', path.join(bin, 'grok'))
    // A stale file from an earlier official install must not win over the link.
    fs.writeFileSync(path.join(home, '.grok', 'version.json'), '{"version":"0.2.112"}\n', 'utf8')

    await expect(readGrokLocalVersionForExecutable(path.join(bin, 'grok'), {
      platform: 'linux',
      homeDirectory: home,
    })).resolves.toBe('1.0.44')
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

  it('carries the verified-version advice through to the renderer status', () => {
    // 已装的 2.1.276 是历史事实(它落在名单里那条 2.1.275-2.1.277 的不兼容
    // 区间里),推荐版本则每次巡检都会往前走 —— 所以它读名单,不写死。
    // 写死的后果不是断言变弱,是每条抬版本的 PR 都被迫顺手改测试,而改测试
    // 迁就代码正是这份名单最不该出现的事。
    expect(buildCliStatus({
      installed: true,
      version: '2.1.276 (Claude Code)',
      path: 'claude.cmd',
      installDirectory: null,
    }, latest(recommendedClaudeVersion()), buildCliVersionAdvice('claude', '2.1.276 (Claude Code)'))).toMatchObject({
      versionAdvice: {
        recommendedVersion: recommendedClaudeVersion(),
        blockedReason: expect.stringContaining('失败'),
        onRecommended: false,
        rollbackAvailable: true,
      },
    })
  })

  it('does not advertise an update the pinned list would not install', () => {
    const recommended = recommendedClaudeVersion()
    const beyondRecommended = versionAboveRecommended(recommended)
    const installed = {
      installed: true,
      version: `${recommended} (Claude Code)`,
      path: 'claude.cmd',
      installDirectory: null,
    }
    expect(buildCliStatus(installed, latest(beyondRecommended), buildCliVersionAdvice('claude', installed.version))).toMatchObject({
      latestVersion: beyondRecommended,
      updateAvailable: false,
      updateState: 'latest',
    })
    expect(buildCliStatus(installed, latest(beyondRecommended), buildCliVersionAdvice('claude', installed.version, { alwaysLatest: true }))).toMatchObject({
      updateAvailable: true,
      updateState: 'available',
    })
  })

  it('does not advertise a Codex downgrade as an update when npm has an even newer version', () => {
    const recommended = recommendedCodexVersion()
    const current = versionAboveRecommended(recommended)
    const newest = versionAboveRecommended(current)
    const installed = { installed: true, version: current, path: 'codex.cmd', installDirectory: null }

    expect(buildCliStatus(installed, latest(newest), buildCliVersionAdvice('codex', current))).toMatchObject({
      latestVersion: newest, updateAvailable: false, updateState: 'latest', updateError: null,
    })
    expect(buildCliStatus(installed, latest(newest), buildCliVersionAdvice('codex', current, { alwaysLatest: true })))
      .toMatchObject({ latestVersion: newest, updateAvailable: true, updateState: 'available' })
    const older = { ...installed, version: '0.0.0' }
    expect(buildCliStatus(older, latest(newest), buildCliVersionAdvice('codex', older.version)))
      .toMatchObject({ updateAvailable: true, updateState: 'available' })
  })

  it('omits the advice field entirely when no list applies', () => {
    expect(buildCliStatus({
      installed: true,
      version: 'codex-cli 0.146.0',
      path: 'codex.cmd',
      installDirectory: null,
    }, latest('0.146.0'))).not.toHaveProperty('versionAdvice')
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
    expect(grokInstallStrategyFor('linux')).toBe('linux-official-npm')
    expect(grokInstallStrategyFor('freebsd')).toBe('external')
  })

  it('asks npm for the newest Grok only on Linux, where Grok is installed from npm', () => {
    expect(cliLatestVersionSource('grok', 'linux')).toBe('npm')
    expect(cliLatestVersionSource('grok', 'win32')).toBe('official-manifest')
    expect(cliLatestVersionSource('grok', 'darwin')).toBe('official-manifest')
    // Callers that do not say which platform keep the old answer.
    expect(cliLatestVersionSource('grok')).toBe('official-manifest')
    expect(cliLatestVersionSource('codex', 'win32')).toBe('npm')
    expect(cliLatestVersionSource('gemini', 'linux')).toBe('npm')
  })

  it('names where a first install would land, mirroring the choices installCli makes', () => {
    // 未装的工具没有 installDirectory，而错误面板上的「复制路径」恰恰要在那一刻
    // 回答「它会装到哪」。这几条钉住的是这个映射与 installCli 的选路一致。
    expect(cliInstallTargetDirectory('claude', {
      platform: 'win32',
      npmGlobalRoot: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules',
      managedNpmPrefix: null,
      managedNativeRoot: null,
    })).toBe(path.join('C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules', '@anthropic-ai', 'claude-code'))
    // trusted-only 下装的是托管布局，落点根本不在用户的 npm 目录里。
    expect(cliInstallTargetDirectory('claude', {
      platform: 'win32',
      npmGlobalRoot: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules',
      managedNpmPrefix: 'C:\\ProgramData\\XingMangAI\\Cli\\npm',
      managedNativeRoot: null,
    })).toBe(managedCliPackageDirectory('C:\\ProgramData\\XingMangAI\\Cli\\npm', '@anthropic-ai/claude-code', 'win32'))
    // macOS 的托管布局把包放在 lib/node_modules 下，不是 prefix 根下。
    // 分隔符不写死：拼接用的是运行平台的 path，Windows 分片上同一个落点是
    // 反斜杠，这里钉的是「走托管 lib/node_modules，而不是用户的 npm 全局根」。
    const darwinManaged = cliInstallTargetDirectory('gemini', {
      platform: 'darwin',
      npmGlobalRoot: '/usr/local/lib/node_modules',
      managedNpmPrefix: '/Users/alex/Library/Application Support/XingMangAI/Cli/npm',
      managedNativeRoot: null,
    })
    expect(darwinManaged).toBe(managedCliPackageDirectory(
      '/Users/alex/Library/Application Support/XingMangAI/Cli/npm',
      '@google/gemini-cli',
      'darwin',
    ))
    expect(darwinManaged).toContain('lib')
    expect(darwinManaged).not.toContain('usr')
  })

  it('points Windows Grok at its native directory, since npm never writes that install', () => {
    expect(cliInstallTargetDirectory('grok', {
      platform: 'win32',
      npmGlobalRoot: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules',
      managedNpmPrefix: 'C:\\ProgramData\\XingMangAI\\Cli\\npm',
      managedNativeRoot: 'C:\\ProgramData\\XingMangAI\\Cli\\native\\grok',
    })).toBe('C:\\ProgramData\\XingMangAI\\Cli\\native\\grok')
    // Grok 在 macOS 上走官方 npm，且不用托管布局——调用方传的就是 null。
    expect(cliInstallTargetDirectory('grok', {
      platform: 'darwin',
      npmGlobalRoot: '/usr/local/lib/node_modules',
      managedNpmPrefix: null,
      managedNativeRoot: null,
    })).toBe(path.join('/usr/local/lib/node_modules', '@xai-official', 'grok'))
    // Linux 上 npm 的 postinstall 把程序放进 ~/.grok/bin，不在 node_modules 里。
    expect(cliInstallTargetDirectory('grok', {
      platform: 'linux',
      npmGlobalRoot: '/usr/lib/node_modules',
      managedNpmPrefix: null,
      managedNativeRoot: '/home/tester/.grok/bin',
    })).toBe('/home/tester/.grok/bin')
  })

  it('returns null rather than a guessed path when nothing resolves', () => {
    expect(cliInstallTargetDirectory('codex', {
      platform: 'linux',
      npmGlobalRoot: null,
      managedNpmPrefix: null,
      managedNativeRoot: null,
    })).toBeNull()
    expect(cliInstallTargetDirectory('grok', {
      platform: 'win32',
      npmGlobalRoot: 'C:\\npm',
      managedNpmPrefix: 'C:\\ProgramData\\XingMangAI\\Cli\\npm',
      managedNativeRoot: null,
    })).toBeNull()
  })

  it('allows Grok npm maintenance only after Darwin or Linux integrity verification', () => {
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

    // Linux 和 macOS 一样跑 npm ci，同样要先过生命周期脚本的完整性对账（Linux 版拆分 ③）。
    expect(buildCliMaintenancePlan(
      'grok',
      '/home/tester/.local/share/XingMangAI/Runtime/node/bin/npm',
      null,
      '1.0.44',
      true,
      'linux',
    )).toEqual({
      kind: 'npm-install',
      executable: '/home/tester/.local/share/XingMangAI/Runtime/node/bin/npm',
      argv: ['ci', '--omit=dev'],
      windowsPackageManager: 'npm',
    })
    expect(() => buildCliMaintenancePlan(
      'grok',
      '/usr/bin/npm',
      null,
      '1.0.44',
      false,
      'linux',
    )).toThrow('完整性校验')

    expect(() => buildCliMaintenancePlan(
      'grok',
      '/usr/bin/npm',
      null,
      '0.2.118',
      true,
      'freebsd',
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

describe('latest version probe budget when the machine looks offline', () => {
  function hangingProbe(): Promise<LatestVersionProbe> {
    return new Promise<LatestVersionProbe>(() => {})
  }

  function checkedProbe(version: string): LatestVersionProbe {
    return { status: 'checked', version, source: 'npm', checkedAt: '2026-09-22T00:00:00.000Z', error: null }
  }

  it('treats a network location probe with no region and an error as "probably offline"', () => {
    expect(networkProbeSuggestsOffline({ region: 'unknown', error: '无法连接网络位置服务' })).toBe(true)
    expect(networkProbeSuggestsOffline({ region: 'unknown', error: null })).toBe(false)
    expect(networkProbeSuggestsOffline({ region: 'mainland-china', error: null })).toBe(false)
    // 探测拿到了 IP 却没拿到国家代码时 region 也是 unknown，但那台机器分明能上网。
    expect(networkProbeSuggestsOffline({ region: 'outside-mainland-china', error: '备用源失败' })).toBe(false)
  })

  it('marks installed CLIs as unchecked and leaves missing ones skipped', () => {
    expect(buildUncheckedLatestVersion('claude', true, '2026-09-22T00:00:00.000Z')).toEqual({
      status: 'failed',
      version: null,
      source: 'npm',
      checkedAt: '2026-09-22T00:00:00.000Z',
      error: latestVersionUncheckedMessage,
    })
    expect(buildUncheckedLatestVersion('grok', true, '2026-09-22T00:00:00.000Z').source).toBe('official-manifest')
    expect(buildUncheckedLatestVersion('grok', true, '2026-09-22T00:00:00.000Z', 'win32').source).toBe('official-manifest')
    expect(buildUncheckedLatestVersion('grok', true, '2026-09-22T00:00:00.000Z', 'darwin').source).toBe('official-manifest')
    expect(buildUncheckedLatestVersion('grok', true, '2026-09-22T00:00:00.000Z', 'linux').source).toBe('npm')
    expect(buildUncheckedLatestVersion('gemini', false, '2026-09-22T00:00:00.000Z')).toEqual({
      status: 'skipped',
      version: null,
      source: 'npm',
      checkedAt: '2026-09-22T00:00:00.000Z',
      error: null,
    })
  })

  it('waits for every probe when no budget is given', async () => {
    const unchecked = [buildUncheckedLatestVersion('claude', true), buildUncheckedLatestVersion('codex', true)]
    const results = await settleLatestVersionProbes(
      [Promise.resolve(checkedProbe('2.1.277')), Promise.resolve(checkedProbe('0.155.1'))],
      unchecked,
      null,
    )

    expect(results.map((probe) => probe.version)).toEqual(['2.1.277', '0.155.1'])
  })

  it('returns the placeholder for probes that miss the budget and the real result for those that made it', async () => {
    const unchecked = [buildUncheckedLatestVersion('claude', true), buildUncheckedLatestVersion('codex', true)]
    const startedAt = Date.now()

    const results = await settleLatestVersionProbes(
      [Promise.resolve(checkedProbe('2.1.277')), hangingProbe()],
      unchecked,
      40,
    )

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(results[0]).toMatchObject({ status: 'checked', version: '2.1.277' })
    expect(results[1]).toEqual(unchecked[1])
    expect(results[1].error).toBe(latestVersionUncheckedMessage)
  })

  it('does not retry a probe that missed the budget', async () => {
    let started = 0
    const probe = (): Promise<LatestVersionProbe> => {
      started += 1
      return hangingProbe()
    }
    const unchecked = [buildUncheckedLatestVersion('claude', true)]

    await settleLatestVersionProbes([probe()], unchecked, 30)
    await new Promise((resolve) => setTimeout(resolve, 60))

    // 预算到点只是不再等：那个 Promise 留在后台自己走完，这里不重新发起。
    expect(started).toBe(1)
  })

  it('aborts the batch controller when the budget runs out and leaves it alone otherwise', async () => {
    const unchecked = [buildUncheckedLatestVersion('claude', true)]
    const missed = new AbortController()

    await settleLatestVersionProbes([hangingProbe()], unchecked, 30, missed)

    expect(missed.signal.aborted).toBe(true)

    const madeIt = new AbortController()
    await settleLatestVersionProbes([Promise.resolve(checkedProbe('2.1.277'))], unchecked, 1_000, madeIt)
    await new Promise((resolve) => setTimeout(resolve, 60))

    // 整批在预算内回齐时定时器已被清掉，探测那侧不该收到「别再发了」的信号。
    expect(madeIt.signal.aborted).toBe(false)
  })

  it('keeps a rejected probe readable instead of losing the reason', async () => {
    const unchecked = [buildUncheckedLatestVersion('claude', true)]

    const results = await settleLatestVersionProbes(
      [Promise.reject(new Error('npm 官方源 查询失败'))],
      unchecked,
      1_000,
    )

    expect(results[0]).toMatchObject({ status: 'failed', source: 'npm', error: 'npm 官方源 查询失败' })
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

function versionProbeRunner() {
  return vi.fn<typeof productionRunCommand>(async (spec: { executable: string; argv: readonly string[] }) => ({
    executable: spec.executable,
    argv: [...spec.argv],
    exitCode: 0,
    signal: null,
    stdout: '10.9.0\n',
    stderr: '',
    outputBytes: 7,
    durationMs: 1,
  }))
}

describe('checking a single CLI for updates', () => {
  it('looks up where npm is without running npm --version', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-update-npm-'))
    temporaryDirectories.push(userHome)
    const npmPath = path.join(userHome, 'bin', 'npm')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests') }))
    const runCommand = versionProbeRunner()
    const resolveCliInstallation = vi.fn(async () => null)
    const service = createService({
      platform: 'linux',
      providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
      resolveCliInstallation,
      findExecutable: vi.fn(async (command: string) => command === 'npm' ? npmPath : null),
      runCommand,
    })

    const status = await service.inspectCliUpdate('claude', false)

    expect(status.installed).toBe(false)
    expect(resolveCliInstallation).toHaveBeenCalledWith('claude', expect.objectContaining({ npmExecutable: npmPath }))
    expect(runCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ executable: npmPath, argv: ['--version'] }),
      expect.anything(),
    )
  })

  it('still reports the CLI as missing when npm itself cannot be found', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-update-no-npm-'))
    temporaryDirectories.push(userHome)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests') }))
    const runCommand = versionProbeRunner()
    const resolveCliInstallation = vi.fn(async () => null)
    const service = createService({
      platform: 'linux',
      providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
      resolveCliInstallation,
      findExecutable: vi.fn(async () => null),
      runCommand,
    })

    const status = await service.inspectCliUpdate('claude', false)

    expect(status.installed).toBe(false)
    expect(resolveCliInstallation).toHaveBeenCalledWith('claude', expect.objectContaining({ npmExecutable: null }))
    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('installing or uninstalling a CLI', () => {
  it('checks who owns the existing copy without running npm --version', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-install-npm-'))
    temporaryDirectories.push(userHome)
    const npmPath = path.join(userHome, 'bin', 'npm')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests') }))
    const runCommand = versionProbeRunner()
    // 装在 npm 之外的那份 Codex：安装前的归属确认会拦下，不会真的往下装。
    const resolveCliInstallation = vi.fn(async () => ({
      commandPath: '/opt/tools/codex',
      installDirectory: '/opt/tools',
      packageRoot: null,
      npmPrefix: null,
      packageVersion: null,
      source: 'native' as const,
    }))
    const service = createService({
      platform: 'linux',
      providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
      resolveCliInstallation,
      findExecutable: vi.fn(async (command: string) => command === 'npm' ? npmPath : null),
      runCommand,
    })
    const target = { isDestroyed: () => false, send: vi.fn() }

    await expect(service.installCli('codex', target)).rejects.toThrow('不是通过本工具安装的')

    expect(resolveCliInstallation).toHaveBeenCalledWith('codex', expect.objectContaining({ npmExecutable: npmPath }))
    expect(runCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ executable: npmPath, argv: ['--version'] }),
      expect.anything(),
    )
  })

  it('looks up where npm is before uninstalling without running npm --version', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-uninstall-npm-'))
    temporaryDirectories.push(userHome)
    const npmPath = path.join(userHome, 'bin', 'npm')
    const runCommand = versionProbeRunner()
    const resolveCliInstallation = vi.fn(async () => null)
    const service = createService({
      platform: 'linux',
      providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
      resolveCliInstallation,
      findExecutable: vi.fn(async (command: string) => command === 'npm' ? npmPath : null),
      runCommand,
    })

    await expect(service.uninstallCli('codex')).resolves.toEqual({ outcome: 'not-installed', previousVersion: null })

    expect(resolveCliInstallation).toHaveBeenCalledWith('codex', expect.objectContaining({ npmExecutable: npmPath }))
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('still finds nothing to uninstall when npm itself cannot be found', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-uninstall-no-npm-'))
    temporaryDirectories.push(userHome)
    const runCommand = versionProbeRunner()
    const resolveCliInstallation = vi.fn(async () => null)
    const service = createService({
      platform: 'linux',
      providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
      resolveCliInstallation,
      findExecutable: vi.fn(async () => null),
      runCommand,
    })

    await expect(service.uninstallCli('codex')).resolves.toEqual({ outcome: 'not-installed', previousVersion: null })

    expect(resolveCliInstallation).toHaveBeenCalledWith('codex', expect.objectContaining({ npmExecutable: null }))
    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('trusting the workspace the user picked before opening a CLI', () => {
  function launchService(userHome: string, provider: ProviderId, runtimeLog?: SystemServiceOptions['runtimeLog']) {
    return createService({
      platform: 'linux',
      ...(runtimeLog ? { runtimeLog } : {}),
      providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
      inspectProviderConfig: vi.fn(() => ({
        baseUrl: 'https://xm.solov.cc',
        actualBaseUrl: 'https://xm.solov.cc',
        exists: true,
        hasApiKey: true,
        matchesRelay: true,
        apiKey: 'sk-test-key',
        model: 'claude-opus-4-6',
        dataDirectory: path.join(userHome, `.${provider}`),
        dataDirectoryExists: true,
        files: [],
        updatedAt: '2026-09-21T00:00:00.000Z',
      })),
      // 本用例只关心打开之前那一步，所以让 CLI 检测稳定地答「没装」：
      // 打开必然失败，而信任写入在它之前，两件事互不影响。
      resolveCliInstallation: vi.fn(async () => null),
      findExecutable: vi.fn(async () => null),
    })
  }

  it('records the trust before it even looks for the CLI', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-launch-trust-'))
    temporaryDirectories.push(userHome)
    const workspace = path.join(userHome, 'project')
    fs.mkdirSync(workspace)

    await expect(launchService(userHome, 'claude').launchProvider('claude', workspace)).rejects.toThrow()
    await expect(launchService(userHome, 'gemini').launchProvider('gemini', workspace)).rejects.toThrow()

    const claudeConfig = JSON.parse(fs.readFileSync(path.join(userHome, '.claude.json'), 'utf8')) as Record<string, unknown>
    const projects = claudeConfig.projects as Record<string, Record<string, unknown>>
    expect(projects[workspace].hasTrustDialogAccepted).toBe(true)
    expect(claudeConfig.hasCompletedOnboarding).toBe(true)
    const trustedFolders = path.join(userHome, '.gemini', 'trustedFolders.json')
    expect(JSON.parse(fs.readFileSync(trustedFolders, 'utf8'))).toEqual({ [workspace]: 'TRUST_FOLDER' })
  })

  // 这组用例的服务按 linux 平台构造，而判定按平台选路径语义：Windows 主机上的临时目录
  // 是 D:\ 开头，按 posix 看不是绝对路径，会被当成无效工作目录直接跳过。
  it.runIf(process.platform !== 'win32')('logs project settings that override the current account with key names only', async () => {
    const userHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-launch-override-')))
    temporaryDirectories.push(userHome)
    const workspace = path.join(userHome, 'project')
    fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(workspace, '.claude', 'settings.local.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://elsewhere.example', ANTHROPIC_AUTH_TOKEN: 'sk-project-secret' },
    }))
    const log = vi.fn()

    // CLI 检测稳定答「没装」，打开必然失败；检查发生在它之前，日志照样记下。
    await expect(launchService(userHome, 'claude', { log }).launchProvider('claude', workspace)).rejects.toThrow('未检测到 Claude Code')

    const entry = log.mock.calls.find((call) => call[2] === 'workspace.config-override')
    expect(entry?.slice(0, 3)).toEqual(['warn', 'config', 'workspace.config-override'])
    expect(entry?.[4]).toEqual({
      provider: 'claude',
      severity: 'blocking',
      scopes: ['project'],
      files: ['.claude/settings.local.json：ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN'],
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('sk-project-secret')
    expect(JSON.stringify(log.mock.calls)).not.toContain('elsewhere.example')
  })

  it('looks up where npm is without running npm --version', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-launch-npm-'))
    temporaryDirectories.push(userHome)
    const workspace = path.join(userHome, 'project')
    fs.mkdirSync(workspace)
    const npmPath = path.join(userHome, 'bin', 'npm')
    const runCommand = vi.fn<typeof productionRunCommand>(async (spec: { executable: string; argv: readonly string[] }) => ({
      executable: spec.executable,
      argv: [...spec.argv],
      exitCode: 0,
      signal: null,
      stdout: '10.9.0\n',
      stderr: '',
      outputBytes: 7,
      durationMs: 1,
    }))
    const resolveCliInstallation = vi.fn(async () => null)
    const service = createService({
      platform: 'linux',
      providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
      resolveCliInstallation,
      findExecutable: vi.fn(async (command: string) => command === 'npm' ? npmPath : null),
      runCommand,
    })

    await expect(service.launchProvider('claude', workspace)).rejects.toThrow('未检测到 Claude Code')

    expect(resolveCliInstallation).toHaveBeenCalledWith('claude', expect.objectContaining({ npmExecutable: npmPath }))
    expect(runCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ executable: npmPath, argv: ['--version'] }),
      expect.anything(),
    )
  })

  it('opens the tool anyway when the trust file cannot be written', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-launch-trust-broken-'))
    temporaryDirectories.push(userHome)
    const workspace = path.join(userHome, 'project')
    fs.mkdirSync(workspace)
    fs.writeFileSync(path.join(userHome, '.claude.json'), '{"projects":', 'utf8')

    // 损坏的配置只能让 CLI 自己再问一次，不能提前把打开这条路截断：
    // 报出来的仍然是后面那一步的原因，不是配置解析失败。
    await expect(launchService(userHome, 'claude').launchProvider('claude', workspace))
      .rejects.toThrow('未检测到 Claude Code')
    expect(fs.readFileSync(path.join(userHome, '.claude.json'), 'utf8')).toBe('{"projects":')
  })
})

describe('opening a CLI on Linux', () => {
  function linuxLaunchService(userHome: string, launchLinuxTerminal: NonNullable<SystemServiceOptions['launchLinuxTerminal']>, runtimeLog?: SystemServiceOptions['runtimeLog']) {
    return createService({
      platform: 'linux',
      ...(runtimeLog ? { runtimeLog } : {}),
      providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
      inspectProviderConfig: vi.fn(() => ({
        baseUrl: 'https://xm.solov.cc',
        actualBaseUrl: 'https://xm.solov.cc',
        exists: true,
        hasApiKey: true,
        matchesRelay: true,
        apiKey: 'sk-test-key',
        model: 'claude-opus-4-6',
        dataDirectory: path.join(userHome, '.claude'),
        dataDirectoryExists: true,
        files: [],
        updatedAt: '2026-10-02T00:00:00.000Z',
      })),
      resolveCliInstallation: vi.fn(async () => ({
        commandPath: '/opt/xm/npm/bin/claude',
        installDirectory: '/opt/xm/npm/lib/node_modules/@anthropic-ai/claude-code',
        packageRoot: '/opt/xm/npm/lib/node_modules/@anthropic-ai/claude-code',
        npmPrefix: '/opt/xm/npm',
        packageVersion: '2.1.283',
        source: 'npm' as const,
      })),
      resolveCliCommand: vi.fn(async () => ({ executable: '/opt/xm/npm/bin/claude', argv: [] })),
      findExecutable: vi.fn(async () => null),
      probeLoopbackProxy: async () => true,
      launchLinuxTerminal,
    })
  }

  function project(prefix: string): { userHome: string; workspace: string } {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    temporaryDirectories.push(userHome)
    const workspace = path.join(userHome, 'project')
    fs.mkdirSync(workspace)
    return { userHome, workspace }
  }

  it.runIf(process.platform !== 'win32')('hands the resolved tool, the folder and a titled window to the Linux launcher', async () => {
    const { userHome, workspace } = project('xingmang-linux-open-')
    const launchLinuxTerminal = vi.fn<NonNullable<SystemServiceOptions['launchLinuxTerminal']>>(async () => ({
      terminal: { id: 'gnome-terminal', label: 'GNOME 终端', executable: '/usr/bin/gnome-terminal' },
      attempts: [],
    }))
    const log = vi.fn()

    await expect(linuxLaunchService(userHome, launchLinuxTerminal, { log }).launchProvider('claude', workspace)).resolves.toBeDefined()

    expect(launchLinuxTerminal).toHaveBeenCalledTimes(1)
    const plan = launchLinuxTerminal.mock.calls[0]?.[0]
    expect(plan).toMatchObject({ executable: '/opt/xm/npm/bin/claude', workspace, title: 'Claude Code · 星芒AI' })
    expect(plan?.env).toMatchObject({ FORCE_COLOR: '3', NODE_USE_SYSTEM_CA: expect.any(String) })
    expect(log).toHaveBeenCalledWith('info', 'system', 'terminal.opened', expect.stringContaining('GNOME 终端'), expect.objectContaining({ terminal: 'gnome-terminal' }))
  })

  it.runIf(process.platform !== 'win32')('says which tool did not open, and logs the terminals it tried with the home folder hidden', async () => {
    const { userHome, workspace } = project('xingmang-linux-open-fail-')
    const launchLinuxTerminal = vi.fn<NonNullable<SystemServiceOptions['launchLinuxTerminal']>>(async () => {
      throw new LinuxTerminalLaunchError(linuxTerminalFailureMessages.notStarted, [
        { terminal: 'kitty', executable: path.join(userHome, '.local', 'bin', 'kitty'), outcome: 'exited', detail: '1' },
      ])
    })
    const log = vi.fn()

    await expect(linuxLaunchService(userHome, launchLinuxTerminal, { log }).launchProvider('claude', workspace))
      .rejects.toThrow(`未能打开 Claude Code：${linuxTerminalFailureMessages.notStarted}`)

    const entry = log.mock.calls.find((call) => call[2] === 'terminal.failed')
    expect(entry?.slice(0, 3)).toEqual(['warn', 'system', 'terminal.failed'])
    expect(JSON.stringify(entry?.[4])).toContain('kitty')
    expect(JSON.stringify(entry?.[4])).not.toContain(userHome)
  })

  it.runIf(process.platform !== 'win32')('keeps the system error behind an unusable temporary folder in the log only, with the home folder hidden', async () => {
    const { userHome, workspace } = project('xingmang-linux-open-tmp-')
    const reason = `EACCES: permission denied, mkdtemp '${path.join(userHome, '.cache', 'xingmang-terminal-1-')}XXXXXX'`
    const launchLinuxTerminal = vi.fn<NonNullable<SystemServiceOptions['launchLinuxTerminal']>>(async () => {
      throw new LinuxTerminalLaunchError(linuxTerminalFailureMessages.noLauncherDirectory, [], reason)
    })
    const log = vi.fn()

    const failure = linuxLaunchService(userHome, launchLinuxTerminal, { log }).launchProvider('claude', workspace)
    await expect(failure).rejects.toThrow(`未能打开 Claude Code：${linuxTerminalFailureMessages.noLauncherDirectory}`)
    await expect(failure).rejects.not.toThrow('EACCES')

    const entry = log.mock.calls.find((call) => call[2] === 'terminal.failed')
    expect(JSON.stringify(entry?.[4])).toContain('EACCES')
    expect(JSON.stringify(entry?.[4])).not.toContain(userHome)
  })
})

describe('opening a CLI on macOS', () => {
  it.runIf(process.platform !== 'win32')('keeps the reason a tool did not open as the cause, so the log records it', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-open-fail-'))
    temporaryDirectories.push(userHome)
    const workspace = path.join(userHome, 'project')
    fs.mkdirSync(workspace)
    const refused = new CommandRunnerError('命令执行失败（退出码 1）：codesign', {
      code: 'EXIT_NON_ZERO',
      executable: '/usr/bin/codesign',
      argv: ['--verify', '--strict', path.join(userHome, '.local', 'bin', 'claude')],
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'code object is not signed at all',
      outputBytes: 32,
      maxOutputBytes: 1024,
      durationMs: 3,
    })
    const service = createService({
      platform: 'darwin',
      providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
      inspectProviderConfig: vi.fn(() => ({
        baseUrl: 'https://xm.solov.cc',
        actualBaseUrl: 'https://xm.solov.cc',
        exists: true,
        hasApiKey: true,
        matchesRelay: true,
        apiKey: 'sk-test-key',
        model: 'claude-opus-4-6',
        dataDirectory: path.join(userHome, '.claude'),
        dataDirectoryExists: true,
        files: [],
        updatedAt: '2026-10-06T00:00:00.000Z',
      })),
      resolveCliInstallation: vi.fn(async () => ({
        commandPath: path.join(userHome, '.local', 'bin', 'claude'),
        installDirectory: path.join(userHome, '.local', 'share', 'claude'),
        packageRoot: path.join(userHome, '.local', 'share', 'claude'),
        npmPrefix: null,
        packageVersion: '2.1.283',
        source: 'native' as const,
      })),
      resolveCliCommand: vi.fn(async () => { throw refused }),
      findExecutable: vi.fn(async () => null),
    })

    const failure: unknown = await service.launchProvider('claude', workspace).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error && failure.message).toBe('未能打开 Claude Code：命令执行失败（退出码 1）：codesign')
    expect(failure instanceof Error && failure.cause).toBe(refused)
  })
})

describe('opening a CLI on Windows', () => {
  function windowsLaunchService(userHome: string, launchCliPowerShell: NonNullable<SystemServiceOptions['launchCliPowerShell']>, runtimeLog?: SystemServiceOptions['runtimeLog']) {
    return createService({
      platform: 'win32',
      windowsExecutionMode: 'same-user',
      ...(runtimeLog ? { runtimeLog } : {}),
      providerRoots: { userHome, codexHome: path.join(userHome, '.codex') },
      inspectProviderConfig: vi.fn(() => ({
        baseUrl: 'https://xm.solov.cc',
        actualBaseUrl: 'https://xm.solov.cc',
        exists: true,
        hasApiKey: true,
        matchesRelay: true,
        apiKey: 'sk-test-key',
        model: 'claude-opus-4-6',
        dataDirectory: path.join(userHome, '.claude'),
        dataDirectoryExists: true,
        files: [],
        updatedAt: '2026-10-04T00:00:00.000Z',
      })),
      resolveCliInstallation: vi.fn(async () => ({
        commandPath: 'C:\\Program Files\\nodejs\\claude.cmd',
        installDirectory: 'C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code',
        packageRoot: 'C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code',
        npmPrefix: 'C:\\Program Files\\nodejs',
        packageVersion: '2.1.283',
        source: 'npm' as const,
      })),
      resolveCliCommand: vi.fn(async () => ({
        executable: 'C:\\Program Files\\nodejs\\node.exe',
        argv: ['C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
      })),
      findExecutable: vi.fn(async () => null),
      probeLoopbackProxy: async () => true,
      launchCliPowerShell,
    })
  }

  it('says why the tool did not open, and logs what PowerShell reported with the home folder hidden', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-windows-open-fail-'))
    temporaryDirectories.push(userHome)
    const workspace = path.join(userHome, 'project')
    fs.mkdirSync(workspace)
    const cause = `Cannot perform operation because the wildcard path ${path.join(workspace, '作业[1]')} did not resolve to a file.`
    const launchCliPowerShell = vi.fn<NonNullable<SystemServiceOptions['launchCliPowerShell']>>(async () => {
      throw new WindowsCliLaunchError(`Windows 无法启动 PowerShell：${cause}`, {
        stderr: cause,
        message: `Command failed: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [REDACTED]\n${cause}`,
        code: 1,
        signal: null,
        killed: false,
      })
    })
    const log = vi.fn()

    const failure = windowsLaunchService(userHome, launchCliPowerShell, { log }).launchProvider('claude', workspace)
    await expect(failure).rejects.toThrow(`未能打开 Claude Code：Windows 无法启动 PowerShell：${cause}`)
    await expect(failure).rejects.not.toThrow('Command failed')

    expect(launchCliPowerShell).toHaveBeenCalledTimes(1)
    expect(launchCliPowerShell.mock.calls[0]?.[0]).toMatchObject({ workspace, title: 'Claude Code · 星芒AI' })
    const entry = log.mock.calls.find((call) => call[2] === 'terminal.failed')
    expect(entry?.slice(0, 4)).toEqual(['warn', 'system', 'terminal.failed', 'Claude Code 的命令窗口没能打开'])
    expect(entry?.[4]).toMatchObject({ provider: 'claude', code: 1, signal: null, killed: false })
    for (const field of ['stderr', 'message']) {
      expect(entry?.[4][field]).toContain('did not resolve to a file')
      expect(entry?.[4][field]).not.toContain(userHome)
    }
  })
})

describe('scan coalescing', () => {
  function harness() {
    let revision = 0
    let clock = 0
    const runs: { force: boolean; finish: (value: string) => void; fail: (error: Error) => void }[] = []
    const coalescer = createScanCoalescer({
      run: (force) => new Promise<string>((resolve, reject) => { runs.push({ force, finish: resolve, fail: reject }) }),
      revision: () => revision,
      reuseMs: 15_000,
      now: () => clock,
    })
    return { scan: coalescer.scan, recent: coalescer.recent, runs, bump: () => { revision++ }, advance: (ms: number) => { clock += ms } }
  }

  it('lets a later non-forced scan join the one already running instead of probing twice', async () => {
    const h = harness()
    const warmup = h.scan(false)
    const renderer = h.scan(false)
    expect(renderer).toBe(warmup)
    expect(h.runs).toHaveLength(1)
    h.runs[0].finish('snapshot')
    await expect(renderer).resolves.toBe('snapshot')
  })

  it('reuses a scan that finished moments ago, and scans again once it is older than the reuse window', async () => {
    const h = harness()
    const warmup = h.scan(false)
    h.runs[0].finish('warmup')
    await warmup
    h.advance(15_000)
    await expect(h.scan(false)).resolves.toBe('warmup')
    expect(h.runs).toHaveLength(1)
    h.advance(1)
    void h.scan(false)
    expect(h.runs).toHaveLength(2)
  })

  it('never lets a forced rescan reuse anything, and lets later plain reads use the forced result', async () => {
    const h = harness()
    const plain = h.scan(false)
    const forced = h.scan(true)
    expect(forced).not.toBe(plain)
    expect(h.runs.map((run) => run.force)).toEqual([false, true])
    expect(h.scan(false)).toBe(forced)
    h.runs[1].finish('forced')
    h.runs[0].finish('stale plain')
    await Promise.all([plain, forced])
    await expect(h.scan(false)).resolves.toBe('forced')
    await expect(h.scan(true)).not.toBe(forced)
    expect(h.runs).toHaveLength(3)
  })

  it('does not reuse a scan that started before an installation began or finished', async () => {
    const h = harness()
    const beforeInstall = h.scan(false)
    h.bump()
    const whileInstalling = h.scan(false)
    expect(whileInstalling).not.toBe(beforeInstall)
    h.runs[0].finish('before')
    h.runs[1].finish('during')
    await Promise.all([beforeInstall, whileInstalling])
    h.bump()
    void h.scan(false)
    expect(h.runs).toHaveLength(3)
  })

  it('hands out what it already has without ever starting a scan of its own', async () => {
    const h = harness()
    expect(h.recent(60_000)).toBeNull()
    const running = h.scan(false)
    expect(h.recent(60_000)).toBe(running)
    h.runs[0].finish('fresh')
    await running
    h.advance(60_000)
    await expect(h.recent(60_000)).resolves.toBe('fresh')
    h.advance(1)
    expect(h.recent(60_000)).toBeNull()
    h.advance(-1)
    h.bump()
    expect(h.recent(60_000)).toBeNull()
    expect(h.runs).toHaveLength(1)
  })

  it('forgets a failed scan so the next read tries again', async () => {
    const h = harness()
    const failed = h.scan(false)
    h.runs[0].fail(new Error('probe crashed'))
    await expect(failed).rejects.toThrow('probe crashed')
    void h.scan(false)
    expect(h.runs).toHaveLength(2)
  })
})

describe('startup snapshot cache and probe limits', () => {
  function service(directory: string, resolveCliInstallation: SystemServiceOptions['resolveCliInstallation']) {
    return createSystemService(new AppSettingsStore(path.join(directory, 'settings.json'), directory), {
      platform: 'linux',
      findExecutable: async () => null,
      resolveCliInstallation,
      systemSnapshotCacheFile: path.join(directory, 'system-snapshot.json'),
      appVersion: '0.2.9',
    })
  }

  async function waitForFile(filePath: string) {
    for (let attempt = 0; attempt < 200 && !fs.existsSync(filePath); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  it('hands the home page the last scan until this launch finishes one of its own, then never again', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-snapshot-startup-'))
    temporaryDirectories.push(directory)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const first = service(directory, async () => null)
    await expect(first.cachedScan()).resolves.toBeNull()
    await first.scanSystem(false)
    const snapshotFile = path.join(directory, 'system-snapshot.json')
    await waitForFile(snapshotFile)
    const firstSaved = fs.readFileSync(snapshotFile, 'utf8')

    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const second = service(directory, async () => { await blocked; return null })
    const cached = await second.cachedScan()
    expect(cached?.cachedAt).toEqual(expect.any(String))
    expect(cached?.clis.claude.installed).toBe(false)
    expect(cached?.officialChatGpt).toBeUndefined()
    // The cached answer must not stand in for a real scan anywhere else.
    expect(second.recentScan(60_000)).not.toBeNull()
    release()
    const fresh = await second.scanSystem(false)
    expect(fresh.cachedAt).toBeUndefined()
    await expect(second.cachedScan()).resolves.toBeNull()
    // scanSystem 不等快照落盘就返回。落盘是写临时文件再改名，收尾删目录时要是
    // 撞上那个临时文件，macOS 上会报 ENOTEMPTY。等新快照改名到位再结束。
    for (let attempt = 0; attempt < 200 && fs.readFileSync(snapshotFile, 'utf8') === firstSaved; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })

  it('never starts more probe processes at once than the limit', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-probe-limit-'))
    temporaryDirectories.push(directory)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    let active = 0
    let peak = 0
    const probed = service(directory, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active--
      return null
    })
    await probed.scanSystem(false)
    expect(scanProbeConcurrency).toBe(3)
    expect(peak).toBe(scanProbeConcurrency)
  })
})

describe('CC Switch leftovers in the config summary', () => {
  it('flags configurations CC Switch left behind without exposing anything new', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cc-switch-summary-'))
    temporaryDirectories.push(directory)
    const service = createService({ providerRoots: { userHome: directory, codexHome: path.join(directory, '.codex') } })
    fs.mkdirSync(path.join(directory, '.claude'))
    fs.writeFileSync(path.join(directory, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721', ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED' },
    }), 'utf8')
    fs.mkdirSync(path.join(directory, '.gemini'))
    fs.writeFileSync(path.join(directory, '.gemini', '.env'), 'GOOGLE_GEMINI_BASE_URL=https://other.example\nGEMINI_API_KEY=sk-other\n', 'utf8')

    const before = service.getConfig(false).providers
    expect(before.claude.ccSwitchLeftover).toBe('proxy')
    expect(before.gemini).not.toHaveProperty('ccSwitchLeftover')
    expect(before.codex).not.toHaveProperty('ccSwitchLeftover')

    fs.mkdirSync(path.join(directory, '.cc-switch'))
    const after = service.getConfig(false).providers
    expect(after.claude.ccSwitchLeftover).toBe('proxy')
    expect(after.gemini.ccSwitchLeftover).toBe('provider')
    expect(after.codex).not.toHaveProperty('ccSwitchLeftover')
  })
})

describe('telling which Codex builds would read the model catalog', () => {
  const desktopPackage = {
    name: 'OpenAI.Codex',
    version: '26.930.2377.0',
    packageFullName: 'OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0',
    packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0',
    installLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0',
  }

  it('counts a Windows desktop app as absent only when the Appx probe confirmed it', () => {
    expect(codexDesktopCatalogProbeFromPackage({ value: desktopPackage, error: null, source: 'current-user', confirmedAbsent: false }))
      .toEqual({ installed: true, version: '26.930.2377.0' })
    expect(codexDesktopCatalogProbeFromPackage({ value: null, error: null, source: null, confirmedAbsent: true }))
      .toEqual({ installed: false, version: null })
    expect(codexDesktopCatalogProbeFromPackage({ value: null, error: 'Get-AppxPackage 超时', source: null, confirmedAbsent: true }))
      .toEqual({ installed: null, version: null })
    expect(codexDesktopCatalogProbeFromPackage({ value: null, error: null, source: null, confirmedAbsent: false }))
      .toEqual({ installed: null, version: null })
  })

  it('treats an unfinished macOS app scan as unknown rather than absent', () => {
    expect(codexDesktopCatalogProbeFromMacosApp({ app: { path: '/Applications/Codex.app', version: '26.930.11008', running: false }, detectionFailed: false, detectionError: null }))
      .toEqual({ installed: true, version: '26.930.11008' })
    expect(codexDesktopCatalogProbeFromMacosApp({ app: null, detectionFailed: false, detectionError: null }))
      .toEqual({ installed: false, version: null })
    expect(codexDesktopCatalogProbeFromMacosApp({ app: null, detectionFailed: true, detectionError: 'codesign 超时' }))
      .toEqual({ installed: null, version: null })
  })

  it('reuses one probe within its time window and probes again after it or once forgotten', async () => {
    let clock = 1_000
    let runs = 0
    const probe = createCachedProbe(async () => ++runs, 30_000, () => clock)

    expect(await Promise.all([probe.read(), probe.read()])).toEqual([1, 1])
    clock += 29_999
    expect(await probe.read()).toBe(1)
    clock += 1
    expect(await probe.read()).toBe(2)
    probe.forget()
    expect(await probe.read()).toBe(3)
    // 系统时间往回拨了：不能让这一次的结论一直用到时间追回来。
    clock -= 60_000
    expect(await probe.read()).toBe(4)
  })

  it('stops waiting at the deadline but lets the work finish on its own, and never throws', async () => {
    vi.useFakeTimers()
    try {
      let finish!: () => void
      let finished = false
      const work = new Promise<void>((resolve) => { finish = resolve }).then(() => { finished = true })
      let waited = false
      void settleWithin(work, 3_000).then(() => { waited = true })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(waited).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(waited).toBe(true)
      expect(finished).toBe(false)
      finish()
      await work
      expect(finished).toBe(true)

      await expect(settleWithin(Promise.reject(new Error('收回失败')), 3_000)).resolves.toBeUndefined()
      await expect(settleWithin(Promise.resolve('done'), 3_000)).resolves.toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('stops waiting once the signal stops but lets the work finish on its own', async () => {
    let finish!: (value: string) => void
    let finished = false
    const work = new Promise<string>((resolve) => { finish = resolve }).then((value) => {
      finished = true
      return value
    })
    const stop = new AbortController()
    const waiting = unlessStopped(() => work, stop.signal)
    stop.abort()

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(finished).toBe(false)
    finish('done')
    expect(await work).toBe('done')
    expect(finished).toBe(true)

    // 已经停了的不再起；没停的照常交回结果，或原样交回它自己的错。
    const late = vi.fn(async () => 'late')
    await expect(unlessStopped(late, stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(late).not.toHaveBeenCalled()
    await expect(unlessStopped(async () => 'ok', new AbortController().signal)).resolves.toBe('ok')
    await expect(unlessStopped(async () => { throw new Error('探测失败') }, new AbortController().signal)).rejects.toThrow('探测失败')
  })
})

// 第三十四批 A：Mac 上客户自己那份 Node.js 太旧时，本软件自己检测、装工具、开工具都改用代下的
// 那份；客户自己那份够新、或者没有代下的那份时，一切照旧。判断看产品目录里的真文件，路径按 Mac
// 的写法拼，所以 Windows 主机上不跑。
describe.skipIf(process.platform === 'win32')('a Mac whose own Node.js is too old for the tools', () => {
  interface OldNodeMac {
    home: string
    customerBin: string
    managedBin: string
    findExecutable: ReturnType<typeof vi.fn<typeof productionFindExecutable>>
    runCommand: ReturnType<typeof vi.fn<typeof productionRunCommand>>
    placeManagedCopy(version: string): void
  }

  function oldNodeMac(options: { customerNode?: string; managedNode?: string | null } = {}): OldNodeMac {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-mac-old-node-')))
    temporaryDirectories.push(home)
    vi.stubEnv('HOME', home)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    // 客户自己装的那份（比如官网安装包放在 /usr/local/bin 的 Node.js 16）；夹具里不放真文件，
    // `npm root --global` 这类真去跑的命令找不到它就当问不到。
    const customerBin = path.join(home, 'usr-local', 'bin')
    const managedBin = managedNodeRuntimeBinDirectory({ HOME: home }, 'darwin')
    const versions = new Map<string, string>([
      [path.join(customerBin, 'node'), options.customerNode ?? 'v16.20.2'],
      [path.join(customerBin, 'npm'), '8.19.4'],
    ])
    function placeManagedCopy(version: string) {
      fs.mkdirSync(managedBin, { recursive: true })
      fs.writeFileSync(path.join(managedBin, 'node'), 'node', { mode: 0o755 })
      versions.set(path.join(managedBin, 'node'), version)
      versions.set(path.join(managedBin, 'npm'), '10.9.2')
    }
    if (options.managedNode !== null) placeManagedCopy(options.managedNode ?? 'v22.12.0')
    // 同 darwinCommandPathCandidates：additionalPaths 排最前，客户自己的在中间，代下的那份最后。
    const findExecutable = vi.fn<typeof productionFindExecutable>(async (command, findOptions = {}) => {
      for (const directory of [...findOptions.additionalPaths ?? [], customerBin, managedBin]) {
        const candidate = path.join(directory, command)
        if (versions.has(candidate)) return candidate
      }
      return null
    })
    const runCommand = vi.fn<typeof productionRunCommand>(async (spec) => {
      // 装工具的用例只看第一次 `npm install` 用的是哪个 npm、带着什么 PATH，到这里就停。
      if (spec.argv.includes('install')) throw new Error('stopped at the first npm install')
      const stdout = `${versions.get(spec.executable) ?? ''}\n`
      return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: stdout.length, durationMs: 1 }
    })
    return { home, customerBin, managedBin, findExecutable, runCommand, placeManagedCopy }
  }

  function macService(mac: OldNodeMac, options: SystemServiceOptions = {}) {
    return createSystemService(new AppSettingsStore(path.join(mac.home, 'settings.json'), mac.home), {
      platform: 'darwin',
      providerRoots: { userHome: mac.home, codexHome: path.join(mac.home, '.codex') },
      findExecutable: mac.findExecutable,
      runCommand: mac.runCommand,
      resolveCliInstallation: async () => null,
      macosCodexAppDetector: async () => ({ app: null, detectionFailed: false, detectionError: null }),
      ...options,
    })
  }

  const downloaded: NodeRuntimeInstallResult = {
    installed: true,
    action: 'installed',
    method: 'archive',
    source: 'npmmirror',
    version: 'v22.12.0',
    architecture: 'arm64',
    pathRefreshRequired: false,
    systemRestartRequired: false,
  }

  it('reports its own copy on the home page and asks npm for its version with that copy', async () => {
    const mac = oldNodeMac()
    const snapshot = await macService(mac).scanSystem(false)

    expect(snapshot.runtime.node).toMatchObject({
      installed: true,
      version: 'v22.12.0',
      path: path.join(mac.managedBin, 'node'),
      tooOld: false,
      versionStatus: 'supported',
    })
    expect(snapshot.runtime.npm).toMatchObject({ installed: true, version: '10.9.2', path: path.join(mac.managedBin, 'npm') })
    // npm 靠 `#!/usr/bin/env node` 找 node：问它版本时代下的那份也得排在 PATH 最前，不然又落到旧的上面。
    const npmVersion = mac.runCommand.mock.calls.find(([spec]) => spec.executable === path.join(mac.managedBin, 'npm'))
    expect(npmVersion?.[1]?.env?.PATH?.split(path.delimiter)[0]).toBe(mac.managedBin)
  })

  it('leaves everything on the customer\'s own Node.js when it is new enough', async () => {
    const mac = oldNodeMac({ customerNode: 'v22.1.0' })
    const snapshot = await macService(mac).scanSystem(false)

    expect(snapshot.runtime.node).toMatchObject({ path: path.join(mac.customerBin, 'node'), version: 'v22.1.0', versionStatus: 'supported' })
    expect(snapshot.runtime.npm.path).toBe(path.join(mac.customerBin, 'npm'))
    for (const [, findOptions] of mac.findExecutable.mock.calls) expect(findOptions?.additionalPaths).toBeUndefined()
  })

  it('does not download Node.js again once its own copy is ready', async () => {
    const mac = oldNodeMac()
    const installNodeRuntime = vi.fn(async () => downloaded)
    const target = { isDestroyed: () => false, send: vi.fn() }

    await expect(macService(mac, { installNodeRuntime }).installNodeRuntime(target))
      .resolves.toMatchObject({ action: 'unchanged', version: 'v22.12.0' })
    expect(installNodeRuntime).not.toHaveBeenCalled()
  })

  it('switches to the copy it just downloaded without waiting for the next check', async () => {
    const mac = oldNodeMac({ managedNode: null })
    const installNodeRuntime = vi.fn(async () => {
      mac.placeManagedCopy('v22.12.0')
      return downloaded
    })
    const service = macService(mac, { installNodeRuntime })
    const target = { isDestroyed: () => false, send: vi.fn() }

    const before = await service.scanSystem(false)
    expect(before.runtime.node).toMatchObject({ path: path.join(mac.customerBin, 'node'), tooOld: true, versionStatus: 'too-old' })

    await expect(service.installNodeRuntime(target)).resolves.toMatchObject({ action: 'installed' })
    const after = await service.scanSystem(false)
    expect(after.runtime.node).toMatchObject({ path: path.join(mac.managedBin, 'node'), tooOld: false, versionStatus: 'supported' })
    expect(after.runtime.npm.path).toBe(path.join(mac.managedBin, 'npm'))

    // 装工具前那一步再问一次也不会重下。
    await expect(service.installNodeRuntime(target)).resolves.toMatchObject({ action: 'unchanged' })
    expect(installNodeRuntime).toHaveBeenCalledTimes(1)
  })

  it('installs a tool with the npm that came with its own copy, run by that copy', async () => {
    const mac = oldNodeMac()
    const expectedVersion = recommendedCodexVersion()
    const integrity = `sha512-${Buffer.alloc(64, 0x33).toString('base64')}`
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('cloudflare.com/cdn-cgi/trace')) return new Response('ip=203.0.113.8\nloc=US\n', { status: 200 })
      if (url === npmPackageVersionUrl('https://registry.npmjs.org', '@openai/codex', expectedVersion)) {
        return new Response(JSON.stringify({ name: '@openai/codex', version: expectedVersion, dist: { integrity } }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))
    const target = { isDestroyed: () => false, send: vi.fn() }

    await expect(macService(mac).installCli('codex', target)).rejects.toThrow('stopped at the first npm install')

    const npmInstall = mac.runCommand.mock.calls.find(([spec]) => spec.argv.includes('install'))
    expect(npmInstall?.[0].executable).toBe(path.join(mac.managedBin, 'npm'))
    // npm 和工具的安装脚本都靠 `#!/usr/bin/env node` 找 node，跑 npm 的 PATH 得先找到代下的那份。
    expect(npmInstall?.[1]?.env?.PATH?.split(path.delimiter)[0]).toBe(mac.managedBin)
  })

  it('runs a JavaScript tool with its own copy but hands the terminal the customer\'s own PATH', async () => {
    const mac = oldNodeMac()
    const workspace = path.join(mac.home, 'project')
    fs.mkdirSync(workspace)
    // 到解析出要跑的命令为止：真的去开终端要靠 /usr/bin/open，用例里不开。
    const resolveCliCommand = vi.fn<typeof resolveVerifiedToolCommand>(async () => {
      throw new Error('stopped before opening Terminal')
    })
    const service = macService(mac, {
      inspectProviderConfig: vi.fn(() => ({
        baseUrl: 'https://xm.solov.cc',
        actualBaseUrl: 'https://xm.solov.cc',
        exists: true,
        hasApiKey: true,
        matchesRelay: true,
        apiKey: 'sk-test-key',
        model: 'gemini-3-pro-preview',
        dataDirectory: path.join(mac.home, '.gemini'),
        dataDirectoryExists: true,
        files: [],
        updatedAt: '2026-10-06T00:00:00.000Z',
      })),
      resolveCliInstallation: vi.fn(async () => ({
        commandPath: path.join(mac.home, 'Library', 'Application Support', 'XingMangAI', 'Cli', 'npm', 'bin', 'gemini'),
        installDirectory: path.join(mac.home, 'Library', 'Application Support', 'XingMangAI', 'Cli', 'npm', 'lib', 'node_modules', '@google', 'gemini-cli'),
        packageRoot: path.join(mac.home, 'Library', 'Application Support', 'XingMangAI', 'Cli', 'npm', 'lib', 'node_modules', '@google', 'gemini-cli'),
        npmPrefix: path.join(mac.home, 'Library', 'Application Support', 'XingMangAI', 'Cli', 'npm'),
        packageVersion: '0.59.0',
        source: 'npm' as const,
      })),
      resolveCliCommand,
    })

    await expect(service.launchProvider('gemini', workspace)).rejects.toThrow('stopped before opening Terminal')

    expect(resolveCliCommand).toHaveBeenCalledTimes(1)
    const [provider, terminalEnvironment, , launchOptions] = resolveCliCommand.mock.calls[0]
    expect(provider).toBe('gemini')
    expect(launchOptions?.nodeDirectories).toEqual([mac.managedBin])
    // 交给终端的就是这份环境：客户在工具里跑 node，用的还是他自己那份。
    expect(terminalEnvironment?.PATH?.split(path.delimiter)[0]).not.toBe(mac.managedBin)
  })

  it('opens the tool exactly as before when the customer\'s own Node.js is new enough', async () => {
    const mac = oldNodeMac({ customerNode: 'v22.1.0' })
    const workspace = path.join(mac.home, 'project')
    fs.mkdirSync(workspace)
    const resolveCliCommand = vi.fn<typeof resolveVerifiedToolCommand>(async () => {
      throw new Error('stopped before opening Terminal')
    })
    const service = macService(mac, {
      inspectProviderConfig: vi.fn(() => ({
        baseUrl: 'https://xm.solov.cc',
        actualBaseUrl: 'https://xm.solov.cc',
        exists: true,
        hasApiKey: true,
        matchesRelay: true,
        apiKey: 'sk-test-key',
        model: 'gemini-3-pro-preview',
        dataDirectory: path.join(mac.home, '.gemini'),
        dataDirectoryExists: true,
        files: [],
        updatedAt: '2026-10-06T00:00:00.000Z',
      })),
      resolveCliInstallation: vi.fn(async () => ({
        commandPath: path.join(mac.home, '.npm-global', 'bin', 'gemini'),
        installDirectory: path.join(mac.home, '.npm-global', 'lib', 'node_modules', '@google', 'gemini-cli'),
        packageRoot: path.join(mac.home, '.npm-global', 'lib', 'node_modules', '@google', 'gemini-cli'),
        npmPrefix: path.join(mac.home, '.npm-global'),
        packageVersion: '0.59.0',
        source: 'npm' as const,
      })),
      resolveCliCommand,
    })

    await expect(service.launchProvider('gemini', workspace)).rejects.toThrow('stopped before opening Terminal')

    expect(resolveCliCommand.mock.calls[0]?.[3]).toEqual({ darwinStagingRetention: 'retained' })
  })
})
