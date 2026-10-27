// 一键检测里「运行环境与工具」那几项（#1070 第 9 步，从 diagnostics.ts 的 runDiagnostics 原样搬来）：Node.js、它自带的
// 安装组件、Python、Git 装没装、是哪一版，各家命令行工具和 Codex 桌面端装没装，各家工具的连接设置是不是连到当前账号
// （导出的报告里另写工具配置走的是哪条线路）；以及一个命令行工具都没装时 Node.js 那两项降成「需留意」。
//
// 各类检查共用的那份在 diagnostics-context.ts；这里只 import diagnostics.ts 的类型，免得两个文件互相 require。
import { activeProviderIds, cliCatalog, type ProviderId } from './catalog'
import type { ProviderConfigRoots } from './codex-home'
import { runCommand, trustedCommandEnvironment } from './command-runner'
import { inspectCodexDaemonAutoStart, type CodexDaemonAutoStart, type NativeConfigInspection } from './config-files'
import type { CheckDefinition, CheckOutcome, DiagnosticItem, DiagnosticToolStatus } from './diagnostics'
import { relayLineNames, scannedCodexDesktopStatus, type DiagnosticsContext } from './diagnostics-context'
import { pathForDisplay, pathOrIdentifierForDisplay, safeUrlForDisplay } from './diagnostics-redaction'
import { gitMissingImpact, gitMissingNotice } from './git-runtime'
import { commandLineToolsShimNotice, xcodeLicensePendingNotice } from './macos-command-line-tools'
import { buildPowerShellModuleImportStatement } from './powershell-module-imports'
import { relayProviderBaseUrlEquals, relaySiteEndpointChoices, resolveRelaySite, type RelayEndpointId } from './relay-sites'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const runtimeCheckTitles: Readonly<Record<'node' | 'npm' | 'python', string>> = {
  node: 'Node.js',
  // npm 是 Node.js 自带的，客户不需要认识这个名字。
  npm: 'Node.js 自带的安装组件',
  python: 'Python',
}

/**
 * 检查页「Codex 桌面端」那一项单独跑时的脚本。跑在 trustedCommandEnvironment() 下，
 * 有一条命令要 PowerShell 自己去找模块就得把系统模块整个扫一遍（CI 上 20 多秒），
 * 远超这一项的 6 秒，检查页就报「读不到」；所以开头先按名字导入用到的模块。
 */
export const diagnosticsCodexDesktopProbeModules = [
  'Microsoft.PowerShell.Utility',
  'Appx',
  'Microsoft.PowerShell.Management',
  'StartLayout',
] as const

export const diagnosticsCodexDesktopProbeTimeoutMs = 6_000

export function buildDiagnosticsCodexDesktopProbeScript(): string {
  return [
    buildPowerShellModuleImportStatement(diagnosticsCodexDesktopProbeModules),
    '$app=@(Get-StartApps | Where-Object { $_.AppID -like "OpenAI.Codex*!App" } | Select-Object -First 1 Name,AppID)',
    // AppX registration is per user. Do not fall back to Get-AppxPackage
    // -AllUsers: a normal account is commonly denied that query, and an
    // elevated manager could otherwise report another user's package as
    // launchable from the current profile.
    'if ($app.Count -eq 0) { $pkg=@(Get-AppxPackage -Name "OpenAI.Codex*" | Sort-Object Name | Select-Object -First 1 PackageFamilyName,Version); if ($pkg.Count -gt 0) { $app=@([pscustomobject]@{Name="Codex Desktop $($pkg[0].Version)";AppID="$($pkg[0].PackageFamilyName)!App"}) } }',
    '$running=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "Codex*" }).Count -gt 0',
    '[pscustomobject]@{Name=$app.Name;AppID=$app.AppID;Running=$running}|ConvertTo-Json -Compress',
  ].join(';')
}

async function defaultInspectCodexDesktop(signal: AbortSignal): Promise<DiagnosticToolStatus> {
  if (process.platform !== 'win32') return { installed: false, version: null, path: null, running: false }
  const script = buildDiagnosticsCodexDesktopProbeScript()
  const result = await runCommand({
    executable: resolveWindowsPowerShellExecutable(),
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
  }, {
    env: trustedCommandEnvironment(),
    trustedOnly: true,
    timeoutMs: diagnosticsCodexDesktopProbeTimeoutMs,
    maxOutputBytes: 64 * 1024,
    signal,
  })
  const parsed = JSON.parse(result.stdout) as { Name?: unknown; AppID?: unknown; Running?: unknown }
  const appId = typeof parsed.AppID === 'string' ? parsed.AppID : null
  return {
    installed: Boolean(appId),
    version: typeof parsed.Name === 'string' ? parsed.Name : null,
    path: appId,
    running: parsed.Running === true,
  }
}

