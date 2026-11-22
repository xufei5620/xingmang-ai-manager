param(
  [Parameter(Mandatory = $true)][string]$Installer,
  # The installer customers have now. The second scenario starts from it, so the
  # upgrade runs its uninstaller against the manifest, the way it does on a
  # customer's machine. Without it the freshly built installer stands in.
  [string]$ReleasedInstaller = ''
)

# Files a customer or an administrator puts into the install folder are theirs:
# upgrades and uninstalls must leave them alone (11-18 recheck D05).
#
# Every install writes a manifest of the install folder's top-level entries
# (build/installer.nsh, xingmangRecordInstalledEntries), and every upgrade and
# uninstall moves aside or deletes exactly what it names. The installer used to
# record whatever it found in the folder, so a file the customer added after
# one install was kept by the next upgrade's uninstaller, then recorded by that
# upgrade's installer as if it were ours, and deleted by the upgrade after
# that. The installer now records only what the package itself carries (the
# list scripts/windows-installer-package-entries.cjs writes at packaging time)
# plus its uninstaller, and before running an older version's uninstaller it
# strikes from that version's manifest whatever is not ours.
#
# Two scenarios:
#   1. install, add the customer's things, upgrade twice, uninstall: they are
#      never recorded and are still there at the end, while the app is gone;
#   2. an install from before this fix that already recorded them (its manifest
#      has no Format value): upgrading keeps them and records only ours.
#
# CI only; the finally block removes what it made.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Check([bool]$condition, [string]$message) {
  if (-not $condition) { throw "CHECK FAILED: $message" }
  Write-Output "ok - $message"
}

function Get-AppExe([string]$dir) {
  return Get-ChildItem -LiteralPath $dir -Filter '*.exe' | Where-Object { $_.Name -notlike 'Uninstall *' } | Select-Object -First 1
}

function Get-Uninstaller([string]$dir) {
  return Get-ChildItem -LiteralPath $dir -Filter 'Uninstall *.exe' | Select-Object -First 1
}

# Runs an installer silently and expects it to finish on its own. A dialog
# would leave it waiting, so a run that outlives the bound fails the check
# instead of the step's timeout.
function Invoke-Installer([string]$stage, [string]$path, [string[]]$switches, [string]$dir) {
  # /D= has to come last: NSIS takes the rest of the command line as the path.
  $process = Start-Process -FilePath $path -ArgumentList (@('/S') + $switches + "/D=$dir") -PassThru
  # Without touching the handle before the process ends, ExitCode stays empty.
  $null = $process.Handle
  if (-not $process.WaitForExit(900000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "CHECK FAILED: $stage did not finish within 15 minutes (a dialog is probably waiting)"
  }
  Check ($process.ExitCode -eq 0) "$stage exits 0 (got $($process.ExitCode))"
  Check ($null -ne (Get-AppExe $dir)) "$stage left the app in place"
}

# A real uninstall, no --updated. _?= keeps the uninstaller in place so -Wait
# covers the whole run; for the same reason the uninstaller itself stays behind.
function Invoke-Uninstall([string]$stage, [string]$dir) {
  $uninstaller = Get-Uninstaller $dir
  Check ($null -ne $uninstaller) "$stage found the uninstaller"
  $run = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S', "_?=$dir") -Wait -PassThru
  Check ($run.ExitCode -eq 0) "$stage exits 0 (got $($run.ExitCode))"
}

# The manifest the installer leaves under HKLM\Software\<app guid>, found by
# the install location so the guid does not have to be spelled out here.
function Get-ManifestKey([string]$dir) {
  foreach ($key in Get-ChildItem -LiteralPath 'HKLM:\SOFTWARE') {
    $location = $key.GetValue('InstallLocation', $null)
    if ($location -ne $dir) { continue }
    $entries = Join-Path $key.PSPath 'InstalledEntries'
    if (Test-Path -LiteralPath $entries) { return $entries }
  }
  # throw rather than Check: whatever Check prints would land in the result.
  throw "CHECK FAILED: the install of $dir left no manifest"
}

function Get-ManifestEntries([string]$dir) {
  $item = Get-Item -LiteralPath (Get-ManifestKey $dir)
  $names = @()
  for ($i = 0; $i -lt [int]$item.GetValue('Count'); $i++) {
    $name = $item.GetValue("$i", $null)
    if ($name) { $names += $name }
  }
  return $names
}

function Get-ManifestFormat([string]$dir) {
  return (Get-Item -LiteralPath (Get-ManifestKey $dir)).GetValue('Format', $null)
}

# What the customer adds. ffmpeg.dll.bak and resources-old sit right next to
# names the package does carry, so a match on part of a name would show up;
# the Chinese name ("my notes", written as code points so the script stays
# ASCII whatever encoding the shell assumes) goes through the registry and
# back.
$chineseName = [string][char]0x6211 + [char]0x7684 + [char]0x7B14 + [char]0x8BB0 + '.txt'
$customerFiles = @('customer-notes.txt', 'ffmpeg.dll.bak', $chineseName, 'resources-old\keep.txt')
$customerTopLevel = @('customer-notes.txt', 'ffmpeg.dll.bak', $chineseName, 'resources-old')

function Add-CustomerFiles([string]$dir) {
  foreach ($relative in $customerFiles) {
    $path = Join-Path $dir $relative
    $parent = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent }
    [IO.File]::WriteAllText($path, "the customer's own: $relative")
  }
}

