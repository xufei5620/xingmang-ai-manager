import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  antigravityGatewayVariableNames,
  assertCompleteAntigravityEnvironment,
  type AntigravityEnvironmentValues,
  type AntigravityEnvironmentWriteOutcome,
  type AntigravityGatewayEnvironment,
  type AntigravityGatewayVariableName,
} from './antigravity-gateway'
import { trustedCommandEnvironment, windowsSystemExecutable } from './command-runner'
import {
  buildPowerShellConstrainedLanguageBranch,
  buildPowerShellEnvironmentBroadcastStatements,
  buildPowerShellJsonOutputStatements,
  powerShellReadEnvironmentValueFunction,
  powerShellUserEnvironmentKey,
} from './powershell-constrained-language'
import { buildPowerShellModuleImportStatement } from './powershell-module-imports'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const execFileAsync = promisify(execFile)

// Antigravity 的网关设置在 Windows 上写进当前用户的环境变量（HKCU\Environment）：yoyo 11-23 选的。
// 这样客户自己开的终端里敲 agy，和从开始菜单、桌面快捷方式打开的 Antigravity 桌面端都带着它
// （写完通知系统，资源管理器换上新环境，之后它开的程序都看得到）。只写当前用户那一份，不提权。
//
// 本进程的环境不跟着改，这只管这一次运行：客户下次从开始菜单、桌面图标打开的星芒，和别的程序一样从资源管理器
// 继承到这四个变量，之后它起的子进程（npm、别的命令行工具）也都带着。这把密钥本来就是写给客户自己开的每个程序用的，
// 星芒带着它不比别的程序多知道什么。所以星芒打开 Antigravity 时不靠自己的环境（可能是旧的，或者还没有），
// 由打开的那一步把这次写下的设置另外交给它（antigravity-service.ts 的 withAntigravityEnvironment，同名的整组换掉）。

export type PowerShellRunner = (script: string, env: NodeJS.ProcessEnv) => Promise<string>

// 写完要等 setx / SetEnvironmentVariable 通知完所有顶层窗口，有窗口卡着时会多等几秒。
export const antigravityEnvironmentPowerShellTimeoutMs = 20_000

// 受限语言模式那一段读、写、通知系统都要 Microsoft.PowerShell.Management；读的那条还要 Utility 出 JSON
// （buildPowerShellModuleImportStatement 总会带上 Utility）。普通模式下读的那条同样先导入，理由同 stale-proxy-environment.ts。
export const antigravityEnvironmentConstrainedModules = ['Microsoft.PowerShell.Management'] as const
const readFullLanguageModules = ['Microsoft.PowerShell.Utility'] as const

/** 值经子进程的环境变量交给脚本，一个字也不拼进脚本（I1）。 */
export function antigravityEnvironmentValueVariable(name: AntigravityGatewayVariableName): string {
  return `XINGMANG_SET_${name}`
}

const powerShellNameList = antigravityGatewayVariableNames.map((name) => `'${name}'`).join(', ')
const powerShellValueList = antigravityGatewayVariableNames.map((name) => `$env:${antigravityEnvironmentValueVariable(name)}`).join(', ')

function buildWriteConstrainedStatements(): string[] {
  return [
    buildPowerShellModuleImportStatement(antigravityEnvironmentConstrainedModules),
    ...powerShellReadEnvironmentValueFunction,
    `$names = @(${powerShellNameList})`,
    `$values = @(${powerShellValueList})`,
    "foreach ($value in $values) { if (-not $value) { throw 'Missing value' } }",
    `if (-not (Test-Path -LiteralPath '${powerShellUserEnvironmentKey}')) { $null = New-Item -Path '${powerShellUserEnvironmentKey}' }`,
    '$changed = $false',
    'for ($i = 0; $i -lt $names.Count; $i++) {',
    `  if ((Read-XingmangEnvironmentValue '${powerShellUserEnvironmentKey}' $names[$i]) -ceq $values[$i]) { continue }`,
    `  $null = New-ItemProperty -LiteralPath '${powerShellUserEnvironmentKey}' -Name $names[$i] -Value $values[$i] -PropertyType String -Force`,
    '  $changed = $true',
    '}',
    'if (-not $changed) { "unchanged"; return }',
    ...buildPowerShellEnvironmentBroadcastStatements(),
    '"written"',
  ]
}

/**
 * 把 `$env:XINGMANG_SET_AGY_LLM_GATEWAY_*` 四个值写进当前用户的环境变量，一律存成 REG_SZ（里面没有 %…%，
 * 不用展开）。四个都已经是这个值时什么都不写、也不通知系统，答 unchanged；有一个不一样就写不一样的那几个，
 * 再通知一次，答 written。别的变量一个不碰：客户自己设的 AGY_LLM_GATEWAY_HEADERS、_PROXY_URL 之类照旧。
 * 开着应用控制策略的电脑上 PowerShell 跑在受限语言模式里，那里改走注册表命令和 setx，写下的结果一样
 * （Windows 冒烟两种模式各跑一遍对照）。
 */
