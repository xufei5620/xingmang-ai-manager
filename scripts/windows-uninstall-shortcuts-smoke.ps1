param([Parameter(Mandatory = $true)][string]$Installer)

# On machines that refuse writes to the public desktop and start menu,
# customInstall in build/installer.nsh puts the shortcuts in the installing
# user's own profile instead. The electron-builder uninstall section only
# deletes the all-users pair, so un.xingmangRemoveFallbackShortcuts deletes this
# pair on a real uninstall. It must leave the pair alone when an upgrade runs
# the previous uninstaller with --updated: the new installer does not recreate
# shortcuts then.
#
# The smoke turns the runner into such a machine: everyone is denied adding
# files to the public desktop and the all-users start menu, so the installer
# writes the pair itself. It then upgrades twice (a plain reinstall over the
# installed copy, and an updater-style --updated one), uninstalls for real,
# and installs into another folder, where the pair has to come back (a leftover
# pair used to stop that).
#
# The uninstaller runs elevated and the pair sits where the user's own
# programs can write, so it must not delete through links. Before the second
# uninstall the desktop is pointed at a junction and the start menu shortcut
# is swapped for a symbolic link; neither, nor what they point at, may go.
#
# CI only. It changes the ACLs of the two all-users folders, the current
# user's desktop location, and writes into the current user's desktop and
# start menu; the finally block undoes all of it.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Check([bool]$condition, [string]$message) {
  if (-not $condition) { throw "CHECK FAILED: $message" }
  Write-Output "ok - $message"
}

function Get-AppExe([string]$dir) {
  return Get-ChildItem -LiteralPath $dir -Filter '*.exe' | Where-Object { $_.Name -notlike 'Uninstall *' } | Select-Object -First 1
}

function Install-App([string]$stage, [string]$dir, [string[]]$switches) {
  # /D= has to come last: NSIS takes the rest of the command line as the path.
  $install = Start-Process -FilePath $Installer -ArgumentList (@('/S') + $switches + "/D=$dir") -Wait -PassThru
  Check ($install.ExitCode -eq 0) "$stage exits 0 (got $($install.ExitCode))"
}

function Uninstall-App([string]$stage, [string]$dir) {
  $exe = Get-AppExe $dir
  $uninstaller = Get-ChildItem -LiteralPath $dir -Filter 'Uninstall *.exe' | Select-Object -First 1
  Check ($null -ne $exe -and $null -ne $uninstaller) "$stage found the app and its uninstaller"
  # _?= keeps the uninstaller in place so -Wait covers the whole uninstall.
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S', "_?=$dir") -Wait -PassThru
  Check ($uninstall.ExitCode -eq 0) "$stage exits 0 (got $($uninstall.ExitCode))"
  Check (-not (Test-Path -LiteralPath $exe.FullName)) "$stage removed the app"
}

function Set-AddFileDenied([string]$dir, [bool]$denied) {
  # Everyone by SID, so the runner's display language does not matter. WD on a
  # folder is "add file"; without (OI)(CI) nothing inside inherits the deny.
  $arguments = if ($denied) { @($dir, '/deny', '*S-1-1-0:(WD)') } else { @($dir, '/remove:d', '*S-1-1-0') }
  & (Join-Path $env:SystemRoot 'System32\icacls.exe') @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls $($arguments -join ' ') exited $LASTEXITCODE" }
}

function Get-Links([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return @() }
  return @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -Force | ForEach-Object { $_.Name })
}

function Assert-Links([string]$stage, [string[]]$paths, [bool]$expected) {
  $state = if ($expected) { 'is there' } else { 'is gone' }
  foreach ($path in $paths) { Check ((Test-Path -LiteralPath $path) -eq $expected) "after $stage, $path $state" }
}

$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$installRoot = Join-Path ([IO.Path]::GetTempPath()) ('xingmang-shortcut-smoke-' + $suffix)
$firstDir = Join-Path $installRoot 'first'
$secondDir = Join-Path $installRoot 'second'
# Not under the temp folder: that one is spelled with an 8.3 name on the
# runner, which alone would make the uninstaller refuse the redirected path.
$linkRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('xingmang-shortcut-links-' + $suffix)
$shellFolders = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
$savedDesktop = $null
# What NSIS means by $DESKTOP and $SMPROGRAMS in the all-users context, and
# after SetShellVarContext current.
$publicDesktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$publicPrograms = [Environment]::GetFolderPath('CommonPrograms')
$userDesktop = [Environment]::GetFolderPath('DesktopDirectory')
$userPrograms = [Environment]::GetFolderPath('Programs')
$denied = @()
$leftovers = @()

