import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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
  buildWindowsStoreAppLaunchContextScript,
  buildWindowsStoreAvailabilityScript,
  inspectWindowsStoreAppLaunchContext,
  inspectWindowsStoreAvailability,
  parseWindowsStoreAppLaunchContext,
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
  ['Codex merged probe answers all three segments and the current account', async () => {
    const output = await runScript(buildCodexDesktopCombinedProbeScript())
    const parsed = JSON.parse(output.trim())
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'startApps'))
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'processes'))
    assert.ok(parsed.package)
    // 首页装之前的「这个账户打不开商店应用」提醒靠这一段读出当前用户。
    assert.match(String(parsed.storeAppLaunch?.sid ?? ''), /^S-1-\d+(?:-\d+)+$/)
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

checks.push(['store app launch script reads the current account', async () => {
  const context = parseWindowsStoreAppLaunchContext(await runScript(buildWindowsStoreAppLaunchContextScript()))
  assert.match(context.userSid ?? '', /^S-1-\d+(?:-\d+)+$/)
}])

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

// The shipped functions, in the environment the app gives them. Under
// trustedCommandEnvironment() command autoloading used to cost about 22 s per
// process on this runner (#714): the account probe ran past its own 10 s limit
// and the home screen silently lost the "this account cannot open store apps"
// warning, and the Codex merged probe took 23~29 s of its 24 s budget, so a
// scan on a slow machine reported Codex desktop as unreadable. Both are real
// checks at their shipped limits; store availability only prints its timing.
checks.push(['store app launch probe answers inside its own limit under the trusted environment', async () => {
  const context = await inspectWindowsStoreAppLaunchContext()
  assert.match(context.userSid ?? '', /^S-1-5-/)
}])

checks.push(['Codex merged probe answers inside its own limit under the trusted environment', async () => {
  const startedAt = Date.now()
  const output = await runPowerShell(['-Command', buildCodexDesktopCombinedProbeScript()], trustedCommandEnvironment())
  const elapsed = Date.now() - startedAt
  const parsed = JSON.parse(output.trim())
  assert.match(String(parsed.storeAppLaunch?.sid ?? ''), /^S-1-\d+(?:-\d+)+$/)
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
if (failures.length) {
  console.error(`${failures.length} of ${checks.length} PowerShell probe checks failed`)
  process.exit(1)
}
console.log(`PASS: ${checks.length} PowerShell probe checks`)
