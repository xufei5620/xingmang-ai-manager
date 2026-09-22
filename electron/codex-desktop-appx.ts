import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { trustedCommandEnvironment } from './command-runner'
import {
  encodeWindowsPowerShellCommand,
  inspectWindowsElevationCapability,
  powerShellLiteral,
  resolveWindowsPowerShellExecutable,
  windowsElevationCancelledMessage,
  windowsElevationDeniedMessage,
  type WindowsElevationCapability,
} from './windows-elevation'

const execFileAsync = promisify(execFile)

function errorDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '')
  const failure = error as { stderr?: unknown; message?: unknown }
  return [failure.stderr, failure.message].map(value => Buffer.isBuffer(value) ? value.toString('utf8')
    : typeof value === 'string' ? value : '').filter(Boolean).join('\n')
}

/** 0x80073CF6 is generic; only the inner packaged-service elevation error qualifies. */
export function requiresCodexAppxElevation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object') && /\b0x80073d28\b/i.test(errorDetail(error))
}

function validatePackagePath(packagePath: string): void {
  if (typeof packagePath !== 'string' || !/^[a-z]:[\\/]/i.test(packagePath)
    || /[\u0000-\u001f\u007f<>"|?*]/.test(packagePath) || packagePath.slice(2).includes(':')
    || path.win32.extname(packagePath).toLowerCase() !== '.msix') {
    throw new Error('Codex MSIX 安装包路径无效')
  }
}

/** Called only after the download's hash, product, publisher, version and architecture checks. */
export function buildCodexAppxElevationScript(packagePath: string, sha256Base64: string, contentLength?: number): string {
  validatePackagePath(packagePath)
  if (typeof sha256Base64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(sha256Base64)
    || Buffer.from(sha256Base64, 'base64').toString('base64') !== sha256Base64) throw new Error('Codex MSIX 安装包校验值无效')
  const maximumBytes = 1500 * 1024 * 1024
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maximumBytes)) throw new Error('Codex MSIX 安装包长度无效')
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$env:PSModulePath = Join-Path $PSHOME 'Modules'",
    '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    "if ($identity.User.Value -ne '__XINGMANG_ORIGINAL_USER_SID__') { exit 2225 }",
    '$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)',
    'if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 740 }',
    '$cache = $null; $payload = $null; $source = $null; $held = $null; $created = $false',
    '$result = 1603',
    'try {',
    // The elevated process creates its own private copy; it never runs a mutable script or
    // installs the user's temp path after waiting on a UAC prompt.
    "  $root = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)",
    "  if (-not [IO.Path]::IsPathRooted($root)) { throw 'Invalid protected installation root' }",
    "  $cache = Join-Path $root ('Xingmang-Codex-Install-' + [Guid]::NewGuid().ToString('N'))",
    '  $acl = [System.Security.AccessControl.DirectorySecurity]::new()',
    '  $acl.SetAccessRuleProtection($true, $false)',
    "  $administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')",
    '  $acl.SetOwner($administrators)',
    "  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {",
    '    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid), [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)',
    '    $acl.AddAccessRule($rule)',
    '  }',
    '  [void][System.IO.Directory]::CreateDirectory($cache, $acl)',
    '  $created = $true',
    "  $payload = Join-Path $cache 'Codex.msix'",
    `  $source = [System.IO.File]::Open(${powerShellLiteral(packagePath)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)`,
    `  if ($source.Length -le 0 -or $source.Length -gt ${maximumBytes}${contentLength === undefined ? '' : ` -or $source.Length -ne ${contentLength}`}) { $result = 13; throw 'MSIX size mismatch' }`,
    '  $held = [System.IO.File]::Open($payload, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read)',
    '  $source.CopyTo($held); $source.Dispose(); $source = $null; $held.Flush(); $held.Dispose()',
    '  $payloadAcl = [System.IO.File]::GetAccessControl($payload)',
    '  $payloadAcl.SetOwner($administrators)',
    '  [System.IO.File]::SetAccessControl($payload, $payloadAcl)',
    '  $held = [System.IO.File]::Open($payload, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)',
    '  $sha = [System.Security.Cryptography.SHA256]::Create()',
    '  try { $actualHash = [Convert]::ToBase64String($sha.ComputeHash($held)) } finally { $sha.Dispose() }',
    `  if ($actualHash -cne ${powerShellLiteral(sha256Base64)}) { $result = 13 } else {`,
    // Matching bytes bind every pre-UAC metadata check; Add-AppxPackage enforces the
    // Microsoft package signature. No AllowUnsigned, trust-store, or policy bypass.
    "    Import-Module -Name (Join-Path $PSHOME 'Modules\\Appx\\Appx.psd1') -ErrorAction Stop",
    '    Add-AppxPackage -Path $payload -ForceApplicationShutdown -ErrorAction Stop',
    '    $result = 0',
    '  }',
    '} catch { if ($result -ne 13) { $result = 1603 } } finally {',
    '  if ($null -ne $source) { $source.Dispose() }',
    '  if ($null -ne $held) { $held.Dispose() }',
    // Delete only the file and empty directory we created, never recursively traverse
    // an elevated path supplied by the unelevated host.
    '  if ($null -ne $payload) { try { [System.IO.File]::Delete($payload) } catch {} }',
    '  if ($created) { try { [System.IO.Directory]::Delete($cache, $false) } catch {} }',
    '}',
    'exit $result',
  ].join('\n')
}

