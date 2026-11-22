import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// S01: the elevated update handoff script (build/update-handoff/verified-install.ps1)
// run for real, once per CI run. The hosted runner's account is an administrator
// with an elevated token, which is what elevate.exe hands the script on a
// customer's machine; elevate.exe itself is left out, the rest of the command
// line is the one the app builds. A small setup.exe compiled here stands in for
// the installer: it records the arguments it got, where it ran from and that
// directory's security descriptor. The unit tests cover the command and the
// status parser without starting PowerShell; this proves the script still does
// what they assume. It runs after `npm run compile` and drives the compiled
// modules the app ships.
//
// With --elevate <resources\elevate.exe of a built package> it runs the other
// half once the package exists: the same handoff started the way the app starts
// it, through that package's own elevate.exe and script. What elevate.exe does
// with its arguments and what its exit code means are facts about a binary
// electron-builder ships, not something the code here decides, so every check
// prints what it saw before it asserts anything.
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
  buildWindowsUpdateHandoffCommand, classifyWindowsElevateExit, launchDetachedWindowsProcess, parseWindowsUpdateHandoffStatus,
  readWindowsUpdateHandoffStatusFile, resolveWindowsUpdateHandoffStatusPath,
} = compiled('windows-update-handoff')
const { resolveWindowsPowerShellExecutable } = compiled('windows-elevation')
const { resolveWindowsMachinePaths } = compiled('windows-machine-paths')
const { trustedCommandEnvironment } = compiled('command-runner')

const elevateArgument = process.argv.indexOf('--elevate')
const packagedElevate = elevateArgument === -1 ? null : path.resolve(process.argv[elevateArgument + 1] ?? '')
const budgetMs = 120_000
const machinePaths = resolveWindowsMachinePaths()
const powershell = resolveWindowsPowerShellExecutable({ machinePaths })
const script = path.join(repo, 'build', 'update-handoff', 'verified-install.ps1')
const windowsTemp = path.join(machinePaths.systemRoot, 'Temp')
// A space and Chinese in every path the script is handed, as on a customer's
// machine whose account name has them.
const work = fs.mkdtempSync(path.join(os.tmpdir(), '星芒 更新交接-'))
let nonceCounter = 0

function nextNonce() {
  nonceCounter += 1
  return createHash('sha256').update(`${process.pid}-${Date.now()}-${nonceCounter}`).digest('hex').slice(0, 32)
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
    File.WriteAllLines(@"${report.replace(/"/g, '""')}", new string[] {
      "ARGS=" + string.Join("|", args),
      "DIR=" + directory,
      "CWD=" + Environment.CurrentDirectory,
      "SDDL=" + sddl,
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

