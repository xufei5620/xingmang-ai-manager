import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// S01: the update handoff script (build/update-handoff/verified-install.ps1) run
// for real, once per CI run. Most cases run the elevated half directly, where its
// exit code says what it decided. The last one is the whole chain the app starts:
// the system PowerShell runs the script unelevated with -Relaunch, the script asks
// Windows to start an elevated copy of itself, and that copy installs. The hosted
// runner's account is an administrator with an elevated token, so the consent
// prompt never shows and Windows starts the elevated copy straight away, as it
// does on a customer's machine once they click Yes. A small
// setup.exe compiled here stands in for the installer: it records the arguments
// it got, where it ran from, the temp folder it was given and the security
// descriptors of both. The unit
// tests cover the command and the status parser without starting PowerShell;
// this proves the script still does what they assume. It runs after
// `npm run compile` and drives the compiled modules the app ships.
//
// Then the same handoff once under a machine-wide ConstrainedLanguage lockdown and
// once under an AllSigned execution policy from Group Policy, where PowerShell stops
// the script before it asks for elevation: the app must read that as blocked (the
// customer is sent to the download page), not as a consent prompt that was closed.
//
// With --packaged <resources directory of a built package> only the digest
// mismatch and the whole chain run, with that package's own copy of the script.
//
// The relaunch is started the way the app starts it (runHiddenWindowsProcess):
// started detached, the system PowerShell exited 0 here within 114 ms without
// running the script at all.
//
// The relaunch replaced resources\elevate.exe, the helper electron-builder ships,
// after this smoke ran it on the runner: it rejoined its arguments with plain
// spaces (a quoted "two words" reached the program as two arguments), returned
// 0 at once without waiting for the program, and exited 1 without starting
// anything once its arguments ran to a few hundred characters, which the
// handoff's always do.
if (process.platform !== 'win32') {
  console.log('SKIP: the update handoff smoke needs Windows PowerShell and an elevated runner')
  process.exit(0)
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
function compiled(name) {
  return require(path.join(repo, 'dist-electron', `${name}.js`))
}
const {
  buildWindowsUpdateHandoffCommand, classifyWindowsHandoffLaunchExit, createWindowsUpdateHandoff, runHiddenWindowsProcess, parseWindowsUpdateHandoffStatus,
  readWindowsUpdateHandoffStatusFile, resolveWindowsUpdateHandoffStatusPath,
} = compiled('windows-update-handoff')
const { resolveWindowsPowerShellExecutable } = compiled('windows-elevation')
const { resolveWindowsMachinePaths } = compiled('windows-machine-paths')
const { trustedCommandEnvironment } = compiled('command-runner')

const packagedArgument = process.argv.indexOf('--packaged')
const packagedResources = packagedArgument === -1 ? null : path.resolve(process.argv[packagedArgument + 1] ?? '')
const budgetMs = 120_000
const machinePaths = resolveWindowsMachinePaths()
const powershell = resolveWindowsPowerShellExecutable({ machinePaths })
const script = packagedResources
  ? path.join(packagedResources, 'update-handoff', 'verified-install.ps1')
  : path.join(repo, 'build', 'update-handoff', 'verified-install.ps1')
const windowsTemp = path.join(machinePaths.systemRoot, 'Temp')
// A space and Chinese in every path the script is handed, as on a customer's
// machine whose account name has them.
const work = fs.mkdtempSync(path.join(os.tmpdir(), '星芒 更新交接-'))
let nonceCounter = 0

function nextNonce() {
  nonceCounter += 1
  return createHash('sha256').update(`${process.pid}-${Date.now()}-${nonceCounter}`).digest('hex').slice(0, 32)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = execFile(file, args, {
      encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: budgetMs, env: trustedCommandEnvironment(), ...options,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
      resolve({ code, stdout, stderr, killed: Boolean(error?.killed), ms: Date.now() - started })
    })
    child.stdin?.end()
  })
}

function powershellCommand(command) {
  return run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command])
}

function literal(value) {
  return `'${value.replace(/'/g, "''")}'`
}

function stagingDirectories() {
  return new Set(fs.readdirSync(windowsTemp).filter((name) => /^xingmang-update-[0-9a-f]{32}$/.test(name)))
}

