import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MacosCodexAppInspection } from './macos-codex-app'
import { scanPowerShell, unbalancedBracket } from './powershell-script-scan.test-support'
import { AppSettingsStore } from './app-settings'
import { InstallationQueue } from './installation-queue'
import { CommandRunnerError } from './command-runner'
import { InstallCancelledError, isInstallCancelledError } from './install-cancellation'
import { parseWindowsProcessesJson } from './codex-desktop'
import type { NativeConfigInspection } from './config-files'
import {
  assertCodexDesktopUninstalled,
  buildCodexDesktopDarwinStatus,
  createCodexDesktopService,
  buildCodexDesktopLaunchPlan,
  buildCodexDesktopManifestSources,
  buildCodexDesktopPreviousManifestSources,
  buildCodexDesktopPackageSources,
  buildCodexDesktopCombinedProbeFailure,
  buildCodexDesktopCombinedProbeScript,
  codexDesktopCombinedProbeModules,
  buildCodexDesktopPackageInspectionScript,
  buildCodexDesktopPackageProbeScript,
  buildCodexDesktopProcessProbeScript,
  codexDesktopProcessCheckFailedMessage,
  collectCodexDesktopProcesses,
  buildCodexDesktopWorkspaceLaunchPlan,
  buildCodexDesktopWorkspaceUrl,
  buildCodexDesktopWindowsProbes,
  buildDesktopUpdateStatus,
  canAttemptCodexDesktopFirstInstallFallback,
  describeCodexDesktopLaunchFailure,
  describeCodexDesktopLaunchWait,
  buildCodexDesktopResetScript,
  buildCodexDesktopStartAppProbeScript,
  buildCodexDesktopUninstallScript,
  codexDesktopAppxCommandModules,
  codexDesktopPackageInspectionModules,
  codexDesktopPackageProbeModules,
  codexDesktopProcessProbeModules,
  codexDesktopStartAppProbeModules,
  describeCodexDesktopResetFailure,
  startCodexDesktopLaunchHeartbeat,
  codexDesktopLaunchHeartbeatIntervalMs,
  codexDesktopNotStartedPrefix,
  processExistsFromSignalError,
  buildCodexDesktopSessionProcessProbeScript,
  parseCodexDesktopSessionProcessIds,
  codexDesktopRunningFromProbeOutput,
  buildCodexDesktopStoreInstallCommand,
  describeCodexDesktopDownloadAttempt,
  describeCodexDesktopOfficialDownload,
  describeCodexDesktopStoreNotice,
  describeCodexDesktopStoreFailure,
  codexDesktopStoreExitCode,
  parseCodexDesktopStoreProgress,
  buildCodexDesktopStoreWaitMessage,
  codexDesktopStoreHeartbeatMs,
  shouldTryCodexDesktopStoreUpdate,
  describeCodexDesktopPrimaryMirrorSkip,
  desktopMirrorUpdateAvailable,
  downloadCodexDesktopPackage,
  downloadCodexDesktopPackageFromCandidates,
  downloadCodexDesktopOfficialPackage,
  buildCodexDesktopOfficialPackageSource,
  codexDesktopOfficialDownloadLimitMs,
  codexDesktopSlowDownloadGraceMs,
  estimateCodexDesktopDownloadRemainingMs,
  isCodexDesktopDownloadTooSlow,
  fetchCodexDesktopManifestCandidate,
  fetchCodexDesktopMirrorRelease,
  fetchCodexDesktopPreviousManifestCandidates,
  inspectCodexDesktopPackageFile,
  parseCodexDesktopCombinedProbeJson,
  validateCodexDesktopResourceUrl,
  toCodexDesktopMacInstallFailure,
  type CodexDesktopManifestCandidate,
  type CodexDesktopServiceOptions,
  type CodexDesktopWindowsProbes,
} from './codex-desktop-service'
import { codexDesktopKnownIssueMarker } from './codex-desktop-known-issues'
import { installMacosDesktopApp, MacosDesktopInstallError } from './macos-desktop-app-installer'
import { isMacosDesktopInstallFailure, macosDesktopNameTakenMessage } from './macos-desktop-install-failure'
import { buildPowerShellModuleImportStatement } from './powershell-module-imports'

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
  it('resets only the probed package, passing its name as a PowerShell literal', () => {
    const script = buildCodexDesktopResetScript("OpenAI.Codex_26.917.6896.0_x64__2p2nqsd0c76g0'; Remove-Item C:\\")
    expect(script).toContain("Reset-AppxPackage -Package 'OpenAI.Codex_26.917.6896.0_x64__2p2nqsd0c76g0''; Remove-Item C:\\'")
    expect(script).not.toMatch(/Remove-AppxPackage/)
    const scan = scanPowerShell(script)
    expect(scan.unterminated).toBe(false)
    expect(unbalancedBracket(scan.code)).toBeNull()
    expect(scan.code).not.toContain('Remove-Item')
  })

  it('points a failed reset at the same button in Windows settings, in plain words', () => {
    const generic = describeCodexDesktopResetFailure(new Error('Reset-AppxPackage : The term is not recognized'))
    const slow = describeCodexDesktopResetFailure(Object.assign(new Error('timeout'), { killed: true }))
    for (const message of [generic, slow]) {
      expect(message).toContain('「高级选项」→「重置」')
      expect(message).not.toMatch(/Reset-AppxPackage|PowerShell|AppX|Appx|0x[0-9A-F]{8}/i)
    }
    expect(slow).toContain('两分钟')
  })

  it('gives the three steps a customer can take', () => {
    const generic = describeCodexDesktopLaunchFailure()
    expect(generic.startsWith(codexDesktopNotStartedPrefix)).toBe(true)
    expect(generic).toContain('点「重试」')
    expect(generic).toContain('开始菜单里搜「Codex」')
    expect(generic).toContain('联系客服')
  })

  it('says how long it waited and gives a start-menu check the customer can do alone', () => {
    const noWindow = describeCodexDesktopLaunchFailure({ waitedSeconds: 47, processSeen: true })
    expect(noWindow.startsWith(codexDesktopNotStartedPrefix)).toBe(true)
    expect(noWindow).toContain('等了 47 秒')
    expect(noWindow).toContain('Codex 已经启动，但它的窗口一直没出来')
    expect(noWindow).toContain('开始菜单里搜「Codex」直接点开')
    expect(noWindow).toContain('Codex 这一版自己的问题，不是星芒')
    expect(noWindow).toContain('联系客服')

    const notStarted = describeCodexDesktopLaunchFailure({ waitedSeconds: 45, processSeen: false })
    expect(notStarted).toContain('等了 45 秒，Codex 没有启动起来')
    expect(notStarted).not.toContain('窗口一直没出来')
  })

  // Windows only refuses sandboxed store apps on these accounts; Codex Desktop
  // is a full-trust package and opened on the built-in Administrator test
  // machine. A failure there has the same causes as anywhere else.
  it('never blames the Windows account for a failed launch', () => {
    for (const message of [
      describeCodexDesktopLaunchFailure(),
      describeCodexDesktopLaunchFailure({ waitedSeconds: 45, processSeen: false }),
      describeCodexDesktopLaunchFailure({ waitedSeconds: 45, processSeen: true }, '26.924.2738.0'),
    ]) {
      expect(message).not.toMatch(/Administrator|用户账户控制|普通账户/)
    }
  })

  it('names the known-broken version and points to the command-line Codex instead of the start-menu check', () => {
    const message = describeCodexDesktopLaunchFailure({ waitedSeconds: 51, processSeen: false }, '26.924.2738.0')
    expect(message.startsWith(codexDesktopNotStartedPrefix)).toBe(true)
    expect(message).toContain('等了 51 秒，Codex 没有启动起来')
    expect(message).toContain('你装的这一版（26.924.2738.0）')
    expect(message).toContain(codexDesktopKnownIssueMarker)
    expect(message).toContain('「改用 Codex 命令行版」')
    expect(message).not.toContain('开始菜单里搜「Codex」')
    expect(message).not.toMatch(/wsreset|AppModel|AppX|Appx|UAC|0x[0-9A-F]{8}|SID|Microsoft Store/i)

    const noOutcome = describeCodexDesktopLaunchFailure(undefined, '26.924.2738.0')
    expect(noOutcome).toContain('等了将近一分钟')
    expect(noOutcome).toContain(codexDesktopKnownIssueMarker)

    expect(describeCodexDesktopLaunchFailure({ waitedSeconds: 45, processSeen: false }, null)).not.toContain(codexDesktopKnownIssueMarker)
  })

  it('describes the launch wait in plain words and adds the start-menu hint after twenty seconds', () => {
    expect(describeCodexDesktopLaunchWait('preparing', 5)).toBe('正在准备打开 Codex 桌面端，已经等了 5 秒。')
    expect(describeCodexDesktopLaunchWait('waiting-window', 15)).toBe('正在等 Codex 桌面端的窗口出现，已经等了 15 秒。Codex 第一次打开有时要一分钟。')
    expect(describeCodexDesktopLaunchWait('waiting-window', 20)).toBe('正在等 Codex 桌面端的窗口出现，已经等了 20 秒。Codex 第一次打开有时要一分钟，可以先去开始菜单看看它有没有弹出来。')
    for (const stage of ['preparing', 'waiting-window', 'switching-language'] as const) {
      expect(describeCodexDesktopLaunchWait(stage, 30)).not.toMatch(/PowerShell|AppModel|AppX|进程|PID|调试端口|CDP/i)
    }
  })

  it('says Codex is already open while its interface is switched to Chinese and never sends the customer to the start menu', () => {
    expect(describeCodexDesktopLaunchWait('switching-language', 8)).toBe('Codex 桌面端已经打开，正在把它的界面换成中文，已经等了 8 秒。')
    expect(describeCodexDesktopLaunchWait('switching-language', 25)).toBe('Codex 桌面端已经打开，正在把它的界面换成中文，已经等了 25 秒。')
    for (const elapsed of [5, 20, 45, 90]) {
      const message = describeCodexDesktopLaunchWait('switching-language', elapsed)
      expect(message).not.toContain('开始菜单')
      expect(message).not.toContain('等 Codex 桌面端的窗口出现')
    }
  })

  it('moves the heartbeat to the Chinese-switch sentence once the stage changes', () => {
    vi.useFakeTimers()
    try {
      let clock = 0
      const reports: Array<{ elapsedSeconds: number; message: string }> = []
      const heartbeat = startCodexDesktopLaunchHeartbeat((progress) => reports.push(progress), { now: () => clock })
      heartbeat.setStage('waiting-window')
      clock = 4 * codexDesktopLaunchHeartbeatIntervalMs
      vi.advanceTimersByTime(4 * codexDesktopLaunchHeartbeatIntervalMs)
      heartbeat.setStage('switching-language')
      clock = 5 * codexDesktopLaunchHeartbeatIntervalMs
      vi.advanceTimersByTime(codexDesktopLaunchHeartbeatIntervalMs)
      expect(reports.at(-2)?.message).toBe(describeCodexDesktopLaunchWait('waiting-window', 20))
      expect(reports.at(-1)).toEqual({ elapsedSeconds: 25, message: 'Codex 桌面端已经打开，正在把它的界面换成中文，已经等了 25 秒。' })
      heartbeat.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports elapsed time every interval and stays silent once stopped', () => {
    vi.useFakeTimers()
    try {
      let clock = 0
      const reports: Array<{ elapsedSeconds: number; message: string }> = []
      const heartbeat = startCodexDesktopLaunchHeartbeat((progress) => reports.push(progress), { now: () => clock })
      clock = codexDesktopLaunchHeartbeatIntervalMs
      vi.advanceTimersByTime(codexDesktopLaunchHeartbeatIntervalMs)
      expect(reports).toEqual([{ elapsedSeconds: 5, message: describeCodexDesktopLaunchWait('preparing', 5) }])
      heartbeat.setStage('waiting-window')
      clock = 4 * codexDesktopLaunchHeartbeatIntervalMs
      vi.advanceTimersByTime(codexDesktopLaunchHeartbeatIntervalMs)
      expect(reports[1]).toEqual({ elapsedSeconds: 20, message: describeCodexDesktopLaunchWait('waiting-window', 20) })
      expect(heartbeat.elapsedSeconds()).toBe(20)
      heartbeat.stop()
      clock = 10 * codexDesktopLaunchHeartbeatIntervalMs
      vi.advanceTimersByTime(5 * codexDesktopLaunchHeartbeatIntervalMs)
      expect(reports).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps Windows internals out of every sentence a customer can see', () => {
    for (const processSeen of [true, false]) {
      expect(describeCodexDesktopLaunchFailure({ waitedSeconds: 45, processSeen })).not.toMatch(/wsreset|AppModel|AppX|Appx|UAC|0x[0-9A-F]{8}|SID|Microsoft Store|反馈与诊断/i)
    }
    expect(describeCodexDesktopLaunchFailure()).not.toMatch(/wsreset|AppModel|AppX|Appx|UAC|0x[0-9A-F]{8}|SID|Microsoft Store|反馈与诊断/i)
  })

  it('counts a process that refuses the liveness probe as still running', () => {
    expect(processExistsFromSignalError(Object.assign(new Error('denied'), { code: 'EPERM' }))).toBe(true)
    expect(processExistsFromSignalError(Object.assign(new Error('gone'), { code: 'ESRCH' }))).toBe(false)
    expect(processExistsFromSignalError(null)).toBe(false)
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
  it('allows first install when only another Windows account has a running package', () => {
    const processes = parseWindowsProcessesJson(JSON.stringify({
      ProcessId: 101,
      ParentProcessId: 0,
      Name: 'ChatGPT.exe',
      ExecutablePath: 'C:\\WindowsApps\\OpenAI.Codex_26.715.0.0_x64__id\\ChatGPT.exe',
      OwnerSid: 'S-1-5-21-5678',
      CurrentOwnerSid: 'S-1-5-21-1234',
      SessionId: 2,
      CurrentSessionId: 2,
      PackageFamilyName: 'OpenAI.Codex_id',
    }))
    expect(canAttemptCodexDesktopFirstInstallFallback(null, null, processes, true)).toBe(true)
  })

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

  it('continues a dropped mirror download from where it stopped and keeps the progress going', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-msix-resume-'))
    temporaryDirectories.push(directory)
    const destination = path.join(directory, 'Codex.msix')
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x42)
    const cut = 4 * 1024 * 1024
    const url = 'https://mirror.example.cn/Codex.msix'
    const ranges: Array<string | null> = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range')
      ranges.push(range)
      let sent = false
      const response = range
        ? new Response(new Uint8Array(bytes.subarray(cut)), {
          status: 206,
          headers: {
            'Content-Type': 'application/vnd.ms-appx',
            'Content-Range': `bytes ${cut}-${bytes.byteLength - 1}/${bytes.byteLength}`,
          },
        })
        : new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.error(new TypeError('fetch failed'))
              return
            }
            sent = true
            controller.enqueue(new Uint8Array(bytes.subarray(0, cut)))
          },
        }), {
          headers: {
            'Content-Type': 'application/vnd.ms-appx',
            'Content-Length': String(bytes.byteLength),
            ETag: '"msix"',
          },
        })
      Object.defineProperty(response, 'url', { value: url })
      return response
    })
    const progress: Array<{ percent: number; resuming?: boolean }> = []

    const result = await downloadCodexDesktopPackage(
      {
        label: '测试镜像',
        url,
        expectedContentLength: bytes.byteLength,
        expectedSha256Base64: createHash('sha256').update(bytes).digest('base64'),
      },
      destination,
      ({ percent, resuming }) => progress.push({ percent, resuming }),
      fetchMock,
      undefined,
      { wait: async () => undefined },
    )

    expect(ranges).toEqual([null, `bytes=${cut}-`])
    expect(result.transferred).toBe(bytes.byteLength)
    expect(fs.readFileSync(destination).equals(bytes)).toBe(true)
    expect(progress).toContainEqual({ percent: 40, resuming: true })
    const percents = progress.map((entry) => entry.percent)
    expect(percents.every((value, index) => index === 0 || value >= percents[index - 1])).toBe(true)
    expect(percents.at(-1)).toBe(100)
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

  it('says the store is missing instead of that it failed, on every mirror attempt', () => {
    const primary = { label: '国内镜像', url: 'https://codexapp.agentsmirror.com/latest/win-x64' }
    const fallback = { label: '镜像备用源', url: 'https://codexapp-r2.agentsmirror.com/latest/win-x64' }
    const noStore = { storeFailure: null, storeUnavailable: true }
    expect(describeCodexDesktopDownloadAttempt(primary, 0, null, [], noStore))
      .toBe('这台电脑没有微软商店，直接用国内线路装：正在从国内镜像下载')
    expect(describeCodexDesktopDownloadAttempt(fallback, 1, '国内镜像：SHA-256 不一致', [], noStore))
      .toBe('这台电脑没有微软商店，直接用国内线路装：前一路镜像未通过校验，已改从镜像备用源下载')
    expect(describeCodexDesktopDownloadAttempt(primary, 0, null, [], noStore)).not.toContain('没装上')
  })

  it('names a missing store installer as a missing part, not a store failure', () => {
    const primary = { label: '国内镜像', url: 'https://codexapp.agentsmirror.com/latest/win-x64' }
    expect(describeCodexDesktopDownloadAttempt(primary, 0, null, [], {
      storeFailure: '这台电脑上的微软商店安装组件用不了',
      storeInstallerMissing: true,
    })).toBe('微软商店少一个安装组件，先用国内线路装：正在从国内镜像下载')
    expect(describeCodexDesktopStoreNotice({ storeFailure: null })).toBe('')
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
    expect(script).toContain('ExecutablePath = $candidate.Path')
  })

  it('checks owner SID and session before returning a process for termination', () => {
    const script = buildCodexDesktopProcessProbeScript()
    const scan = scanPowerShell(script)
    expect(scan.unterminated).toBe(false)
    expect(unbalancedBracket(scan.code)).toBeNull()
    expect(script).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
    expect(script).toContain('[System.Diagnostics.Process]::GetCurrentProcess().SessionId')
    expect(script).toContain('Get-CimInstance -ClassName Win32_Process -Filter "SessionId=$currentSessionId')
    expect(script).toContain('Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -OperationTimeoutSec 5')
    expect(script).toContain('$owner.ReturnValue -eq 0')
    expect(script).toContain('$owner.Sid -eq $currentSid')
    expect(script).toContain('$_.SessionId -eq $currentSessionId')
    expect(script).toContain('PackageFamilyName = $packageFamilyName')
  })

  it('keeps status and launch scans quiet when the process check fails', async () => {
    const failingProbe = async (): Promise<string> => { throw new Error('WMI timed out') }
    await expect(collectCodexDesktopProcesses(failingProbe, 'roots', {})).resolves.toEqual([])
    await expect(collectCodexDesktopProcesses(failingProbe, 'all', {})).resolves.toEqual([])
  })

  it('refuses to close anything when the process check fails on a close path', async () => {
    const failingProbe = async (): Promise<string> => { throw new Error('WMI timed out') }
    await expect(collectCodexDesktopProcesses(failingProbe, 'all', { strict: true }))
      .rejects.toThrow(codexDesktopProcessCheckFailedMessage)
    expect(codexDesktopProcessCheckFailedMessage).not.toContain('星芒')
  })

  it('gives the close scan a longer budget than the status scan', async () => {
    const budgets: number[] = []
    const probe = async (_script: string, timeoutMs: number): Promise<string> => {
      budgets.push(timeoutMs)
      return ''
    }
    await collectCodexDesktopProcesses(probe, 'roots', {})
    await collectCodexDesktopProcesses(probe, 'all', { strict: true })
    expect(budgets).toEqual([8_000, 60_000])
  })

  it('limits status scans to the app executables but lets close scans see helpers from the package', () => {
    expect(buildCodexDesktopProcessProbeScript('roots'))
      .toContain(`-Filter "SessionId=$currentSessionId AND (Name='ChatGPT.exe' OR Name='Codex.exe')"`)
    const closeScript = buildCodexDesktopProcessProbeScript('all')
    expect(closeScript).toContain('-Filter "SessionId=$currentSessionId"')
    expect(closeScript).not.toContain("Name='ChatGPT.exe'")
    // Helpers are still admitted only from a Codex WindowsApps package path.
    expect(closeScript).toContain(String.raw`\\WindowsApps\\(?<name>OpenAI\.Codex(?:Beta)?)_`)
  })

  it('finds a launched window by session and package path alone, without the owner check the close paths need', () => {
    const script = buildCodexDesktopSessionProcessProbeScript()
    const scan = scanPowerShell(script)
    expect(scan.unterminated).toBe(false)
    expect(unbalancedBracket(scan.code)).toBeNull()
    expect(script).toContain('Get-CimInstance -ClassName Win32_Process -Filter "SessionId=$currentSessionId"')
    expect(script).toContain('$_.SessionId -eq $currentSessionId')
    expect(script).toContain('$_.CommandLine')
    // Opening never closes anything, so it must not drop a window whose owner
    // WMI cannot confirm, and it must not be limited to today's exe names.
    expect(script).not.toContain('GetOwnerSid')
    expect(script).not.toContain("Name='ChatGPT.exe'")
  })

  it('reduces the launch probe to PIDs of the expected package only', () => {
    const stable = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.715.0.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`
    const beta = String.raw`C:\Program Files\WindowsApps\OpenAI.CodexBeta_26.716.0.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`
    const output = JSON.stringify([
      { ProcessId: 101, ExecutablePath: stable },
      { ProcessId: 102, ExecutablePath: beta },
      { ProcessId: 103, ExecutablePath: String.raw`C:\Tools\ChatGPT.exe` },
      { ProcessId: -1, ExecutablePath: stable },
      { ProcessId: 104 },
    ])
    expect(parseCodexDesktopSessionProcessIds(output, 'OpenAI.Codex_2p2nqsd0c76g0')).toEqual([101])
    expect(parseCodexDesktopSessionProcessIds(output, null)).toEqual([101, 102])
    expect(parseCodexDesktopSessionProcessIds(JSON.stringify({ ProcessId: 101, ExecutablePath: stable }), null)).toEqual([101])
    expect(parseCodexDesktopSessionProcessIds('', null)).toEqual([])
    expect(parseCodexDesktopSessionProcessIds('WARNING: not json', null)).toEqual([])
  })

  it('tells an unreadable exit probe apart from a closed desktop app', () => {
    const stable = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.715.0.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`
    expect(codexDesktopRunningFromProbeOutput(JSON.stringify({ ProcessId: 101, ExecutablePath: stable }))).toBe(true)
    expect(codexDesktopRunningFromProbeOutput(JSON.stringify([{ ProcessId: 103, ExecutablePath: String.raw`C:\Tools\ChatGPT.exe` }]))).toBe(false)
    expect(codexDesktopRunningFromProbeOutput('  \r\n')).toBe(false)
    // 读不懂的输出不能当「已经关了」：那会把正在用的人断掉。
    expect(codexDesktopRunningFromProbeOutput('WARNING: not json')).toBeNull()
  })

  it('keeps the three merged segments byte-identical to the standalone probe scripts', () => {
    const combined = buildCodexDesktopCombinedProbeScript()
    // The real run of this script is the Windows packaging job's PowerShell
    // probe smoke (e2e/windows-powershell-probes-smoke.mjs); here only its text.
    for (const script of [combined, buildCodexDesktopProcessProbeScript('all')]) {
      const scan = scanPowerShell(script)
      expect(scan.unterminated).toBe(false)
      expect(unbalancedBracket(scan.code)).toBeNull()
    }

    expect(combined).toContain("Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex*!App' }")
    expect(combined).toContain('Get-CimInstance -ClassName Win32_Process')
    expect(combined).toContain("Get-AppxPackage -Name 'OpenAI.Codex*' -ErrorAction Stop")
    expect(combined).not.toContain("Get-AppxPackage -AllUsers")
    // 每段各自 try/catch，任一段失败只写自己的 error 字段
    expect(combined).toContain('catch { $startAppsError = $_.Exception.Message }')
    expect(combined).toContain('catch { $processesError = $_.Exception.Message }')
    expect(combined).toContain('catch { $packageError = $_.Exception.Message }')
    // 嵌套一层后默认的 Depth 2 会把包条目压成字符串
    expect(combined).toContain('ConvertTo-Json -Compress -Depth 6')
  })

  it('imports the module of every cmdlet the merged probe calls before the first one runs', () => {
    const combined = buildCodexDesktopCombinedProbeScript()
    // Under trustedCommandEnvironment() a single autoloaded cmdlet costs the
    // whole module analysis (#714), so one module left out is as slow as none.
    const cmdletModules: Record<string, string | null> = {
      'Where-Object': null,
      'ForEach-Object': null,
      'Import-Module': null,
      'Get-ItemProperty': 'Microsoft.PowerShell.Management',
      'Select-Object': 'Microsoft.PowerShell.Utility',
      'ConvertTo-Json': 'Microsoft.PowerShell.Utility',
      'Get-CimInstance': 'CimCmdlets',
      'Invoke-CimMethod': 'CimCmdlets',
      'Get-StartApps': 'StartLayout',
      'Get-AppxPackage': 'Appx',
    }
    const used = [...new Set(combined.match(/\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/g) ?? [])]
    for (const cmdlet of used) {
      expect(Object.keys(cmdletModules), `${cmdlet} needs a module entry`).toContain(cmdlet)
      const module = cmdletModules[cmdlet]
      if (module) expect(codexDesktopCombinedProbeModules).toContain(module)
    }
    const importAt = combined.indexOf(buildPowerShellModuleImportStatement(codexDesktopCombinedProbeModules))
    expect(importAt).toBeGreaterThan(0)
    for (const cmdlet of used.filter((name) => cmdletModules[name])) {
      expect(combined.indexOf(cmdlet)).toBeGreaterThan(importAt)
    }
  })
})