async function runHandoff({ packagePath, sha512, size, parentPid, nonce }) {
  const command = buildWindowsUpdateHandoffCommand({
    elevate: 'C:\\unused\\elevate.exe', powershell, script, packagePath, sha512, size, parentPid, nonce,
  })
  // What elevate.exe would start: everything after its own name.
  const [file, ...args] = command.args
  const before = stagingDirectories()
  const result = await run(file, args)
  const leftovers = [...stagingDirectories()].filter((name) => !before.has(name))
  const statusPath = resolveWindowsUpdateHandoffStatusPath(machinePaths.systemRoot, nonce)
  const raw = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8') : null
  // The app reads the status through the same checked reader it ships, so a
  // file the script leaves where that reader refuses to look counts as missing.
  const shipped = await readWindowsUpdateHandoffStatusFile(statusPath)
  assert.equal(shipped, raw, 'the app must be able to read the status file the script wrote')
  const status = raw === null ? null : parseWindowsUpdateHandoffStatus(raw, nonce)
  console.log(`  exit ${result.code} in ${result.ms}ms, status ${JSON.stringify(status)}`)
  assert.equal(result.killed, false, `the handoff script outlived ${budgetMs}ms\n${result.stderr}`)
  assert.deepEqual(leftovers, [], 'the script must remove the staging directory it created')
  return { ...result, status, statusPath }
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
  const passing = await compileFakeSetup('fake-setup-ok.exe', 0)
  const failing = await compileFakeSetup('fake-setup-fails.exe', 7)

  console.log('a verified package is installed from the protected copy once the app has quit')
  {
    const updatePackage = packageFrom(passing.output, 'XingMang-AI-Manager-9.9.9-Setup.exe')
    const parent = startParent(4_000)
    const nonce = nextNonce()
    const result = await runHandoff({ ...updatePackage, parentPid: parent.pid, nonce })
    assert.equal(result.code, 0, result.stderr)
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

  console.log('a package whose digest does not match is never run')
  {
    const updatePackage = packageFrom(passing.output, 'XingMang-AI-Manager-9.9.9-Setup-wrong-digest.exe')
    const other = createHash('sha512').update('something else').digest('base64')
    const result = await runHandoff({ ...updatePackage, sha512: other, parentPid: process.pid, nonce: nextNonce() })
    assert.equal(result.code, 3, result.stderr)
    assert.deepEqual(result.status, { state: 'mismatch', exitCode: 0 })
    assert.equal(fs.existsSync(passing.report), false, 'the installer must not run')
  }

  console.log('a package whose size does not match is never run')
  {
    const updatePackage = packageFrom(passing.output, 'XingMang-AI-Manager-9.9.9-Setup-wrong-size.exe')
    const result = await runHandoff({ ...updatePackage, size: updatePackage.size + 1, parentPid: process.pid, nonce: nextNonce() })
    assert.equal(result.code, 3, result.stderr)
    assert.deepEqual(result.status, { state: 'mismatch', exitCode: 0 })
    assert.equal(fs.existsSync(passing.report), false, 'the installer must not run')
  }

  console.log('an installer that fails is reported for the next start')
  {
    const updatePackage = packageFrom(failing.output, 'XingMang-AI-Manager-9.9.9-Setup-fails.exe')
    const parent = startParent(500)
    await parent.exited
    const result = await runHandoff({ ...updatePackage, parentPid: parent.pid, nonce: nextNonce() })
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
      const result = await runHandoff({ ...updatePackage, parentPid: process.pid, nonce })
      assert.equal(result.code, 5, result.stderr)
      assert.equal(fs.existsSync(passing.report), false, 'the installer must not run')
    } finally {
      fs.rmSync(statusPath, { force: true })
    }
  }

  console.log('PASS: the update handoff script copies, checks and installs only the package it was given the digest of')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForFile(file, ms) {
  const deadline = Date.now() + ms
  while (!fs.existsSync(file) && Date.now() < deadline) await delay(250)
  return fs.existsSync(file)
}

// Every state the script wrote, in order, until it reaches one it stops at. A
// script that never writes one is given up on after startedMs.
async function followStatus(statusPath, nonce, startedMs, finalMs) {
  const started = Date.now()
  const states = []
  let status = null
  for (;;) {
    status = parseWindowsUpdateHandoffStatus(await readWindowsUpdateHandoffStatusFile(statusPath), nonce)
    if (status && states.at(-1) !== status.state) states.push(status.state)
    if (status && status.state !== 'started' && status.state !== 'verified') break
    const elapsed = Date.now() - started
    if ((!status && elapsed >= startedMs) || elapsed >= finalMs) break
    await delay(250)
  }
  return { status, states }
}

async function elevateMain(elevate) {
  assert.ok(fs.existsSync(elevate), `${elevate} does not exist`)
  const packagedScript = path.join(path.dirname(elevate), 'update-handoff', 'verified-install.ps1')
  assert.ok(fs.existsSync(packagedScript), `${packagedScript} does not exist`)
  const env = trustedCommandEnvironment()

  console.log('elevate.exe starts the program it is given, with every argument as it was passed')
  {
    // The stand-in lives under the work directory, so its own path carries a
    // space and Chinese as well.
    const probe = await compileFakeSetup('fake-elevate-args.exe', 0)
    const probeArgs = ['two words', '星芒 中文', '--flag', '/S']
    const exit = await launchDetachedWindowsProcess(elevate, [probe.output, ...probeArgs], env)
    const started = await waitForFile(probe.report, 30_000)
    const report = started ? readReport(probe.report) : null
    console.log(`  elevate.exe exit ${exit}; program ${started ? `started with ${JSON.stringify(report.ARGS)}` : 'did not start within 30 s'}`)
    assert.ok(started, 'elevate.exe did not start the program')
    assert.equal(report.ARGS, probeArgs.join('|'), 'elevate.exe changed the arguments on the way')
    assert.equal(classifyWindowsElevateExit(exit), 'launched', `the app reads elevate.exe exit ${exit} as not started`)
  }

  console.log('the handoff the app starts through the packaged elevate.exe and script installs the verified package')
  {
    const passing = await compileFakeSetup('fake-setup-elevated.exe', 0)
    const updatePackage = packageFrom(passing.output, 'XingMang-AI-Manager-9.9.9-Setup.exe')
    const parent = startParent(6_000)
    const nonce = nextNonce()
    const command = buildWindowsUpdateHandoffCommand({
      elevate, powershell, script: packagedScript, ...updatePackage, parentPid: parent.pid, nonce,
    })
    const before = stagingDirectories()
    const exit = await launchDetachedWindowsProcess(command.file, command.args, env)
    const statusPath = resolveWindowsUpdateHandoffStatusPath(machinePaths.systemRoot, nonce)
    const { status, states } = await followStatus(statusPath, nonce, 30_000, budgetMs)
    console.log(`  elevate.exe exit ${exit}; status ${states.length ? states.join(' -> ') : 'never written'}, last ${JSON.stringify(status)}`)
    assert.equal(classifyWindowsElevateExit(exit), 'launched', `the app reads elevate.exe exit ${exit} as not started`)
    assert.deepEqual(status, { state: 'installed', exitCode: 0 })
    assert.equal(readReport(passing.report).ARGS, '--updated|/S|--force-run')
    assert.deepEqual([...stagingDirectories()].filter((name) => !before.has(name)), [], 'the script must remove the staging directory it created')
  }

  console.log('PASS: the packaged elevate.exe and script carry the handoff through to the installer')
}

try {
  if (packagedElevate) await elevateMain(packagedElevate)
  else await main()
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
