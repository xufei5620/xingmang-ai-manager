import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// The PowerShell probes the main process runs, executed for real, once per CI
// run. They used to live in the vitest shards (codex-desktop-service,
// external-client-runtime), where a cold PowerShell start on a busy runner
// would sometimes eat the whole budget, hand back empty output and turn an
// unrelated PR red. The unit tests now check the generated scripts and the
// parsers without starting a process; this step is the one place that proves
// the scripts still run and still say what the parsers expect. It runs after
// `npm run compile`, so it drives the same compiled modules the app ships.
if (process.platform !== 'win32') {
  console.log('SKIP: the PowerShell probe smoke needs Windows PowerShell')
  process.exit(0)
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
function compiled(name) {
  return require(path.join(repo, 'dist-electron', `${name}.js`))
}
const {
  buildCodexDesktopCombinedProbeScript,
  buildCodexDesktopProcessProbeScript,
  buildCodexDesktopSessionProcessProbeScript,
  codexDesktopCombinedProbeModules,
  codexDesktopCombinedProbeTimeoutMs,
  parseCodexDesktopCombinedProbeJson,
  parseCodexDesktopSessionProcessIds,
} = compiled('codex-desktop-service')
const { parseWindowsProcessesJson } = compiled('codex-desktop')
const { windowsExternalClientInventoryScript } = compiled('external-client-runtime')
const { encodeWindowsPowerShellCommand, resolveWindowsPowerShellExecutable } = compiled('windows-elevation')
const { trustedCommandEnvironment } = compiled('command-runner')
const {
  buildWindowsStoreAvailabilityScript,
  inspectWindowsStoreAvailability,
  parseWindowsStoreAvailability,
} = compiled('windows-store-app-launch')

// One budget per probe, not per step: the first call also pays the cold start,
// and its duration is printed so a slow runner is visible in the log instead of
// being guessed at from a timeout.
const probeBudgetMs = 90_000
const powershell = resolveWindowsPowerShellExecutable()

function runPowerShell(argv, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', ...argv], {
      env, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: probeBudgetMs,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}${error.killed ? ` (killed after ${probeBudgetMs}ms)` : ''}\n${stderr}`))
      else resolve(stdout)
    })
    // Nothing is piped in; a console host waiting on stdin must not hold the probe.
    child.stdin?.end()
  })
}

function runScript(script) {
  return runPowerShell(['-Command', script])
}

function runEncoded(script) {
  return runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(script)])
}

const codexProcessMocks = String.raw`
  $script:ownerCalls = 0
  function Get-CimInstance {
    param($ClassName, $Filter)
    $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    @(
      [pscustomobject]@{ ProcessId = 101; ParentProcessId = 0; Name = 'ChatGPT.exe'; SessionId = $session; ExecutablePath = 'C:\WindowsApps\OpenAI.Codex_26.715.0.0_x64__id\ChatGPT.exe' }
      [pscustomobject]@{ ProcessId = 102; ParentProcessId = 101; Name = 'ChatGPT.exe'; SessionId = $session; ExecutablePath = 'C:\WindowsApps\OpenAI.Codex_26.715.0.0_x64__id\ChatGPT.exe' }
      [pscustomobject]@{ ProcessId = 103; ParentProcessId = 101; Name = 'ChatGPT.exe'; SessionId = $session; ExecutablePath = 'C:\WindowsApps\OpenAI.Codex_26.715.0.0_x64__id\ChatGPT.exe' }
      [pscustomobject]@{ ProcessId = 104; ParentProcessId = 102; Name = 'rg.exe'; SessionId = $session; ExecutablePath = 'C:\WindowsApps\OpenAI.Codex_26.715.0.0_x64__id\app\resources\rg.exe' }
      [pscustomobject]@{ ProcessId = 105; ParentProcessId = 102; Name = 'git.exe'; SessionId = $session; ExecutablePath = 'C:\Program Files\Git\cmd\git.exe' }
    )
  }
  function Invoke-CimMethod {
    [CmdletBinding()]
    param($InputObject, $MethodName, $OperationTimeoutSec)
    $script:ownerCalls += 1
    $sid = if ($InputObject.ProcessId -eq 103) { 'S-1-5-21-9999' } else { [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    [pscustomobject]@{ ReturnValue = 0; Sid = $sid }
  }
`

async function runMockedCodexProcessProbe(scope) {
  const output = await runScript(`${codexProcessMocks}
    ${buildCodexDesktopProcessProbeScript(scope)}
    Write-Output ('CALLS=' + $script:ownerCalls)
  `)
  const lines = output.trim().split(/\r?\n/)
  const calls = Number(lines.pop()?.replace('CALLS=', ''))
  return { calls, processIds: parseWindowsProcessesJson(lines.join('\n')).map((entry) => entry.processId) }
}

const externalClientSubjects = {
  workbuddy: 'CN=Tencent Technology (Shenzhen) Company Limited, O=Tencent Technology (Shenzhen) Company Limited, C=CN',
  opencode: 'CN="Anomaly Innovations, Inc https://anoma.ly/", O="Anomaly Innovations, Inc https://anoma.ly/", C=US',
}

const checks = [
  ['Codex process probe reads this session and emits bounded JSON', async () => {
    const output = await runScript(buildCodexDesktopProcessProbeScript())
    if (output.trim()) assert.doesNotThrow(() => JSON.parse(output))
  }],
  ['Codex merged probe answers all three segments', async () => {
    const output = await runScript(buildCodexDesktopCombinedProbeScript())
    const parsed = JSON.parse(output.trim())
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'startApps'))
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'processes'))
    assert.ok(parsed.package)
    // Appx 段在任何账户下都必须给出结论：要么有包、要么确认没有、要么报错。
    const probe = parseCodexDesktopCombinedProbeJson(output)
    assert.ok(probe.packageProbe.value !== null || probe.packageProbe.confirmedAbsent === true || probe.packageProbe.error !== null)
  }],
  ['Codex close probe checks only roots during scans and each pid before closing', async () => {
    assert.deepEqual(await runMockedCodexProcessProbe('roots'), { calls: 1, processIds: [101] })
    // The mock ignores -Filter, so this pins the package-path check: a helper
    // from the package is closed, an unrelated child of the app is not.
    assert.deepEqual(await runMockedCodexProcessProbe('all'), { calls: 4, processIds: [101, 102, 104] })
  }],
  ['Codex launch probe keeps windows whose owner is unknown', async () => {
    const output = await runScript(String.raw`
      function Get-CimInstance {
        param($ClassName, $Filter)
        $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        @(
          [pscustomobject]@{ ProcessId = 201; Name = 'ChatGPT.exe'; SessionId = $session; ExecutablePath = 'C:\WindowsApps\OpenAI.Codex_26.715.0.0_x64__id\app\ChatGPT.exe' }
          [pscustomobject]@{ ProcessId = 202; Name = 'ChatGPT.exe'; SessionId = $session; ExecutablePath = $null; CommandLine = '"C:\WindowsApps\OpenAI.Codex_26.715.0.0_x64__id\app\ChatGPT.exe" --type=renderer' }
          [pscustomobject]@{ ProcessId = 203; Name = 'ChatGPT.exe'; SessionId = ($session + 1); ExecutablePath = 'C:\WindowsApps\OpenAI.Codex_26.715.0.0_x64__id\app\ChatGPT.exe' }
          [pscustomobject]@{ ProcessId = 204; Name = 'git.exe'; SessionId = $session; ExecutablePath = 'C:\Program Files\Git\cmd\git.exe' }
        )
      }
      function Invoke-CimMethod { throw 'the launch probe must not ask for owners' }
    ` + '\n' + buildCodexDesktopSessionProcessProbeScript())
    assert.deepEqual(parseCodexDesktopSessionProcessIds(output, 'OpenAI.Codex_id'), [201, 202])
  }],
  ['external client inventory keeps verified AppX results when an unrelated uninstall key is unreadable', async () => {
    // external-client-runtime.test.ts feeds the runtime this same shape; the
    // two halves meet on the clients list and the registry sentence.
    const output = await runEncoded(String.raw`
function Test-Path { param([string]$LiteralPath) return $true }
function Get-ChildItem { param([string]$LiteralPath) [pscustomobject]@{ PSPath='unrelated-unreadable-key' } }
function Get-ItemProperty { param([string]$LiteralPath) throw 'Access denied to unrelated registry item' }
function Get-Process { @() }
function Get-AppxPackage {
  [pscustomobject]@{ PackageFamilyName='Claude_pzs8sxrjxfjjc'; InstallLocation='C:\Program Files\WindowsApps\Claude_2.110.1.0_x64__pzs8sxrjxfjjc'; Version='2.110.1.0'; Publisher='CN="Anthropic, PBC", O="Anthropic, PBC", C=US' }
}
` + windowsExternalClientInventoryScript())
    const data = JSON.parse(output.trim())
    assert.equal(data.clients.length, 1)
    assert.equal(data.clients[0].tool, 'claudeDesktop')
    assert.equal(data.clients[0].version, '2.110.1.0')
    assert.equal(data.errors.workbuddy, '部分软件安装记录无法读取，暂时不能确认客户端是否未安装，请重试检测')
  }],
  ['external client inventory decodes every remembered signature', async () => {
    const known = [
      { path: 'C:\\Users\\Tester\\AppData\\Local\\WorkBuddy\\WorkBuddy.exe', stamp: '1:2:3', status: 'Valid', subject: externalClientSubjects.workbuddy },
      { path: "C:\\Users\\Tester\\AppData\\Local\\Open'Code\\OpenCode.exe", stamp: '4:5:6', status: 'Valid', subject: externalClientSubjects.opencode },
    ]
    const output = await runEncoded(String.raw`
function Test-Path { param([string]$LiteralPath) return $false }
function Get-Process { @() }
function Get-AppxPackage { @() }
` + windowsExternalClientInventoryScript(known) + "\n'KNOWN:' + (@($knownSignatures.Keys | Sort-Object) -join '|')")
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith('KNOWN:'))
    assert.equal(line, `KNOWN:${known.map((entry) => entry.path).sort().join('|')}`)
  }],
]

checks.push(['store availability probe answers without throwing', async () => {
  // A runner image may or may not carry the Store; the probe must still reach a
  // reading its parser accepts, and "could not tell" (null) is a legal answer.
  const available = parseWindowsStoreAvailability(await runScript(buildWindowsStoreAvailabilityScript()))
  assert.ok([true, false, null].includes(available))
  console.log(`info store availability on this runner: ${available}`)
}])

// The single Codex desktop probes, each under the trusted environment and held
// to the limit the app gives it (8 s). They import their modules up front for
// the same reason as the merged probe (#714, #716): one autoloaded cmdlet
// costs about 22 s here, and a timeout reads as "not installed", "no window"
// or "could not look". Install, update, uninstall and reset all start with the
// package probe, so on such a machine none of them would get past it.
const {
  buildCodexDesktopPackageProbeScript,
  buildCodexDesktopStartAppProbeScript,
  codexDesktopSingleProbeTimeoutMs,
} = compiled('codex-desktop-service')

const codexSingleProbes = [
  ['start menu', buildCodexDesktopStartAppProbeScript],
  ['scan process list', () => buildCodexDesktopProcessProbeScript('roots')],
  ['session process list', buildCodexDesktopSessionProcessProbeScript],
  ['package', buildCodexDesktopPackageProbeScript],
]

for (const [name, build] of codexSingleProbes) {
  checks.push([`Codex ${name} probe answers inside its own limit under the trusted environment`, async () => {
    const startedAt = Date.now()
    const output = await runPowerShell(['-Command', build()], trustedCommandEnvironment())
    const elapsed = Date.now() - startedAt
    if (output.trim()) assert.doesNotThrow(() => JSON.parse(output.trim()))
    console.log(`info Codex ${name} probe under the trusted environment: ${elapsed}ms`)
    assert.ok(elapsed < codexDesktopSingleProbeTimeoutMs, `took ${elapsed}ms, the app gives it ${codexDesktopSingleProbeTimeoutMs}ms`)
  }])
}

// Autoloading switched off right after the imports: a cmdlet whose module a
// probe forgot fails by name instead of silently costing 22 s. Only printed,
// so it names the culprit if one of the checks above goes red again.
function runPowerShellCollecting(script, env) {
  return new Promise((resolve) => {
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: probeBudgetMs,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    child.stdin?.end()
  })
}

async function reportCodexSingleProbesWithoutAutoloading() {
  for (const [name, build] of codexSingleProbes) {
    const script = build().replace(/(Import-Module [^\n;]*)/, "$1; $PSModuleAutoLoadingPreference = 'None'")
    const startedAt = Date.now()
    const { error, stdout, stderr } = await runPowerShellCollecting(script, trustedCommandEnvironment())
    const missing = [...new Set([...String(stderr).matchAll(/(?:The term '|无法将“)([A-Za-z]+-[A-Za-z]+)/g)].map((match) => match[1]))]
    const notFound = /CommandNotFoundException/.test(String(stderr))
    // The package probe catches its own failure and answers with a plain
    // sentence instead, so a missing Get-AppxPackage only shows up there.
    let reported = null
    try { reported = JSON.parse(String(stdout).trim())?.error ?? null } catch {}
    const outcome = missing.length
      ? `missing ${missing.join(', ')}`
      : notFound ? 'a command was not found (see stderr)'
        : reported ? `the probe reported an error: ${reported}`
          : error ? `failed: ${String(error.message).split('\n')[0]}` : 'no missing command'
    console.log(`${missing.length || notFound || reported ? '::warning::' : 'info '}Codex ${name} probe with autoloading off: ${outcome} (${Date.now() - startedAt}ms)`)
  }
}

// The other probes the main process runs under the trusted environment (#714,
// #716, #718 and the follow-up that imported modules in all of them). Each is
// held to the limit the app gives it; the ones that would launch something
// (Codex activation, the CLI terminal) or need an elevated, admin-owned
// directory (the protected ACL read-back) are left to the unit tests. Every
// result is printed with its time so a slow runner shows up by name.
const { probeRunningCliProcesses, cliProcessProbeTimeoutMs } = compiled('cli-process-probe')
const { buildDiagnosticsCodexDesktopProbeScript, diagnosticsCodexDesktopProbeTimeoutMs } = compiled('diagnostics')
const { resolveCodexDesktopCdpPortOwners, codexDesktopCdpCommandTimeoutMs } = compiled('codex-desktop-cdp')
const { externalClientSystemCommandTimeoutMs } = compiled('external-client-runtime')
const { uninstallAccountProbeScript } = compiled('uninstall-cleanup')
const { buildClaudeDesktopManifestInspectionScript, claudeDesktopPowerShellTimeoutMs } = compiled('claude-desktop-manifest')
const {
  buildClaudeDesktopPackageInspectionScript,
  claudeDesktopPackageInspectionTimeoutMs,
  validateClaudeDesktopPackageInspection,
  windowsPackagePublisherId,
} = compiled('claude-desktop-msix-installer')
const { claudeDesktopPolicyReadScript } = compiled('claude-desktop-policy')
const { buildReadProxyScopesScript, readWindowsProxyScopes, windowsProxyPowerShellTimeoutMs } = compiled('stale-proxy-environment')
const {
  parseWindowsProxySnapshot,
  windowsSystemProxyCommandTimeoutMs,
  windowsSystemProxyCompiledScript,
  windowsSystemProxyScript,
} = compiled('platform/windows-system-proxy')
const {
  appInstallerQueryScript,
  inspectWindowsRestartRequired,
  installedNodeSignatureScript,
  nodeInstallerSignatureScript,
  nodeRuntimeWindowsProbeTimeoutMs,
  windowsRestartStatusScript,
} = compiled('node-runtime')
const { installedPythonInspectionScript, pythonInstallerSignatureScript } = compiled('python-runtime')
const { workBuddyInstallerSignatureScript } = compiled('workbuddy-installer')
const { nativeCliSignatureScript, nativeCliSignatureTimeoutMs } = compiled('trusted-native-cli')
const {
  inspectProgramFilesAclAsync,
  inspectWindowsDirectoryTreeAcl,
  programFilesAclTimeoutMs,
  resolveWindowsMachinePaths,
  windowsDirectoryTreeAclTimeoutMs,
} = compiled('windows-machine-paths')

// The installer and signature checks get a minute (the uninstall probe 90 s);
// they are held to that, which mostly proves they still run and parse.
const signatureCheckTimeoutMs = 60_000
const machinePaths = resolveWindowsMachinePaths()
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-probe-smoke-'))
fs.mkdirSync(path.join(scratch, 'tree', 'nested'), { recursive: true })
const manifestPath = path.join(scratch, 'AppxManifest.xml')
fs.writeFileSync(manifestPath, '<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"><Identity Name="Claude" Version="1.0.0.0" ProcessorArchitecture="x64" Publisher="CN=Test"/></Package>')
const systemProxyRequest = Buffer.from(JSON.stringify({ operation: 'owner', pid: process.pid }), 'utf8').toString('base64')
// Read-only: the reading every acceleration start takes, WinInet included. Nothing here writes
// the runner's proxy; windows-uninstall-smoke.yml does that.
const systemProxyReadRequest = Buffer.from(JSON.stringify({ operation: 'inspect', pid: process.pid }), 'utf8').toString('base64')
const claudePackagePath = path.join(scratch, 'Claude-x64.msix')
fs.writeFileSync(claudePackagePath, storedZip('AppxManifest.xml', fs.readFileSync(manifestPath)))
const programFilesCandidate = path.join(machinePaths.programFiles, 'Common Files')

function trustedEnv(extra = {}) {
  return { ...trustedCommandEnvironment(), ...extra }
}

// An unsigned stand-in for the Claude Desktop MSIX: a zip holding only the
// manifest, stored without compression so no zip library is needed here.
function storedZip(name, data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  crc = (crc ^ 0xffffffff) >>> 0
  const fileName = Buffer.from(name, 'utf8')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x21, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(fileName.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x21, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(fileName.length, 28)
  const centralOffset = local.length + fileName.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + fileName.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, fileName, data, central, fileName, end])
}

// [name, limit, run]; run returns a short description for the log.
const trustedProbes = [
  ['running CLI process', cliProcessProbeTimeoutMs, async () => {
    const probe = await probeRunningCliProcesses(repo)
    assert.equal(probe.status, 'checked', probe.detail)
    return `${probe.processes.length} process(es)`
  }],
  ['check page Codex desktop', diagnosticsCodexDesktopProbeTimeoutMs, async () => {
    const parsed = JSON.parse((await runPowerShell(['-Command', buildDiagnosticsCodexDesktopProbeScript()], trustedEnv())).trim())
    return `installed=${Boolean(parsed.AppID)}, running=${parsed.Running}`
  }],
  ['external client inventory', externalClientSystemCommandTimeoutMs, async () => {
    const parsed = JSON.parse((await runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(windowsExternalClientInventoryScript())], trustedEnv())).trim())
    assert.ok(Array.isArray(parsed.clients))
    return `${parsed.clients.length} client(s), errors=${JSON.stringify(parsed.errors)}`
  }],
  ['uninstall desktop account', 90_000, async () => {
    const output = await runPowerShell(['-Command', uninstallAccountProbeScript], trustedEnv())
    assert.match(output, /^process=S-1-/m)
    return output.match(/^desktop=/m) ? 'desktop owner found' : 'no desktop owner in this session'
  }],
  ['Claude desktop manifest', claudeDesktopPowerShellTimeoutMs, async () => {
    const script = buildClaudeDesktopManifestInspectionScript(manifestPath, '1.0.0.0', 'x64')
    const parsed = JSON.parse((await runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(script)], trustedEnv())).trim())
    assert.equal(parsed.globalMode, 'enabled')
    return `globalMode=${parsed.globalMode}`
  }],
  ['Claude desktop policy', claudeDesktopPowerShellTimeoutMs, async () => {
    const parsed = JSON.parse((await runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(claudeDesktopPolicyReadScript)], trustedEnv())).trim())
    return `${(parsed.machine ?? []).length + (parsed.user ?? []).length} policy value(s)`
  }],
  ['Claude desktop package inspection', claudeDesktopPackageInspectionTimeoutMs, async () => {
    const output = await runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(buildClaudeDesktopPackageInspectionScript(claudePackagePath))], trustedEnv())
    const parsed = JSON.parse(output.trim())
    assert.deepEqual(
      [parsed.name, parsed.version, parsed.architecture, parsed.publisher, parsed.publisherCanonical, parsed.hasSignature],
      ['Claude', '1.0.0.0', 'x64', 'CN=Test', 'CN=Test', false],
    )
    // Every identity field was read; the unsigned stand-in is refused for its signature alone.
    assert.throws(() => validateClaudeDesktopPackageInspection(output, 'x64', windowsPackagePublisherId('CN=Test')), /缺少有效的 Anthropic 签名/)
    return `signature=${parsed.signatureStatus}`
  }],
  ['proxy settings', windowsProxyPowerShellTimeoutMs, async () => {
    const scopes = await readWindowsProxyScopes()
    return `user=${Object.keys(scopes.user).length}, machine=${Object.keys(scopes.machine).length}`
  }],
  ['system proxy owner lookup', windowsSystemProxyCommandTimeoutMs, async () => {
    const parsed = JSON.parse((await runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(windowsSystemProxyScript)], trustedEnv({ XINGMANG_SYSTEM_PROXY_REQUEST: systemProxyRequest }))).trim())
    assert.match(String(parsed.startedAt), /^\d+$/)
    return 'owner found'
  }],
  ['system proxy reading', windowsSystemProxyCommandTimeoutMs, async () => {
    const parsed = JSON.parse((await runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(windowsSystemProxyScript)], trustedEnv({ XINGMANG_SYSTEM_PROXY_REQUEST: systemProxyReadRequest }))).trim())
    assert.match(String(parsed.owner?.startedAt), /^\d+$/)
    // Only the flags reach the log: the proxy strings are the runner's settings, not ours.
    return `flags=${parseWindowsProxySnapshot(parsed.snapshot).flags}`
  }],
  ['pending restart', nodeRuntimeWindowsProbeTimeoutMs, async () => {
    const status = await inspectWindowsRestartRequired()
    return `required=${status.required}`
  }],
  ['App Installer package', nodeRuntimeWindowsProbeTimeoutMs, async () => {
    const output = await runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(appInstallerQueryScript)], trustedEnv())
    return output.trim() ? 'found' : 'not installed'
  }],
  ['Node.js installer signature', signatureCheckTimeoutMs, async () => signatureStatus(nodeInstallerSignatureScript, { XINGMANG_NODE_MSI_PATH: process.execPath })],
  ['installed Node.js signature', signatureCheckTimeoutMs, async () => signatureStatus(installedNodeSignatureScript, { XINGMANG_NODE_EXE_PATH: process.execPath })],
  ['Python installer signature', signatureCheckTimeoutMs, async () => signatureStatus(pythonInstallerSignatureScript, { XINGMANG_PYTHON_FILE_PATH: process.execPath })],
  ['installed Python check', signatureCheckTimeoutMs, async () => signatureStatus(installedPythonInspectionScript, { XINGMANG_PYTHON_FILE_PATH: process.execPath })],
  ['WorkBuddy installer signature', signatureCheckTimeoutMs, async () => signatureStatus(workBuddyInstallerSignatureScript, { XINGMANG_WORKBUDDY_INSTALLER: process.execPath })],
  ['native CLI signature', nativeCliSignatureTimeoutMs, async () => {
    const parsed = JSON.parse((await runPowerShell(['-Command', nativeCliSignatureScript], trustedEnv({ XINGMANG_NATIVE_CLI: process.execPath }))).trim())
    assert.ok(parsed.Status)
    return `status=${parsed.Status}`
  }],
  ['Program Files ACL', programFilesAclTimeoutMs, async () => {
    const snapshot = await inspectProgramFilesAclAsync(programFilesCandidate, machinePaths.programFiles, machinePaths)
    assert.ok(Array.isArray(snapshot.entries))
    return `${snapshot.entries.length} level(s)`
  }],
  ['managed directory tree ACL', windowsDirectoryTreeAclTimeoutMs, async () => {
    const snapshot = inspectWindowsDirectoryTreeAcl(path.join(scratch, 'tree'), machinePaths)
    assert.ok(Array.isArray(snapshot.entries))
    return `${snapshot.entries.length} entr(ies)`
  }],
]

async function signatureStatus(script, extra) {
  const parsed = JSON.parse((await runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(script)], trustedEnv(extra))).trim())
  assert.ok(parsed.status)
  return `status=${parsed.status}`
}

for (const [name, limit, run] of trustedProbes) {
  checks.push([`${name} probe answers inside its own limit under the trusted environment`, async () => {
    const startedAt = Date.now()
    const outcome = await run()
    const elapsed = Date.now() - startedAt
    console.log(`info ${name} probe under the trusted environment: ${outcome} (${elapsed}ms of ${limit}ms)`)
    assert.ok(elapsed < limit, `took ${elapsed}ms, the app gives it ${limit}ms`)
  }])
}

// The CLI terminal itself stays closed, but the step of its launch that reads
// the folder's name runs here. The broker's Start-Process resolves
// -WorkingDirectory as a wildcard, so a project folder such as 作业[1] used to
// fail on every open. The broker the app builds for such a folder runs as built,
// except that its Start-Process starts a hidden, waited-for cmd.exe in place of
// the terminal, so the runner keeps no window; cmd records where it was started.
// Unescaped, the same broker must still fail: that is the premise of the
// escaping, and the failure is the one the customer's error dialog quotes, so it
// must come back as the cause alone, in plain text that reads back as UTF-8.
// Both shells the app may pick are tried.
const {
  buildCliLaunchPlan,
  decodeWindowsPowerShellCommand,
  describeWindowsCliLaunchError,
  parseStartedWindowsProcessId,
  powerShellLiteral,
  windowsPowerShellCandidates,
} = compiled('windows-elevation')
const launchBrokerMarker = path.join(scratch, 'launch-broker-cwd.txt')

function withLaunchedCmd(broker) {
  const cmd = path.join(machinePaths.system32, 'cmd.exe')
  // /u: cmd writes what `cd` prints as UTF-16, so the folder's Chinese name survives the file.
  const argumentList = ['/d', '/u', '/c', `cd > "${launchBrokerMarker}"`].map(powerShellLiteral).join(', ')
  const launched = / -FilePath '(?:[^']|'')*' -ArgumentList @\([^)]*\) -WorkingDirectory /
  const shown = ' -WindowStyle Normal -PassThru;'
  assert.ok(launched.test(broker) && broker.includes(shown), 'the broker no longer reads the way this check expects')
  return broker
    .replace(launched, () => ` -FilePath ${powerShellLiteral(cmd)} -ArgumentList @(${argumentList}) -WorkingDirectory `)
    .replace(shown, () => ' -WindowStyle Hidden -Wait -PassThru;')
}

function runLaunchBroker(shell, script, cwd) {
  return new Promise((resolve) => {
    const child = execFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsPowerShellCommand(script)], {
      cwd, env: trustedEnv(), encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: probeBudgetMs,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    child.stdin?.end()
  })
}

checks.push(['the CLI launch broker opens a folder whose name has brackets, and reports a failure by its cause', async () => {
  const folder = path.join(scratch, '作业[1]', 'a`[b]')
  fs.mkdirSync(folder, { recursive: true })
  const shells = windowsPowerShellCandidates(process.env, 'win32', machinePaths).filter((shell) => fs.existsSync(shell))
  assert.ok(shells.length > 0)
  for (const shell of shells) {
    const name = path.basename(shell)
    const broker = withLaunchedCmd(decodeWindowsPowerShellCommand(buildCliLaunchPlan({ executable: process.execPath, workspace: folder, title: 'smoke' }, shell).argv.at(-1)))
    const shipped = / -WorkingDirectory ('(?:[^']|'')*') /.exec(broker)?.[1]
    assert.ok(shipped && shipped !== powerShellLiteral(folder), 'the broker no longer escapes the folder')

    fs.rmSync(launchBrokerMarker, { force: true })
    const startedAt = Date.now()
    const opened = await runLaunchBroker(shell, broker, folder)
    const elapsed = Date.now() - startedAt
    assert.equal(opened.error, null, `${name}: ${opened.stderr}`)
    assert.ok(parseStartedWindowsProcessId(opened.stdout), `${name} printed no process id: ${opened.stdout}`)
    // Both sides resolved, so a short 8.3 temp path still compares equal.
    const recorded = fs.readFileSync(launchBrokerMarker, 'utf16le').trim()
    assert.equal(fs.realpathSync.native(recorded).toLowerCase(), fs.realpathSync.native(folder).toLowerCase())

    const unescapedBroker = broker.replace(shipped, () => powerShellLiteral(folder))
    const unescaped = await runLaunchBroker(shell, unescapedBroker, folder)
    assert.ok(unescaped.error, `${name} opened the folder unescaped, so escaping it no longer matches what PowerShell does`)
    // The broker's catch wrote the cause, not PowerShell: no error view in CLIXML. A CLIXML
    // header alone may still come first, when the host reported progress before the catch ran.
    assert.ok(!unescaped.stderr.includes('<S S="Error">'), `${name} reported the failure itself: ${unescaped.stderr}`)
    assert.match(unescaped.stderr, /wildcard|通配符/i, `${name}: ${unescaped.stderr}`)
    assert.ok(unescaped.stderr.includes('作'), `${name} did not report the folder's name as UTF-8: ${unescaped.stderr}`)
    // What the error dialog would say, given what execFileAsync hands launchCliPowerShell.
    const dialog = describeWindowsCliLaunchError(Object.assign(unescaped.error, { stdout: unescaped.stdout, stderr: unescaped.stderr }))
    assert.ok(dialog.startsWith('Windows 无法启动 PowerShell：') && dialog.includes('作业'), `${name}: ${dialog}`)
    assert.doesNotMatch(dialog, /Command failed|EncodedCommand|CLIXML|<S /, `${name}: ${dialog}`)

    // Printed only: whether this runner would garble the same cause without the switch.
    const withoutSwitch = await runLaunchBroker(shell, unescapedBroker.slice(unescapedBroker.indexOf('Import-Module')), folder)
    const header = unescaped.stderr.startsWith('#< CLIXML') ? 'after a CLIXML header' : 'as plain text'
    console.log(`info CLI launch broker on ${name}: opened the folder in ${elapsed}ms; unescaped the cause came back ${header} and the dialog would read ${JSON.stringify(dialog)}, and without the UTF-8 switch the folder's name ${withoutSwitch.stderr.includes('作') ? 'still comes through' : 'is lost'}`)
  }
}])