// The stand-in installer. Report path and exit code are compiled in so nothing
// depends on what the script passes through in the environment.
async function compileFakeSetup(name, exitCode) {
  const output = path.join(work, name)
  const report = path.join(work, `${name}.report.txt`)
  const source = `
using System;
using System.IO;
using System.Security.AccessControl;
public static class FakeSetup {
  public static int Main(string[] args) {
    string directory = Path.GetDirectoryName(System.Reflection.Assembly.GetEntryAssembly().Location);
    string sddl = Directory.GetAccessControl(directory).GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
    // Where an NSIS installer would unpack: Windows resolves it from TMP, then TEMP.
    string temp = Path.GetTempPath();
    string tempSddl = Directory.GetAccessControl(temp).GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
    string probe = Path.Combine(temp, "probe.tmp");
    File.WriteAllText(probe, "probe");
    File.Delete(probe);
    File.WriteAllLines(@"${report.replace(/"/g, '""')}", new string[] {
      "ARGS=" + string.Join("|", args),
      "DIR=" + directory,
      "CWD=" + Environment.CurrentDirectory,
      "SDDL=" + sddl,
      "TEMP=" + Environment.GetEnvironmentVariable("TEMP"),
      "TMP=" + Environment.GetEnvironmentVariable("TMP"),
      "TEMPPATH=" + temp,
      "TEMPSDDL=" + tempSddl,
    });
    return ${exitCode};
  }
}`
  const sourcePath = path.join(work, `${name}.cs`)
  fs.writeFileSync(sourcePath, source, 'utf8')
  const result = await powershellCommand(`Add-Type -TypeDefinition ([IO.File]::ReadAllText(${literal(sourcePath)})) -OutputAssembly ${literal(output)} -OutputType ConsoleApplication`)
  assert.equal(result.code, 0, `compiling the stand-in installer failed:\n${result.stderr}`)
  return { output, report }
}

function packageFrom(source, name) {
  const target = path.join(work, name)
  fs.copyFileSync(source, target)
  const bytes = fs.readFileSync(target)
  return { packagePath: target, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length }
}

function startParent(lifetimeMs) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${lifetimeMs})`], { stdio: 'ignore', windowsHide: true })
  const exited = new Promise((resolve) => child.once('exit', () => resolve(Date.now())))
  return { pid: child.pid, exited }
}

function handoffCommand({ packagePath, sha512, size, parentPid, nonce }) {
  return buildWindowsUpdateHandoffCommand({ powershell, script, packagePath, sha512, size, parentPid, nonce })
}

// The status as the app sees it: read through the same checked reader it ships, so
// a file the script leaves where that reader refuses to look counts as missing.
async function readStatus(statusPath, nonce) {
  const raw = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8') : null
  const shipped = await readWindowsUpdateHandoffStatusFile(statusPath)
  assert.equal(shipped, raw, 'the app must be able to read the status file the script wrote')
  return raw === null ? null : parseWindowsUpdateHandoffStatus(raw, nonce)
}

// What the app does: start the unelevated relaunch, then follow the status the
// elevated copy writes until it stops at a state of its own. The app itself never
// waits for that status (it quits once the relaunch has exited), so there is no
// deadline here short of the whole budget: two cold PowerShell starts on a runner
// that has just built the package can take a while, and the timeline says how long.
async function runAsTheApp(input) {
  const command = handoffCommand(input)
  const before = stagingDirectories()
  const started = Date.now()
  const exit = await runHiddenWindowsProcess(command.file, command.args, trustedCommandEnvironment())
  const relaunchMs = Date.now() - started
  const statusPath = resolveWindowsUpdateHandoffStatusPath(machinePaths.systemRoot, input.nonce)
  const timeline = []
  let status = null
  for (;;) {
    status = parseWindowsUpdateHandoffStatus(await readWindowsUpdateHandoffStatusFile(statusPath), input.nonce)
    if (status && timeline.at(-1)?.state !== status.state) timeline.push({ state: status.state, ms: Date.now() - started })
    if (status && status.state !== 'started' && status.state !== 'verified') break
    if (Date.now() - started >= budgetMs) break
    await delay(250)
  }
  const states = timeline.length ? timeline.map((entry) => `${entry.state} at ${entry.ms}ms`).join(' -> ') : 'never written'
  console.log(`  relaunch exit ${exit} after ${relaunchMs}ms; status ${states}; gave up or stopped at ${Date.now() - started}ms`)
  if (!status) await describeMissingElevatedCopy(input.nonce, started)
  assert.equal(classifyWindowsHandoffLaunchExit(exit), 'launched', `the app reads relaunch exit ${exit} as not started`)
  assert.deepEqual(await readStatus(statusPath, input.nonce), status)
  assert.deepEqual([...stagingDirectories()].filter((name) => !before.has(name)), [], 'the script must remove the staging directory it created')
  return { exit, status, statusPath }
}

// Runs only when the elevated copy wrote nothing at all, to say why: whether a
// PowerShell started for this nonce is still running, what the Windows PowerShell
// log recorded for the hosts started with it (event 400 carries the command line a
// host was started with, 403 marks its end), errors the Application log took in the
// meantime, and the exit code of that elevated command line when it is started
// again the way the relaunch started it.
async function describeMissingElevatedCopy(nonce, startedAt) {
  const lookback = Date.now() - startedAt + 5_000
  const result = await powershellCommand(`
