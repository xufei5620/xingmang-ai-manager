param([Parameter(Mandatory = $true)][string]$Installer)

# Installs the freshly built NSIS package, leaves the machine in the state an
# uninstall meets while acceleration is on (system proxy pointing at a local
# port nobody listens on any more, recovery journal on disk, login item in the
# Run key), then clears it several ways: by starting the installed exe with the
# cleanup switch directly (tells a broken cleanup apart from an uninstaller
# that never calls it), with and without the clear-login switch, then through
# the real silent uninstaller, once plain and once (after reinstalling) with
# the clear-login switch the uninstall page's checkbox stands for. Each time
# the proxy must be back to what it was, the journal gone, the login item
# removed; the saved sign-in must survive unless clearing it was asked for,
# and the stored CLI keys must survive either way.
#
# The acceleration worker itself is not started: the uninstaller kills it
# before customUnInstall runs, so "journal present, owner dead" is exactly the
# state the cleanup sees on a customer machine.
#
# CI only. It rewrites the current user's system proxy and Run key, and puts
# both back in the finally block.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'windows-acceleration-recovery.ps1')
Initialize-WinInet

function Check([bool]$condition, [string]$message) {
  if (-not $condition) { throw "CHECK FAILED: $message" }
  Write-Output "ok - $message"
}

