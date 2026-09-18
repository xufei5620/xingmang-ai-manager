import os from 'node:os'
import path from 'node:path'
import { runCommand, trustedCommandEnvironment } from './command-runner'
import { readBoundedFile } from './bounded-file'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const maximumBytes = 512 * 1024
const label = 'Claude Desktop 管理策略'
const recognizedRegistryKinds = new Set(['String', 'ExpandString', 'DWord'])
// Official app-behavior policies remain independent of local inference profiles.
const appBehaviorPolicyNames = new Set([
  'disableAutoUpdates',
  'autoUpdaterEnforcementHours',
  'updateViaUpdatesHost',
  'relaunchEnforcementHours',
  'configRecheckIntervalMinutes',
  'egressProxyUrl',
  'egressProxyPacUrl',
])

export interface ClaudeDesktopPolicyEntry {
  name: string
  kind: string
}

export interface ClaudeDesktopPolicyNames {
  machine: ClaudeDesktopPolicyEntry[]
  user: ClaudeDesktopPolicyEntry[]
}

export interface ClaudeDesktopPolicyOptions {
  platform: NodeJS.Platform
  userHome: string
  username?: string
  readWindowsPolicy?: () => Promise<ClaudeDesktopPolicyNames>
  execute?: typeof runCommand
  resolvePowerShell?: () => string
  readManagedFile?: (filePath: string) => Promise<Buffer | null>
}

// Only names/kinds leave PowerShell. Registry values may contain API keys.
const readPolicyScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Read-Hive($hive) {
  $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,[Microsoft.Win32.RegistryView]::Registry64)
  $key=$null
  try {
    $key=$root.OpenSubKey('SOFTWARE\Policies\Claude',$false)
    if($null -eq $key){return}
    foreach($name in $key.GetValueNames()) {
      [pscustomobject]@{name=$name;kind=$key.GetValueKind($name).ToString()}
    }
  } finally {if($null -ne $key){$key.Dispose()};$root.Dispose()}
}
@{machine=@(Read-Hive ([Microsoft.Win32.RegistryHive]::LocalMachine));user=@(Read-Hive ([Microsoft.Win32.RegistryHive]::CurrentUser))} | ConvertTo-Json -Depth 4 -Compress
`

function policyEntries(value: unknown): ClaudeDesktopPolicyEntry[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error(`${label}读取结果无效`)
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error(`${label}读取结果无效`)
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string' || item.name.length > 512 || /[\x00-\x1f]/.test(item.name)
      || typeof item.kind !== 'string' || item.kind.length > 64) throw new Error(`${label}读取结果无效`)
    return { name: item.name, kind: item.kind }
  })
}

async function readWindowsPolicy(options: ClaudeDesktopPolicyOptions): Promise<ClaudeDesktopPolicyNames> {
  try {
    const result = await (options.execute ?? runCommand)({
      executable: (options.resolvePowerShell ?? resolveWindowsPowerShellExecutable)(),
      argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(readPolicyScript, 'utf16le').toString('base64')],
    }, { env: trustedCommandEnvironment(), trustedOnly: true, windowsHide: true, timeoutMs: 15000, maxOutputBytes: maximumBytes })
    const value: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
    if (!value || typeof value !== 'object') throw new Error('invalid-policy')
    const record = value as Record<string, unknown>
    return { machine: policyEntries(record.machine), user: policyEntries(record.user) }
  } catch {
    throw new Error(`${label}无法读取，未修改本地配置，请检查权限后重试`)
  }
}

async function readManagedFile(filePath: string): Promise<Buffer | null> {
  try { return await readBoundedFile(filePath, maximumBytes, label) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`${label}无法安全读取，未修改本地配置`)
  }
}

function assertNoPolicyKeys(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效，未修改本地配置`)
  if (Object.keys(value).some((name) => !appBehaviorPolicyNames.has(name))) {
    throw new Error('Claude Desktop 已受系统管理策略控制，本地第三方推理配置可能被覆盖；请先由管理员移除旧推理策略后重试')
  }
}

/** Read-only guard. In particular, never remove policies owned by an administrator. */
export async function assertClaudeDesktopUnmanaged(options: ClaudeDesktopPolicyOptions): Promise<void> {
  if (options.platform === 'win32') {
    let snapshot: ClaudeDesktopPolicyNames
    try { snapshot = await (options.readWindowsPolicy ? options.readWindowsPolicy() : readWindowsPolicy(options)) }
    catch { throw new Error(`${label}无法读取，未修改本地配置，请检查权限后重试`) }
    const machine = policyEntries(snapshot.machine).filter((entry) => recognizedRegistryKinds.has(entry.kind))
    const user = policyEntries(snapshot.user).filter((entry) => recognizedRegistryKinds.has(entry.kind))
    // The application selects a complete hive; even an empty String in HKLM masks HKCU.
    const effective = machine.length ? machine : user
    if (effective.some((entry) => !appBehaviorPolicyNames.has(entry.name))) {
      throw new Error(`Claude Desktop 已存在 ${machine.length ? 'HKLM 机器' : 'HKCU 用户'}管理策略，会覆盖本地第三方推理配置；请先移除旧推理策略后重试`)
    }
    return
  }
  const read = options.readManagedFile ?? readManagedFile
  if (options.platform === 'darwin') {
    const username = options.username ?? (options.userHome === os.homedir() ? os.userInfo().username : path.posix.basename(options.userHome))
    if (!username || username === '.' || username === '..' || /[\x00-\x1f\\/]/.test(username)) throw new Error(`${label}的用户名无效`)
    for (const filePath of [
      path.posix.join('/Library/Managed Preferences', username, 'com.anthropic.claudefordesktop.plist'),
      '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist',
    ]) {
      if (await read(filePath) === null) continue
      let value: unknown
      try {
        const result = await (options.execute ?? runCommand)({ executable: '/usr/bin/plutil', argv: ['-convert', 'json', '-o', '-', filePath] }, {
          env: trustedCommandEnvironment(), timeoutMs: 10000, maxOutputBytes: maximumBytes,
        })
        value = JSON.parse(result.stdout)
      } catch { throw new Error(`${label}无法读取，未修改本地配置`) }
      assertNoPolicyKeys(value)
    }
    return
  }
  if (await read('/etc/claude-desktop/managed-settings.json') !== null) {
    throw new Error('Claude Desktop 已存在系统 managed-settings.json 管理配置，请先由管理员移除旧推理策略后重试')
  }
}
