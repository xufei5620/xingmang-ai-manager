import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { asarRawFs } from './asar-raw-fs'
import {
  claudeDesktopBuildScript,
  claudeDesktopFixtureWinChecksum,
  claudeDesktopFixtureWorkspaceSha,
} from './claude-desktop-asar.test-support'

const execFileAsync = promisify(execFile)
const requireFromTest = createRequire(__filename)
const { createSettledPackage } = requireFromTest('../scripts/asar-fixture.test-support.cjs') as {
  createSettledPackage(source: string, archive: string): Promise<string>
}
const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-asar-raw-fs-'))
  temporaryRoots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

interface ElectronReadResult {
  electron: string | null
  plainOpen: string
  plainStat: { directory: boolean, size: number }
  rawStat: { file: boolean, size: number }
  pin: { version: string, checksum: string } | string | null
  manifest: { code: string | null, vm: string | null } | string
}

/**
 * Runs the real readers inside the real Electron binary (as Node, so no display is needed):
 * only there does the asar layer exist that answers for app.asar as if it were a folder. The
 * sources are compiled as they are required, so what runs is this directory's modules with
 * their real imports. The same script first tries the plain node:fs, which proves the fixture
 * really reproduces the EISDIR the 0.2.25 Windows log showed rather than passing because
 * nothing was in the way.
 */
async function readInElectron(root: string, archive: string): Promise<ElectronReadResult> {
  const runner = path.join(root, 'runner.js')
  fs.writeFileSync(runner, `
const fs = require('node:fs')
const ts = require(process.argv[2])
require.extensions['.ts'] = function compileTypeScript(module, filename) {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  module._compile(outputText, filename)
}
const directory = process.argv[3]
const archive = process.argv[4]
const { asarRawFs } = require(directory + '/asar-raw-fs.ts')
const { readClaudeCodeBuildPin } = require(directory + '/claude-desktop-code-seed.ts')
const { readClaudeDesktopComponentManifest } = require(directory + '/claude-desktop-component-manifest.ts')
function failure(error) {
  return error.code ?? String(error)
}
async function main() {
  const plainOpen = await fs.promises.open(archive, 'r').then(async (handle) => { await handle.close(); return 'opened' }, failure)
  const plain = await fs.promises.stat(archive)
  const raw = await asarRawFs().promises.stat(archive)
  const pin = await readClaudeCodeBuildPin(archive, 'win32-x64').then(
    (value) => value && { version: value.version, checksum: value.checksum },
    (error) => 'threw ' + failure(error) + ': ' + error.message,
  )
  const manifest = await readClaudeDesktopComponentManifest(archive).then(
    (value) => ({ code: value.code?.version ?? null, vm: value.vm?.sha ?? null }),
    (error) => 'threw ' + failure(error) + ': ' + error.message,
  )
  process.stdout.write(JSON.stringify({
    electron: process.versions.electron ?? null,
    plainOpen,
    plainStat: { directory: plain.isDirectory(), size: plain.size },
    rawStat: { file: raw.isFile(), size: raw.size },
    pin,
    manifest,
  }))
}
main()
`)
  const electronBinary = requireFromTest('electron') as string
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // The test runner's own loader flags mean nothing to Electron's Node.
  delete environment.NODE_OPTIONS
  const { stdout } = await execFileAsync(
    electronBinary,
    [runner, requireFromTest.resolve('typescript'), __dirname, archive],
    { env: environment, timeout: 30_000 },
  )
  return JSON.parse(stdout) as ElectronReadResult
}

describe('asarRawFs', () => {
  it('is plain node:fs outside Electron, where nothing patched it', () => {
    expect(process.versions.electron).toBeUndefined()
    expect(asarRawFs()).toBe(fs)
  })

  it('lets the Claude Desktop readers open its app.asar inside Electron, where node:fs takes it for a folder', async () => {
    const root = temporaryRoot()
    const source = path.join(root, 'source')
    fs.mkdirSync(path.join(source, '.vite', 'build'), { recursive: true })
    fs.writeFileSync(path.join(source, '.vite', 'build', 'index.js'), claudeDesktopBuildScript())
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"claude-desktop-fixture"}\n')
    const archive = path.join(root, 'Claude', 'app', 'resources', 'app.asar')
    fs.mkdirSync(path.dirname(archive), { recursive: true })
    await createSettledPackage(source, archive)

    const result = await readInElectron(root, archive)

    expect(result.electron).toEqual(expect.any(String))
    // What the main process's node:fs does with it (claude-desktop.code-seed.skipped, cause EISDIR).
    expect(result.plainOpen).toBe('EISDIR')
    expect(result.plainStat).toEqual({ directory: true, size: 0 })
    // The size and timestamp the seeds stamp their cache with must be the archive's own.
    expect(result.rawStat).toEqual({ file: true, size: fs.statSync(archive).size })
    expect(result.pin).toEqual({ version: '2.1.309', checksum: claudeDesktopFixtureWinChecksum })
    expect(result.manifest).toEqual({ code: '2.1.309', vm: claudeDesktopFixtureWorkspaceSha })
  })
})