export function buildCodexAppxUacBrokerScript(powershell: string, packagePath: string, sha256Base64: string, contentLength?: number): string {
  if (!path.win32.isAbsolute(powershell) || !/[\\/]powershell\.exe$/i.test(powershell)) throw new Error('Codex UAC 需要系统 Windows PowerShell')
  const installer = buildCodexAppxElevationScript(packagePath, sha256Base64, contentLength)
  return [
    "$ErrorActionPreference = 'Stop'",
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$originalSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "if ($originalSid -notmatch '^S-1-[0-9-]+$') { exit 2225 }",
    `$installer = ${powerShellLiteral(installer)}`,
    "$installer = $installer.Replace('__XINGMANG_ORIGINAL_USER_SID__', $originalSid)",
    '$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($installer))',
    '$arguments = "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded"',
    'try {',
    `  $process = Start-Process -FilePath ${powerShellLiteral(powershell)} -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -WorkingDirectory $PSHOME -Wait -PassThru`,
    '  if ($null -eq $process) { exit 1603 }',
    '  exit $process.ExitCode',
    '} catch {',
    '  $failure = $_.Exception',
    '  while ($null -ne $failure) {',
    '    if ($failure.NativeErrorCode -eq 1223 -or $failure.HResult -eq -2147023673) { exit 1223 }',
    '    $failure = $failure.InnerException',
    '  }',
    '  throw',
    '}',
  ].join('\n')
}

interface CodexAppxInstallOptions { sha256Base64: string; contentLength?: number; onElevationRequired?: () => void }
interface CodexAppxInstallDependencies {
  resolvePowerShell: () => string
  run: (executable: string, argv: string[]) => Promise<void>
}

const defaultDependencies: CodexAppxInstallDependencies = {
  resolvePowerShell: () => resolveWindowsPowerShellExecutable(),
  async run(executable, argv) {
    await execFileAsync(executable, argv, {
      env: trustedCommandEnvironment(), cwd: path.win32.dirname(executable), windowsHide: true,
      // Killing the broker does not reliably stop its elevated child. Keep the install
      // queue and source payload until -Wait confirms that child actually exited.
      timeout: argv.includes('-EncodedCommand') ? 0 : 15 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  },
}

export async function addCodexDesktopPackage(
  packagePath: string, options: CodexAppxInstallOptions, dependencies: CodexAppxInstallDependencies = defaultDependencies,
): Promise<void> {
  validatePackagePath(packagePath)
  const powershell = dependencies.resolvePowerShell()
  const broker = buildCodexAppxUacBrokerScript(powershell, packagePath, options.sha256Base64, options.contentLength)
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'Stop'",
    `Add-AppxPackage -Path ${powerShellLiteral(packagePath)} -ForceApplicationShutdown -ErrorAction Stop`,
  ].join('; ')
  try {
    await dependencies.run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script])
    return
  } catch (error) {
    if (!requiresCodexAppxElevation(error)) throw new Error(`Add-AppxPackage 安装失败：${errorDetail(error).trim().slice(0, 2000) || 'Windows 未返回错误详情'}`)
  }
  options.onElevationRequired?.()
  try {
    await dependencies.run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsPowerShellCommand(broker)])
  } catch (error) {
    const code = error && typeof error === 'object' ? Number((error as { code?: unknown }).code) : NaN
    const cancelled = code === 1223 || /\b0x800704c7\b/i.test(errorDetail(error))
    // 「取消了授权」和「这个账号没有权限」在普通账号上会是同一个退出码，先问一次
    // 当前账号在不在管理员组，再决定说哪一句。
    const capability = cancelled || code === 740
      ? await inspectWindowsElevationCapability()
      : 'unknown'
    const message = codexDesktopElevationFailureMessage(cancelled ? 1223 : code, capability)
    if (message) throw new Error(message)
    const detail = errorDetail(error).trim().slice(0, 1200)
    throw new Error(`Codex 桌面端管理员安装失败${Number.isFinite(code) ? `（退出码 ${code}）` : ''}，请检查 Windows 应用部署事件日志后重试。${detail ? ` ${detail}` : ''}`)
  }
}

/**
 * 提权安装失败后要说的那一句。1223 是用户自己取消，740 是没拿到管理员权限——
 * 普通账号两种都会遇到，所以拿到 'standard' 时改说要管理员账号的密码。
 */
export function codexDesktopElevationFailureMessage(
  exitCode: number,
  capability: WindowsElevationCapability = 'unknown',
): string | null {
  switch (exitCode) {
    case 1223:
      return windowsElevationCancelledMessage('Codex 桌面端', capability)
    case 2225:
      return '授权使用了不同的 Windows 账号，已停止安装以免注册到其他用户。请由当前 Windows 账号的管理员会话完成安装。'
    case 13:
      return '授权期间 Codex 安装包发生变化，已停止安装，请重新下载。'
    case 740:
      return windowsElevationDeniedMessage('Codex 桌面端', capability)
    default:
      return null
  }
}