// The Codex debugging port owner lookup reads the TCP table with netstat.exe
// now, not PowerShell, so it is checked against a port whose owners are known
// rather than an empty one. This process listens on the port, and its end
// closes one connection first, which leaves a TIME_WAIT row with PID 0 on the
// port, the way Codex's end of a closed request does. A second process then
// connects out from 127.0.0.2 with the same port number, which must not count,
// and a third listens on it over IPv6, which must. Every lookup is held to the
// limit the app gives it.
function listenOn(server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options, () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function connectUntilClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('error', reject)
    socket.once('close', resolve)
    socket.resume()
  })
}

// Resolves with the helper's first line, which says what it managed to set up.
function startPortHelper(source) {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  const ready = new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`port helper said nothing within 30000ms: ${output}`)), 30_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('\n')) {
        clearTimeout(timer)
        resolve(output.split('\n')[0].trim())
      }
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); reject(new Error(`port helper exited with ${code} before it reported: ${output}`)) })
  })
  return { child, ready }
}

async function lookUpPortOwners(port, situation) {
  const startedAt = Date.now()
  const owners = await resolveCodexDesktopCdpPortOwners(port)
  const elapsed = Date.now() - startedAt
  console.log(`info Codex debugging port owner lookup, ${situation}: ${owners.length ? owners.join(', ') : 'no listener'} (${elapsed}ms of ${codexDesktopCdpCommandTimeoutMs}ms)`)
  assert.ok(elapsed < codexDesktopCdpCommandTimeoutMs, `took ${elapsed}ms, the app gives it ${codexDesktopCdpCommandTimeoutMs}ms`)
  return owners
}

