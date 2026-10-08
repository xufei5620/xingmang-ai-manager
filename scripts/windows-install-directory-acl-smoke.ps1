param([Parameter(Mandatory = $true)][string]$Installer)

# Installing outside Program Files must leave the install directory writable by
# administrators and SYSTEM only (build/installer.nsh,
# xingmangLockInstallDirectory). A folder such as D:\XingMang otherwise
# inherits "Authenticated Users: Modify" from the drive root, while the elevated
# upgrade runs the old uninstaller from it, the elevated uninstaller runs the
# app from it, and the updater runs resources\elevate.exe from it.
#
# The smoke builds that folder in the root of the system drive (not under the
# temp folder: the runner spells that one with an 8.3 name, and the installer
# only touches a directory whose real path it can confirm), gives
# Authenticated Users modify on it the way a data drive's root does, and then:
#   1. installs into Program Files, where nothing may change;
#   2. installs into the loose folder: the directory and the files the elevated
#      steps run are locked down;
#   3. puts that install back the way an older version left it (inherited
#      permissions), adds a stray file and a junction to a folder outside, and
#      upgrades the way the updater does: locked again, the stray file too,
#      and the folder behind the junction keeps its permissions;
#   4. uninstalls.
#
# Accounts are named by SID, so the runner's display language does not matter.
# CI only; the finally block removes everything it made.

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
  Check ($null -ne (Get-AppExe $dir)) "$stage put the app in place"
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

function Invoke-Icacls([string[]]$arguments) {
  & (Join-Path $env:SystemRoot 'System32\icacls.exe') @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls $($arguments -join ' ') exited $LASTEXITCODE" }
}

$system = 'S-1-5-18'
$administrators = 'S-1-5-32-544'
$users = 'S-1-5-32-545'
$authenticatedUsers = 'S-1-5-11'
$trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
# Anything that lets the holder change the file, its permissions or its owner:
# write data, append, write extended attributes, delete child, write
# attributes, delete, change permissions, take ownership, generic all/write.
$writeBits = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000

function Get-OtherWriters([string]$path) {
  $acl = Get-Acl -LiteralPath $path
  $writers = @()
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne 'Allow') { continue }
    $sid = $rule.IdentityReference.Value
    if (@($system, $administrators, $trustedInstaller) -contains $sid) { continue }
    if (([int64][int]$rule.FileSystemRights -band $writeBits) -ne 0) { $writers += "$sid=$($rule.FileSystemRights)" }
  }
  return $writers
}

function Assert-LockedDown([string]$stage, [string]$dir, [string[]]$files) {
  $acl = Get-Acl -LiteralPath $dir
  Check $acl.AreAccessRulesProtected "after $stage, the install directory no longer inherits from its parent"
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  Check ($owner -eq $administrators) "after $stage, the install directory belongs to Administrators (got $owner)"
  $readers = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $users })
  Check ($readers.Count -gt 0) "after $stage, Users can still read and run the app"
  foreach ($path in @($dir) + $files) {
    $writers = Get-OtherWriters $path
    Check ($writers.Count -eq 0) "after $stage, only administrators and SYSTEM can change $path (also: $($writers -join ', '))"
  }
}

$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$drive = [IO.Path]::GetPathRoot($env:SystemRoot)
$looseRoot = Join-Path $drive ('xingmang-acl-smoke-' + $suffix)
$appDir = Join-Path $looseRoot 'app'
$outsideRoot = Join-Path $drive ('xingmang-acl-outside-' + $suffix)
$outsideTarget = Join-Path $outsideRoot 'target'
$outsideFile = Join-Path $outsideTarget 'keep.txt'
$link = Join-Path $appDir 'outside-link'
$programFilesDir = Join-Path $env:ProgramFiles ('xingmang-acl-smoke-' + $suffix)

