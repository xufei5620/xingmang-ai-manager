param([switch]$Apply)

# Windows PowerShell 5.1 compatible; ASCII source is also UTF-8 without BOM.
# Direct execution exports a Desktop TXT. Dot-sourcing only loads functions.

function Test-ProxyEndpoint($state, [string]$endpoint) {
    if (($state.flags -band 2) -eq 0 -and $state.registry.ProxyEnable -ne 1) { return $false }
    foreach ($server in @($state.server, $state.registry.ProxyServer)) {
        foreach ($entry in ([string]$server -split '[;\s]+')) {
            if (($entry -split '=', 2)[-1] -ceq $endpoint) { return $true }
        }
    }
    return $false
}

function Assert-ProxySnapshot($state) {
    if ($null -eq $state -or $null -eq $state.registry -or
        $state.flags -isnot [int] -or $state.flags -lt 0 -or $state.flags -gt 15) { throw 'invalid-snapshot' }
    foreach ($name in @('server', 'bypass', 'autoConfigUrl')) {
        $value = $state.$name
        if ($value -isnot [string] -or $value.Length -gt 8192 -or $value -match '[\x00-\x1f\x7f]') { throw 'invalid-snapshot-text' }
    }
    if ($null -ne $state.registry.ProxyEnable -and $state.registry.ProxyEnable -cne 0 -and $state.registry.ProxyEnable -cne 1) { throw 'invalid-proxy-enable' }
    foreach ($name in @('ProxyServer', 'ProxyOverride', 'AutoConfigURL')) {
        if ($name -notin $state.registry.PSObject.Properties.Name) { throw 'missing-registry-value' }
        $value = $state.registry.$name
        if ($null -ne $value -and ($value -isnot [string] -or $value.Length -gt 8192 -or $value -match '[\x00-\x1f\x7f]')) { throw 'invalid-registry-text' }
    }
    if ('ProxyEnable' -notin $state.registry.PSObject.Properties.Name) { throw 'missing-proxy-enable' }
}

function Assert-RecoveryJournal($journal, $lease) {
    if ($null -eq $journal -or $journal.version -cne 1 -or $journal.id -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$' -or
        $journal.owner.pid -isnot [int] -or $journal.owner.pid -le 0 -or
        $journal.owner.startedAt -isnot [string] -or $journal.owner.startedAt -notmatch '^\d{15,20}$') { throw 'invalid-journal' }
    Assert-ProxySnapshot $journal.applied
    Assert-ProxySnapshot $journal.before
    if ($null -ne $lease -and ($lease.version -cne 1 -or $lease.id -cne $journal.id -or
        $lease.owner.pid -cne $journal.owner.pid -or $lease.owner.startedAt -cne $journal.owner.startedAt)) { throw 'lease-journal-mismatch' }
    if ($journal.applied.server -cnotmatch '^http=127\.0\.0\.1:(\d+);https=127\.0\.0\.1:\1$') { throw 'invalid-owned-endpoint' }
    $port = [int]$Matches[1]
    $canonical = [pscustomobject]@{
        flags = 3; server = "http=127.0.0.1:$port;https=127.0.0.1:$port"
        bypass = '<local>;localhost;127.0.0.1;[::1]'; autoConfigUrl = ''
        registry = [pscustomobject]@{ ProxyEnable = 1; ProxyServer = "http=127.0.0.1:$port;https=127.0.0.1:$port"; ProxyOverride = '<local>;localhost;127.0.0.1;[::1]'; AutoConfigURL = $null }
    }
    if ($port -lt 1024 -or $port -gt 65535 -or -not (Same-State $journal.applied $canonical)) { throw 'noncanonical-owned-snapshot' }
    if (Test-ProxyEndpoint $journal.before "127.0.0.1:$port") { throw 'original-proxy-still-uses-owned-port' }
    return $port
}

function Get-ProxyRestoreTarget($current, $journal) {
    $comparable = $current | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $comparable.bypass = $journal.applied.bypass
    $comparable.registry.ProxyOverride = $journal.applied.registry.ProxyOverride
    if (-not (Same-State $comparable $journal.applied)) { throw 'settings-changed-beyond-bypass' }
    $desired = $journal.before | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    if ($current.bypass -cne $journal.applied.bypass) { $desired.bypass = $current.bypass }
    if ($current.registry.ProxyOverride -cne $journal.applied.registry.ProxyOverride) { $desired.registry.ProxyOverride = $current.registry.ProxyOverride }
    return $desired
}