checks.push(['Codex debugging port owner lookup names the real listeners inside its own limit', async () => {
  assert.deepEqual(await lookUpPortOwners(1, 'nothing listening'), [])
  const sockets = new Set()
  let endNextConnection = true
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    if (endNextConnection) {
      endNextConnection = false
      socket.end()
    }
  })
  const helpers = []
  try {
    const port = await listenOn(server, { host: '127.0.0.1', port: 0 })
    await connectUntilClosed(port)
    assert.deepEqual(await lookUpPortOwners(port, 'this process listening'), [process.pid])

    const outgoing = startPortHelper(`
      const socket = require('node:net').connect({ host: '127.0.0.1', port: ${port}, localAddress: '127.0.0.2', localPort: ${port} })
      socket.on('connect', () => console.log('connected'))
      socket.on('error', (error) => console.log('unavailable ' + error.code))
      setInterval(() => {}, 60_000)
    `)
    helpers.push(outgoing.child)
    const outgoingState = await outgoing.ready
    if (outgoingState === 'connected') {
      assert.deepEqual(await lookUpPortOwners(port, 'another process connected out from the same port number'), [process.pid])
    } else {
      console.log(`info Codex debugging port owner lookup: no connection from 127.0.0.2 on this runner (${outgoingState})`)
    }

    const listener = startPortHelper(`
      const server = require('node:net').createServer()
      server.on('error', (error) => { console.log('unavailable ' + error.code); setInterval(() => {}, 60_000) })
      server.listen({ host: '::1', port: ${port} }, () => console.log('listening'))
    `)
    helpers.push(listener.child)
    const listenerState = await listener.ready
    if (listenerState === 'listening') {
      const owners = await lookUpPortOwners(port, 'another process listening over IPv6')
      assert.deepEqual([...owners].sort((a, b) => a - b), [process.pid, listener.child.pid].sort((a, b) => a - b))
    } else {
      console.log(`info Codex debugging port owner lookup: no IPv6 loopback listener on this runner (${listenerState})`)
    }
  } finally {
    for (const child of helpers) child.kill()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(() => resolve()))
  }
}])