$nonce = ${literal(nonce)}
$since = [DateTime]::Now.AddMilliseconds(-${lookback})
$running = $false
foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'")) {
  if ($process.ProcessId -ne $PID -and [string]$process.CommandLine -like "*-Nonce $nonce*") { $running = $true; 'running: ' + $process.ProcessId + ' ' + $process.CommandLine }
}
$elevated = $null
foreach ($entry in @(Get-WinEvent -FilterHashtable @{ LogName = 'Windows PowerShell'; StartTime = $since } -ErrorAction SilentlyContinue)) {
  # Matched on "-Nonce <value>", which this diagnostic's own command line never holds.
  if ([string]$entry.Message -notlike "*-Nonce $nonce*") { continue }
  $lines = [string]$entry.Message -split '\\r?\\n'
  $application = [string]($lines | Where-Object { $_ -match '^\\s*HostApplication=' } | Select-Object -First 1)
  $state = [string]($lines | Where-Object { $_ -match '^\\s*NewEngineState=' } | Select-Object -First 1)
  'event ' + $entry.Id + ' at ' + $entry.TimeCreated.ToString('HH:mm:ss.fff') + ' ' + $state.Trim() + ' ' + $application.Trim()
  if ($entry.Id -eq 400 -and $application -notmatch '-Relaunch') { $elevated = $application.Trim().Substring('HostApplication='.Length) }
}
foreach ($entry in @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 1, 2; StartTime = $since } -ErrorAction SilentlyContinue)) {
  'application error ' + $entry.ProviderName + ' ' + $entry.Id + ': ' + ([string]$entry.Message -split '\\r?\\n' | Select-Object -First 3) -join ' '
}
if ($null -eq $elevated) {
  'no elevated PowerShell host was logged for this nonce'
} elseif ($running) {
  'not run again: a PowerShell for this nonce is still running'
} else {
  if ($elevated.StartsWith('"')) { $end = $elevated.IndexOf('"', 1); $file = $elevated.Substring(1, $end - 1); $rest = $elevated.Substring($end + 1).Trim() }
  else { $space = $elevated.IndexOf(' '); $file = $elevated.Substring(0, $space); $rest = $elevated.Substring($space + 1) }
  $again = Start-Process -FilePath $file -ArgumentList $rest -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  'the elevated command line started again exits ' + $again.ExitCode
}
`)
  console.log(`  why no status (exit ${result.code}):\n${`${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).map((line) => `    ${line}`).join('\n')}`)
}

// The elevated half on its own: the runner is already elevated, so leaving out
// -Relaunch runs exactly what the elevated copy runs, and its exit code is ours.
async function runElevatedHalf(input) {
  const command = handoffCommand(input)
  const args = command.args.filter((arg) => arg !== '-Relaunch')
  assert.equal(args.length, command.args.length - 1)
  const before = stagingDirectories()
  const result = await run(command.file, args)
  const leftovers = [...stagingDirectories()].filter((name) => !before.has(name))
  const statusPath = resolveWindowsUpdateHandoffStatusPath(machinePaths.systemRoot, input.nonce)
  const status = await readStatus(statusPath, input.nonce)
  console.log(`  exit ${result.code} in ${result.ms}ms, status ${JSON.stringify(status)}`)
  assert.equal(result.killed, false, `the handoff script outlived ${budgetMs}ms\n${result.stderr}`)
  assert.deepEqual(leftovers, [], 'the script must remove the staging directory it created')
  return { ...result, status, statusPath }
}

