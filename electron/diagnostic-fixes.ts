import fs from 'node:fs'
import path from 'node:path'
import { trustedCommandEnvironment } from './command-runner'
import { environmentOverrideNames } from './diagnostics'
import { GENERATED_PROJECT_INSTRUCTION_FILENAME, hasUntouchedHomeProjectInstructions } from './project-instructions'
import { assertNoReparseComponents, assertSafeDataFile } from './safe-local-data'
import { runPowerShell, type PowerShellRunner } from './stale-proxy-environment'

/**
 * 检查页里「点这里就好」的按钮（新手引导梳理 2026-09-25 第 2 条）。以前这几项
 * 只有一句「删掉它」或一颗把人带回首页的「去处理」，首页上并没有能处理它们的地方。
 */

export type DiagnosticFixKind = 'set-aside-codex-dotenv' | 'clear-user-overrides' | 'set-aside-home-agents-md'

export function isDiagnosticFixKind(value: unknown): value is DiagnosticFixKind {
  return value === 'set-aside-codex-dotenv' || value === 'clear-user-overrides' || value === 'set-aside-home-agents-md'
}

export interface DiagnosticFixResult {
  kind: DiagnosticFixKind
  /** 这次真的处理掉的项数：挪开的文件（0 或 1），或删掉的设置个数。 */
  fixed: number
  /** 还剩下要管理员才能改的（整台电脑那一份），这次没动。只有清设置时会有。 */
  machineRemaining: boolean
}

function timestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * 把 Codex 文件夹里那份 `.env` 改个名留在原处，不删：里面可能是用户自己写的密钥，
 * 想用回来把名字改回去就行。改名前按 I8 过一遍：文件夹路径上不许有联接，文件本身
 * 必须是单链接普通文件，免得被人放个链接把改名引到别处。
 */
export function setAsideCodexDotenv(codexHome: string, now: Date = new Date()): DiagnosticFixResult {
  const source = path.join(codexHome, '.env')
  const label = 'Codex 文件夹里的额外设置'
  if (!assertSafeDataFile(source, label)) return { kind: 'set-aside-codex-dotenv', fixed: 0, machineRemaining: false }
  const base = `.env.xingmang-${timestamp(now)}.bak`
  let target = path.join(codexHome, base)
  for (let attempt = 2; fs.existsSync(target); attempt++) {
    if (attempt > 20) throw new Error('这份额外设置没挪开：同名的旧文件太多，请把 Codex 文件夹里的旧备份删掉几份再试')
    target = path.join(codexHome, `${base}.${attempt}`)
  }
  assertNoReparseComponents(path.dirname(target), label)
  fs.renameSync(source, target)
  return { kind: 'set-aside-codex-dotenv', fixed: 1, machineRemaining: false }
}

/**
 * 「挪开这份说明」（已知36）：个人文件夹里星芒早先放的那份 AGENTS.md 改个名留在原处，
 * 不删，想用回来把名字改回去就行。点下去那一刻再认一遍内容：检查之后客户改过的就算
 * 他的了，不挪，答「已经不在了」（星芒放的那份确实不在了）。改名前的 I8 检查同上。
 */
export function setAsideHomeProjectInstructions(home: string, now: Date = new Date()): DiagnosticFixResult {
  const source = path.join(home, GENERATED_PROJECT_INSTRUCTION_FILENAME)
  const label = '个人文件夹里的项目说明'
  if (!hasUntouchedHomeProjectInstructions(home) || !assertSafeDataFile(source, label)) {
    return { kind: 'set-aside-home-agents-md', fixed: 0, machineRemaining: false }
  }
  const base = `${GENERATED_PROJECT_INSTRUCTION_FILENAME}.xingmang-${timestamp(now)}.bak`
  let target = path.join(home, base)
  // 不设上限也一定停得下：每一轮换一个没用过的名字，文件夹里的文件总是有限的。
  for (let attempt = 2; fs.existsSync(target); attempt++) target = path.join(home, `${base}.${attempt}`)
  assertNoReparseComponents(path.dirname(target), label)
  fs.renameSync(source, target)
  return { kind: 'set-aside-home-agents-md', fixed: 1, machineRemaining: false }
}