/** 工具配置这会儿该用的那条线路，和那条线路上这个工具的地址。 */
interface ProviderRelayLine {
  siteId: string
  line: RelayEndpointId
  baseUrl: string
}

// 只认每条线路自己的地址：写着旧地址（别名）的配置说不上走的是哪条，下次保存会改成线路自己的地址。
function providerRouteLine(siteId: string, provider: ProviderId, actual: string): RelayEndpointId | null {
  const endpoint = relaySiteEndpointChoices(siteId)
    .find((choice) => relayProviderBaseUrlEquals(actual, resolveRelaySite(siteId, choice.id).providerBaseUrls[provider]))
  return endpoint?.id ?? null
}

// 「Codex 连接设置」导出报告里的一行：换线路后旧对话还走原来的地址时，客服先看它（xm 三线路 C16）。
// 客户自己设成开的也是一种选择，检查页详情不列这个键，不提醒。
const codexDaemonAutoStartNames: Readonly<Record<CodexDaemonAutoStart, string>> = {
  on: '开',
  off: '关',
  default: '没写（0.157 起缺省开）',
}

function providerOutcome(provider: ProviderId, inspection: NativeConfigInspection, roots: ProviderConfigRoots, current?: ProviderRelayLine): CheckOutcome {
  const details: Record<string, boolean | number | string | null> = {
    exists: inspection.exists,
    hasApiKey: inspection.hasApiKey,
    matchesRelay: inspection.matchesRelay,
    model: inspection.model || null,
    baseUrl: safeUrlForDisplay(inspection.actualBaseUrl),
    fileCount: inspection.files.length,
    existingFileCount: inspection.files.filter((file) => file.exists).length,
    updatedAt: inspection.updatedAt,
  }
  inspection.files.forEach((file, index) => {
    details[`file${index + 1}`] = pathForDisplay(file.path, roots)
  })
  if (inspection.matchesRelay && inspection.hasApiKey) {
    // 工具走的线路和星芒这会儿走的对不上（#941 第 2 节）：线路换了以后写失败的、客户自己改过配置所以没跟着
    // 改的。两条线路连的是同一个账号，工具照样能用，所以不算要留意的事（yoyo 10-8：线路的事不要太多提示），
    // 只在导出的报告里写清两边各是哪条；星芒下次跟着线路改配置时会改过来。
    const line = current ? providerRouteLine(current.siteId, provider, inspection.actualBaseUrl) : null
    if (current && line) details.routeLine = relayLineNames[line]
    if (current && !relayProviderBaseUrlEquals(inspection.actualBaseUrl, current.baseUrl)) details.currentRouteLine = relayLineNames[current.line]
    return { state: 'pass', summary: '已连到当前账号', details }
  }
  if (!inspection.exists) return { state: 'warn', summary: '还没有连接设置', details }
  if (!inspection.hasApiKey) return { state: 'fail', summary: '连接设置里没有密钥', details }
  return { state: 'fail', summary: '连接地址不是当前账号的', details }
}

const cliCheckCodes: readonly string[] = activeProviderIds.map((provider) => `CLI_${provider.toUpperCase()}`)

/**
 * 一个命令行工具都没装（只用 Codex 桌面端，它自带运行环境）时，Node.js、npm 没装只是
 * 「需留意」：首页运行环境卡这时也只写「可选 · 未装」、不挂橙点（第二十七批 B），检查页
 * 却是两行红色「待处理」，状态栏和开机提示跟着数进去（已知7）。仍旧要提、不能不出：
 * Codex 桌面端的「星芒画图」要 Node.js。有一家装着、或者这次没查出来装没装的，照旧红。
 */
export function reconcileNodeRuntimeWithClis(items: DiagnosticItem[]): DiagnosticItem[] {
  const clis = items.filter((item) => cliCheckCodes.includes(item.code))
  if (clis.length === 0 || clis.some((item) => item.details?.installed !== false)) return items
  return items.map((item) => (item.code === 'RUNTIME_NODE' || item.code === 'RUNTIME_NPM')
    && item.state === 'fail' && item.details?.installed === false
    ? { ...item, state: 'warn' }
    : item)
}