describe('Codex Desktop uninstall verification', () => {
  const packageFullName = 'OpenAI.Codex_26.721.4979.0_x64__abc123'
  const installed = {
    name: 'OpenAI.Codex',
    version: '26.721.4979.0',
    packageFullName,
    packageFamilyName: 'OpenAI.Codex_abc123',
    installLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__abc123',
  }

  it('accepts only a successful current-user absence probe', () => {
    expect(() => assertCodexDesktopUninstalled(packageFullName, {
      value: null, error: null, confirmedAbsent: true,
    })).not.toThrow()
  })

  it('rejects when the same package is still registered', () => {
    expect(() => assertCodexDesktopUninstalled(packageFullName, {
      value: installed, error: null, confirmedAbsent: false,
    })).toThrow('卸载未完成')
  })

  it('does not call a failed probe a confirmed uninstall', () => {
    expect(() => assertCodexDesktopUninstalled(packageFullName, {
      value: null, error: 'AppX probe failed', confirmedAbsent: false,
    })).toThrow('未能确认')
  })

  it('does not call an inconclusive or different package a confirmed uninstall', () => {
    for (const probe of [
      { value: null, error: null, confirmedAbsent: false },
      { value: { ...installed, packageFullName: 'OpenAI.CodexBeta_26.721.4979.0_x64__abc123' }, error: null, confirmedAbsent: false },
    ]) {
      expect(() => assertCodexDesktopUninstalled(packageFullName, probe)).toThrow('未能确认')
    }
  })
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
    OwnerSid: 'S-1-5-21-1234',
    CurrentOwnerSid: 'S-1-5-21-1234',
    SessionId: 2,
    CurrentSessionId: 2,
    PackageFamilyName: 'OpenAI.Codex_abc123',
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
      ownerSid: processEntry.OwnerSid,
      sessionId: processEntry.SessionId,
      packageFamilyName: processEntry.PackageFamilyName,
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

describe('Codex Desktop install on macOS', () => {
  function macInstallFixture(overrides: Partial<CodexDesktopServiceOptions> = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-mac-install-'))
    temporaryDirectories.push(directory)
    const routed: string[] = []
    const downloadFetch = vi.fn<typeof fetch>()
    const executeCommand = vi.fn<CodexDesktopServiceOptions['executeCommand']>(async (spec) => ({
      executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null,
      stdout: spec.executable === '/usr/sbin/sysctl' ? '1\n' : '', stderr: '', outputBytes: 0, durationMs: 1,
    }))
    const installMacosDesktopApp = vi.fn<NonNullable<CodexDesktopServiceOptions['installMacosDesktopApp']>>(async (options) => {
      options.onProgress?.({ phase: 'downloading', message: '正在下载 Codex 桌面端 26.930.31730', percent: 40 })
      options.onProgress?.({ phase: 'checking', message: '正在检查下载下来的安装包是不是完整的官方版', percent: null })
      await options.runProcess({ executable: '/usr/bin/codesign', argv: ['--verify'], timeoutMs: 1_000 })
      options.onProgress?.({ phase: 'installing', message: '正在放进「应用程序」', percent: null })
      return { version: '26.930.31730', path: '/Applications/ChatGPT.app' }
    })
    const service = createCodexDesktopService({
      platform: 'darwin',
      installationQueue: new InstallationQueue(),
      createInstallTemporaryDirectory: async () => { throw new Error('未使用') },
      detectMacosCodexApp: async () => ({ app: null, detectionFailed: false, detectionError: null }),
      executeCommand,
      codexEnv: {},
      store: new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      inspectNativeProviderConfig: vi.fn(() => relayCodexConfig(directory)),
      spawnDetached: async () => { throw new Error('未使用') },
      downloadFetch,
      installMacosDesktopApp,
      withDownloadRoute: async (operation) => {
        routed.push('start')
        try { return await operation() } finally { routed.push('end') }
      },
      userHome: '/Users/tester',
      getuid: () => 501,
      architecture: 'arm64',
      ...overrides,
    })
    const target = { isDestroyed: () => false, send: vi.fn() }
    function progress(): unknown[][] {
      return target.send.mock.calls
        .filter(([channel]) => channel === 'desktop:codex-install-progress')
        .map(([, event]) => [event.phase, event.percent, event.message])
    }
    return { service, target, installMacosDesktopApp, executeCommand, downloadFetch, routed, progress }
  }

  it('installs the official package through the shared Mac installer, inside the download route', async () => {
    const f = macInstallFixture()

    await expect(f.service.installCodexDesktop(f.target))
      .resolves.toEqual({ action: 'installed', previousVersion: null, installedVersion: '26.930.31730' })

    expect(f.routed).toEqual(['start', 'end'])
    expect(f.installMacosDesktopApp).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'codexDesktop', architecture: 'arm64', userHome: '/Users/tester', fetch: f.downloadFetch, signal: expect.any(AbortSignal),
    }))
    expect(f.progress()).toEqual([
      ['downloading', 40, '正在下载 Codex 桌面端 26.930.31730'],
      ['validating', null, '正在检查下载下来的安装包是不是完整的官方版'],
      ['installing', null, '正在放进「应用程序」'],
      ['completed', 100, 'Codex 桌面端 26.930.31730 装好了，在「应用程序」里叫 ChatGPT'],
    ])
    // The installer's own checks run through the same runner, never claiming trustedOnly on darwin.
    expect(f.executeCommand).toHaveBeenCalledWith(
      { executable: '/usr/bin/codesign', argv: ['--verify'] },
      expect.objectContaining({ trustedOnly: false, timeoutMs: 1_000, signal: expect.any(AbortSignal) }),
    )
    for (const [, options] of f.executeCommand.mock.calls) expect(options?.trustedOnly).toBe(false)
  })

  it('installs the Apple silicon package when an Intel build of the toolbox runs under Rosetta', async () => {
    const rosetta = macInstallFixture({ architecture: 'x64' })
    await rosetta.service.installCodexDesktop(rosetta.target)
    expect(rosetta.executeCommand).toHaveBeenCalledWith({ executable: '/usr/sbin/sysctl', argv: ['-n', 'hw.optional.arm64'] }, expect.objectContaining({ trustedOnly: false }))
    expect(rosetta.installMacosDesktopApp).toHaveBeenCalledWith(expect.objectContaining({ architecture: 'arm64' }))

    // Intel Macs report 0, or have no such key and sysctl fails.
    for (const answer of [async () => '0\n', async (): Promise<string> => { throw new Error('unknown oid') }]) {
      const intel = macInstallFixture({
        architecture: 'x64',
        executeCommand: async (spec) => ({
          executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null,
          stdout: spec.executable === '/usr/sbin/sysctl' ? await answer() : '', stderr: '', outputBytes: 0, durationMs: 1,
        }),
      })
      await intel.service.installCodexDesktop(intel.target)
      expect(intel.installMacosDesktopApp).toHaveBeenCalledWith(expect.objectContaining({ architecture: 'x64' }))
    }
  })

  it('leaves an installed desktop app alone', async () => {
    const f = macInstallFixture({
      detectMacosCodexApp: async () => ({
        app: { path: '/Applications/ChatGPT.app', version: '26.930.31730', running: false },
        detectionFailed: false,
        detectionError: null,
      }),
    })
    await expect(f.service.installCodexDesktop(f.target))
      .resolves.toEqual({ action: 'unchanged', previousVersion: '26.930.31730', installedVersion: '26.930.31730' })
    expect(f.installMacosDesktopApp).not.toHaveBeenCalled()
    expect(f.progress()).toEqual([['completed', 100, 'Codex 桌面端已经装好了，不用重复安装']])
  })

  // 点「安装」那一刻检测没做完：照「没装」往下走的话，安装那一步会把「应用程序」里客户自己装好的
  // 正版 ChatGPT 说成「不是官方原版」，叫客户移到废纸篓。
  it('checks once more when the first detection did not finish, and leaves the app it then finds alone', async () => {
    const installed = {
      app: { path: '/Applications/ChatGPT.app', version: '26.930.31730', running: false },
      detectionFailed: false,
      detectionError: null,
    }
    const unfinished = { app: null, detectionFailed: true, detectionError: '核对 ChatGPT.app 的签名超时' }
    const firstAttempts: Array<() => Promise<MacosCodexAppInspection>> = [
      async () => unfinished,
      async () => { throw new Error('plutil 没有起来') },
    ]
    for (const first of firstAttempts) {
      const detectMacosCodexApp = vi.fn<CodexDesktopServiceOptions['detectMacosCodexApp']>()
        .mockImplementationOnce(first)
        .mockResolvedValueOnce(installed)
      const f = macInstallFixture({ detectMacosCodexApp })
      await expect(f.service.installCodexDesktop(f.target))
        .resolves.toEqual({ action: 'unchanged', previousVersion: '26.930.31730', installedVersion: '26.930.31730' })
      expect(detectMacosCodexApp).toHaveBeenCalledTimes(2)
      expect(f.installMacosDesktopApp).not.toHaveBeenCalled()
      expect(f.progress()).toEqual([['completed', 100, 'Codex 桌面端已经装好了，不用重复安装']])
    }
  })

  // 没做完的原因不一定和 ChatGPT.app 有关（Spotlight 查不了、扫应用目录超时）：一律停下会让这类 Mac
  // 再也装不上。
  it('installs as before when the second detection does not finish either', async () => {
    const unfinished = { app: null, detectionFailed: true, detectionError: '应用目录扫描达到时间上限，Codex 检测未能完成' }
    const secondAttempts: Array<() => Promise<MacosCodexAppInspection>> = [
      async () => unfinished,
      async () => { throw new Error('plutil 没有起来') },
    ]
    for (const second of secondAttempts) {
      const detectMacosCodexApp = vi.fn<CodexDesktopServiceOptions['detectMacosCodexApp']>()
        .mockResolvedValueOnce(unfinished)
        .mockImplementationOnce(second)
      const f = macInstallFixture({ detectMacosCodexApp })
      await expect(f.service.installCodexDesktop(f.target))
        .resolves.toEqual({ action: 'installed', previousVersion: null, installedVersion: '26.930.31730' })
      expect(detectMacosCodexApp).toHaveBeenCalledTimes(2)
      expect(f.installMacosDesktopApp).toHaveBeenCalledTimes(1)
    }
  })

  // 两次都没做完、「应用程序」里又是自称正版的 ChatGPT：照「检测未完成」说，不再说它不是官方原版、
  // 叫客户移到废纸篓。安装那一步用真的，只把「应用程序」换成临时目录。
  it.skipIf(process.platform === 'win32')('says the detection did not finish when neither detection could check the ChatGPT already in Applications', async () => {
    const detectionUnfinishedMessage = 'Codex 桌面端检测未完成，请重新检测后再试'
    const unfinished = async (): Promise<MacosCodexAppInspection> => ({ app: null, detectionFailed: true, detectionError: '核对 ChatGPT.app 的签名超时' })
    const broken = async (): Promise<MacosCodexAppInspection> => { throw new Error('plutil 没有起来') }
    const finished = async (): Promise<MacosCodexAppInspection> => ({ app: null, detectionFailed: false, detectionError: null })
    const rejected = async (): Promise<MacosCodexAppInspection> => ({ app: null, detectionFailed: true, detectionError: '命令执行失败（退出码 1）：codesign', rejected: true })
    const cases: Array<[Array<() => Promise<MacosCodexAppInspection>>, string]> = [
      [[unfinished, unfinished], detectionUnfinishedMessage],
      [[broken, broken], detectionUnfinishedMessage],
      // A detection that finished and still did not find it has turned that app down,
      // and so has one that checked it and found it is not the official app.
      [[finished], macosDesktopNameTakenMessage('ChatGPT')],
      [[unfinished, finished], macosDesktopNameTakenMessage('ChatGPT')],
      [[rejected, rejected], macosDesktopNameTakenMessage('ChatGPT')],
    ]
    for (const [attempts, message] of cases) {
      const applications = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-mac-applications-'))
      temporaryDirectories.push(applications)
      fs.mkdirSync(path.join(applications, 'ChatGPT.app', 'Contents'), { recursive: true })
      const detectMacosCodexApp = vi.fn<CodexDesktopServiceOptions['detectMacosCodexApp']>()
      for (const attempt of attempts) detectMacosCodexApp.mockImplementationOnce(attempt)
      const f = macInstallFixture({
        detectMacosCodexApp,
        executeCommand: async (spec) => ({
          executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null,
          stdout: spec.executable === '/usr/bin/plutil' ? 'com.openai.codex\n' : '', stderr: '', outputBytes: 0, durationMs: 1,
        }),
        installMacosDesktopApp: (options) => installMacosDesktopApp({ ...options, systemApplicationsDirectory: applications }),
      })
      const error = await f.service.installCodexDesktop(f.target).then(() => null, (reason: unknown) => reason)
      expect(error).toBeInstanceOf(MacosDesktopInstallError)
      expect((error as Error).message).toBe(message)
      expect(detectMacosCodexApp).toHaveBeenCalledTimes(attempts.length)
      expect(f.downloadFetch).not.toHaveBeenCalled()
      expect(fs.readdirSync(path.join(applications, 'ChatGPT.app'))).toEqual(['Contents'])
      expect(f.progress().at(-1)).toEqual(['error', null, message])
    }
  })

  it('does not detect a second time once the customer has cancelled during the first one', async () => {
    let finishFirst = (): void => {}
    const firstFinished = new Promise<void>((resolve) => { finishFirst = resolve })
    const detectMacosCodexApp = vi.fn<CodexDesktopServiceOptions['detectMacosCodexApp']>(async () => {
      await firstFinished
      return { app: null, detectionFailed: true, detectionError: '核对 ChatGPT.app 的签名超时' }
    })
    const f = macInstallFixture({ detectMacosCodexApp })
    const install = f.service.installCodexDesktop(f.target)
    await vi.waitFor(() => expect(detectMacosCodexApp).toHaveBeenCalledTimes(1))
    expect(f.service.cancelCodexDesktopInstall()).toEqual({ cancelled: true, reason: null })
    finishFirst()
    const error = await install.then(() => null, (reason: unknown) => reason)
    expect(isInstallCancelledError(error)).toBe(true)
    expect(detectMacosCodexApp).toHaveBeenCalledTimes(1)
    expect(f.installMacosDesktopApp).not.toHaveBeenCalled()
    expect(f.progress().at(-1)).toEqual(['error', null, 'Codex 桌面端安装已取消'])
  })

  it('detects only once when the first detection finished and found nothing', async () => {
    const detectMacosCodexApp = vi.fn<CodexDesktopServiceOptions['detectMacosCodexApp']>(async () => ({
      app: null,
      detectionFailed: false,
      detectionError: null,
    }))
    const f = macInstallFixture({ detectMacosCodexApp })
    await expect(f.service.installCodexDesktop(f.target))
      .resolves.toEqual({ action: 'installed', previousVersion: null, installedVersion: '26.930.31730' })
    expect(detectMacosCodexApp).toHaveBeenCalledTimes(1)
  })

  it('will not install for root, whose copy the customer could never update', async () => {
    const f = macInstallFixture({ getuid: () => 0 })
    await expect(f.service.installCodexDesktop(f.target)).rejects.toThrow('请用你平时登录 Mac 的账号重新打开工具箱，再安装 Codex 桌面端。')
    expect(f.installMacosDesktopApp).not.toHaveBeenCalled()
  })

  it('tells root that an app already there is installed instead of refusing', async () => {
    const f = macInstallFixture({
      getuid: () => 0,
      detectMacosCodexApp: async () => ({
        app: { path: '/Applications/ChatGPT.app', version: '26.930.31730', running: false },
        detectionFailed: false,
        detectionError: null,
      }),
    })
    await expect(f.service.installCodexDesktop(f.target))
      .resolves.toEqual({ action: 'unchanged', previousVersion: '26.930.31730', installedVersion: '26.930.31730' })
    expect(f.installMacosDesktopApp).not.toHaveBeenCalled()
  })

  it('passes the Mac wording on as it is, never the Windows one that points at the Microsoft Store', async () => {
    const failure = new MacosDesktopInstallError('Codex 桌面端没下载下来，请检查网络后再点一次「安装」。', 'fetch failed')
    const failing = macInstallFixture({ installMacosDesktopApp: async () => { throw failure } })
    await expect(failing.service.installCodexDesktop(failing.target)).rejects.toBe(failure)
    expect(failing.progress().at(-1)).toEqual(['error', null, failure.message])

    const unexpected = macInstallFixture({ withDownloadRoute: async () => { throw new Error('连接超时') } })
    const error = await unexpected.service.installCodexDesktop(unexpected.target).then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(MacosDesktopInstallError)
    expect((error as MacosDesktopInstallError).message).toBe('Codex 桌面端没装好，请再点一次「安装」。')
    expect((error as MacosDesktopInstallError).detail).toBe('连接超时')
  })

  it('says why a Mac install failed in plain words, keeping the ones already written for customers', () => {
    const disk = new Error('Codex 桌面端安装失败：安装目录所在磁盘空间不足，只剩 300 MB，至少需要 1.0 GB，请先清理磁盘再试')
    expect(toCodexDesktopMacInstallFailure(disk)).toBe(disk)
    const failure = toCodexDesktopMacInstallFailure(new Error('HTTP 503'))
    expect(failure.message).toBe('Codex 桌面端没装好，请再点一次「安装」。')
    expect(isMacosDesktopInstallFailure(failure.message)).toBe(true)
    expect(failure.message).not.toContain('Codex 桌面端没装上')
  })

  it('stops a cancelled install and reports it as cancelled', async () => {
    let release = (): void => {}
    const f = macInstallFixture({
      installMacosDesktopApp: async (options) => {
        await new Promise<void>((resolve) => { release = resolve })
        options.signal?.throwIfAborted()
        return { version: '26.930.31730', path: '/Applications/ChatGPT.app' }
      },
    })
    const install = f.service.installCodexDesktop(f.target)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.service.cancelCodexDesktopInstall()).toEqual({ cancelled: true, reason: null })
    release()
    const error = await install.then(() => null, (reason: unknown) => reason)
    expect(isInstallCancelledError(error)).toBe(true)
    expect(f.progress().at(-1)).toEqual(['error', null, 'Codex 桌面端安装已取消'])
  })

  it('takes an install still waiting in the queue out at once instead of waiting for the one ahead', async () => {
    const queue = new InstallationQueue()
    let release = (): void => {}
    const ahead = queue.enqueue('cli:install:claude', () => new Promise<void>((resolve) => { release = resolve }))
    const f = macInstallFixture({ installationQueue: queue })
    const install = f.service.installCodexDesktop(f.target).then(() => 'installed', (reason: unknown) => reason)
    expect(queue.snapshot().pendingKeys).toEqual(['desktop:codex:install'])

    expect(f.service.cancelCodexDesktopInstall()).toEqual({ cancelled: true, reason: null })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const error = await Promise.race([install, Promise.resolve('still waiting for the install ahead')])
    expect(isInstallCancelledError(error)).toBe(true)
    expect((error as Error).message).toBe('Codex 桌面端安装已取消')
    expect(f.progress()).toEqual([['error', null, 'Codex 桌面端安装已取消']])
    expect(queue.snapshot()).toEqual({ activeKey: 'cli:install:claude', pendingKeys: [] })
    expect(f.installMacosDesktopApp).not.toHaveBeenCalled()
    expect(f.service.cancelCodexDesktopInstall().cancelled).toBe(false)
    release()
    await ahead
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
    expect(describeCodexDesktopStoreFailure(storeError({ exitCode: 0x8a150084 | 0 }))).toBe('商店那边没说原因')
    expect(codexDesktopStoreExitCode(storeError({ exitCode: 0x8a150084 | 0 }))).toBe('0x8a150084')
    expect(describeCodexDesktopStoreFailure(new Error('spawn failed'))).toBe('安装没有完成')
  })

  it('reads the last percentage from Store progress output', () => {
    expect(parseCodexDesktopStoreProgress('  ██████      12%\r  ████████████  48%')).toBe(48)
    expect(parseCodexDesktopStoreProgress('已找到 Codex [9PLM9XGG6VKS]')).toBeNull()
    expect(parseCodexDesktopStoreProgress('999%')).toBeNull()
  })

  it('tells the user how long the Store install has been waiting', () => {
    expect(buildCodexDesktopStoreWaitMessage(0, null)).toBe('正在从微软商店下载安装 Codex 桌面端，要等几分钟，请别关窗口')
    expect(buildCodexDesktopStoreWaitMessage(3 * 60_000 + 5_000, null))
      .toBe('正在从微软商店下载安装 Codex 桌面端，已经等了 3 分 05 秒。商店有时要十来分钟，不用管它，请别关窗口')
    expect(buildCodexDesktopStoreWaitMessage(codexDesktopStoreHeartbeatMs, 42)).toContain('（42%），已经等了 15 秒')
  })

  it('says how much longer the Store gets before switching to the fallback download', () => {
    const timeoutMs = 15 * 60_000
    expect(buildCodexDesktopStoreWaitMessage(12 * 60_000, null, timeoutMs))
      .toBe('还在等微软商店，最多再等 3 分钟；还不行星芒会自动换 OpenAI 官网的离线安装包接着装，请别关窗口')
    expect(buildCodexDesktopStoreWaitMessage(14 * 60_000 + 30_000, 90, timeoutMs)).toContain('（90%），最多再等 1 分钟')
    expect(buildCodexDesktopStoreWaitMessage(timeoutMs + 5_000, null, timeoutMs)).toContain('最多再等 1 分钟')
    expect(buildCodexDesktopStoreWaitMessage(11 * 60_000, null, timeoutMs)).toContain('已经等了 11 分 00 秒')
  })

  it('keeps install jargon out of the Store wait messages', () => {
    const samples = [0, 20_000, 5 * 60_000, 13 * 60_000].flatMap((elapsed) => [
      buildCodexDesktopStoreWaitMessage(elapsed, null),
      buildCodexDesktopStoreWaitMessage(elapsed, 50),
    ])
    for (const message of samples) {
      expect(message).not.toMatch(/winget|msstore|appx|msix|app installer|powershell/i)
    }
  })

  it('tries the Store for an update unless the official feed says nothing newer exists', () => {
    expect(shouldTryCodexDesktopStoreUpdate('26.900.1.0', '26.917.9434.0')).toBe(true)
    expect(shouldTryCodexDesktopStoreUpdate('26.917.9434.0', '26.917.9434.0')).toBe(false)
    expect(shouldTryCodexDesktopStoreUpdate('26.917.9434.0', null)).toBe(true)
  })
})

