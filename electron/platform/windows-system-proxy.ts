import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { runCommand, trustedCommandEnvironment } from '../command-runner'
import { buildPowerShellModuleImportStatement } from '../powershell-module-imports'
import { resolveWindowsPowerShellExecutable } from '../windows-elevation'
import { platformCapabilitiesFor } from '../platform-capabilities'
import {
  assertNoReparseComponents, assertSafeDataFile, ensureSafeDataDirectory,
  readSafeUtf8File, removeSafeDataFile, writeAtomicSafeUtf8File,
} from '../safe-local-data'

interface ProxyRegistryValues {
  ProxyEnable: number | null
  ProxyServer: string | null
  ProxyOverride: string | null
  AutoConfigURL: string | null
}

export interface WindowsProxySnapshot {
  flags: number
  server: string
  bypass: string
  autoConfigUrl: string
  registry: ProxyRegistryValues
}

interface ProxyOwner {
  pid: number
  startedAt: string
}

interface ProxyLease {
  version: 1
  id: string
  owner: ProxyOwner
}

interface ProxyJournal extends ProxyLease {
  before: WindowsProxySnapshot
  applied: WindowsProxySnapshot
}

export interface WindowsSystemProxyOptions {
  journalPath: string
  platform?: NodeJS.Platform
  runCommand?: typeof runCommand
  powerShellExecutable?: () => string
  commandEnvironment?: () => NodeJS.ProcessEnv
  withOperationLock?: <T>(operation: () => Promise<T>) => Promise<T>
  // 卸载清理在刚被强行结束一批进程的机器上冷启动 PowerShell，可能超过 15 秒；
  // 辅助进程沿用缺省值。
  commandTimeoutMs?: number
}

const label = '系统代理恢复记录'
const requestEnvironmentKey = 'XINGMANG_SYSTEM_PROXY_REQUEST'
const maximumJournalBytes = 96 * 1024
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

// The payload is data in a dedicated environment variable, never PowerShell
// source. WinInet owns Connections binary layouts, PAC flags and notifications.
//
// Under trustedCommandEnvironment() a cmdlet left to autoloading costs the
// whole System32 module scan (20 s and more on the CI runner, see
// buildPowerShellModuleImportStatement) against a 15 s limit; so the one
// module it calls into is imported by name.
export const windowsSystemProxyModules = ['Microsoft.PowerShell.Utility'] as const

export const windowsSystemProxyCommandTimeoutMs = 15_000

