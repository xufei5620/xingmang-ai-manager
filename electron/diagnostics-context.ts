// 一键检测各类检查共用的那一份上下文（#1070 第 9 步，从 diagnostics.ts 的 runDiagnostics 开头原样搬来）：依赖解析成
// 实际用的那一份（测试注入的替身或缺省实现）、用户目录和 Codex 目录、各家工具配置先读一遍的结果（顺带记下已知的
// Key，报告里要遮掉）、脱敏、首页扫描结果的复用，以及几类检查都要用的小工具（问工具装没装、是哪一版，错误原因串，
// 线路名）。各类检查搬出 diagnostics.ts 时都只拿这一份，类与类之间不互相 import。
//
// 这里只 import diagnostics.ts 的类型：值要是也从那边拿，两个文件就互相 require 了。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cliCatalog, providerIds, type ProviderId } from './catalog'
import {
  commandEnvironment,
  findExecutable,
  isTrustedHighIntegrityExecutable,
  primeTrustedHighIntegrityExecutable,
  runCommand,
  trustedCommandEnvironment,
} from './command-runner'
import { defaultProviderConfigRoots, type ProviderConfigRoots } from './codex-home'
import { inspectProviderConfig, type NativeConfigInspection } from './config-files'
import type {
  DiagnosticsDependencies,
  DiagnosticsRelayRoute,
  DiagnosticsScanSnapshot,
  DiagnosticToolId,
  DiagnosticToolStatus,
} from './diagnostics'
import { redactDiagnosticText } from './diagnostics-redaction'
import { inspectCommandLineToolsShim, isMacOsCommandLineToolsShim } from './macos-command-line-tools'
import { resolveDarwinPreferredNodeDirectory } from './macos-node-runtime'
import { resolveRelaySite, type RelayEndpointId, type RelaySite } from './relay-sites'
import { resolveCliCommand, resolveCliInstallation } from './tool-installation'

/** 多久以内跑完的扫描算「现成的」：开机自动检查紧跟着首页扫描，一分钟足够。 */
export const diagnosticsScanReuseMs = 60_000

/** 扫描里这一项的结论；扫描自己没探成（detectionFailed）就是 null，交回诊断自己探。 */
export function scannedToolStatus(snapshot: DiagnosticsScanSnapshot, tool: DiagnosticToolId): DiagnosticToolStatus | null {
  const status = (providerIds as readonly string[]).includes(tool) ? snapshot.clis[tool as ProviderId] : snapshot.runtime[tool as 'node' | 'npm' | 'python' | 'git']
  if (!status || status.detectionFailed) return null
  return status.installed ? { installed: true, version: status.version, path: status.path } : { installed: false, version: null, path: null }
}

export function scannedCodexDesktopStatus(snapshot: DiagnosticsScanSnapshot): DiagnosticToolStatus | null {
  const status = snapshot.desktopApps.codex
  if (status.detectionFailed) return null
  return status.installed
    ? { installed: true, version: status.version, path: status.path, running: status.running }
    : { installed: false, version: null, path: null, running: false }
}

function findWindowsShim(command: string, env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'win32') return null
  const searchPath = env.PATH ?? env.Path ?? env.path ?? ''
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory.replace(/^"(.*)"$/, '$1'), `${command}.cmd`)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Continue with the next PATH entry.
    }
  }
  return null
}

async function versionForExecutable(
  executable: string,
  tool: DiagnosticToolId,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  additionalPaths: readonly string[] = [],
): Promise<string | null> {
  // 直接做同步校验，Program Files 下的路径会在主线程上起 PowerShell 读权限，
  // node / npm / git 各一次，普通用户点「重新检测」时窗口就卡住了。
  await primeTrustedHighIntegrityExecutable(executable)
  if (!isTrustedHighIntegrityExecutable(executable, env)) return null
  if (process.platform === 'win32' && path.extname(executable).toLowerCase() === '.cmd' && tool !== 'npm') {
    return null
  }
  const args = ['--version']
  const result = await runCommand({
    executable,
    argv: args,
    windowsPackageManager: tool === 'npm' ? 'npm' : undefined,
  }, {
    env: process.platform === 'win32' ? trustedCommandEnvironment(env) : commandEnvironment(env, additionalPaths),
    trustedOnly: process.platform === 'win32',
    timeoutMs: 5_000,
    maxOutputBytes: 128 * 1024,
    signal,
  })
  return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
}

