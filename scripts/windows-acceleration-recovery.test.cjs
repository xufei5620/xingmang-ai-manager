const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')

const recoveryPath = path.resolve(__dirname, 'windows-acceleration-recovery.ps1')

test('customer recovery source is UTF-8 without BOM and remains readable in Windows PowerShell 5.1', () => {
  const bytes = fs.readFileSync(recoveryPath)
  assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf')
  assert.ok([...bytes].every((value) => value < 128))
})

test('Windows recovery preserves bypass edits and refuses conflicting or unverified proxy writes', { skip: process.platform !== 'win32' }, () => {
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. '${recoveryPath.replaceAll("'", "''")}'
Initialize-WinInet
$script:checks = 0
function Check([bool]$condition, [string]$name) {
  if (-not $condition) { throw ('CHECK FAILED: ' + $name) }
  $script:checks++
}
function Fails([scriptblock]$action, [string]$message) {
  $caught = $null
  try { & $action } catch { $caught = $_.Exception.Message }
  Check ($caught -ceq $message) ('expected failure ' + $message + ', actual ' + $caught)
}
function Clone-Snapshot($value) { return $value | ConvertTo-Json -Depth 12 | ConvertFrom-Json }
$applied = @'
{"flags":3,"server":"http=127.0.0.1:57448;https=127.0.0.1:57448","bypass":"<local>;localhost;127.0.0.1;[::1]","autoConfigUrl":"","registry":{"ProxyEnable":1,"ProxyServer":"http=127.0.0.1:57448;https=127.0.0.1:57448","ProxyOverride":"<local>;localhost;127.0.0.1;[::1]","AutoConfigURL":null}}
'@ | ConvertFrom-Json
$before = @'
{"flags":3,"server":"http://localhost:15236","bypass":"old-bypass","autoConfigUrl":"","registry":{"ProxyEnable":1,"ProxyServer":"http://localhost:15236","ProxyOverride":null,"AutoConfigURL":null}}
'@ | ConvertFrom-Json
$journal = [pscustomobject]@{version=1;id='aaaabbbb-cccc-4ddd-8eee-ffffffffffff';owner=[pscustomobject]@{pid=44300;startedAt='134022112340000000'};before=$before;applied=$applied}
$lease = [pscustomobject]@{version=1;id=$journal.id;owner=(Clone-Snapshot $journal.owner)}
Check ((Assert-RecoveryJournal $journal $lease) -eq 57448) 'valid journal'
Check ((Assert-RecoveryJournal $journal $null) -eq 57448) 'missing lease is recoverable'
Check (Same-State (Get-ProxyRestoreTarget $applied $journal) $before) 'unchanged proxy restores original including absent registry'
$current = Clone-Snapshot $applied
$current.registry.ProxyOverride = 'added.example.test;<local>'
$desired = Get-ProxyRestoreTarget $current $journal
Check ($desired.registry.ProxyOverride -ceq $current.registry.ProxyOverride) 'customer registry-only bypass edit retained'
Check ($desired.bypass -ceq $before.bypass) 'unmodified native bypass restores original'
Check ($desired.server -ceq $before.server) 'previous localhost proxy retained'
$current = Clone-Snapshot $applied
$current.bypass = ''
$desired = Get-ProxyRestoreTarget $current $journal
Check ($desired.bypass -ceq '') 'native empty bypass edit retained'
Check ($null -eq $desired.registry.ProxyOverride) 'unchanged registry restores absent value'
foreach ($override in @($null, '', 'new-bypass')) {
  $current = Clone-Snapshot $applied
  $current.bypass = 'native-new'
  $current.registry.ProxyOverride = $override
  $desired = Get-ProxyRestoreTarget $current $journal
  Check ($desired.bypass -ceq 'native-new' -and $desired.registry.ProxyOverride -ceq $override) 'distinct native/registry bypass edits retained'
}
foreach ($field in @('flags', 'server', 'autoConfigUrl')) {
  $current = Clone-Snapshot $applied
  if ($field -eq 'flags') { $current.flags = 7 } else { $current.$field = 'external-change' }
  Fails { Get-ProxyRestoreTarget $current $journal } 'settings-changed-beyond-bypass'
}
foreach ($field in @('ProxyEnable', 'ProxyServer', 'AutoConfigURL')) {
  $current = Clone-Snapshot $applied
  if ($field -eq 'ProxyEnable') { $current.registry.ProxyEnable = 0 } else { $current.registry.$field = 'external-change' }
  Fails { Get-ProxyRestoreTarget $current $journal } 'settings-changed-beyond-bypass'
}
$bad = Clone-Snapshot $lease
$bad.owner.startedAt = '134022112340000001'
Fails { Assert-RecoveryJournal $journal $bad } 'lease-journal-mismatch'
$bad = Clone-Snapshot $journal
$bad.applied.registry.ProxyOverride = 'tampered'
Fails { Assert-RecoveryJournal $bad $lease } 'noncanonical-owned-snapshot'
$bad = Clone-Snapshot $journal
$bad.before = Clone-Snapshot $applied
Fails { Assert-RecoveryJournal $bad $lease } 'original-proxy-still-uses-owned-port'
Check (Test-ProxyEndpoint $applied '127.0.0.1:57448') 'detect owned endpoint'
Check (-not (Test-ProxyEndpoint $before '127.0.0.1:57448')) 'previous proxy is independent'
$disabled = Clone-Snapshot $applied
$disabled.flags = 1
$disabled.registry.ProxyEnable = 0
Check (-not (Test-ProxyEndpoint $disabled '127.0.0.1:57448')) 'disabled proxy is independent'

# Stub all registry/native reads and writes. No test changes the real proxy.
function Read-State { return Clone-Snapshot $script:state }
function Write-State($value) {
  $script:writes++
  if ($script:failure -eq 'before') { $script:failure = ''; throw 'synthetic-write-denied' }
  $script:state = Clone-Snapshot $value
  if ($script:failure -eq 'after') { $script:failure = ''; throw 'synthetic-notify-failed' }
  if ($script:failure -eq 'external') { $script:failure = ''; $script:state.server = 'other.example.test:8080' }
}
$script:state = Clone-Snapshot $applied
$script:writes = 0
$script:failure = ''
Invoke-ProxyRestore $applied $before
Check ((Same-State $script:state $before) -and $script:writes -eq 1) 'confirmed restoration'
$script:state = Clone-Snapshot $before
$script:writes = 0
Fails { Invoke-ProxyRestore $applied $before } 'proxy-changed-before-write'
Check ($script:writes -eq 0) 'CAS refuses concurrent edits'
$script:state = Clone-Snapshot $applied
$script:writes = 0
$script:failure = 'before'
Fails { Invoke-ProxyRestore $applied $before } 'proxy-restore-not-confirmed'
Check ((Same-State $script:state $applied) -and $script:writes -eq 1) 'failed write leaves owned endpoint recoverable'
$script:state = Clone-Snapshot $applied
$script:writes = 0
$script:failure = 'after'
Fails { Invoke-ProxyRestore $applied $before } 'proxy-restore-not-confirmed'
Check ((Same-State $script:state $applied) -and $script:writes -eq 2) 'notification failure safely rolls back'
Invoke-ProxyRestore $applied $before
Check (Same-State $script:state $before) 'retry after rollback succeeds'
$script:state = Clone-Snapshot $applied
$script:writes = 0
$script:failure = 'external'
Fails { Invoke-ProxyRestore $applied $before } 'proxy-restore-not-confirmed'
Check ($script:state.server -ceq 'other.example.test:8080' -and $script:writes -eq 1) 'readback mismatch never overwrites a third-party change'
Write-Output ('RECOVERY_CHECKS=' + $script:checks)
`
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error))
  assert.match(result.stdout, /RECOVERY_CHECKS=33/)
})