export function buildWriteWindowsAntigravityEnvironmentScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    ...buildPowerShellConstrainedLanguageBranch(buildWriteConstrainedStatements()),
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$names = @(${powerShellNameList})`,
    `$values = @(${powerShellValueList})`,
    "foreach ($value in $values) { if (-not $value) { throw 'Missing value' } }",
    '$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")',
    '$changed = $false',
    'try {',
    '  for ($i = 0; $i -lt $names.Count; $i++) {',
    '    $current = $key.GetValue($names[$i])',
    '    if (($current -is [string]) -and ($current -ceq $values[$i])) { continue }',
    '    $key.SetValue($names[$i], $values[$i], [Microsoft.Win32.RegistryValueKind]::String)',
    '    $changed = $true',
    '  }',
    '} finally {',
    '  $key.Close()',
    '}',
    'if (-not $changed) { "unchanged"; return }',
    // Only for its WM_SETTINGCHANGE broadcast, as in the PATH scripts: the
    // value does not exist, so nothing is removed.
    '[Environment]::SetEnvironmentVariable("XINGMANG_ENVIRONMENT_REFRESH", $null, "User")',
    '"written"',
  ].join('\n')
}

function buildReadConstrainedStatements(): string[] {
  return [
    buildPowerShellModuleImportStatement(antigravityEnvironmentConstrainedModules),
    ...powerShellReadEnvironmentValueFunction,
    `$names = @(${powerShellNameList})`,
    '$found = @{}',
    'foreach ($name in $names) {',
    `  $value = Read-XingmangEnvironmentValue '${powerShellUserEnvironmentKey}' $name`,
    '  if ($null -ne $value) { $found[$name] = $value }',
    '}',
    ...buildPowerShellJsonOutputStatements('$found | ConvertTo-Json -Compress'),
  ]
}

/** 当前用户那四个变量现在是什么：只答是字符串的，没有的不出现。 */
export function buildReadWindowsAntigravityEnvironmentScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    ...buildPowerShellConstrainedLanguageBranch(buildReadConstrainedStatements()),
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    buildPowerShellModuleImportStatement(readFullLanguageModules),
    `$names = @(${powerShellNameList})`,
    '$found = @{}',
    'foreach ($name in $names) {',
    '  $value = [Environment]::GetEnvironmentVariable($name, "User")',
    '  if ($null -ne $value) { $found[$name] = $value }',
    '}',
    '$found | ConvertTo-Json -Compress',
  ].join('\n')
}

function lastLine(stdout: string): string | undefined {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
}

export function parseWriteAntigravityEnvironmentOutput(stdout: string): AntigravityEnvironmentWriteOutcome {
  const last = lastLine(stdout)
  if (last === 'written' || last === 'unchanged') return last
  throw new Error('无法确认 Antigravity 的连接设置是否已写入，请重试')
}

export function parseReadAntigravityEnvironmentOutput(stdout: string): AntigravityEnvironmentValues {
  const failure = '无法读取 Antigravity 的设置'
  const last = lastLine(stdout)
  if (!last) throw new Error(failure)
  let parsed: unknown
  try {
    parsed = JSON.parse(last)
  } catch {
    throw new Error(failure)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(failure)
  const record = parsed as Record<string, unknown>
  const values: AntigravityEnvironmentValues = {}
  // 注册表的值名不分大小写，PowerShell 的哈希表也不分，答回来的写法跟着注册表里存的那一份走。
  for (const [key, value] of Object.entries(record)) {
    const name = antigravityGatewayVariableNames.find((candidate) => candidate.toLowerCase() === key.toLowerCase())
    if (name && typeof value === 'string') values[name] = value
  }
  return values
}

async function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    env,
    windowsHide: true,
    timeout: antigravityEnvironmentPowerShellTimeoutMs,
    maxBuffer: 64 * 1024,
  })
  return stdout
}

export interface WindowsAntigravityEnvironmentOptions {
  platform?: NodeJS.Platform
  run?: PowerShellRunner
}

function assertWindows(platform: NodeJS.Platform): void {
  if (platform !== 'win32') throw new Error('当前系统不支持此项设置')
}

/**
 * 把网关设置写进当前用户的环境变量。环境必须是 buildAntigravityGatewayEnvironment 给的整份：
 * 少一个或有空值就什么都不写。答 written / unchanged，日志里只记这一个词，不记值。
 */
export async function writeWindowsAntigravityEnvironment(
  environment: AntigravityGatewayEnvironment,
  options: WindowsAntigravityEnvironmentOptions = {},
): Promise<AntigravityEnvironmentWriteOutcome> {
  assertWindows(options.platform ?? process.platform)
  assertCompleteAntigravityEnvironment(environment)
  const values: NodeJS.ProcessEnv = {}
  for (const name of antigravityGatewayVariableNames) values[antigravityEnvironmentValueVariable(name)] = environment[name]
  const run = options.run ?? runPowerShell
  return parseWriteAntigravityEnvironmentOutput(await run(buildWriteWindowsAntigravityEnvironmentScript(), {
    ...trustedCommandEnvironment(),
    ...values,
    // 只有受限模式那一段用它（I14：System32 里那一份的绝对路径）。
    XINGMANG_SETX_EXE: windowsSystemExecutable('setx.exe'),
  }))
}

/** 读当前用户那四个变量。答回来的值里有密钥，只在主进程里用，不进日志、不过 IPC（I3）。 */
export async function readWindowsAntigravityEnvironment(
  options: WindowsAntigravityEnvironmentOptions = {},
): Promise<AntigravityEnvironmentValues> {
  assertWindows(options.platform ?? process.platform)
  const run = options.run ?? runPowerShell
  return parseReadAntigravityEnvironmentOutput(await run(buildReadWindowsAntigravityEnvironmentScript(), trustedCommandEnvironment()))
}
