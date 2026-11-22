# Update install handoff for the Windows client (audit item S01). Started elevated by
# electron/windows-update-handoff.ts through elevate.exe, and shipped in the install
# directory's resources\update-handoff, which only administrators can change
# (build/installer.nsh). Keep this file ASCII: Windows PowerShell 5.1 reads a script
# without a byte order mark in the system code page.
#
# Everything the unelevated side passes in is a claim, not a fact. -Package only says
# where to read from. The bytes that run are the bytes this script copied into a
# directory only SYSTEM and Administrators can change, hashed twice against -Sha512,
# and kept open without write sharing until the installer has exited.
#
# Status goes to %SystemRoot%\Temp\xingmang-update-status-<nonce>.json, created here
# with CreateNew and an explicit DACL: an elevated write never lands in a location the
# unelevated user controls. The app reads it as a hint only.
#
# Exit codes: 0 installed, 2 invalid arguments, 3 package mismatch, 4 the app did not
# quit, 5 any other failure, 6 the installer itself failed, 740 not elevated.
param(
  [string]$Package = '',
  [string]$Sha512 = '',
  [long]$Size = -1,
  [int]$ParentPid = 0,
  [string]$Nonce = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Only .NET types are used below; this keeps any module autoload on the system copy.
$env:PSModulePath = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\Modules')

$exitInvalid = 2
$exitMismatch = 3
$exitAborted = 4
$exitFailed = 5
$exitInstallerFailed = 6
$exitNotAdministrator = 740
$maximumBytes = [long]2147483648
$parentWaitMs = 90000

function ConvertFrom-ExpectedDigest([string]$Value) {
  $text = $Value.Trim()
  if ($text -cmatch '^[0-9a-fA-F]{128}$') {
    $bytes = [byte[]]::new(64)
    for ($index = 0; $index -lt 64; $index++) {
      $bytes[$index] = [Convert]::ToByte($text.Substring($index * 2, 2), 16)
    }
    return , $bytes
  }
  # Same rule as update-package-digest.ts: the base64 form counts only when it is
  # exactly the canonical encoding of 64 bytes.
  if ($text -cmatch '^[A-Za-z0-9+/]{86}==$') {
    $bytes = [Convert]::FromBase64String($text)
    if ($bytes.Length -eq 64 -and [Convert]::ToBase64String($bytes) -ceq $text) { return , $bytes }
  }
  return $null
}

function Test-DigestEqual([byte[]]$Left, [byte[]]$Right) {
  if ($null -eq $Left -or $null -eq $Right -or $Left.Length -ne $Right.Length) { return $false }
  $difference = 0
  for ($index = 0; $index -lt $Left.Length; $index++) { $difference = $difference -bor ($Left[$index] -bxor $Right[$index]) }
  return $difference -eq 0
}

if ($Nonce -cnotmatch '^[0-9a-f]{32}$') { exit $exitInvalid }
if ($ParentPid -le 0) { exit $exitInvalid }
if ($Size -lt 0 -or $Size -gt $maximumBytes) { exit $exitInvalid }
if ($Package.IndexOf([char]0) -ge 0 -or $Package -cnotmatch '^(?:[A-Za-z]:\\|\\\\[^\\.?])' -or -not $Package.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) { exit $exitInvalid }
$expected = ConvertFrom-ExpectedDigest $Sha512
if ($null -eq $expected) { exit $exitInvalid }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit $exitNotAdministrator }

# Held from the start, so the wait below is for the process that asked for this
# install, not for whatever later reuses its id.
$parent = $null
try { $parent = [Diagnostics.Process]::GetProcessById($ParentPid) } catch { $parent = $null }
if ($null -ne $parent) { try { [void]$parent.Handle } catch { } }

$windows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
if ([string]::IsNullOrEmpty($windows) -or -not [IO.Path]::IsPathRooted($windows)) { exit $exitFailed }
$tempRoot = [IO.Path]::Combine($windows, 'Temp')
$system32 = [Environment]::SystemDirectory

$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$fullControl = [Security.AccessControl.FileSystemRights]::FullControl
$allow = [Security.AccessControl.AccessControlType]::Allow
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$noPropagation = [Security.AccessControl.PropagationFlags]::None