// Machines with application control on (WDAC, AppLocker) run PowerShell in
// ConstrainedLanguage, and Group Policy can pin the execution policy to AllSigned,
// which -ExecutionPolicy Bypass does not override. On both the script never gets
// to ask for elevation: PowerShell stops it and exits 1 (Windows CI, 2026-11-25,
// run 45648962353). Machine-wide __PSLockdownPolicy=4 is the lockdown PowerShell
// itself honours, the same switch the probes smoke was checked against; the
// policy key is what Group Policy writes. Each is undone before the next step.
async function withMachineLockdown(action) {
  const set = await powershellCommand("[Environment]::SetEnvironmentVariable('__PSLockdownPolicy', '4', 'Machine')")
  assert.equal(set.code, 0, set.stderr)
  try {
    const mode = await powershellCommand('$ExecutionContext.SessionState.LanguageMode')
    assert.equal(mode.stdout.trim(), 'ConstrainedLanguage', `the lockdown did not take: ${mode.stdout}${mode.stderr}`)
    return await action()
  } finally {
    const cleared = await run(path.join(machinePaths.system32, 'reg.exe'), ['delete', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', '__PSLockdownPolicy', '/f'])
    assert.equal(cleared.code, 0, cleared.stderr)
    const mode = await powershellCommand('$ExecutionContext.SessionState.LanguageMode')
    assert.equal(mode.stdout.trim(), 'FullLanguage', 'the lockdown must be lifted again')
  }
}

async function withAllSignedPolicy(action) {
  const key = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell'
  const set = await powershellCommand(`New-Item -Path '${key}' -Force | Out-Null; New-ItemProperty -Path '${key}' -Name EnableScripts -PropertyType DWord -Value 1 -Force | Out-Null; New-ItemProperty -Path '${key}' -Name ExecutionPolicy -PropertyType String -Value AllSigned -Force | Out-Null`)
  assert.equal(set.code, 0, set.stderr)
  try {
    return await action()
  } finally {
    const cleared = await powershellCommand(`Remove-Item -Path '${key}' -Recurse -Force`)
    assert.equal(cleared.code, 0, cleared.stderr)
  }
}

// The app's own handoff, as bootstrap/updates.ts builds it, on such a machine.
async function handoffAsTheAppOnABlockedMachine(installer, label) {
  const updatePackage = packageFrom(installer, `XingMang-AI-Manager-9.9.9-Setup-${label}.exe`)
  const nonce = nextNonce()
  const remembered = []
  const before = stagingDirectories()
  const handoff = createWindowsUpdateHandoff({
    parentPid: process.pid,
    resolvePaths: () => ({ powershell, script, windowsDirectory: machinePaths.systemRoot }),
    launch: (file, args) => runHiddenWindowsProcess(file, args, trustedCommandEnvironment()),
    readStatus: readWindowsUpdateHandoffStatusFile,
    rememberAttempt: async (attempt) => { remembered.push(attempt) },
    createNonce: () => nonce,
  })
  const started = Date.now()
  const outcome = await handoff.start({ path: updatePackage.packagePath, sha512: updatePackage.sha512, size: updatePackage.size, version: '9.9.9' })
  console.log(`  ${label}: ${JSON.stringify(outcome)} after ${Date.now() - started}ms`)
  assert.deepEqual(outcome, { kind: 'blocked', reason: 'PowerShell 未运行安装脚本（退出码 1）' })
  assert.deepEqual(remembered, [{ nonce, version: '9.9.9' }, { nonce, version: '9.9.9', blocked: true }])
  await delay(2_000)
  assert.equal(fs.existsSync(resolveWindowsUpdateHandoffStatusPath(machinePaths.systemRoot, nonce)), false, 'no elevated copy may have written a status')
  assert.deepEqual([...stagingDirectories()].filter((name) => !before.has(name)), [], 'no elevated copy may have started')
}

function readReport(report) {
  return Object.fromEntries(fs.readFileSync(report, 'utf8').trim().split(/\r?\n/).map((line) => {
    const index = line.indexOf('=')
    return [line.slice(0, index), line.slice(index + 1)]
  }))
}

function aces(sddl) {
  return [...sddl.matchAll(/\(([^)]*)\)/g)].map((match) => match[1].split(';'))
}

async function main() {
  assert.ok(fs.existsSync(script), `${script} does not exist`)
  const passing = await compileFakeSetup('fake-setup-ok.exe', 0)

  // The elevated half on its own comes first: its exit code says what it decided,
  // which a relaunched copy that never writes a status cannot.
  console.log('a package whose digest does not match is never run')
  {
    const updatePackage = packageFrom(passing.output, 'XingMang-AI-Manager-9.9.9-Setup-wrong-digest.exe')
    const other = createHash('sha512').update('something else').digest('base64')
    const result = await runElevatedHalf({ ...updatePackage, sha512: other, parentPid: process.pid, nonce: nextNonce() })
    assert.equal(result.code, 3, result.stderr)
    assert.deepEqual(result.status, { state: 'mismatch', exitCode: 0 })
    assert.equal(fs.existsSync(passing.report), false, 'the installer must not run')
  }

  if (!packagedResources) {
    const failing = await compileFakeSetup('fake-setup-fails.exe', 7)

    console.log('a relaunch with an argument the script refuses stops before it asks for elevation')
    {
      const updatePackage = packageFrom(passing.output, 'XingMang-AI-Manager-9.9.9-Setup-refused.exe')
      const args = handoffCommand({ ...updatePackage, parentPid: process.pid, nonce: nextNonce() }).args
      args[args.indexOf('-Nonce') + 1] = 'not-a-nonce'
      const before = stagingDirectories()
      const result = await run(powershell, args)
      console.log(`  exit ${result.code} in ${result.ms}ms`)
      // 2 comes from the argument checks, which run before the relaunch; a relaunch
      // that went ahead would have exited 0.
      assert.equal(result.code, 2, result.stderr)
      await delay(3_000)
      assert.deepEqual([...stagingDirectories()].filter((name) => !before.has(name)), [], 'no elevated copy may have started')
    }

    console.log('a package whose size does not match is never run')
    {
      const updatePackage = packageFrom(passing.output, 'XingMang-AI-Manager-9.9.9-Setup-wrong-size.exe')
      const result = await runElevatedHalf({ ...updatePackage, size: updatePackage.size + 1, parentPid: process.pid, nonce: nextNonce() })
      assert.equal(result.code, 3, result.stderr)
      assert.deepEqual(result.status, { state: 'mismatch', exitCode: 0 })
      assert.equal(fs.existsSync(passing.report), false, 'the installer must not run')
    }

    console.log('an installer that fails is reported for the next start')
    {
      const updatePackage = packageFrom(failing.output, 'XingMang-AI-Manager-9.9.9-Setup-fails.exe')
      const parent = startParent(500)
      await parent.exited
      const result = await runElevatedHalf({ ...updatePackage, parentPid: parent.pid, nonce: nextNonce() })
      assert.equal(result.code, 6, result.stderr)
      assert.deepEqual(result.status, { state: 'install-failed', exitCode: 7 })
      assert.equal(fs.existsSync(failing.report), true)
    }

    console.log('a status file name that already exists stops the handoff before anything is copied')
    {
      const updatePackage = packageFrom(passing.output, 'XingMang-AI-Manager-9.9.9-Setup-claimed.exe')
      const nonce = nextNonce()
      const statusPath = resolveWindowsUpdateHandoffStatusPath(machinePaths.systemRoot, nonce)
      fs.writeFileSync(statusPath, JSON.stringify({ nonce, state: 'verified', exitCode: 0 }), 'utf8')
      try {
        const result = await runElevatedHalf({ ...updatePackage, parentPid: process.pid, nonce })
        assert.equal(result.code, 5, result.stderr)
        assert.equal(fs.existsSync(passing.report), false, 'the installer must not run')
      } finally {
        fs.rmSync(statusPath, { force: true })
      }
    }
  }

  console.log(`the app's handoff relaunches the script elevated, which installs the verified package from the protected copy once the app has quit (${script})`)
  {
    const updatePackage = packageFrom(passing.output, 'XingMang-AI-Manager-9.9.9-Setup.exe')
    // Long enough to outlast both PowerShell starts and the copy, so the elevated
    // copy really has to wait for it.
    const parent = startParent(15_000)
    const nonce = nextNonce()
    const result = await runAsTheApp({ ...updatePackage, parentPid: parent.pid, nonce })
    assert.deepEqual(result.status, { state: 'installed', exitCode: 0 })
    const parentExitedAt = await parent.exited
    const report = readReport(passing.report)
    assert.equal(report.ARGS, '--updated|/S|--force-run')
    assert.match(path.basename(report.DIR), /^xingmang-update-[0-9a-f]{32}$/)
    assert.equal(path.dirname(report.DIR).toLowerCase(), windowsTemp.toLowerCase())
    assert.equal(report.CWD.toLowerCase(), report.DIR.toLowerCase())
    // Owned by Administrators, not inheriting, and nobody but SYSTEM and
    // Administrators allowed anything.
    assert.match(report.SDDL, /^O:BA/)
    assert.match(report.SDDL, /D:P/)
    const allowed = aces(report.SDDL).filter((ace) => ace[0] === 'A').map((ace) => ace[5])
    assert.ok(allowed.length > 0)
    assert.deepEqual([...new Set(allowed)].sort(), ['BA', 'SY'])
    // Its temp folder is a folder of its own inside that directory, locked down the
    // same way, not the user's temp folder the script was started with.
    const installTemp = path.join(report.DIR, 'temp')
    assert.equal(report.TEMP.toLowerCase(), installTemp.toLowerCase())
    assert.equal(report.TMP.toLowerCase(), installTemp.toLowerCase())
    assert.equal(path.resolve(report.TEMPPATH).toLowerCase(), installTemp.toLowerCase())
    assert.match(report.TEMPSDDL, /^O:BA/)
    assert.match(report.TEMPSDDL, /D:P/)
    const tempAllowed = aces(report.TEMPSDDL).filter((ace) => ace[0] === 'A').map((ace) => ace[5])
    assert.ok(tempAllowed.length > 0)
    assert.deepEqual([...new Set(tempAllowed)].sort(), ['BA', 'SY'])
    // The installer started only after the process it waited for had exited.
    assert.ok(fs.statSync(passing.report).mtimeMs >= parentExitedAt - 1_000, 'the installer must not start before the app has quit')
    const statusAcl = await powershellCommand(`[IO.File]::GetAccessControl(${literal(result.statusPath)}).GetSecurityDescriptorSddlForm('Owner, Access')`)
    assert.equal(statusAcl.code, 0, statusAcl.stderr)
    assert.match(statusAcl.stdout.trim(), /^O:BAD:P/)
    for (const ace of aces(statusAcl.stdout.trim()).filter((entry) => entry[0] === 'A')) {
      assert.ok(['SY', 'BA', 'BU'].includes(ace[5]), `unexpected status file ACE ${ace.join(';')}`)
      if (ace[5] === 'BU') assert.ok(['FR', '0x120089'].includes(ace[2]), `Users may only read the status file, got ${ace[2]}`)
    }
    fs.rmSync(passing.report, { force: true })
  }

  if (!packagedResources) {
    console.log('where PowerShell stops the script before it asks for elevation, the app reads it as blocked and sends the customer to the download page')
    await withMachineLockdown(() => handoffAsTheAppOnABlockedMachine(passing.output, 'constrained-language'))
    await withAllSignedPolicy(() => handoffAsTheAppOnABlockedMachine(passing.output, 'allsigned-policy'))
    assert.equal(fs.existsSync(passing.report), false, 'the installer must not run')
  }
  console.log(packagedResources
    ? 'PASS: the packaged script relaunches itself elevated and installs only the package it was given the digest of'
    : 'PASS: the update handoff script copies, checks and installs only the package it was given the digest of')
}

try {
  await main()
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