function Assert-CustomerFilesKept([string]$stage, [string]$dir) {
  foreach ($relative in $customerFiles) {
    $path = Join-Path $dir $relative
    $kept = (Test-Path -LiteralPath $path -PathType Leaf) -and ([IO.File]::ReadAllText($path) -eq "the customer's own: $relative")
    Check $kept "$stage kept the customer's $relative"
  }
}

function Assert-ManifestIsOurs([string]$stage, [string]$dir) {
  $entries = Get-ManifestEntries $dir
  Write-Output "$stage manifest: $($entries -join ', ')"
  $recorded = @($customerTopLevel | Where-Object { $entries -contains $_ })
  Check ($recorded.Count -eq 0) "$stage did not record the customer's things as ours (recorded: $($recorded -join ', '))"
  $exe = Get-AppExe $dir
  foreach ($name in @($exe.Name, 'resources', 'locales', (Get-Uninstaller $dir).Name)) {
    Check ($entries -contains $name) "$stage recorded $name"
  }
  $format = Get-ManifestFormat $dir
  Check ($format -eq 2) "$stage marked the manifest as recording only the package (Format: $format)"
}

function Assert-AppRemoved([string]$stage, [string]$dir, [string]$exeName) {
  Check (-not (Test-Path -LiteralPath (Join-Path $dir $exeName))) "$stage removed the app"
  Check (-not (Test-Path -LiteralPath (Join-Path $dir 'resources'))) "$stage removed the resources folder"
  Check (-not (Test-Path -LiteralPath (Join-Path $dir 'locales'))) "$stage removed the locales folder"
}

function Remove-Install([string]$dir) {
  # Clears the registry too, so the next scenario starts from a machine without
  # the app instead of upgrading whatever this one left behind.
  $uninstaller = if (Test-Path -LiteralPath $dir) { Get-Uninstaller $dir } else { $null }
  if ($null -ne $uninstaller) {
    $run = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S', "_?=$dir") -Wait -PassThru
    if ($run.ExitCode -ne 0) { Write-Output "cleanup: uninstalling $dir exited $($run.ExitCode)" }
  }
  if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
# Not under the temp folder: the runner spells that one with an 8.3 name, and
# the manifest is found by comparing InstallLocation with this path.
$root = $env:SystemDrive + '\'
$failures = @()
$scenarioCount = 0

function Invoke-Scenario([string]$name, [scriptblock]$body) {
  $script:scenarioCount++
  $dir = Join-Path $root "xingmang-user-files-smoke-$suffix-$($script:scenarioCount)"
  Write-Output "--- $name"
  try {
    & $body $dir
  } catch {
    Write-Output $_.ScriptStackTrace
    Write-Output "FAILED: $name - $_"
    $script:failures += "$name - $_"
  } finally {
    try { Remove-Install $dir } catch { Write-Output "cleanup of ${dir}: $_" }
  }
}

Invoke-Scenario 'what the customer adds is never recorded and outlives two upgrades and an uninstall' {
  param($dir)
  Invoke-Installer 'first install' $Installer @() $dir
  Assert-ManifestIsOurs 'first install' $dir
  $exeName = (Get-AppExe $dir).Name
  Add-CustomerFiles $dir
  # The first upgrade's installer is where the customer's things used to get
  # recorded; the second upgrade's uninstaller is where they then went.
  foreach ($round in 1, 2) {
    Invoke-Installer "upgrade $round" $Installer @('--updated') $dir
    Assert-CustomerFilesKept "upgrade $round" $dir
    Assert-ManifestIsOurs "upgrade $round" $dir
  }
  Invoke-Uninstall 'uninstalling' $dir
  Assert-AppRemoved 'uninstalling' $dir $exeName
  Assert-CustomerFilesKept 'uninstalling' $dir
}

Invoke-Scenario 'an install from before this fix recorded the customer''s things' {
  param($dir)
  if ($ReleasedInstaller) {
    Invoke-Installer 'installing the released version' $ReleasedInstaller @() $dir
  } else {
    Invoke-Installer 'first install' $Installer @() $dir
  }
  $exeName = (Get-AppExe $dir).Name
  Add-CustomerFiles $dir
  # Make the manifest what an installer from before this fix leaves after an
  # upgrade: the customer's things recorded next to ours, no Format value.
  $key = Get-ManifestKey $dir
  $count = [int](Get-Item -LiteralPath $key).GetValue('Count')
  foreach ($name in $customerTopLevel) {
    $null = New-ItemProperty -LiteralPath $key -Name "$count" -Value $name -PropertyType String -Force
    $count++
  }
  $null = New-ItemProperty -LiteralPath $key -Name 'Count' -Value $count -PropertyType DWord -Force
  Remove-ItemProperty -LiteralPath $key -Name 'Format' -ErrorAction SilentlyContinue
  $entries = Get-ManifestEntries $dir
  Check (@($customerTopLevel | Where-Object { $entries -notcontains $_ }).Count -eq 0) "the old manifest records the customer's things (entries: $($entries -join ', '))"

  # The installed uninstaller moves aside and deletes everything its manifest
  # names: only the new installer can keep the customer's things out of it.
  Invoke-Installer 'upgrading over the old manifest' $Installer @('--updated') $dir
  Assert-CustomerFilesKept 'upgrading over the old manifest' $dir
  Assert-ManifestIsOurs 'upgrading over the old manifest' $dir
  Invoke-Uninstall 'uninstalling' $dir
  Assert-AppRemoved 'uninstalling' $dir $exeName
  Assert-CustomerFilesKept 'uninstalling' $dir
}

if ($failures.Count -gt 0) {
  throw "CHECK FAILED in $($failures.Count) scenario(s):`n$($failures -join "`n")"
}