// What the app falls back to when the in-memory script fails, say on a machine
// whose antivirus refuses it: the script 0.2.14 ran, which compiles WinInet with
// Add-Type. Nothing on this runner refuses anything (Defender's script scanning
// is off), so this only proves the two read the same proxy. The fallback starts
// csc.exe in a cold process, the cost the main script dropped, so its time is
// printed rather than held to the 15 s limit.
checks.push(['the compiled fallback reads the system proxy exactly as the in-memory script does', async () => {
  const env = trustedEnv({ XINGMANG_SYSTEM_PROXY_REQUEST: systemProxyReadRequest })
  const startedAt = Date.now()
  const fallback = JSON.parse((await runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(windowsSystemProxyCompiledScript)], env)).trim())
  const elapsed = Date.now() - startedAt
  const primary = JSON.parse((await runPowerShell(['-EncodedCommand', encodeWindowsPowerShellCommand(windowsSystemProxyScript)], env)).trim())
  assert.deepEqual(parseWindowsProxySnapshot(fallback.snapshot), parseWindowsProxySnapshot(primary.snapshot))
  console.log(`info system proxy reading through the compiled fallback: flags=${parseWindowsProxySnapshot(fallback.snapshot).flags} (${elapsed}ms; the app gives a call ${windowsSystemProxyCommandTimeoutMs}ms)`)
}])

