param(
  [Parameter(Mandatory = $true)][string]$Installer,
  # The installer customers have now. Installed first, so the upgrades below run
  # its uninstaller, the way they do on a customer's machine. Without it the
  # freshly built installer stands in for the old version as well.
  [string]$ReleasedInstaller = ''
)

# Every upgrade runs the installed version's uninstaller with --updated before
# the new files go in. That uninstaller moves each entry of the install
# manifest aside (build/installer.nsh, un.xingmangRemoveInstalledFiles) and, as
# soon as one cannot be moved, puts back what it moved and gives up with exit
# code 2. The template's installer then showed "Failed to uninstall old
# application files. Please try running the installer again.: 2" and quit:
# English, no way forward, and on an updater-run (silent) upgrade the only
# thing the customer sees.
#
# The smoke drives the two ways an entry cannot be moved:
#   1. the manifest names a file that is no longer there. The uninstallers up
#      to 0.2.22 count that as "cannot move" every time, so the machine could
#      never upgrade again; the installer now drops such entries from the
#      manifest before it runs the old uninstaller, and the new uninstaller
#      skips them by itself;
#   2. another program holds a file open. The installer now says so in Chinese
#      and offers to retry; cancelling leaves the old version in place,
#      retrying once the file is free finishes the upgrade.
#
# The dialogs are found and answered through the Win32 API, so a regression
# shows up as a failed check instead of an installer waiting for a click until
# the step times out. CI only; the finally block removes what it made.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Check([bool]$condition, [string]$message) {
  if (-not $condition) { throw "CHECK FAILED: $message" }
  Write-Output "ok - $message"
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class XingmangInstallerDialog {
  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]
  static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, StringBuilder lParam);
  [DllImport("user32.dll")]
  static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

  // A message box is a #32770 dialog owned by the thread that called it.
  public static IntPtr Find(int processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, unused) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner != (uint)processId || !IsWindowVisible(hwnd)) return true;
      StringBuilder name = new StringBuilder(64);
      GetClassName(hwnd, name, name.Capacity);
      if (name.ToString() != "#32770") return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  // The message text sits in the static control with id 0xFFFF. WM_GETTEXT,
  // unlike GetWindowText, is marshalled for a control in another process.
  public static string Text(IntPtr dialog) {
    IntPtr label = GetDlgItem(dialog, 0xFFFF);
    if (label == IntPtr.Zero) return "";
    StringBuilder text = new StringBuilder(4096);
    SendMessage(label, 0x000D, (IntPtr)text.Capacity, text);
    return text.ToString();
  }

  // WM_COMMAND with a button id ends a message box with that answer.
  public static void Answer(IntPtr dialog, int buttonId) {
    PostMessage(dialog, 0x0111, (IntPtr)buttonId, IntPtr.Zero);
  }
}
'@

$IDOK = 1
$IDCANCEL = 2
$IDRETRY = 4

function Get-AppExe([string]$dir) {
  return Get-ChildItem -LiteralPath $dir -Filter '*.exe' | Where-Object { $_.Name -notlike 'Uninstall *' } | Select-Object -First 1
}

function Start-Installer([string]$path, [string[]]$switches, [string]$dir) {
  # /D= has to come last: NSIS takes the rest of the command line as the path.
  $process = Start-Process -FilePath $path -ArgumentList (@('/S') + $switches + "/D=$dir") -PassThru
  # Without touching the handle before the process ends, ExitCode stays empty.
  $null = $process.Handle
  return $process
}

# Waits until the installer either exits ($null) or puts up a message box.
function Wait-ForDialog($process, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { return $null }
    $dialog = [XingmangInstallerDialog]::Find($process.Id)
    if ($dialog -ne [IntPtr]::Zero) { return $dialog }
    Start-Sleep -Milliseconds 500
  }
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  throw "the installer neither finished nor asked anything within $seconds seconds"
}