/**
 * Mac 上客户自己那份 Node.js 太旧时，本软件自己用代下的那份（第三十四批 A，system-service.ts
 * 的 preferredNodeDirectories）；检查页的 Node.js、npm 两项也报那一份，和首页对得上。
 */
async function preferredNodeDirectories(signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<string[]> {
  if (process.platform !== 'darwin') return []
  const directory = await resolveDarwinPreferredNodeDirectory({
    findNode: () => findExecutable('node', { env: commandEnvironment(env) }),
    readVersion: (executable) => versionForExecutable(executable, 'node', signal, env),
    environment: env,
  }).catch(() => null)
  return directory ? [directory] : []
}

async function defaultInspectTool(
  tool: DiagnosticToolId,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<DiagnosticToolStatus> {
  if (providerIds.includes(tool as ProviderId)) {
    const provider = tool as ProviderId
    const installation = await resolveCliInstallation(provider, { env })
    if (!installation) return { installed: false, version: null, path: null }
    if (installation.source === 'npm') {
      return {
        installed: true,
        version: installation.packageVersion ?? null,
        path: installation.commandPath,
      }
    }
    try {
      const command = await resolveCliCommand(provider, env, 'trusted-only', {
        darwinStagingRetention: 'ephemeral',
      })
      try {
        await primeTrustedHighIntegrityExecutable(command.executable)
        if (!isTrustedHighIntegrityExecutable(command.executable, env)) {
          return { installed: true, version: null, path: installation.commandPath }
        }
        const result = await runCommand({
          executable: command.executable,
          argv: [...command.argv, ...cliCatalog[provider].versionArgs],
        }, {
          env: process.platform === 'win32' ? trustedCommandEnvironment(env) : commandEnvironment(env),
          trustedOnly: process.platform === 'win32',
          timeoutMs: 5_000,
          maxOutputBytes: 128 * 1024,
          signal,
        })
        return {
          installed: true,
          version: `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null,
          path: command.verifiedDarwinStandalone?.executablePath ?? installation.commandPath,
        }
      } finally {
        await command.release?.()
      }
    } catch {
      return { installed: true, version: null, path: null }
    }
  }
  const commands = tool === 'python' ? ['python', 'python3', 'py'] : [tool]
  const nodeDirectories = tool === 'node' || tool === 'npm' ? await preferredNodeDirectories(signal, env) : []
  let commandLineToolsShim = false
  let xcodeLicensePending = false
  for (const command of commands) {
    const executable = await findExecutable(command, {
      env: commandEnvironment(env),
      windowsPackageManagers: command === 'npm' ? ['npm'] : [],
      ...(nodeDirectories.length ? { additionalPaths: nodeDirectories } : {}),
    }) ?? findWindowsShim(command, env)
    if (!executable) continue
    if (isMacOsCommandLineToolsShim(executable)) {
      const shimState = await inspectCommandLineToolsShim(executable, { env, signal })
      if (shimState !== 'usable') {
        commandLineToolsShim = true
        xcodeLicensePending ||= shimState === 'license-pending'
        continue
      }
    }
    let version: string | null = null
    try {
      version = await versionForExecutable(executable, tool, signal, env, nodeDirectories)
    } catch {
      // Presence is still useful when a package-manager shim cannot be executed safely.
    }
    return { installed: true, version, path: executable }
  }
  if (commandLineToolsShim) {
    return {
      installed: false,
      version: null,
      path: null,
      commandLineToolsShim,
      ...(xcodeLicensePending ? { xcodeLicensePending } : {}),
    }
  }
  return { installed: false, version: null, path: null }
}

/** 日志里要看得见真正的原因，而 fetch 把它塞在 cause 里，外层只剩 fetch failed。 */
export function errorChainText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== 'object') {
      parts.push(String(current))
      break
    }
    const record = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }
    parts.push([record.name, record.message, record.code]
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .join(': '))
    current = record.cause
  }
  return parts.filter(Boolean).join(' <- ').slice(0, 500)
}

// 线路在星芒里就叫这两个名字，和设置里的选项、网络那一项的结论一致：只说线路1、线路2，不说在哪
// （yoyo 10-14）。两个账号按入口对应，默认那条（CF）是线路1，直连是线路2，客服对报告时同一个名字指同一种
// 入口。下面几处只写进导出的检查报告；检查页的详情不摆（diagnostic-details.ts 不列这几个键）。
export const relayLineNames: Readonly<Record<RelayEndpointId, string>> = { primary: '线路1', direct: '线路2' }

/** runDiagnostics 开头解析好、各类检查都要用的那些（名字照原来的局部变量，搬过去的代码一字不改）。 */
export interface DiagnosticsContext {
  dependencies: DiagnosticsDependencies
  env: NodeJS.ProcessEnv
  userHome: string
  providerRoots: ProviderConfigRoots
  codexHome: string
  /** 报告里写路径时拿来换成 ~、[CODEX_HOME] 的那两个目录。 */
  displayRoots: ProviderConfigRoots
  platform: NodeJS.Platform
  arch: string
  release: string
  inspectProvider: NonNullable<DiagnosticsDependencies['inspectProvider']>
  relaySite: RelaySite
  /** 工具配置那条线路所在的站和线路（toolRoute 缺省时就是 relaySite、relayRoute）。 */
  toolSite: RelaySite
  toolRoute: Pick<DiagnosticsRelayRoute, 'line' | 'automatic' | 'settled' | 'primarySite'> | undefined
  /** 各家工具配置先读一遍的结果；读失败的那家不在里面，由它自己那一项报错。 */
  providerInspections: Map<ProviderId, NativeConfigInspection>
  /** 报告里每句话都过一遍：遮掉已知 Key、密钥样式的串和用户目录。 */
  sanitize: (value: string) => string
  scanned: DiagnosticsScanSnapshot | null
  /** 有首页扫描结果就先用它，没有或扫描自己没探成才去探。 */
  inspectTool: NonNullable<DiagnosticsDependencies['inspectTool']>
  log: DiagnosticsDependencies['log']
  now: () => Date
}

export function createDiagnosticsContext(dependencies: DiagnosticsDependencies): DiagnosticsContext {
  const env = dependencies.env ?? process.env
  const userHome = path.resolve(
    dependencies.providerRoots?.userHome ?? dependencies.homeDirectory ?? os.homedir(),
  )
  const providerRoots = dependencies.providerRoots ?? defaultProviderConfigRoots(userHome, env)
  const codexHome = providerRoots.codexHome
  const displayRoots = { userHome, codexHome }
  const platform = dependencies.platform ?? process.platform
  const arch = dependencies.arch ?? process.arch
  const release = dependencies.release ?? os.release()
  const inspectProvider = dependencies.inspectProvider
    ?? ((provider, roots) => inspectProviderConfig(provider, roots))
  const relaySite = dependencies.relaySite ?? resolveRelaySite(undefined)
  const toolSite = dependencies.toolRoute?.site ?? relaySite
  const toolRoute = dependencies.toolRoute ? dependencies.toolRoute.route : dependencies.relayRoute
  const providerInspections = new Map<ProviderId, NativeConfigInspection>()
  const knownSecrets: string[] = []
  // 下线的 Gemini CLI 也照读：它的 Key 还在本机配置里，报告里一样要遮掉。
  for (const provider of providerIds) {
    try {
      const inspection = inspectProvider(provider, providerRoots)
      providerInspections.set(provider, inspection)
      if (inspection.apiKey) knownSecrets.push(inspection.apiKey)
    } catch {
      // The isolated provider check will surface its own error.
    }
  }
  const sanitize = (value: string) => redactDiagnosticText(value, {
    userHome,
    codexHome,
    sensitiveValues: knownSecrets,
  })
  const scanned = dependencies.recentScan ?? null
  const probeTool = dependencies.inspectTool
    ?? ((tool, signal) => defaultInspectTool(tool, signal, env))
  const inspectTool: typeof probeTool = (tool, signal) => {
    const known = scanned ? scannedToolStatus(scanned, tool) : null
    return known ? Promise.resolve(known) : probeTool(tool, signal)
  }
  const log = dependencies.log
  const now = dependencies.now ?? (() => new Date())
  return {
    dependencies,
    env,
    userHome,
    providerRoots,
    codexHome,
    displayRoots,
    platform,
    arch,
    release,
    inspectProvider,
    relaySite,
    toolSite,
    toolRoute,
    providerInspections,
    sanitize,
    scanned,
    inspectTool,
    log,
    now,
  }
}