describe('Codex Desktop official offline package', () => {
  const manifestUrl = 'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json'
  const packageUrl = 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix'

  function officialMetadata(version: string, overrides: Partial<{ name: string; architecture: string; publisher: string; hasSignature: boolean }> = {}) {
    return {
      name: 'OpenAI.Codex',
      version,
      architecture: 'x64',
      publisher: 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B',
      hasSignature: true,
      ...overrides,
    }
  }

  function officialFetch(options: { version?: string; contentType?: string | null; manifestStatus?: number } = {}) {
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x43)
    const requested: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      let response: Response
      if (url === manifestUrl) {
        response = new Response(JSON.stringify({
          schemaVersion: 1,
          buildVersion: options.version ?? '26.930.1.0',
          storeProductId: '9PLM9XGG6VKS',
          packageIdentity: 'OpenAI.Codex',
        }), { status: options.manifestStatus ?? 200, headers: { 'Content-Type': 'application/json' } })
      } else if (url === packageUrl) {
        const headers: Record<string, string> = { 'Content-Length': String(bytes.byteLength) }
        if (options.contentType !== null) headers['Content-Type'] = options.contentType ?? 'application/octet-stream'
        response = new Response(bytes, { headers })
      } else {
        throw new Error(`unexpected request ${url}`)
      }
      Object.defineProperty(response, 'url', { value: url })
      return response
    })
    return { bytes, requested, fetchMock }
  }

  function officialDestination(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-official-msix-'))
    temporaryDirectories.push(directory)
    return path.join(directory, 'ChatGPT-x64.msix')
  }

  it('words the official download step the way the customer was told', () => {
    const storeFailed = { storeFailure: '连不上微软商店' }
    expect(describeCodexDesktopOfficialDownload(storeFailed, '26.930.1.0', { percent: 12 }))
      .toBe('微软商店这次没装上（连不上微软商店），正在从 OpenAI 官网下载 Codex 桌面端 26.930.1.0 的离线安装包（12%）')
    expect(describeCodexDesktopOfficialDownload({ storeFailure: null, storeUnavailable: true }, '26.930.1.0'))
      .toBe('这台电脑没有微软商店，正在从 OpenAI 官网下载 Codex 桌面端 26.930.1.0 的离线安装包（0%）')
    expect(describeCodexDesktopOfficialDownload({
      storeFailure: '这台电脑上的微软商店安装组件用不了',
      storeInstallerMissing: true,
    }, '26.930.1.0', { percent: 40 }))
      .toBe('微软商店少一个安装组件，正在从 OpenAI 官网下载 Codex 桌面端 26.930.1.0 的离线安装包（40%）')
    expect(describeCodexDesktopOfficialDownload(storeFailed, '26.930.1.0', { percent: 40, resuming: true }))
      .toBe('网络断了一下，正在接着从 OpenAI 官网下载 Codex 桌面端 26.930.1.0 的离线安装包（已下 40%）')
    // 接线路、读官网清单那几秒还不知道版本：先把「正在等微软商店」换掉。
    expect(describeCodexDesktopOfficialDownload(storeFailed, null))
      .toBe('微软商店这次没装上（连不上微软商店），正在从 OpenAI 官网下载 Codex 桌面端的离线安装包')
  })

  it('names the failed official package, without the store reason, before every mirror attempt', () => {
    const primary = { label: '国内镜像', url: 'https://codexapp.agentsmirror.com/latest/win-x64' }
    const official = 'OpenAI 官网连接或下载超时'
    expect(describeCodexDesktopDownloadAttempt(primary, 0, null, [], { storeFailure: '连不上微软商店', officialFailure: official }))
      .toBe('微软商店这次没装上，OpenAI 官网的离线安装包也没下成，正在从国内镜像下载')
    expect(describeCodexDesktopDownloadAttempt(primary, 0, null, [], { storeFailure: null, storeUnavailable: true, officialFailure: official }))
      .toBe('这台电脑没有微软商店，OpenAI 官网的离线安装包也没下成，正在从国内镜像下载')
    expect(describeCodexDesktopDownloadAttempt(primary, 0, null, [], {
      storeFailure: '这台电脑上的微软商店安装组件用不了',
      storeInstallerMissing: true,
      officialFailure: official,
    })).toBe('微软商店少一个安装组件，OpenAI 官网的离线安装包也没下成，正在从国内镜像下载')
    expect(describeCodexDesktopStoreNotice({ storeFailure: '连不上微软商店', officialFailure: official })).not.toContain(official)
  })

  it('keeps install jargon out of every official download line', () => {
    const attempts = [
      { storeFailure: '连不上微软商店' },
      { storeFailure: null, storeUnavailable: true },
      { storeFailure: '这台电脑上的微软商店安装组件用不了', storeInstallerMissing: true },
    ]
    for (const attempt of attempts) {
      for (const message of [
        describeCodexDesktopOfficialDownload(attempt, null),
        describeCodexDesktopOfficialDownload(attempt, '26.930.1.0', { percent: 3 }),
        describeCodexDesktopOfficialDownload(attempt, '26.930.1.0', { percent: 3, resuming: true }),
        describeCodexDesktopStoreNotice({ ...attempt, officialFailure: 'OpenAI 官网返回 HTTP 403' }),
      ]) {
        expect(message).not.toMatch(/winget|msstore|appx|msix|app installer|powershell|HTTP \d{3}/i)
      }
    }
  })

  it('downloads the package for this processor from the official site and checks it is the signed OpenAI build', async () => {
    const destination = officialDestination()
    const { bytes, requested, fetchMock } = officialFetch()
    const events: string[] = []
    const inspected: string[] = []

    const result = await downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination,
      installedVersion: null,
      knownVersion: null,
      fetchImplementation: fetchMock,
      onVersion: (version) => events.push(`version ${version}`),
      onProgress: (version, progress) => {
        if (progress.percent === 100) events.push(`downloaded ${version}`)
      },
      onValidating: () => events.push('validating'),
      inspectPackage: async (packagePath) => {
        inspected.push(packagePath)
        return officialMetadata('26.930.1.0')
      },
    })

    expect(requested).toEqual([manifestUrl, packageUrl])
    expect(result).toEqual({
      status: 'downloaded',
      version: '26.930.1.0',
      download: {
        transferred: bytes.byteLength,
        total: bytes.byteLength,
        sha256Base64: createHash('sha256').update(bytes).digest('base64'),
      },
    })
    expect(events).toEqual(['version 26.930.1.0', 'downloaded 26.930.1.0', 'validating'])
    expect(inspected).toEqual([destination])
    expect(fs.readFileSync(destination).equals(bytes)).toBe(true)
    expect(buildCodexDesktopOfficialPackageSource('arm64').url)
      .toBe('https://persistent.oaistatic.com/codex-app-prod/ChatGPT-arm64.msix')
  })

  it('installs the newer build the official package turns out to carry', async () => {
    const { fetchMock } = officialFetch({ version: '26.930.1.0' })

    const result = await downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination: officialDestination(),
      installedVersion: '26.900.1.0',
      knownVersion: null,
      fetchImplementation: fetchMock,
      inspectPackage: async () => officialMetadata('26.931.2.0'),
    })

    expect(result.status === 'downloaded' && result.version).toBe('26.931.2.0')
  })

  it('accepts whatever binary type the official CDN sends but not a web page', async () => {
    for (const contentType of [null, 'application/x-msix', 'application/vnd.ms-appx']) {
      const { fetchMock } = officialFetch({ contentType })
      await expect(downloadCodexDesktopOfficialPackage({
        architecture: 'x64',
        destination: officialDestination(),
        installedVersion: null,
        knownVersion: '26.930.1.0',
        fetchImplementation: fetchMock,
        inspectPackage: async () => officialMetadata('26.930.1.0'),
      })).resolves.toMatchObject({ status: 'downloaded' })
    }

    const destination = officialDestination()
    const page = officialFetch({ contentType: 'text/html; charset=utf-8' })
    await expect(downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination,
      installedVersion: null,
      knownVersion: '26.930.1.0',
      fetchImplementation: page.fetchMock,
      inspectPackage: async () => officialMetadata('26.930.1.0'),
    })).rejects.toThrow('OpenAI 官网返回的不是 MSIX 文件（Content-Type: text/html; charset=utf-8）')
    expect(fs.existsSync(destination)).toBe(false)

    // 国内镜像那一路照旧只认 MSIX 与二进制流。
    const mirror = officialFetch({ contentType: null })
    await expect(downloadCodexDesktopPackage(
      { label: '国内镜像', url: packageUrl },
      officialDestination(),
      () => undefined,
      mirror.fetchMock,
    )).rejects.toThrow('国内镜像返回的不是 MSIX 文件（Content-Type: 缺失）')
  })

  it('skips the download when the official build is not newer than the installed one', async () => {
    const asked = officialFetch({ version: '26.930.1.0' })
    await expect(downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination: officialDestination(),
      installedVersion: '26.930.1.0',
      knownVersion: null,
      fetchImplementation: asked.fetchMock,
    })).resolves.toEqual({ status: 'not-newer', version: '26.930.1.0' })
    expect(asked.requested).toEqual([manifestUrl])

    const known = officialFetch()
    await expect(downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination: officialDestination(),
      installedVersion: '26.931.0.0',
      knownVersion: '26.930.1.0',
      fetchImplementation: known.fetchMock,
    })).resolves.toEqual({ status: 'not-newer', version: '26.930.1.0' })
    expect(known.requested).toEqual([])
  })

  it('uses the version read when the install started instead of asking the official site again', async () => {
    const { requested, fetchMock } = officialFetch()

    await downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination: officialDestination(),
      installedVersion: '26.900.1.0',
      knownVersion: '26.930.1.0',
      fetchImplementation: fetchMock,
      inspectPackage: async () => officialMetadata('26.930.1.0'),
    })

    expect(requested).toEqual([packageUrl])
  })

  it('deletes the download and gives up on this route when the package is not the official build', async () => {
    for (const [metadata, reason] of [
      [officialMetadata('26.930.1.0', { publisher: 'CN=Someone Else' }), '发布者身份不匹配'],
      [officialMetadata('26.930.1.0', { name: 'Contoso.Codex' }), '产品身份不是 OpenAI.Codex'],
      [officialMetadata('26.930.1.0', { hasSignature: false }), '缺少 Appx 签名'],
      [officialMetadata('26.930.1.0', { architecture: 'arm64' }), '架构 arm64 与本机 x64 不匹配'],
      [officialMetadata('26.929.0.0'), '低于更新清单 26.930.1.0'],
    ] as const) {
      const destination = officialDestination()
      const { fetchMock } = officialFetch()
      await expect(downloadCodexDesktopOfficialPackage({
        architecture: 'x64',
        destination,
        installedVersion: null,
        knownVersion: null,
        fetchImplementation: fetchMock,
        inspectPackage: async () => metadata,
      })).rejects.toThrow(reason)
      expect(fs.existsSync(destination)).toBe(false)
    }
  })

  it('says why the route failed when the official version list cannot be read', async () => {
    const { requested, fetchMock } = officialFetch({ manifestStatus: 403 })

    await expect(downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination: officialDestination(),
      installedVersion: null,
      knownVersion: null,
      fetchImplementation: fetchMock,
    })).rejects.toThrow('OpenAI 官网版本清单读取失败：返回 HTTP 403')
    expect(requested).toEqual([manifestUrl])
  })

  it('reports a cancellation as a cancellation and asks nothing more', async () => {
    const controller = new AbortController()
    controller.abort(new InstallCancelledError())
    const { requested, fetchMock } = officialFetch()

    const error = await downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination: officialDestination(),
      installedVersion: null,
      knownVersion: null,
      fetchImplementation: fetchMock,
      signal: controller.signal,
    }).catch((cause: unknown) => cause)

    expect(isInstallCancelledError(error)).toBe(true)
    expect(requested).toEqual([])
  })

  /**
   * 每读一块就把假时钟往前拨 secondsPerChunk 秒：下载「花了多久」全由它说了算，
   * 测试本身不用真等。cancelled 记下连接有没有被掐断（没掐断的话连接会一直挂着）。
   */
  function trickleFetch(secondsPerChunk: number, options: { chunks?: number; onChunk?: (sent: number) => void } = {}) {
    const chunks = options.chunks ?? 10
    const chunkBytes = 1024 * 1024
    const clock = { now: 0 }
    const stream = { sent: 0, cancelled: false }
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      // highWaterMark 0: a chunk "arrives" only when the download asks for it, so the
      // fake clock reads exactly the time the chunks handed out so far took.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (stream.sent >= chunks) {
            controller.close()
            return
          }
          stream.sent += 1
          clock.now += secondsPerChunk * 1000
          controller.enqueue(new Uint8Array(chunkBytes).fill(0x43))
          options.onChunk?.(stream.sent)
        },
        cancel() {
          stream.cancelled = true
        },
      }, { highWaterMark: 0 })
      const response = new Response(body, {
        headers: { 'Content-Length': String(chunks * chunkBytes), 'Content-Type': 'application/octet-stream' },
      })
      Object.defineProperty(response, 'url', { value: url })
      return response
    })
    return { fetchMock, clock, stream, now: () => clock.now }
  }

  it('estimates how much longer a download takes at its average speed so far', () => {
    const megabytes = 1024 * 1024
    // 一分钟下了 30 MB，剩下 270 MB 还要九分钟。
    expect(estimateCodexDesktopDownloadRemainingMs(60_000, 30 * megabytes, 300 * megabytes)).toBe(9 * 60_000)
    expect(estimateCodexDesktopDownloadRemainingMs(60_000, 300 * megabytes, 300 * megabytes)).toBe(0)
    expect(estimateCodexDesktopDownloadRemainingMs(60_000, 0, 300 * megabytes)).toBeNull()
  })

  it('gives up on a download only after half a minute and only when ten more minutes are still ahead', () => {
    const megabytes = 1024 * 1024
    const limit = codexDesktopOfficialDownloadLimitMs
    expect(limit).toBe(10 * 60_000)
    // 前半分钟速度还没稳，再慢也不判。
    expect(isCodexDesktopDownloadTooSlow(codexDesktopSlowDownloadGraceMs - 1, 1, 300 * megabytes, limit)).toBe(false)
    // 半分钟下了 15 MB：剩下 285 MB 要 9.5 分钟，接着下。
    expect(isCodexDesktopDownloadTooSlow(30_000, 15 * megabytes, 300 * megabytes, limit)).toBe(false)
    // 半分钟只下了 12 MB：还要 12 分钟，换下一路。
    expect(isCodexDesktopDownloadTooSlow(30_000, 12 * megabytes, 300 * megabytes, limit)).toBe(true)
    // 半分钟一个字节都没收到。
    expect(isCodexDesktopDownloadTooSlow(30_000, 0, 300 * megabytes, limit)).toBe(true)
    // 前面慢过、已经下了二十分钟，但只差最后一点：不扔掉重下。
    expect(isCodexDesktopDownloadTooSlow(20 * 60_000, 299 * megabytes, 300 * megabytes, limit)).toBe(false)
  })

  it('drops the official download as too slow, not as cancelled, once ten more minutes are ahead', async () => {
    const destination = officialDestination()
    // 两分钟才 1 MB：第一块到时已过了半分钟的观察期，剩下 9 MB 照这个速度还要 18 分钟，
    // 超过 10 分钟，第一块之后就停下。
    const slow = trickleFetch(120)

    const error = await downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination,
      installedVersion: null,
      knownVersion: '26.930.1.0',
      fetchImplementation: slow.fetchMock,
      inspectPackage: async () => officialMetadata('26.930.1.0'),
      resumeOptions: { now: slow.now },
    }).catch((cause: unknown) => cause)

    expect(isInstallCancelledError(error)).toBe(false)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('OpenAI 官网下载太慢：照目前的速度还要 18 分钟才下得完')
    // 顶多多向服务器要了一块，没写进文件。
    expect(slow.stream.sent).toBeLessThanOrEqual(2)
    expect(slow.stream.cancelled).toBe(true)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('lets a slow official download finish when what is left is short', async () => {
    // 十秒一块（每分钟 6 MB）：半分钟时还剩 7 MB、七十秒，不换。
    const steady = trickleFetch(10)

    await expect(downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination: officialDestination(),
      installedVersion: null,
      knownVersion: '26.930.1.0',
      fetchImplementation: steady.fetchMock,
      inspectPackage: async () => officialMetadata('26.930.1.0'),
      resumeOptions: { now: steady.now },
    })).resolves.toMatchObject({ status: 'downloaded', version: '26.930.1.0' })
    expect(steady.stream.sent).toBe(10)
  })

  it('never drops the domestic mirror for being slow: it is the last route', async () => {
    const slow = trickleFetch(120)

    await expect(downloadCodexDesktopPackage(
      { label: '国内镜像', url: packageUrl },
      officialDestination(),
      () => undefined,
      slow.fetchMock,
      undefined,
      { now: slow.now },
    )).resolves.toMatchObject({ transferred: 10 * 1024 * 1024 })
  })

  it('still reports the customer pressing cancel mid-download as a cancellation', async () => {
    const controller = new AbortController()
    const destination = officialDestination()
    const download = trickleFetch(10, { onChunk: (sent) => { if (sent === 2) controller.abort(new InstallCancelledError()) } })

    const error = await downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination,
      installedVersion: null,
      knownVersion: '26.930.1.0',
      fetchImplementation: download.fetchMock,
      signal: controller.signal,
      inspectPackage: async () => officialMetadata('26.930.1.0'),
      resumeOptions: { now: download.now },
    }).catch((cause: unknown) => cause)

    expect(isInstallCancelledError(error)).toBe(true)
    expect(download.stream.cancelled).toBe(true)
    expect(fs.existsSync(destination)).toBe(false)
  })
})