# Leftovers from runs that were killed: only names this script creates, only real
# directories and files, only ones owned by Administrators, only after a day.
try {
  $cutoff = [DateTime]::UtcNow.AddDays(-1)
  foreach ($directory in [IO.Directory]::GetDirectories($tempRoot, 'xingmang-update-*')) {
    try {
      if ([IO.Path]::GetFileName($directory) -cnotmatch '^xingmang-update-[0-9a-f]{32}$') { continue }
      $info = [IO.DirectoryInfo]::new($directory)
      if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $info.LastWriteTimeUtc -gt $cutoff) { continue }
      if ($info.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]) -ne $administrators) { continue }
      [IO.Directory]::Delete($directory, $true)
    } catch { }
  }
  foreach ($file in [IO.Directory]::GetFiles($tempRoot, 'xingmang-update-status-*.json')) {
    try {
      if ([IO.Path]::GetFileName($file) -cnotmatch '^xingmang-update-status-[0-9a-f]{32}\.json$') { continue }
      $info = [IO.FileInfo]::new($file)
      if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $info.LastWriteTimeUtc -gt $cutoff) { continue }
      if ($info.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]) -ne $administrators) { continue }
      [IO.File]::Delete($file)
    } catch { }
  }
} catch { }

$statusStream = $null
$statusSecurity = [Security.AccessControl.FileSecurity]::new()
$statusSecurity.SetAccessRuleProtection($true, $false)
$statusSecurity.SetOwner($administrators)
$statusSecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system, $fullControl, $allow))
$statusSecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($administrators, $fullControl, $allow))
$statusSecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, [Security.AccessControl.FileSystemRights]::Read, $allow))
try {
  $statusPath = [IO.Path]::Combine($tempRoot, 'xingmang-update-status-' + $Nonce + '.json')
  # CreateNew: a name that already exists, whoever made it, stops the install here.
  $statusStream = [IO.FileStream]::new($statusPath, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::Read, 4096, [IO.FileOptions]::None, $statusSecurity)
} catch {
  exit $exitFailed
}

function Write-HandoffStatus([string]$State, [int]$Code) {
  $bytes = [Text.Encoding]::UTF8.GetBytes('{"nonce":"' + $Nonce + '","state":"' + $State + '","exitCode":' + $Code + '}')
  $statusStream.SetLength(0)
  $statusStream.Position = 0
  $statusStream.Write($bytes, 0, $bytes.Length)
  $statusStream.Flush($true)
}