// The same probes with autoloading switched off right after their imports, so
// a forgotten module is named instead of costing the whole scan. Printed only.
// The two ACL probes are left out: they call Microsoft.PowerShell.Security\Get-Acl
// module-qualified, which loads that module by name and is fast, but is refused
// outright once autoloading is 'None', so they would only ever warn here.
const trustedProbeScripts = [
  ['check page Codex desktop', buildDiagnosticsCodexDesktopProbeScript(), {}],
  ['external client inventory', windowsExternalClientInventoryScript(), {}],
  ['uninstall desktop account', uninstallAccountProbeScript, {}],
  ['Claude desktop manifest', buildClaudeDesktopManifestInspectionScript(manifestPath, '1.0.0.0', 'x64'), {}],
  ['Claude desktop policy', claudeDesktopPolicyReadScript, {}],
  ['Claude desktop package inspection', buildClaudeDesktopPackageInspectionScript(claudePackagePath), {}],
  ['proxy settings', buildReadProxyScopesScript(), {}],
  ['system proxy owner lookup', windowsSystemProxyScript, { XINGMANG_SYSTEM_PROXY_REQUEST: systemProxyRequest }],
  ['system proxy reading', windowsSystemProxyScript, { XINGMANG_SYSTEM_PROXY_REQUEST: systemProxyReadRequest }],
  ['system proxy reading, compiled fallback', windowsSystemProxyCompiledScript, { XINGMANG_SYSTEM_PROXY_REQUEST: systemProxyReadRequest }],
  ['pending restart', windowsRestartStatusScript, {}],
  ['App Installer package', appInstallerQueryScript, {}],
  ['Node.js installer signature', nodeInstallerSignatureScript, { XINGMANG_NODE_MSI_PATH: process.execPath }],
  ['native CLI signature', nativeCliSignatureScript, { XINGMANG_NATIVE_CLI: process.execPath }],
]

