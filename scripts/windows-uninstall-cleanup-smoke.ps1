param([Parameter(Mandatory = $true)][string]$Installer)

# Installs the freshly built NSIS package, leaves the machine in the state an
# uninstall meets while acceleration is on (system proxy pointing at a local
# port nobody listens on any more, recovery journal on disk, login item in the
# Run key), then clears it twice: once by starting the installed exe with the
# cleanup switch directly (tells a broken cleanup apart from an uninstaller
# that never calls it), once through the real silent uninstaller. Each time
# the proxy must be back to what it was, the journal gone, the login item
# removed.
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
$dataDirectory = Join-Path $env:APPDATA 'xingmang-ai-manager\acceleration-development'
$journalPath = Join-Path $dataDirectory 'proxy-lease.json'
$leasePath = "$journalPath.lock"
$runKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$loginItemName = 'com.xingmang.ai.manager'
$original = Read-State

try {
  Check (-not (Test-Path -LiteralPath $journalPath) -and -not (Test-Path -LiteralPath $leasePath)) 'runner starts without a recovery journal'

  $install = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$installDir" -Wait -PassThru
  Check ($install.ExitCode -eq 0) "silent install exits 0 (got $($install.ExitCode))"
  $exe = Get-ChildItem -LiteralPath $installDir -Filter '*.exe' | Where-Object { $_.Name -notlike 'Uninstall *' } | Select-Object -First 1
  $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall *.exe' | Select-Object -First 1
  Check ($null -ne $exe -and $null -ne $uninstaller) 'installed app and uninstaller found'

  # A distinct "before" proves the cleanup writes back the recorded original,
  # not merely "proxy off".
  $before = [ordered]@{
    flags = 3; server = 'http://localhost:15236'; bypass = 'smoke-bypass'; autoConfigUrl = ''
    registry = [ordered]@{ ProxyEnable = 1; ProxyServer = 'http://localhost:15236'; ProxyOverride = 'smoke-bypass'; AutoConfigURL = $null }
  }
  Write-State $before
  Check (Same-State (Read-State) $before) 'original user proxy installed'

  # Stage 1: the cleanup entry on its own, so a failure below can be told apart
  # from the uninstaller never reaching it.
  Set-AccelerationLeftOn $exe.FullName
  $cleanupErrors = Join-Path $installRoot 'cleanup-stderr.txt'
  $direct = Start-Process -FilePath $exe.FullName -ArgumentList '--xingmang-uninstall-cleanup' -RedirectStandardError $cleanupErrors -Wait -PassThru
  Show-Diagnostics "direct cleanup exit code $($direct.ExitCode)"
  if (Test-Path -LiteralPath $cleanupErrors) { Get-Content -LiteralPath $cleanupErrors -Encoding utf8 | ForEach-Object { Write-Output "cleanup stderr: $_" } }
  Check ($direct.ExitCode -eq 0) "direct cleanup exits 0 (got $($direct.ExitCode))"
  Assert-Cleaned 'direct cleanup'

  # Stage 2: the real uninstaller.
  Set-AccelerationLeftOn $exe.FullName
  # _?= keeps the uninstaller in place so -Wait covers the whole uninstall.
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S', "_?=$installDir" -Wait -PassThru
  Check ($uninstall.ExitCode -eq 0) "silent uninstall exits 0 (got $($uninstall.ExitCode))"

  Show-Diagnostics 'after uninstall'
  Check (-not (Test-Path -LiteralPath $exe.FullName)) 'uninstall removed the app'
  Assert-Cleaned 'uninstall'
} catch {
  Write-Output $_.ScriptStackTrace
  throw
} finally {
  try { Write-State $original } catch { Write-Warning 'could not restore the runner proxy' }
  Remove-ItemProperty -Path $runKeyPath -Name $loginItemName -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $journalPath, $leasePath -Force -ErrorAction SilentlyContinue
}