function Wait-ForExit($process, [string]$stage) {
  if (-not $process.WaitForExit(120000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "$stage did not exit after the dialog was answered"
  }
  return $process.ExitCode
}

# Upgrades the way the updater does and expects it to finish without asking.
function Update-Quietly([string]$stage, [string]$dir) {
  $process = Start-Installer $Installer @('--updated') $dir
  $dialog = Wait-ForDialog $process 900
  if ($null -ne $dialog) {
    $text = [XingmangInstallerDialog]::Text($dialog)
    [XingmangInstallerDialog]::Answer($dialog, $IDCANCEL)
    [XingmangInstallerDialog]::Answer($dialog, $IDOK)
    $null = Wait-ForExit $process $stage
    Check $false "$stage finishes without a dialog (it showed: $text)"
  }
  Check ($process.ExitCode -eq 0) "$stage exits 0 (got $($process.ExitCode))"
  Check ($null -ne (Get-AppExe $dir)) "$stage left the app in place"
}

function Install-Fresh([string]$stage, [string]$path, [string]$dir) {
  $process = Start-Installer $path @() $dir
  $dialog = Wait-ForDialog $process 900
  Check ($null -eq $dialog) "$stage finishes without a dialog"
  Check ($process.ExitCode -eq 0) "$stage exits 0 (got $($process.ExitCode))"
  Check ($null -ne (Get-AppExe $dir)) "$stage put the app in place"
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
  return $null
}

function Get-ManifestEntries([string]$dir) {
  $key = Get-ManifestKey $dir
  # throw rather than Check: whatever Check prints would land in the result.
  if ($null -eq $key) { throw "CHECK FAILED: the install of $dir left no manifest" }
  $item = Get-Item -LiteralPath $key
  $names = @()
  for ($i = 0; $i -lt [int]$item.GetValue('Count'); $i++) {
    $name = $item.GetValue("$i", $null)
    if ($name) { $names += $name }
  }
  return $names
}

function Remove-Install([string]$dir) {
  # A real uninstall (no --updated) skips whatever is already gone, and it
  # clears the registry, so the next scenario starts from a machine without
  # the app instead of upgrading whatever this one left behind.
  $uninstaller = if (Test-Path -LiteralPath $dir) { Get-ChildItem -LiteralPath $dir -Filter 'Uninstall *.exe' | Select-Object -First 1 } else { $null }
  if ($null -ne $uninstaller) {
    $run = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S', "_?=$dir") -Wait -PassThru
    if ($run.ExitCode -ne 0) { Write-Output "cleanup: uninstalling $dir exited $($run.ExitCode)" }
  }
  if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
# Not under the temp folder: the runner spells that one with an 8.3 name.
$root = $env:SystemDrive + '\'
$failures = @()
$scenarioCount = 0
$script:process = $null
$script:lock = $null

# Each scenario starts from a clean machine and cleans up after itself, so one
# that fails does not leave the next one upgrading a broken install.
function Invoke-Scenario([string]$name, [scriptblock]$body) {
  $script:scenarioCount++
  $dir = Join-Path $root "xingmang-upgrade-smoke-$suffix-$($script:scenarioCount)"
  Write-Output "--- $name"
  try {
    & $body $dir
  } catch {
    Write-Output $_.ScriptStackTrace
    Write-Output "FAILED: $name - $_"
    $script:failures += "$name - $_"
  } finally {
    # A failure here must not hide the one that brought us here.
    if ($null -ne $script:process -and -not $script:process.HasExited) { Stop-Process -Id $script:process.Id -Force -ErrorAction SilentlyContinue }
    $script:process = $null
    if ($null -ne $script:lock) { $script:lock.Dispose() }
    $script:lock = $null
    try { Remove-Install $dir } catch { Write-Output "cleanup of ${dir}: $_" }
  }
}

Invoke-Scenario 'a recorded file has gone, upgrading from the released version' {
  param($dir)
  if ($ReleasedInstaller) {
    Install-Fresh 'installing the released version' $ReleasedInstaller $dir
  } else {
    Install-Fresh 'first install' $Installer $dir
  }
  # The installed uninstaller is the released one, which gives up on a missing
  # entry: only the new installer can keep this upgrade going.
  $entries = Get-ManifestEntries $dir
  $gone = $entries | Where-Object { $_ -like 'LICENSE*' } | Select-Object -First 1
  Check ($null -ne $gone) "the manifest records a license file to take away (entries: $($entries -join ', '))"
  Remove-Item -LiteralPath (Join-Path $dir $gone) -Force
  Update-Quietly "upgrading after $gone went missing" $dir
}

Invoke-Scenario 'a recorded file has gone, the new uninstaller on its own' {
  param($dir)
  # What the next installer runs, and what an installer from before this fix
  # would run without first tidying the manifest.
  Install-Fresh 'first install' $Installer $dir
  $gone = Get-ManifestEntries $dir | Where-Object { $_ -like 'LICENSE*' } | Select-Object -First 1
  Check ($null -ne $gone) 'the manifest records a license file to take away'
  Remove-Item -LiteralPath (Join-Path $dir $gone) -Force
  $uninstaller = Get-ChildItem -LiteralPath $dir -Filter 'Uninstall *.exe' | Select-Object -First 1
  # _?= keeps the uninstaller in place so -Wait covers the whole run.
  $run = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S', '--updated', "_?=$dir") -Wait -PassThru
  Check ($run.ExitCode -eq 0) "the uninstaller moves an install with $gone missing aside (got $($run.ExitCode))"
}

Invoke-Scenario 'another program holds a file open' {
  param($dir)
  Install-Fresh 'first install' $Installer $dir
  $held = Join-Path $dir 'resources\app.asar'
  $before = Get-ManifestEntries $dir
  $script:lock = [IO.File]::Open($held, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)

  $script:process = Start-Installer $Installer @('--updated') $dir
  $dialog = Wait-ForDialog $script:process 900
  Check ($null -ne $dialog) 'an upgrade over a held file stops and asks'
  $text = [XingmangInstallerDialog]::Text($dialog)
  Write-Output "the dialog says: $text"
  $missing = @($before | Where-Object { -not (Test-Path -LiteralPath (Join-Path $dir $_)) })
  Check ($missing.Count -eq 0) "the old version is still all there while it asks (missing: $($missing -join ', '))"
  Check ($text -notmatch 'Failed to uninstall') 'the dialog is not the English one from the template'
  Check ($text -match '重试') 'the dialog offers to retry'
  [XingmangInstallerDialog]::Answer($dialog, $IDCANCEL)
  $code = Wait-ForExit $script:process 'cancelling'
  Check ($code -eq 2) "cancelling exits 2 like the template did (got $code)"
  $missing = @($before | Where-Object { -not (Test-Path -LiteralPath (Join-Path $dir $_)) })
  Check ($missing.Count -eq 0) "cancelling leaves the old version as it was (missing: $($missing -join ', '))"

  $script:process = Start-Installer $Installer @('--updated') $dir
  $dialog = Wait-ForDialog $script:process 900
  Check ($null -ne $dialog) 'the next upgrade over the held file asks again'
  $script:lock.Dispose()
  $script:lock = $null
  [XingmangInstallerDialog]::Answer($dialog, $IDRETRY)
  # A second dialog here would mean the retry did not get through.
  $again = Wait-ForDialog $script:process 900
  if ($null -ne $again) {
    $text = [XingmangInstallerDialog]::Text($again)
    [XingmangInstallerDialog]::Answer($again, $IDCANCEL)
    $null = Wait-ForExit $script:process 'retrying'
    Check $false "retrying once the file is free finishes the upgrade (it asked again: $text)"
  }
  Check ($script:process.ExitCode -eq 0) "retrying once the file is free finishes the upgrade (got $($script:process.ExitCode))"
  Check (Test-Path -LiteralPath $held) 'the upgrade put the app back in place'
}

if ($failures.Count -gt 0) {
  throw "CHECK FAILED in $($failures.Count) scenario(s):`n$($failures -join "`n")"
}