export function buildToolChecks(context: DiagnosticsContext): CheckDefinition[] {
  const { dependencies, displayRoots, platform, providerRoots, inspectProvider, toolSite, toolRoute, providerInspections, scanned, inspectTool } = context
  const probeDesktop = dependencies.inspectCodexDesktop ?? defaultInspectCodexDesktop
  const inspectDesktop = (signal: AbortSignal): Promise<DiagnosticToolStatus> => {
    const known = scanned ? scannedCodexDesktopStatus(scanned) : null
    return known ? Promise.resolve(known) : probeDesktop(signal)
  }

  return [
    ...(['node', 'npm', 'python'] as const).map<CheckDefinition>((tool) => ({
      code: `RUNTIME_${tool.toUpperCase()}`,
      title: runtimeCheckTitles[tool],
      run: async (signal) => {
        const status = await inspectTool(tool, signal)
        const required = tool !== 'python'
        return {
          state: status.installed ? 'pass' : required ? 'fail' : 'warn',
          summary: status.installed
            ? (status.version || '已安装')
            : status.xcodeLicensePending ? `未安装。${xcodeLicensePendingNotice('python3')}。`
              : status.commandLineToolsShim ? `未安装。${commandLineToolsShimNotice('python3')}。` : '未安装',
          details: { installed: status.installed, path: pathForDisplay(status.path, displayRoots) },
        }
      },
    })),
    {
      // 官方文档明说 Git for Windows 是 optional，所以缺了最重也只是「需留意」：
      // 把它判成待处理会让一个用不到 bash 的客户以为软件装坏了。要说的是
      // 「缺了会怎样」，文案在 git-runtime.ts（与插件市场那条共用）。
      code: 'RUNTIME_GIT',
      title: 'Git',
      run: async (signal) => {
        const status = await inspectTool('git', signal)
        return {
          state: status.installed ? 'pass' : 'warn',
          summary: status.installed
            ? (status.version || '已安装')
            : status.xcodeLicensePending
              ? `${xcodeLicensePendingNotice('git')}。${gitMissingImpact(platform)}。`
              : status.commandLineToolsShim
                ? `${commandLineToolsShimNotice('git')}。${gitMissingImpact(platform)}。`
                : gitMissingNotice(platform),
          details: {
            required: false,
            installed: status.installed,
            path: pathForDisplay(status.path, displayRoots),
          },
        }
      },
    },
    ...activeProviderIds.map<CheckDefinition>((provider) => ({
      code: `CLI_${provider.toUpperCase()}`,
      title: cliCatalog[provider].name,
      run: async (signal) => {
        const status = await inspectTool(provider, signal)
        return {
          state: status.installed ? 'pass' : 'warn',
          summary: status.installed ? (status.version || '已安装') : '未安装',
          details: { installed: status.installed, path: pathForDisplay(status.path, displayRoots) },
        }
      },
    })),
    {
      code: 'CODEX_DESKTOP',
      title: 'Codex 桌面端',
      run: async (signal) => {
        const status = await inspectDesktop(signal)
        return {
          state: status.installed ? 'pass' : 'warn',
          summary: status.installed ? (status.running ? '已安装并正在运行' : '已安装，当前未运行') : '未安装',
          details: {
            installed: status.installed,
            running: status.running ?? false,
            path: pathOrIdentifierForDisplay(status.path, displayRoots),
          },
        }
      },
    },
    ...activeProviderIds.map<CheckDefinition>((provider) => ({
      code: `PROVIDER_${provider.toUpperCase()}`,
      title: `${cliCatalog[provider].name} 连接设置`,
      run: () => {
        const inspection = providerInspections.get(provider) ?? inspectProvider(provider, providerRoots)
        // 「自动」还没定下来时不比：那时工具配置本来就不跟着迁。
        const current = toolRoute?.settled ? { siteId: toolSite.id, line: toolRoute.line, baseUrl: toolSite.providerBaseUrls[provider] } : undefined
        const outcome = providerOutcome(provider, inspection, displayRoots, current)
        if (provider !== 'codex' || outcome.state !== 'pass') return outcome
        const daemon = inspectCodexDaemonAutoStart(providerRoots)
        return daemon ? { ...outcome, details: { ...outcome.details, daemonAutoStart: codexDaemonAutoStartNames[daemon] } } : outcome
      },
    })),
  ]
}