function Invoke-ProxyRestore($expected, $desired) {
    if (-not (Same-State (Read-State) $expected)) { throw 'proxy-changed-before-write' }
    try {
        Write-State $desired
        if (-not (Same-State (Read-State) $desired)) { throw 'proxy-readback-failed' }
    } catch {
        # A notification failure can follow a completed write. Do not roll back
        # an unrelated edit made after our write.
        try { if (Same-State (Read-State) $desired) { Write-State $expected } } catch {}
        throw 'proxy-restore-not-confirmed'
    }
}

function Assert-OrdinaryPath([string]$file) {
    $walk = [IO.Path]::GetFullPath($file)
    while ($walk) {
        if (Test-Path -LiteralPath $walk) {
            $item = Get-Item -LiteralPath $walk -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'linked-path-rejected' }
        }
        $walk = [IO.Path]::GetDirectoryName($walk)
    }
}

function Read-RecoveryJson([string]$file) {
    Assert-OrdinaryPath $file
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -gt 98304) { throw 'invalid-record-file' }
    try { return [IO.File]::ReadAllText($file, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'invalid-record-json' }
}

function Invoke-XingmangProxyRecovery([bool]$writeChanges) {
    $ErrorActionPreference = 'Stop'
    $lines = [Collections.Generic.List[string]]::new()
    $desktop = [Environment]::GetFolderPath('Desktop')
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $report = Join-Path $desktop "xingmang-proxy-recovery-$stamp.txt"
    $mutex = $null
    $owned = $false
    $lines.Add('Time: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
    $lines.Add('Mode: ' + $(if ($writeChanges) { 'APPLY' } else { 'INSPECT' }))
    try {
        $directory = Join-Path $env:APPDATA 'xingmang-ai-manager\acceleration-development'
        $journalPath = Join-Path $directory 'proxy-lease.json'
        $leasePath = "$journalPath.lock"
        $name = 'Local\XingMangAI-SystemProxy-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $mutex = [Threading.Mutex]::new($false, $name)
        try { $owned = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw 'proxy-operation-lock-timeout' }
        $journal = Read-RecoveryJson $journalPath
        $lease = Read-RecoveryJson $leasePath
        if ($null -eq $journal) { $lines.Add('Result: NO_RECOVERY_JOURNAL'); return }
        $port = Assert-RecoveryJournal $journal $lease
        $lines.Add('OwnedPort: ' + $port)
        $lines.Add('OwnerPID: ' + $journal.owner.pid)
        Initialize-WinInet
        $current = Read-State
        $owner = Get-Process -Id $journal.owner.pid -ErrorAction SilentlyContinue
        $ownerMatches = $null -ne $owner -and $owner.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ceq $journal.owner.startedAt
        $lines.Add('OriginalOwnerStillRunning: ' + $ownerMatches)
        if (-not (Test-ProxyEndpoint $current "127.0.0.1:$port")) {
            $lines.Add('Result: OWNED_PROXY_ALREADY_RELEASED')
            $lines.Add('Next: Exit and reopen the app so its worker can finish cleanup.')
            return
        }
        $desired = Get-ProxyRestoreTarget $current $journal
        $lines.Add('BypassOnlyOrUnchanged: True')
        $lines.Add('PreservedNativeBypassEdit: ' + ($current.bypass -cne $journal.applied.bypass))
        $lines.Add('PreservedRegistryBypassEdit: ' + ($current.registry.ProxyOverride -cne $journal.applied.registry.ProxyOverride))
        if (-not $writeChanges) { $lines.Add('Result: RECOVERABLE; rerun with -Apply to restore the previous proxy.'); return }
        # Keep the original journal for the old worker to finish its own core,
        # config and trial-ledger cleanup. Never delete account files or kill PIDs.
        $backup = Join-Path $directory "proxy-recovery-backup-$stamp.json"
        Assert-OrdinaryPath $backup
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes((@{ journal = $journal; lease = $lease; current = $current; desired = $desired } | ConvertTo-Json -Depth 12))
        $stream = [IO.File]::Open($backup, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        $lines.Add('BackupFile: ' + [IO.Path]::GetFileName($backup))
        $journalAgain = Read-RecoveryJson $journalPath
        $leaseAgain = Read-RecoveryJson $leasePath
        if (($journal | ConvertTo-Json -Depth 12 -Compress) -cne ($journalAgain | ConvertTo-Json -Depth 12 -Compress) -or
            ($lease | ConvertTo-Json -Depth 12 -Compress) -cne ($leaseAgain | ConvertTo-Json -Depth 12 -Compress)) { throw 'records-changed-before-write' }
        Invoke-ProxyRestore $current $desired
        $lines.Add('Result: PREVIOUS_PROXY_RESTORED')
        $mutex.ReleaseMutex()
        $owned = $false
        # The disconnected helper retries cleanup every second. Give its native
        # proxy commands time to finish, but do not terminate a live core.
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            if (-not (Test-Path -LiteralPath $journalPath)) { break }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $deadline)
        $lines.Add('WorkerJournalCleaned: ' + (-not (Test-Path -LiteralPath $journalPath)))
        $lines.Add('Next: Reopen the app. If cleanup is false, exit the app once and send this TXT to support.')
    } catch {
        # Only our fixed diagnostic codes are exported; raw OS or JSON errors
        # could include settings, private URLs or account information.
        $reason = $_.Exception.Message
        if ($reason -notmatch '^[a-z][a-z0-9-]{2,80}$') { $reason = 'unexpected-system-error' }
        $lines.Add('Result: FAILED')
        $lines.Add('Reason: ' + $reason)
        $lines.Add('Next: Send this TXT to support. Do not delete Local State or proxy-lease files.')
    } finally {
        if ($owned) { $mutex.ReleaseMutex() }
        if ($null -ne $mutex) { $mutex.Dispose() }
        $lines.Add('Report: ' + $report)
        $content = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
        [IO.File]::WriteAllText($report, $content, [Text.UTF8Encoding]::new($false))
        Write-Output $content
    }
}

# Native WinInet functions are appended below. They use the same full snapshot
# format and notification order as electron/platform/windows-system-proxy.ts.

function Initialize-WinInet {
  if($null -ne $script:XingmangWinInet){return}
  $type=[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly([Reflection.AssemblyName]::new('XingmangWinInet'),[Reflection.Emit.AssemblyBuilderAccess]::Run).DefineDynamicModule('XingmangWinInet').DefineType('XingmangWinInet',[Reflection.TypeAttributes]'Public, Sealed, Abstract')
  foreach($call in @(@('Query','wininet.dll','InternetQueryOptionW',[bool],[IntPtr],[uint32],[IntPtr],[IntPtr]),@('Set','wininet.dll','InternetSetOptionW',[bool],[IntPtr],[uint32],[IntPtr],[uint32]),@('GlobalFree','kernel32.dll','GlobalFree',[IntPtr],[IntPtr]))) {
    $method=$type.DefinePInvokeMethod($call[0],[IO.Path]::Combine([Environment]::SystemDirectory,$call[1]),$call[2],[Reflection.MethodAttributes]'Public, Static, PinvokeImpl',[Reflection.CallingConventions]::Standard,$call[3],[Type[]]$call[4..($call.Count-1)],[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  $script:XingmangWinInet=$type.CreateType()
}
function New-WinInetList([int]$extra) {
  Initialize-WinInet
  $m=[Runtime.InteropServices.Marshal];$p=[IntPtr]::Size;$size=3*$p+8;$bytes=$size+4*($p+8)+$extra
  $list=$m::AllocHGlobal($bytes)
  $m::Copy([byte[]]::new($bytes),0,$list,$bytes)
  $m::WriteInt32($list,0,$size);$m::WriteInt32($list,2*$p,4);$m::WriteIntPtr($list,2*$p+8,[IntPtr]::Add($list,$size))
  for($i=0;$i -lt 4;$i++){$m::WriteInt32($list,$size+$i*($p+8),$i+1)}
  return $list
}
function Read-WinInet {
  $m=[Runtime.InteropServices.Marshal];$p=[IntPtr]::Size;$size=3*$p+8
  $list=New-WinInetList 4
  try {
    $length=[IntPtr]::Add($list,$size+4*($p+8))
    $m::WriteInt32($length,0,$size)
    if(-not $script:XingmangWinInet::Query([IntPtr]::Zero,75,$list,$length)){throw 'proxy-query-failed'}
    $text=@('','','')
    for($i=1;$i -lt 4;$i++){
      $value=$m::ReadIntPtr($list,$size+$i*($p+8)+$p)
      if($value -ne [IntPtr]::Zero){$text[$i-1]=$m::PtrToStringUni($value);[void]$script:XingmangWinInet::GlobalFree($value)}
    }
    return @{flags=$m::ReadInt32($list,$size+$p);server=$text[0];bypass=$text[1];autoConfigUrl=$text[2]}
  } finally {$m::FreeHGlobal($list)}
}
function Write-WinInet([int]$flags,[string]$server,[string]$bypass,[string]$pac) {
  $m=[Runtime.InteropServices.Marshal];$p=[IntPtr]::Size;$size=3*$p+8
  $list=New-WinInetList 0
  $text=@()
  try {
    $m::WriteInt32($list,$size+$p,$flags)
    foreach($value in @($server,$bypass,$pac)){
      $text+=$m::StringToHGlobalUni($value)
      $m::WriteIntPtr($list,$size+$text.Count*($p+8)+$p,$text[-1])
    }
    if(-not $script:XingmangWinInet::Set([IntPtr]::Zero,75,$list,$size)){throw 'proxy-write-failed'}
  } finally {
    foreach($item in $text){$m::FreeHGlobal($item)}
    $m::FreeHGlobal($list)
  }
}
function Update-WinInet {
  Initialize-WinInet
  if(-not $script:XingmangWinInet::Set([IntPtr]::Zero,39,[IntPtr]::Zero,0) -or -not $script:XingmangWinInet::Set([IntPtr]::Zero,37,[IntPtr]::Zero,0)){throw 'proxy-notify-failed'}
}
function Read-State {
  $native=Read-WinInet
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Internet Settings',$false)
  try {
    $registry=[ordered]@{}
    foreach($name in @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')) {
      $value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if($null -ne $value) {
        $kind=$key.GetValueKind($name)
        if(($name -eq 'ProxyEnable' -and $kind -ne [Microsoft.Win32.RegistryValueKind]::DWord) -or
           ($name -ne 'ProxyEnable' -and $kind -ne [Microsoft.Win32.RegistryValueKind]::String)) { throw 'unsupported-registry-kind' }
      }
      $registry[$name]=$value
    }
    return [ordered]@{flags=$native.flags;server=$native.server;bypass=$native.bypass;autoConfigUrl=$native.autoConfigUrl;registry=$registry}
  } finally { if($null -ne $key){$key.Dispose()} }
}
function Write-State($state) {
  Write-WinInet ([int]$state.flags) ([string]$state.server) ([string]$state.bypass) ([string]$state.autoConfigUrl)
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Internet Settings',$true)
  try {
    foreach($name in @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')) {
      $value=$state.registry.$name
      if($null -eq $value){$key.DeleteValue($name,$false)}
      elseif($name -eq 'ProxyEnable'){$key.SetValue($name,[int]$value,[Microsoft.Win32.RegistryValueKind]::DWord)}
      else {$key.SetValue($name,[string]$value,[Microsoft.Win32.RegistryValueKind]::String)}
    }
  } finally { if($null -ne $key){$key.Dispose()} }
  Update-WinInet
}
function Same-State($left,$right) {
  if([int]$left.flags -ne [int]$right.flags){return $false}
  foreach($name in @('server','bypass','autoConfigUrl')) {
    if(-not [string]::Equals([string]$left.$name,[string]$right.$name,[StringComparison]::Ordinal)){return $false}
  }
  foreach($name in @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')) {
    if(($null -eq $left.registry.$name) -ne ($null -eq $right.registry.$name)){return $false}
    if(-not [string]::Equals([string]$left.registry.$name,[string]$right.registry.$name,[StringComparison]::Ordinal)){return $false}
  }
  return $true
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-XingmangProxyRecovery $Apply.IsPresent }