function Set-AccelerationLeftOn([string]$exePath) {
  $port = 57448
  $endpoint = "http=127.0.0.1:$port;https=127.0.0.1:$port"
  $bypass = '<local>;localhost;127.0.0.1;[::1]'
  $applied = [ordered]@{
    flags = 3; server = $endpoint; bypass = $bypass; autoConfigUrl = ''
    registry = [ordered]@{ ProxyEnable = 1; ProxyServer = $endpoint; ProxyOverride = $bypass; AutoConfigURL = $null }
  }
  # An owner that has already exited, as the killed worker has by now.
  $gone = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\whoami.exe') -WindowStyle Hidden -Wait -PassThru
  $owner = [ordered]@{ pid = $gone.Id; startedAt = $gone.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) }
  $id = [Guid]::NewGuid().ToString()
  $utf8 = [Text.UTF8Encoding]::new($false)
  New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
  [IO.File]::WriteAllText($leasePath, (([ordered]@{ version = 1; id = $id; owner = $owner }) | ConvertTo-Json -Depth 8 -Compress), $utf8)
  [IO.File]::WriteAllText($journalPath, (([ordered]@{ version = 1; id = $id; owner = $owner; before = $before; applied = $applied }) | ConvertTo-Json -Depth 8 -Compress), $utf8)
  Write-State $applied
  Check (Same-State (Read-State) $applied) 'system proxy points at the dead acceleration port'
  # Fresh runner profiles may have no Run key yet; never recreate an existing one
  # (New-Item -Force on a registry key would drop its values).
  if (-not (Test-Path -LiteralPath $runKeyPath)) { New-Item -Path $runKeyPath | Out-Null }
  New-ItemProperty -Path $runKeyPath -Name $loginItemName -Value "`"$exePath`" --launched-at-login" -PropertyType String -Force | Out-Null
  Check ($null -ne (Get-LoginItem)) 'login item registered'
}

function Get-LoginItem {
  $item = Get-ItemProperty -Path $runKeyPath -Name $loginItemName -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  return $item.$loginItemName
}

function Set-SignedIn {
  foreach ($file in $loginRecords + $keptFiles) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
    [IO.File]::WriteAllText($file, 'smoke')
  }
}

function Assert-SignIn([string]$stage, [bool]$expectKept) {
  $verb = if ($expectKept) { 'kept' } else { 'removed' }
  foreach ($file in $loginRecords) {
    Check ((Test-Path -LiteralPath $file) -eq $expectKept) "$stage $verb $file"
  }
  foreach ($file in $keptFiles) { Check (Test-Path -LiteralPath $file) "$stage kept $file" }
}

function Install-App {
  $install = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$installDir" -Wait -PassThru
  Check ($install.ExitCode -eq 0) "silent install exits 0 (got $($install.ExitCode))"
  $script:exe = Get-ChildItem -LiteralPath $installDir -Filter '*.exe' | Where-Object { $_.Name -notlike 'Uninstall *' } | Select-Object -First 1
  $script:uninstaller = Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall *.exe' | Select-Object -First 1
  Check ($null -ne $script:exe -and $null -ne $script:uninstaller) 'installed app and uninstaller found'
}

function Invoke-DirectCleanup([string]$stage, [string[]]$arguments) {
  $cleanupErrors = Join-Path $installRoot 'cleanup-stderr.txt'
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $direct = Start-Process -FilePath $exe.FullName -ArgumentList $arguments -RedirectStandardError $cleanupErrors -Wait -PassThru
  Show-Diagnostics "$stage exit code $($direct.ExitCode) after $([int]$clock.Elapsed.TotalSeconds)s"
  if (Test-Path -LiteralPath $cleanupErrors) { Get-Content -LiteralPath $cleanupErrors -Encoding utf8 | ForEach-Object { Write-Output "cleanup stderr: $_" } }
  Check ($direct.ExitCode -eq 0) "$stage exits 0 (got $($direct.ExitCode))"
  Assert-Cleaned $stage
}

function Invoke-Uninstall([string]$stage, [string[]]$arguments) {
  # _?= keeps the uninstaller in place so -Wait covers the whole uninstall.
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList ($arguments + "_?=$installDir") -Wait -PassThru
  Write-Output "$stage took $([int]$clock.Elapsed.TotalSeconds)s"
  Check ($uninstall.ExitCode -eq 0) "$stage exits 0 (got $($uninstall.ExitCode))"
  Show-Diagnostics "after $stage"
  Check (-not (Test-Path -LiteralPath $exe.FullName)) "$stage removed the app"
  Assert-Cleaned $stage
}

function Show-Diagnostics([string]$stage) {
  Write-Output "--- $stage"
  Write-Output ('proxy: ' + ((Read-State) | ConvertTo-Json -Depth 8 -Compress))
  Write-Output ('journal present: ' + (Test-Path -LiteralPath $journalPath) + '; lease present: ' + (Test-Path -LiteralPath $leasePath))
  Write-Output ('login item: ' + (Get-LoginItem))
  Get-ChildItem -LiteralPath $env:APPDATA -Directory | Where-Object { $_.Name -like 'xingmang*' -or $_.Name -like '*AI*' } |
    ForEach-Object { Write-Output ('appdata dir: ' + $_.Name) }
}

function Assert-Cleaned([string]$stage) {
  Check ($null -eq (Get-LoginItem)) "$stage removed the login item"
  Check (-not (Test-Path -LiteralPath $journalPath) -and -not (Test-Path -LiteralPath $leasePath)) "$stage removed the recovery journal and lease"
  Check (Same-State (Read-State) $before) "$stage restored the system proxy to the recorded original"
}

$installRoot = Join-Path ([IO.Path]::GetTempPath()) ('xingmang-uninstall-smoke-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$installDir = Join-Path $installRoot 'app'
$userData = Join-Path $env:APPDATA 'xingmang-ai-manager'
$dataDirectory = Join-Path $userData 'acceleration-development'
$journalPath = Join-Path $dataDirectory 'proxy-lease.json'
$leasePath = "$journalPath.lock"
# The files electron/uninstall-cleanup.ts loginRecordFiles names, and two that
# must never go with them.
$loginRecords = @('account-session.dat', 'saved-accounts.dat', 'realm-accounts-v2.dat', 'account-credentials.dat', 'realms\api-account\account-credentials.dat') |
  ForEach-Object { Join-Path $userData $_ }
$keptFiles = @('managed-cli-keys.dat', 'settings.json') | ForEach-Object { Join-Path $userData $_ }
$runKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$loginItemName = 'com.xingmang.ai.manager'
$original = Read-State

try {
  Check (-not (Test-Path -LiteralPath $journalPath) -and -not (Test-Path -LiteralPath $leasePath)) 'runner starts without a recovery journal'
  Check (-not (Test-Path -LiteralPath $loginRecords[0])) 'runner starts signed out'
  Install-App

  # A distinct "before" proves the cleanup writes back the recorded original,
  # not merely "proxy off".
  $before = [ordered]@{
    flags = 3; server = 'http://localhost:15236'; bypass = 'smoke-bypass'; autoConfigUrl = ''
    registry = [ordered]@{ ProxyEnable = 1; ProxyServer = 'http://localhost:15236'; ProxyOverride = 'smoke-bypass'; AutoConfigURL = $null }
  }
  Write-State $before
  Check (Same-State (Read-State) $before) 'original user proxy installed'
  Set-SignedIn

  # Stage 1: the cleanup entry on its own, so a failure below can be told apart
  # from the uninstaller never reaching it. Without the switch the sign-in stays.
  Set-AccelerationLeftOn $exe.FullName
  Invoke-DirectCleanup 'direct cleanup' @('--xingmang-uninstall-cleanup')
  Assert-SignIn 'direct cleanup' $true

  Set-AccelerationLeftOn $exe.FullName
  Invoke-DirectCleanup 'direct cleanup with clear-login' @('--xingmang-uninstall-cleanup', '--xingmang-clear-login')
  Assert-SignIn 'direct cleanup with clear-login' $false

  # Stage 2: the real uninstaller with the box left unticked, the default.
  Set-SignedIn
  Set-AccelerationLeftOn $exe.FullName
  Invoke-Uninstall 'uninstall' @('/S')
  Assert-SignIn 'uninstall' $true

  # Stage 3: reinstall, then uninstall with the switch a ticked box stands for.
  Install-App
  Set-AccelerationLeftOn $exe.FullName
  Invoke-Uninstall 'uninstall with clear-login' @('/S', '--xingmang-clear-login')
  Assert-SignIn 'uninstall with clear-login' $false
} catch {
  Write-Output $_.ScriptStackTrace
  throw
} finally {
  try { Write-State $original } catch { Write-Warning 'could not restore the runner proxy' }
  Remove-ItemProperty -Path $runKeyPath -Name $loginItemName -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $journalPath, $leasePath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ($loginRecords + $keptFiles) -Force -ErrorAction SilentlyContinue
}