describe('Codex Desktop PowerShell scripts import their modules', () => {
  // Under trustedCommandEnvironment() one cmdlet left to autoloading costs the
  // whole module analysis, about 22 s against an 8 s limit for most of these
  // (#714, #716). So every cmdlet must belong to a module imported by name
  // before it runs. Core cmdlets are always loaded and need no import.
  const cmdletModules: Record<string, string | null> = {
    'Where-Object': null,
    'ForEach-Object': null,
    'Import-Module': null,
    'Select-Object': 'Microsoft.PowerShell.Utility',
    'ConvertTo-Json': 'Microsoft.PowerShell.Utility',
    'Add-Type': 'Microsoft.PowerShell.Utility',
    'Get-ItemProperty': 'Microsoft.PowerShell.Management',
    'Get-CimInstance': 'CimCmdlets',
    'Invoke-CimMethod': 'CimCmdlets',
    'Get-StartApps': 'StartLayout',
    'Get-AppxPackage': 'Appx',
    'Remove-AppxPackage': 'Appx',
    'Reset-AppxPackage': 'Appx',
  }
  const packageFullName = 'OpenAI.Codex_26.715.0.0_x64__2p2nqsd0c76g0'
  const scripts: Array<[string, string, readonly string[]]> = [
    ['merged scan probe', buildCodexDesktopCombinedProbeScript(), codexDesktopCombinedProbeModules],
    ['start menu probe', buildCodexDesktopStartAppProbeScript(), codexDesktopStartAppProbeModules],
    ['scan process probe', buildCodexDesktopProcessProbeScript('roots'), codexDesktopProcessProbeModules],
    ['close process probe', buildCodexDesktopProcessProbeScript('all', new Set([101, 102])), codexDesktopProcessProbeModules],
    ['session process probe', buildCodexDesktopSessionProcessProbeScript(), codexDesktopProcessProbeModules],
    ['package probe', buildCodexDesktopPackageProbeScript(), codexDesktopPackageProbeModules],
    ['package file inspection', buildCodexDesktopPackageInspectionScript('C:\\Temp\\codex.msix'), codexDesktopPackageInspectionModules],
    ['uninstall', buildCodexDesktopUninstallScript(packageFullName), codexDesktopAppxCommandModules],
    ['reset', buildCodexDesktopResetScript(packageFullName), codexDesktopAppxCommandModules],
  ]

  function importStatement(modules: readonly string[]): string {
    return buildPowerShellModuleImportStatement(modules)
  }

  /** Cmdlets that would still be autoloaded: unknown, unimported, or used before the import. */
  function unimportedCmdlets(script: string, modules: readonly string[]): string[] {
    const importAt = script.indexOf(importStatement(modules))
    const used = [...new Set(script.match(/\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/g) ?? [])]
    return used.filter((cmdlet) => {
      if (!(cmdlet in cmdletModules)) return true
      const module = cmdletModules[cmdlet]
      if (!module) return false
      return importAt < 0 || !modules.includes(module) || script.indexOf(cmdlet) < importAt
    })
  }

  it.each(scripts)('imports the module of every cmdlet the %s calls before the first one runs', (_name, script, modules) => {
    expect(unimportedCmdlets(script, modules)).toEqual([])
    expect(script.indexOf(importStatement(modules))).toBeGreaterThan(0)
  })

  it.each(scripts)('notices when the %s loses any one of its imports', (_name, script, modules) => {
    // Utility is imported whatever the list says, so it cannot be lost.
    for (const module of modules.filter((name) => name !== 'Microsoft.PowerShell.Utility')) {
      const remaining = modules.filter((name) => name !== module)
      const weakened = script.replace(importStatement(modules), importStatement(remaining))
      expect(weakened).not.toBe(script)
      expect(unimportedCmdlets(weakened, remaining), `${module} dropped`).not.toEqual([])
    }
  })

  it('imports nothing a script does not call', () => {
    for (const [name, script, modules] of scripts) {
      const needed = new Set(Object.entries(cmdletModules)
        .filter(([cmdlet, module]) => module && script.includes(cmdlet))
        .map(([, module]) => module))
      expect([...modules].sort(), name).toEqual([...needed].sort())
    }
  })
})