try {
  # 1. The default location is already admin-only and must stay exactly as Windows set it up.
  Install-App 'install into Program Files' $programFilesDir @()
  Check (-not (Get-Acl -LiteralPath $programFilesDir).AreAccessRulesProtected) 'a Program Files install still inherits from Program Files'
  Uninstall-App 'uninstall from Program Files' $programFilesDir

  # 2. A folder every signed-in account may change, like a data drive's root.
  New-Item -ItemType Directory -Path $looseRoot | Out-Null
  Invoke-Icacls @($looseRoot, '/grant', "*${authenticatedUsers}:(OI)(CI)M")
  $probe = Join-Path $looseRoot 'probe.txt'
  Set-Content -LiteralPath $probe -Value 'probe'
  Check ((Get-OtherWriters $probe).Count -gt 0) 'files under the loose folder are writable by Authenticated Users'
  Remove-Item -LiteralPath $probe -Force

  Install-App 'install into the loose folder' $appDir @()
  $exe = (Get-AppExe $appDir).FullName
  $uninstaller = (Get-ChildItem -LiteralPath $appDir -Filter 'Uninstall *.exe' | Select-Object -First 1).FullName
  $elevate = Join-Path $appDir 'resources\elevate.exe'
  Check (Test-Path -LiteralPath $elevate) 'the updater helper is in the install directory'
  Assert-LockedDown 'install' $appDir @($exe, $uninstaller, $elevate)

  # 3. What an older version left behind: everything inherits from the loose folder again.
  Invoke-Icacls @($appDir, '/inheritance:e')
  Invoke-Icacls @($appDir, '/reset', '/T', '/C', '/Q')
  Check (-not (Get-Acl -LiteralPath $appDir).AreAccessRulesProtected) 'the install directory inherits from the loose folder again'
  Check ((Get-OtherWriters $uninstaller).Count -gt 0) 'the old uninstaller is writable by Authenticated Users again'
  $stray = Join-Path $appDir 'stray.txt'
  Set-Content -LiteralPath $stray -Value 'not ours'
  # A folder outside whose permissions inherit (so a change followed through the
  # junction would show), under a parent only administrators can read.
  New-Item -ItemType Directory -Path $outsideTarget -Force | Out-Null
  Invoke-Icacls @($outsideRoot, '/inheritance:r', '/grant:r', "*${administrators}:(OI)(CI)F", "*${system}:(OI)(CI)F")
  Set-Content -LiteralPath $outsideFile -Value 'keep'
  Check (-not (Get-Acl -LiteralPath $outsideTarget).AreAccessRulesProtected) 'the folder behind the junction inherits its permissions'
  $outsideBefore = @((Get-Acl -LiteralPath $outsideTarget).Sddl, (Get-Acl -LiteralPath $outsideFile).Sddl)
  New-Item -ItemType Junction -Path $link -Target $outsideTarget | Out-Null

  Install-App 'updater-style upgrade' $appDir @('--updated')
  Assert-LockedDown 'upgrade' $appDir @((Get-AppExe $appDir).FullName, $uninstaller, $elevate, $stray)
  Check ((Get-Item -LiteralPath $link -Force).LinkType -eq 'Junction') 'the junction is still a junction'
  $outsideAfter = @((Get-Acl -LiteralPath $outsideTarget).Sddl, (Get-Acl -LiteralPath $outsideFile).Sddl)
  Check ($outsideAfter[0] -eq $outsideBefore[0]) "the folder behind the junction kept its permissions (was $($outsideBefore[0]), now $($outsideAfter[0]))"
  Check ($outsideAfter[1] -eq $outsideBefore[1]) "the file behind the junction kept its permissions (was $($outsideBefore[1]), now $($outsideAfter[1]))"

  # The junction was there only to see where the lock goes; take it out before
  # the uninstaller walks the directory.
  [IO.Directory]::Delete($link)

  # 4.
  Uninstall-App 'uninstall from the loose folder' $appDir
  Check (Test-Path -LiteralPath $outsideFile) 'the file behind the junction is still there'
} catch {
  Write-Output $_.ScriptStackTrace
  throw
} finally {
  # A failure here must not hide the one that brought us here.
  if (Test-Path -LiteralPath $link) {
    try { [IO.Directory]::Delete($link) } catch { Write-Output "could not remove the junction: $_" }
  }
  foreach ($dir in $programFilesDir, $looseRoot, $outsideRoot) {
    if (Test-Path -LiteralPath $dir) {
      try { Remove-Item -LiteralPath $dir -Recurse -Force } catch { Write-Output "could not remove ${dir}: $_" }
    }
  }
}