// WinInet is declared in memory through Reflection.Emit, never compiled from
// source. Windows PowerShell compiles a type definition by starting csc.exe,
// which writes a DLL under %TEMP% and loads it back: a second cold process on
// every call, which took 18.6 s of the 15 s limit on a fresh CI runner (#745,
// #796, #805) while the rest of this script needs well under a second, and
// which a customer's antivirus also gets to scan. Each library is named by its
// full System32 path. The structures are laid out by hand as wininet.h
// declares them, P being [IntPtr]::Size:
//   INTERNET_PER_CONN_OPTION_LIST  dwSize 0, pszConnection P, dwOptionCount 2P,
//                                  dwOptionError 2P+4, pOptions 2P+8; 3P+8 bytes
//   INTERNET_PER_CONN_OPTION       dwOption 0, value union P (8 bytes); P+8 bytes
// with the four options (flags, server, bypass, PAC) straight after the list in
// one block, which keeps them aligned on x86, x64 and ARM64 alike. Only the
// operations that read or write the proxy declare it; the owner lookup does not.
//
// scripts/windows-acceleration-recovery.ps1 carries this helper and the three
// state functions after it verbatim, from Initialize-WinInet through Same-State
// (windows-acceleration-recovery.test.cjs).
export const windowsSystemProxyScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
${buildPowerShellModuleImportStatement(windowsSystemProxyModules)}
$r = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:XINGMANG_SYSTEM_PROXY_REQUEST)) | ConvertFrom-Json
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
function Owner-Time([int]$processId) {
  try { $p=[Diagnostics.Process]::GetProcessById($processId) }
  catch [ArgumentException] { return $null }
  try { return $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) }
  finally {$p.Dispose()}
}
switch($r.operation) {
  'inspect' {
    $started=Owner-Time ([int]$r.pid)
    if($null -eq $started){throw 'owner-not-found'}
    @{owner=@{pid=[int]$r.pid;startedAt=$started};snapshot=(Read-State)} | ConvertTo-Json -Depth 8 -Compress
  }
  'owner' { @{startedAt=(Owner-Time ([int]$r.pid))} | ConvertTo-Json -Compress }
  'apply' {
    $before=Read-State
    if(-not (Same-State $before $r.expected)) { @{changed=$false;snapshot=$before} | ConvertTo-Json -Depth 8 -Compress; break }
    try {
      Write-State $r.desired
      $after=Read-State
      if(-not (Same-State $after $r.desired)){throw 'proxy-readback-failed'}
      @{changed=$true;snapshot=$after} | ConvertTo-Json -Depth 8 -Compress
    } catch {
      # A failed notification can follow a successful write. Restore only if
      # all current values still equal the state this operation installed.
      try { if(Same-State (Read-State) $r.desired){Write-State $before} } catch {}
      throw 'proxy-apply-failed'
    }
  }
  default {throw 'unsupported-operation'}
}
`

const mutexScript = String.raw`
$ErrorActionPreference='Stop'
$name='Local\XingMangAI-SystemProxy-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex=[Threading.Mutex]::new($false,$name)
$owned=$false
try {
  try {$owned=$mutex.WaitOne(10000)} catch [Threading.AbandonedMutexException] {$owned=$true}
  if(-not $owned){exit 2}
  [Console]::Out.WriteLine('locked')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally {if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function proxyText(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('系统代理记录字段无效。')
  return value
}

export function parseWindowsProxySnapshot(value: unknown): WindowsProxySnapshot {
  if (!isRecord(value) || !Number.isInteger(value.flags) || Number(value.flags) < 0 || Number(value.flags) > 15 || !isRecord(value.registry)) {
    throw new Error('系统代理状态无效。')
  }
  const enable = value.registry.ProxyEnable
  if (enable !== null && enable !== 0 && enable !== 1) throw new Error('系统代理状态无效。')
  return {
    flags: Number(value.flags), server: proxyText(value.server)!, bypass: proxyText(value.bypass)!, autoConfigUrl: proxyText(value.autoConfigUrl)!,
    registry: {
      ProxyEnable: enable,
      ProxyServer: proxyText(value.registry.ProxyServer, true),
      ProxyOverride: proxyText(value.registry.ProxyOverride, true),
      AutoConfigURL: proxyText(value.registry.AutoConfigURL, true),
    },
  }
}

function parseOwner(value: unknown): ProxyOwner {
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || Number(value.pid) > 0x7fffffff
    || typeof value.startedAt !== 'string' || !/^\d{15,20}$/.test(value.startedAt)) throw new Error('系统代理所属进程记录无效。')
  return { pid: Number(value.pid), startedAt: value.startedAt }
}

function parseLease(value: unknown): ProxyLease {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || !uuidPattern.test(value.id)) throw new Error('系统代理租约记录无效。')
  return { version: 1, id: value.id, owner: parseOwner(value.owner) }
}

function parseJournal(value: unknown): ProxyJournal {
  if (!isRecord(value)) throw new Error('系统代理恢复记录无效。')
  const applied = parseWindowsProxySnapshot(value.applied)
  const port = applied.server.match(/^http=127\.0\.0\.1:(\d+);https=127\.0\.0\.1:\1$/)?.[1]
  if (!port || !sameSnapshot(applied, buildWindowsLoopbackProxySnapshot(Number(port)))) throw new Error('系统代理恢复目标无效。')
  return { ...parseLease(value), before: parseWindowsProxySnapshot(value.before), applied }
}