$result = $exitFailed
$finalState = 'failed'
$installerExit = 0
$staging = $null
$payload = $null
$source = $null
$copy = $null
$held = $null
$sha = $null
try {
  Write-HandoffStatus 'started' 0

  $directorySecurity = [Security.AccessControl.DirectorySecurity]::new()
  $directorySecurity.SetAccessRuleProtection($true, $false)
  $directorySecurity.SetOwner($administrators)
  foreach ($sid in @($system, $administrators)) {
    $directorySecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $fullControl, $inherit, $noPropagation, $allow))
  }
  for ($attempt = 0; $attempt -lt 5 -and $null -eq $staging; $attempt++) {
    $candidate = [IO.Path]::Combine($tempRoot, 'xingmang-update-' + [Guid]::NewGuid().ToString('N'))
    if ([IO.Directory]::Exists($candidate) -or [IO.File]::Exists($candidate)) { continue }
    # Created with its DACL in one step, never created first and locked down after.
    [void][IO.Directory]::CreateDirectory($candidate, $directorySecurity)
    $staging = $candidate
  }
  if ($null -eq $staging) { throw 'no staging directory' }

  # CreateDirectory hands back a directory that already existed without applying the
  # DACL, so what is actually there is checked, not what was asked for.
  $stagingInfo = [IO.DirectoryInfo]::new($staging)
  if (($stagingInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'staging is a reparse point' }
  $stagingAcl = $stagingInfo.GetAccessControl()
  if ($stagingAcl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $administrators) { throw 'staging owner' }
  if (-not $stagingAcl.AreAccessRulesProtected) { throw 'staging inherits' }
  foreach ($rule in $stagingAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne $allow) { continue }
    if ($rule.IdentityReference -ne $system -and $rule.IdentityReference -ne $administrators) { throw 'staging grants access beyond SYSTEM and Administrators' }
  }

  $payload = [IO.Path]::Combine($staging, 'setup.exe')
  $source = [IO.FileStream]::new($Package, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $length = $source.Length
  if ($length -le 0 -or $length -gt $maximumBytes -or ($Size -gt 0 -and $length -ne $Size)) {
    $result = $exitMismatch
    $finalState = 'mismatch'
  } else {
    $copy = [IO.FileStream]::new($payload, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $sha = [Security.Cryptography.SHA512]::Create()
    $buffer = [byte[]]::new(1048576)
    $total = [long]0
    while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $total += $read
      if ($total -gt $length) { break }
      [void]$sha.TransformBlock($buffer, 0, $read, $null, 0)
      $copy.Write($buffer, 0, $read)
    }
    [void]$sha.TransformFinalBlock($buffer, 0, 0)
    $copied = $sha.Hash
    $sha.Dispose(); $sha = $null
    $copy.Flush($true); $copy.Dispose(); $copy = $null
    $source.Dispose(); $source = $null

    $held = [IO.FileStream]::new($payload, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA512]::Create()
    $reread = $sha.ComputeHash($held)
    $sha.Dispose(); $sha = $null

    if ($total -ne $length -or $held.Length -ne $length -or -not (Test-DigestEqual $copied $expected) -or -not (Test-DigestEqual $reread $expected)) {
      $result = $exitMismatch
      $finalState = 'mismatch'
    } else {
      Write-HandoffStatus 'verified' 0
      $exited = $true
      if ($null -ne $parent) {
        try { $exited = $parent.WaitForExit($parentWaitMs) } catch { $exited = $true }
      }
      if (-not $exited) {
        $result = $exitAborted
        $finalState = 'aborted'
      } else {
        # Same arguments electron-updater gave the installer. It is started from the
        # verified copy while that copy is still held open without write sharing.
        $start = [Diagnostics.ProcessStartInfo]::new($payload, '--updated /S --force-run')
        $start.UseShellExecute = $false
        $start.WorkingDirectory = $staging
        foreach ($name in @($start.EnvironmentVariables.Keys)) {
          if ($name -match '^(?:NODE_|ELECTRON_|NPM_|COR_|COMPLUS_|CORECLR_|DOTNET_|PYTHON|PERL|RUBY|PSModulePath$)') { $start.EnvironmentVariables.Remove($name) }
        }
        $start.EnvironmentVariables['PATH'] = $system32 + ';' + $windows + ';' + [IO.Path]::Combine($system32, 'Wbem') + ';' + [IO.Path]::Combine($system32, 'WindowsPowerShell\v1.0')
        $installer = [Diagnostics.Process]::Start($start)
        $installer.WaitForExit()
        $installerExit = $installer.ExitCode
        if ($installerExit -eq 0) {
          $result = 0
          $finalState = 'installed'
        } else {
          $result = $exitInstallerFailed
          $finalState = 'install-failed'
        }
      }
    }
  }
} catch {
  $result = $exitFailed
  $finalState = 'failed'
} finally {
  if ($null -ne $sha) { try { $sha.Dispose() } catch { } }
  if ($null -ne $source) { try { $source.Dispose() } catch { } }
  if ($null -ne $copy) { try { $copy.Dispose() } catch { } }
  if ($null -ne $held) { try { $held.Dispose() } catch { } }
  # Only the file and the directory created above, never a recursive walk.
  if ($null -ne $staging) {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
      try {
        if ($null -ne $payload -and [IO.File]::Exists($payload)) { [IO.File]::Delete($payload) }
        if ([IO.Directory]::Exists($staging)) { [IO.Directory]::Delete($staging, $false) }
        break
      } catch {
        [Threading.Thread]::Sleep(500)
      }
    }
  }
  try { Write-HandoffStatus $finalState $installerExit } catch { }
  try { $statusStream.Dispose() } catch { }
}
exit $result
