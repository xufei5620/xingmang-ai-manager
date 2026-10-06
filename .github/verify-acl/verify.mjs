// Temporary, branch-only: proves the managed-root hardening reorder closes the
// standard-user write window on a real Windows runner. Removed before the PR.
// Drives the compiled modules the app ships (dist-electron), like the e2e smokes.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') { console.log('SKIP: Windows only'); process.exit(0) }

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const compiled = (name) => require(path.join(repo, 'dist-electron', `${name}.js`))
const { applyWindowsRootHardening, windowsAclResetContentsArguments } = compiled('trusted-temp')
const { trustedCommandEnvironment, windowsSystemExecutable } = compiled('command-runner')
const { resolveWindowsMachinePaths, inspectWindowsDirectoryTreeAcl } = compiled('windows-machine-paths')

const machinePaths = resolveWindowsMachinePaths()
const icacls = windowsSystemExecutable('icacls.exe', process.env, 'win32', machinePaths)
const untrustedWrite = /\b(?:BUILTIN\\Users|Everyone|Authenticated Users|S-1-5-32-545|S-1-1-0|S-1-5-11)\b/i

function run(file, args) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env: trustedCommandEnvironment(), windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' }))
    child.stdin?.end()
  })
}

function seedTree(label) {
  const root = path.join(os.tmpdir(), `xingmang-verify-acl-${label}-${process.pid}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'Cli', 'npm', 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(root, 'Cli', 'npm', 'node_modules', 'pkg', 'index.js'), '// content')
  return root
}

// 1) Demonstrate the OLD order's window: `/reset /T` first leaves the root
//    inheriting ProgramData (Users-writable) until the root is hardened.
const oldRoot = seedTree('old')
const reset = await run(icacls, [oldRoot, '/reset', '/T', '/C', '/Q'])
assert.equal(reset.error, null, `old-order reset failed: ${reset.stderr}`)
const afterReset = (await run(icacls, [oldRoot])).stdout
console.log(`VERIFY old-order root ACL right after /reset /T:\n${afterReset}`)
console.log(`VERIFY old-order window present (standard user can write): ${untrustedWrite.test(afterReset)}`)
fs.rmSync(oldRoot, { recursive: true, force: true })

// 2) The NEW order: harden the root first; prove it is locked the instant the
//    first step returns, then that the whole sequence succeeds and verifies.
const newRoot = seedTree('new')
let afterHarden = null
let step = 0
await applyWindowsRootHardening(newRoot, async (args) => {
  const outcome = await run(icacls, args)
  assert.equal(outcome.error, null, `new-order step ${step} failed (${args.join(' ')}): ${outcome.stderr}`)
  step += 1
  if (step === 1) afterHarden = (await run(icacls, [newRoot])).stdout
})
console.log(`VERIFY new-order root ACL right after hardening the root:\n${afterHarden}`)
assert.ok(afterHarden, 'harden step did not run')
assert.doesNotMatch(afterHarden, untrustedWrite, 'new order: root still writable by a standard user right after hardening')
console.log(`VERIFY new-order contents reset ran as ${windowsAclResetContentsArguments(newRoot)[0]}`)

const snapshot = inspectWindowsDirectoryTreeAcl(newRoot, machinePaths)
const trusted = new Set(['S-1-5-18', 'S-1-5-32-544'])
assert.ok(snapshot.entries.length > 0)
for (const entry of snapshot.entries) {
  assert.ok(trusted.has(String(entry.ownerSid).toUpperCase()), `owner ${entry.ownerSid} not trusted`)
  assert.equal(entry.reparsePoint, false)
  for (const sid of entry.allowWriteSids) assert.ok(trusted.has(String(sid).toUpperCase()), `writer ${sid} not trusted`)
}
console.log(`VERIFY new-order final tree hardened: ${snapshot.entries.length} entr(ies), owner+writers all SYSTEM/Administrators`)

// 3) Empty root: the contents reset is skipped so the `\*` wildcard never errors.
const emptyRoot = path.join(os.tmpdir(), `xingmang-verify-acl-empty-${process.pid}`)
fs.rmSync(emptyRoot, { recursive: true, force: true })
fs.mkdirSync(emptyRoot, { recursive: true })
const emptyCalls = []
await applyWindowsRootHardening(emptyRoot, async (args) => {
  emptyCalls.push(args[0])
  const outcome = await run(icacls, args)
  assert.equal(outcome.error, null, `empty-root step failed (${args.join(' ')}): ${outcome.stderr}`)
})
assert.deepEqual(emptyCalls, [emptyRoot, emptyRoot], `empty root should run harden+setowner on the root only, got ${JSON.stringify(emptyCalls)}`)
console.log('VERIFY empty root: contents reset skipped, no wildcard call')
fs.rmSync(newRoot, { recursive: true, force: true })
fs.rmSync(emptyRoot, { recursive: true, force: true })
console.log('VERIFY all checks passed')