function sameSnapshot(left: WindowsProxySnapshot, right: WindowsProxySnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function restoreWithBypassEdits(current: WindowsProxySnapshot, journal: ProxyJournal): WindowsProxySnapshot | null {
  const { before, applied } = journal
  // Bypass edits do not transfer ownership of our endpoint. Preserve only the
  // fields edited since enable; endpoint, PAC and flags still require an exact match.
  if (!sameSnapshot({ ...current, bypass: applied.bypass,
    registry: { ...current.registry, ProxyOverride: applied.registry.ProxyOverride } }, applied)) return null
  return { ...before,
    bypass: current.bypass === applied.bypass ? before.bypass : current.bypass,
    registry: { ...before.registry,
      ProxyOverride: current.registry.ProxyOverride === applied.registry.ProxyOverride
        ? before.registry.ProxyOverride : current.registry.ProxyOverride },
  }
}

function stillUsesOwnedEndpoint(current: WindowsProxySnapshot, applied: WindowsProxySnapshot): boolean {
  if ((current.flags & 2) === 0 && current.registry.ProxyEnable !== 1) return false
  const endpoint = applied.server.slice('http='.length).split(';')[0]
  return [current.server, current.registry.ProxyServer ?? ''].some((server) => server.split(/[;\s]+/).some((entry) => (
    entry === endpoint || entry.slice(entry.indexOf('=') + 1) === endpoint
  )))
}

export function buildWindowsLoopbackProxySnapshot(port: number): WindowsProxySnapshot {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本地代理端口无效。')
  const server = `http=127.0.0.1:${port};https=127.0.0.1:${port}`
  const bypass = '<local>;localhost;127.0.0.1;[::1]'
  return { flags: 3, server, bypass, autoConfigUrl: '', registry: { ProxyEnable: 1, ProxyServer: server, ProxyOverride: bypass, AutoConfigURL: null } }
}

/** OS mutex covers journal transitions as well as WinInet compare/write. Its
 * helper releases automatically when the parent's stdin pipe disappears. */
async function withWindowsProxyMutex<T>(executable: string, env: NodeJS.ProcessEnv, operation: () => Promise<T>): Promise<T> {
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(mutexScript, 'utf16le').toString('base64')], {
    env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  })
  let closed = false
  let lockLost = false
  const closedPromise = new Promise<void>((resolve) => {
    child.once('close', () => { closed = true; lockLost = true; resolve() })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      timer = setTimeout(() => reject(new Error('系统代理正在由另一实例操作，请稍后重试。')), 12_000)
      child.once('error', () => reject(new Error('无法创建系统代理操作锁。')))
      child.once('close', () => reject(new Error('系统代理操作锁提前结束。')))
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 64) reject(new Error('系统代理操作锁返回异常。'))
        else if (output.trim() === 'locked') resolve()
      })
    })
    clearTimeout(timer)
    const result = await operation()
    if (lockLost) throw new Error('系统代理操作锁异常中断，请重试恢复。')
    return result
  } finally {
    clearTimeout(timer)
    child.stdin.on('error', () => undefined)
    child.stdin.end('\n')
    if (!closed) {
      let stopTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([closedPromise, new Promise<void>((resolve) => { stopTimer = setTimeout(resolve, 2_000) })])
      clearTimeout(stopTimer)
      if (!closed) child.kill()
    }
  }
}