async function reportTrustedProbesWithoutAutoloading() {
  for (const [name, script, extra] of trustedProbeScripts) {
    const silenced = script.replace(/(Import-Module [^\n;]*)/, "$1; $PSModuleAutoLoadingPreference = 'None'")
    const startedAt = Date.now()
    const { error, stderr } = await runPowerShellCollecting(silenced, trustedEnv(extra))
    const missing = [...new Set([...String(stderr).matchAll(/(?:The term '|无法将“)([A-Za-z]+-[A-Za-z]+)/g)].map((match) => match[1]))]
    const notFound = /CommandNotFoundException/.test(String(stderr))
    const outcome = missing.length
      ? `missing ${missing.join(', ')}`
      : notFound ? 'a command was not found (see stderr)'
        : error ? `failed: ${String(error.message).split('\n')[0]}` : 'no missing command'
    console.log(`${missing.length || notFound ? '::warning::' : 'info '}${name} probe with autoloading off: ${outcome} (${Date.now() - startedAt}ms)`)
  }
}

// The shipped functions, in the environment the app gives them. Under
// trustedCommandEnvironment() command autoloading used to cost about 22 s per
// process on this runner (#714): the Codex merged probe took 23~29 s of its
// 24 s budget, so a scan on a slow machine reported Codex desktop as
// unreadable. It is a real check at its shipped limit; store availability only
// prints its timing.
checks.push(['Codex merged probe answers inside its own limit under the trusted environment', async () => {
  const startedAt = Date.now()
  const output = await runPowerShell(['-Command', buildCodexDesktopCombinedProbeScript()], trustedCommandEnvironment())
  const elapsed = Date.now() - startedAt
  const parsed = JSON.parse(output.trim())
  console.log(`info Codex merged probe under the trusted environment: package=${parsed.package?.packages?.length ? 'yes' : 'none'}, startAppsError=${parsed.startAppsError ?? 'none'}, processesError=${parsed.processesError ?? 'none'}, packageError=${parsed.packageError ?? 'none'} (${elapsed}ms)`)
  assert.ok(elapsed < codexDesktopCombinedProbeTimeoutMs, `took ${elapsed}ms, the app gives it ${codexDesktopCombinedProbeTimeoutMs}ms`)
}])

// With autoloading switched off after the imports, any cmdlet whose module the
// script forgot to import fails by name instead of silently costing 22 s. Only
// printed: it names the culprit if the check above ever goes red again.
async function reportUnimportedCommands() {
  const script = buildCodexDesktopCombinedProbeScript().replace(
    /^(Import-Module .*)$/m,
    "$1\n$PSModuleAutoLoadingPreference = 'None'",
  )
  const startedAt = Date.now()
  try {
    const output = await runPowerShell(['-Command', script], trustedCommandEnvironment())
    const parsed = JSON.parse(output.trim())
    const errors = [parsed.startAppsError, parsed.processesError, parsed.packageError].filter(Boolean)
    console.log(`info Codex merged probe with autoloading off (modules ${codexDesktopCombinedProbeModules.join(', ')}): ${errors.length ? errors.join(' | ') : 'no missing command'} (${Date.now() - startedAt}ms)`)
  } catch (error) {
    console.log(`::warning::Codex merged probe with autoloading off failed after ${Date.now() - startedAt}ms: ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

// The in-memory WinInet declaration is the kind of script an antivirus may
// refuse, and the app falls back when one does, but this runner cannot show it:
// GitHub's Windows images switch Defender's scanning off. Printed only, so the
// log says so outright rather than every check here passing as if it had been
// scanned.
async function reportDefenderOnThisRunner() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $status = Get-MpComputerStatus
  $preference = Get-MpPreference
  [ordered]@{
    mode = [string]$status.AMRunningMode
    antivirus = $status.AntivirusEnabled
    realTime = $status.RealTimeProtectionEnabled
    behaviour = $status.BehaviorMonitorEnabled
    scriptScanning = -not $preference.DisableScriptScanning
    excludedPaths = @($preference.ExclusionPath | Where-Object { $_ }).Count
    detections = @(Get-MpThreatDetection -ErrorAction SilentlyContinue).Count
  } | ConvertTo-Json -Compress
} catch { @{ unavailable = $_.Exception.GetType().Name } | ConvertTo-Json -Compress }
`
  try { console.log(`info Defender on this runner: ${(await runEncoded(script)).trim()}`) }
  catch (error) { console.log(`info Defender on this runner: not readable (${String(error?.message ?? error).split('\n')[0]})`) }
}

async function reportTrustedEnvironmentTimings() {
  const availabilityStartedAt = Date.now()
  const available = await inspectWindowsStoreAvailability({ timeoutMs: probeBudgetMs })
  console.log(`info inspectWindowsStoreAvailability under the trusted environment: ${available} (${Date.now() - availabilityStartedAt}ms)`)
  await reportUnimportedCommands()
}

const failures = []
for (const [name, check] of checks) {
  const startedAt = Date.now()
  try {
    await check()
    console.log(`ok   ${name} (${Date.now() - startedAt}ms)`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name} (${Date.now() - startedAt}ms)\n${error?.stack ?? error}`)
  }
}
await reportTrustedEnvironmentTimings()
await reportCodexSingleProbesWithoutAutoloading()
await reportTrustedProbesWithoutAutoloading()
await reportDefenderOnThisRunner()
fs.rmSync(scratch, { recursive: true, force: true })
if (failures.length) {
  console.error(`${failures.length} of ${checks.length} PowerShell probe checks failed`)
  process.exit(1)
}
console.log(`PASS: ${checks.length} PowerShell probe checks`)
