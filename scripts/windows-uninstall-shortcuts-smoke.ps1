param([Parameter(Mandatory = $true)][string]$Installer)

# On machines that refuse writes to the public desktop and start menu,
# customInstall in build/installer.nsh puts the shortcuts in the installing
# user's own profile instead. The electron-builder uninstall section only
# deletes the all-users pair, so un.xingmangRemoveFallbackShortcuts deletes this
# pair on a real uninstall. It must leave the pair alone when an upgrade runs
# the previous uninstaller with --updated: the new installer does not recreate
# shortcuts then.
#
# A hosted runner can write the public desktop, so the fallback never fires
# here. The smoke plants the pair itself, next to a differently named shortcut
# that must survive, then upgrades twice (a plain reinstall over the installed
# copy, and an updater-style --updated one) and finally uninstalls for real.
#
# CI only. It writes shortcuts into the current user's desktop and start menu,
# and removes whatever of them is left in the finally block.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Check([bool]$condition, [string]$message) {
  if (-not $condition) { throw "CHECK FAILED: $message" }
  Write-Output "ok - $message"
}

function Install-App([string]$stage, [string[]]$switches) {
  # /D= has to come last: NSIS takes the rest of the command line as the path.
  $install = Start-Process -FilePath $Installer -ArgumentList (@('/S') + $switches + "/D=$installDir") -Wait -PassThru
  Check ($install.ExitCode -eq 0) "$stage exits 0 (got $($install.ExitCode))"
}

function New-Shortcut([string]$path, [string]$target) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $link.TargetPath = $target
  $link.Save()
}

function Assert-Present([string]$stage, [string[]]$paths, [bool]$expected) {
  $verb = if ($expected) { 'kept' } else { 'removed' }
  foreach ($path in $paths) { Check ((Test-Path -LiteralPath $path) -eq $expected) "$stage $verb $path" }
}

$installRoot = Join-Path ([IO.Path]::GetTempPath()) ('xingmang-shortcut-smoke-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$installDir = Join-Path $installRoot 'app'
# The folders NSIS means by $DESKTOP and $SMPROGRAMS after SetShellVarContext
# current, and by $DESKTOP in the all-users context.
$userDesktop = [Environment]::GetFolderPath('DesktopDirectory')
$userPrograms = [Environment]::GetFolderPath('Programs')
$publicDesktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$planted = @()

try {
  Install-App 'silent install' @()
  $exe = Get-ChildItem -LiteralPath $installDir -Filter '*.exe' | Where-Object { $_.Name -notlike 'Uninstall *' } | Select-Object -First 1
  $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall *.exe' | Select-Object -First 1
  Check ($null -ne $exe -and $null -ne $uninstaller) 'installed app and uninstaller found'

  # The fallback names its shortcuts after nsis.shortcutName, which is the same
  # string as the product name here; the template's own public shortcut proves it.
  $name = [IO.Path]::GetFileNameWithoutExtension($exe.Name) + '.lnk'
  $publicLink = Join-Path $publicDesktop $name
  Check (Test-Path -LiteralPath $publicLink) "the installer put $name on the public desktop"

  $fallbackLinks = @((Join-Path $userDesktop $name), (Join-Path $userPrograms $name))
  $otherLink = Join-Path $userDesktop ('copy of ' + $name)
  foreach ($link in $fallbackLinks + $otherLink) {
    # customInstall only falls back when the public copy is missing, so the
    # installer itself must not have put anything here.
    Check (-not (Test-Path -LiteralPath $link)) "nothing at $link before planting"
    New-Shortcut $link $exe.FullName
    $planted += $link
  }
  Assert-Present 'planting' ($fallbackLinks + $otherLink) $true

  # Running the new installer over the old copy runs the old uninstaller with
  # --updated; the updater adds --updated to the installer itself as well.
  Install-App 'reinstall over the installed copy' @()
  Assert-Present 'reinstall' ($fallbackLinks + $otherLink) $true
  Install-App 'updater-style upgrade' @('--updated')
  Assert-Present 'upgrade' ($fallbackLinks + $otherLink) $true

  # _?= keeps the uninstaller in place so -Wait covers the whole uninstall.
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S', "_?=$installDir") -Wait -PassThru
  Check ($uninstall.ExitCode -eq 0) "uninstall exits 0 (got $($uninstall.ExitCode))"
  Check (-not (Test-Path -LiteralPath $exe.FullName)) 'uninstall removed the app'
  Assert-Present 'uninstall' ($fallbackLinks + $publicLink) $false
  Assert-Present 'uninstall' @($otherLink) $true
} catch {
  Write-Output $_.ScriptStackTrace
  throw
} finally {
  if ($planted.Count -gt 0) { Remove-Item -LiteralPath $planted -Force -ErrorAction SilentlyContinue }
}