try {
  $before = @{}
  foreach ($dir in $publicDesktop, $publicPrograms, $userDesktop, $userPrograms) { $before[$dir] = @(Get-Links $dir) }
  foreach ($dir in $publicDesktop, $publicPrograms) {
    Set-AddFileDenied $dir $true
    $denied += $dir
  }

  Install-App 'first install' $firstDir @()
  $exe = Get-AppExe $firstDir
  Check ($null -ne $exe) 'first install put the app in place'
  # nsis.shortcutName is the product name, which also names the exe.
  $name = [IO.Path]::GetFileNameWithoutExtension($exe.Name) + '.lnk'
  $added = @{}
  foreach ($dir in $before.Keys) { $added[$dir] = @(Get-Links $dir | Where-Object { $before[$dir] -notcontains $_ }) -join ', ' }
  Check ($added[$publicDesktop] -eq '') "the installer could not write the public desktop (added: $($added[$publicDesktop]))"
  Check ($added[$publicPrograms] -eq '') "the installer could not write the all-users start menu (added: $($added[$publicPrograms]))"
  Check ($added[$userDesktop] -eq $name) "the installer fell back to $name on the user's desktop (added: $($added[$userDesktop]))"
  Check ($added[$userPrograms] -eq $name) "the installer fell back to $name in the user's start menu (added: $($added[$userPrograms]))"

  $fallbackLinks = @((Join-Path $userDesktop $name), (Join-Path $userPrograms $name))
  # A shortcut the user made or renamed is not the installer's to delete.
  $otherLink = Join-Path $userDesktop ('copy of ' + $name)
  $leftovers = $fallbackLinks + $otherLink
  Copy-Item -LiteralPath $fallbackLinks[0] -Destination $otherLink

  # Running the new installer over the old copy runs the old uninstaller with
  # --updated; the updater adds --updated to the installer itself as well.
  Install-App 'reinstall over the installed copy' $firstDir @()
  Assert-Links 'reinstall' ($fallbackLinks + $otherLink) $true
  Install-App 'updater-style upgrade' $firstDir @('--updated')
  Assert-Links 'upgrade' ($fallbackLinks + $otherLink) $true

  Uninstall-App 'uninstall' $firstDir
  Assert-Links 'uninstall' $fallbackLinks $false
  Assert-Links 'uninstall' @($otherLink) $true

  # A leftover pair used to make the next install skip the fallback.
  Install-App 'install into another folder' $secondDir @()
  Assert-Links 'install into another folder' $fallbackLinks $true

  # What the user's own programs could set up for the elevated uninstaller: a
  # desktop whose path runs through a junction, with a file of the right name
  # behind it, and a symbolic link with the right name in the start menu.
  $realDesk = Join-Path $linkRoot 'desk'
  $junctionDesk = Join-Path $linkRoot 'desk-junction'
  New-Item -ItemType Directory -Force -Path $realDesk | Out-Null
  New-Item -ItemType Junction -Path $junctionDesk -Target $realDesk | Out-Null
  $behindJunction = Join-Path $realDesk $name
  Copy-Item -LiteralPath $fallbackLinks[0] -Destination $behindJunction
  $symlinkTarget = Join-Path $linkRoot ('target of ' + $name)
  Move-Item -LiteralPath $fallbackLinks[1] -Destination $symlinkTarget
  New-Item -ItemType SymbolicLink -Path $fallbackLinks[1] -Target $symlinkTarget | Out-Null
  $savedDesktop = (Get-Item -LiteralPath $shellFolders).GetValue('Desktop', $null, 'DoNotExpandEnvironmentNames')
  Check ($null -ne $savedDesktop) 'the current user has a desktop location to restore'
  New-ItemProperty -LiteralPath $shellFolders -Name 'Desktop' -Value $junctionDesk -PropertyType ExpandString -Force | Out-Null

  Uninstall-App 'uninstall through links' $secondDir
  # Still there means the uninstaller read the moved desktop, not the old one.
  Check (Test-Path -LiteralPath $fallbackLinks[0]) 'the uninstaller worked on the moved desktop'
  Check (Test-Path -LiteralPath $behindJunction) 'the shortcut behind the desktop junction is still there'
  Check ((Get-Item -LiteralPath $fallbackLinks[1] -Force).LinkType -eq 'SymbolicLink') 'the symbolic link in the start menu is still there'
  Check (Test-Path -LiteralPath $symlinkTarget) 'the file the symbolic link points at is still there'
} catch {
  Write-Output $_.ScriptStackTrace
  throw
} finally {
  # A failure here must not hide the one that brought us here.
  if ($null -ne $savedDesktop) {
    try { New-ItemProperty -LiteralPath $shellFolders -Name 'Desktop' -Value $savedDesktop -PropertyType ExpandString -Force | Out-Null } catch { Write-Output "could not restore the desktop location: $_" }
  }
  foreach ($dir in $denied) {
    try { Set-AddFileDenied $dir $false } catch { Write-Output "could not restore the ACL of ${dir}: $_" }
  }
  if ($leftovers.Count -gt 0) { Remove-Item -LiteralPath $leftovers -Force -ErrorAction SilentlyContinue }
}