export function createWindowsSystemProxy(options: WindowsSystemProxyOptions): {
  enable(port: number): Promise<void>
  restore(): Promise<void>
  recover(): Promise<void>
  inspect(): Promise<WindowsProxySnapshot>
} {
  if (!path.isAbsolute(options.journalPath)) throw new Error('系统代理恢复记录必须使用绝对路径。')
  const journalPath = path.resolve(options.journalPath)
  const lockPath = `${journalPath}.lock`
  const execute = options.runCommand ?? runCommand
  const executable = options.powerShellExecutable ?? resolveWindowsPowerShellExecutable
  const environment = options.commandEnvironment ?? trustedCommandEnvironment
  let ownedId: string | null = null
  let queue: Promise<unknown> = Promise.resolve()

  async function invoke(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
      const result = await execute({ executable: executable(), argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsSystemProxyScript, 'utf16le').toString('base64')] }, {
        env: { ...environment(), [requestEnvironmentKey]: encoded }, trustedOnly: true,
        windowsHide: true, timeoutMs: options.commandTimeoutMs ?? windowsSystemProxyCommandTimeoutMs, maxOutputBytes: maximumJournalBytes, sensitiveValues: [encoded],
      })
      const value: unknown = JSON.parse(result.stdout)
      if (!isRecord(value)) throw new Error('invalid response')
      return value
    } catch (error) {
      // The message stays generic for the UI; the cause is for the uninstall
      // cleanup, whose only reader is whoever launched it with stderr attached.
      throw new Error('Windows 系统代理操作未完成，请重试。', { cause: error })
    }
  }

  function serialized(operation: () => Promise<void>): Promise<void> {
    const result = queue.then(async () => {
      if (platformCapabilitiesFor(options.platform ?? process.platform).platform !== 'windows') throw new Error('当前系统暂不支持此系统代理模式。')
      const withLock = options.withOperationLock ?? ((work: () => Promise<void>) => withWindowsProxyMutex(executable(), environment(), work))
      await withLock(operation)
    })
    queue = result.catch(() => undefined)
    return result
  }

  async function readLease(): Promise<ProxyLease | null> {
    const content = await readSafeUtf8File(lockPath, label, 2048)
    try { return content === null ? null : parseLease(JSON.parse(content) as unknown) }
    catch { throw new Error('系统代理租约记录损坏，已保留原文件。') }
  }

  async function readJournal(): Promise<ProxyJournal | null> {
    const content = await readSafeUtf8File(journalPath, label, maximumJournalBytes)
    try { return content === null ? null : parseJournal(JSON.parse(content) as unknown) }
    catch { throw new Error('系统代理恢复记录损坏，已保留原文件。') }
  }

  async function alive(owner: ProxyOwner): Promise<boolean> {
    const result = await invoke({ operation: 'owner', pid: owner.pid })
    if (result.startedAt === null) return false
    if (typeof result.startedAt !== 'string' || !/^\d{15,20}$/.test(result.startedAt)) throw new Error('无法确认系统代理所属进程。')
    return result.startedAt === owner.startedAt
  }

  async function removeOwnedFiles(id: string): Promise<void> {
    const currentJournal = await readJournal()
    if (currentJournal && currentJournal.id !== id) throw new Error('系统代理恢复记录已变更，拒绝删除。')
    if (currentJournal) await removeSafeDataFile(journalPath, label)
    const currentLease = await readLease()
    if (currentLease && currentLease.id !== id) throw new Error('系统代理租约已变更，拒绝删除。')
    if (currentLease) await removeSafeDataFile(lockPath, label)
    if (ownedId === id) ownedId = null
  }

  async function restorePending(recovery: boolean): Promise<void> {
    const lease = await readLease()
    const journal = await readJournal()
    if (!lease && !journal) { ownedId = null; return }
    const owner = lease ?? journal!
    if (lease && journal && (lease.id !== journal.id || JSON.stringify(lease.owner) !== JSON.stringify(journal.owner))) throw new Error('系统代理恢复记录与租约不一致，已保留原记录。')
    if (ownedId !== owner.id && await alive(owner.owner)) throw new Error('另一实例正在使用系统代理，请先停止该实例的加速。')
    if (!recovery && ownedId !== owner.id) throw new Error('系统代理由其他实例创建，请先执行恢复。')
    if (journal) {
      let desired = journal.before
      let result = await invoke({ operation: 'apply', expected: journal.applied, desired })
      let snapshot = parseWindowsProxySnapshot(result.snapshot)
      if (result.changed === false && !sameSnapshot(snapshot, desired)) {
        const merged = restoreWithBypassEdits(snapshot, journal)
        if (merged) {
          // A second full-state CAS prevents changes made after this snapshot
          // from being overwritten. Leave a lost race to the normal guard below.
          desired = merged
          result = await invoke({ operation: 'apply', expected: snapshot, desired })
          snapshot = parseWindowsProxySnapshot(result.snapshot)
        }
      }
      // A changed configuration belongs to the user/Clash. Relinquish our lease
      // without undoing those later edits. A true write must verify in full.
      if (result.changed !== false && (result.changed !== true || !sameSnapshot(snapshot, desired))) {
        throw new Error('系统代理恢复未确认，恢复记录已保留。')
      }
      if (result.changed === false && !sameSnapshot(snapshot, desired) && stillUsesOwnedEndpoint(snapshot, journal.applied)) {
        // Do not stop the core behind a manually edited but still active local
        // proxy. The caller keeps it alive while the user resolves that change.
        throw new Error('系统代理设置已被修改，但仍指向加速端口。请先切换系统代理，再重试停止加速。')
      }
    }
    await removeOwnedFiles(owner.id)
  }

  async function createLease(lease: ProxyLease): Promise<void> {
    ensureSafeDataDirectory(path.dirname(lockPath), label)
    assertNoReparseComponents(path.dirname(lockPath), label)
    if (assertSafeDataFile(lockPath, label)) throw new Error('系统代理租约已存在。')
    const handle = await fs.promises.open(lockPath, 'wx', 0o600)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('系统代理租约文件无效。')
      await handle.writeFile(`${JSON.stringify(lease)}\n`, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    const saved = await readLease()
    if (JSON.stringify(saved) !== JSON.stringify(lease)) throw new Error('系统代理租约回读校验失败。')
  }

  return {
    enable(port) {
      const applied = buildWindowsLoopbackProxySnapshot(port)
      return serialized(async () => {
        if (ownedId) {
          const active = await readJournal()
          if (active?.id === ownedId && sameSnapshot(active.applied, applied)) {
            const inspected = await invoke({ operation: 'inspect', pid: process.pid })
            if (sameSnapshot(parseWindowsProxySnapshot(inspected.snapshot), applied)) return
          }
          throw new Error('请先停止当前加速，再变更系统代理。')
        }
        await restorePending(true)
        const inspected = await invoke({ operation: 'inspect', pid: process.pid })
        const before = parseWindowsProxySnapshot(inspected.snapshot)
        const lease: ProxyLease = { version: 1, id: randomUUID(), owner: parseOwner(inspected.owner) }
        if (lease.owner.pid !== process.pid) throw new Error('系统代理进程身份不一致。')
        await createLease(lease)
        const journal: ProxyJournal = { ...lease, before, applied }
        ownedId = lease.id
        try {
          await writeAtomicSafeUtf8File(journalPath, `${JSON.stringify(journal)}\n`, label)
          if (JSON.stringify(await readJournal()) !== JSON.stringify(journal)) throw new Error('系统代理恢复记录回读失败。')
          const result = await invoke({ operation: 'apply', expected: before, desired: applied })
          if (result.changed !== true || !sameSnapshot(parseWindowsProxySnapshot(result.snapshot), applied)) throw new Error('系统代理设置已变更，请重试。')
        } catch {
          // Even a command timeout can follow a successful OS write. The
          // journal remains authoritative until rollback/readback confirms it.
          try { await restorePending(false) } catch { throw new Error('系统代理启用失败且恢复尚未确认，请重试停止加速。') }
          throw new Error('系统代理启用失败，原设置已保留。')
        }
      })
    },
    restore: () => serialized(() => restorePending(false)),
    recover: () => serialized(() => restorePending(true)),
    /** Read-only, so it takes neither the operation queue nor the OS mutex: a
     *  reading is a point in time either way, and blocking a look behind a
     *  running enable/restore would only make it staler. */
    async inspect() {
      if (platformCapabilitiesFor(options.platform ?? process.platform).platform !== 'windows') throw new Error('当前系统暂不支持此系统代理模式。')
      return parseWindowsProxySnapshot((await invoke({ operation: 'inspect', pid: process.pid })).snapshot)
    },
  }
}