/**
 * 删掉当前 Windows 账号下 `$env:XINGMANG_CLEAR_OVERRIDES` 列出的几个设置。名字经
 * 环境变量传入、不拼进脚本；脚本里再对照固定名单过一遍，名单外的一律不碰。只删
 * 「当前账号」那一份，整台电脑那一份要管理员，只报告它还在，不提权。
 * 值一律不读出来：ANTHROPIC_AUTH_TOKEN 这类的值本身就是一把 Key（I3、I13）。
 */
export function buildClearProviderOverridesScript(): string {
  const allowed = environmentOverrideNames.map((name) => `"${name}"`).join(',')
  return [
    '$ErrorActionPreference = "Stop"',
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$allowed = @(${allowed})`,
    '$cleared = @()',
    '$machine = @()',
    'foreach ($name in ($env:XINGMANG_CLEAR_OVERRIDES -split ";")) {',
    '  if (-not ($allowed -contains $name)) { continue }',
    '  if ($null -ne [Environment]::GetEnvironmentVariable($name, "User")) {',
    '    [Environment]::SetEnvironmentVariable($name, $null, "User")',
    '    $cleared += $name',
    '  }',
    '  if ($null -ne [Environment]::GetEnvironmentVariable($name, "Machine")) { $machine += $name }',
    '}',
    '"cleared:" + ($cleared -join ";")',
    '"machine:" + ($machine -join ";")',
  ].join('\n')
}

export function parseClearProviderOverridesOutput(stdout: string): { cleared: string[]; machine: string[] } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const cleared = lines.find((line) => line.startsWith('cleared:'))
  const machine = lines.find((line) => line.startsWith('machine:'))
  if (cleared === undefined || machine === undefined) throw new Error('没能确认这几项设置是否已经删掉')
  const names = (line: string, prefix: string) => line.slice(prefix.length).split(';')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => environmentOverrideNames.includes(entry))
  return { cleared: names(cleared, 'cleared:'), machine: names(machine, 'machine:') }
}

export interface ClearProviderOverridesOptions {
  /** 这次要删的名字，由调用方在点下去那一刻按当前环境重新算（clearableEnvironmentOverrides）。 */
  names: readonly string[]
  platform?: NodeJS.Platform
  run?: PowerShellRunner
  /** 删掉之后同步改本进程的环境，下次打开工具、跑检查就不再看到它；缺省 = process.env。 */
  processEnv?: NodeJS.ProcessEnv
}

export async function clearUserProviderOverrides(options: ClearProviderOverridesOptions): Promise<DiagnosticFixResult> {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('只有 Windows 上能在这里删掉这几项设置')
  const targets = options.names.filter((name) => environmentOverrideNames.includes(name))
  if (!targets.length) return { kind: 'clear-user-overrides', fixed: 0, machineRemaining: false }
  const run = options.run ?? runPowerShell
  const result = parseClearProviderOverridesOutput(await run(buildClearProviderOverridesScript(), {
    ...trustedCommandEnvironment(),
    XINGMANG_CLEAR_OVERRIDES: targets.join(';'),
  }))
  const processEnv = options.processEnv ?? process.env
  // 整台电脑那一份还在的，本进程里的值多半就是它，留着；只删只有当前账号那份的。
  for (const name of result.cleared.filter((entry) => !result.machine.includes(entry))) {
    for (const key of Object.keys(processEnv)) {
      if (key.toUpperCase() === name) delete processEnv[key]
    }
  }
  return { kind: 'clear-user-overrides', fixed: result.cleared.length, machineRemaining: result.machine.length > 0 }
}
