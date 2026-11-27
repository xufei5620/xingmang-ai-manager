import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { openForeignAsar, statForeignAsar } from './foreign-asar'

const execFileAsync = promisify(execFile)
const requireFromTest = createRequire(__filename)
const { createSettledPackage } = requireFromTest('../scripts/asar-fixture.test-support.cjs') as {
  createSettledPackage(source: string, archive: string): Promise<string>
}
const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-foreign-asar-'))
  temporaryRoots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const windowsChecksum = '9078b9c1d466965d3faee8d13128f03d79b61794fb2130255ca1f5eab84e602c'
const macBundleChecksum = '5af865b9901c3f7512d85aa78571966834c943e3143f1b82ef4d33ed89b7f0ba'
const workspaceSha = '072b6cbfe74f428a98bd86035f83b322b369d1f1'

// The two manifests the way a shipped Claude Desktop build script carries them (see the
// fixtures in claude-desktop-code-seed.test.ts and claude-desktop-component-manifest.test.ts).
function buildScript(): string {
  const code = JSON.stringify({
    version: '2.1.309',
    manifest: {
      version: '2.1.309',
      platforms: {
        'darwin-arm64': { binary: 'claude.zst', checksum: '6'.repeat(64), size: 93159896, bundle: { checksum: macBundleChecksum, size: 93151388 } },
        'linux-x64': { binary: 'claude.zst', checksum: 'e52289b95def16148c8d0a48b1ccc0d357429e73473a9a20ac0638fb7460a59b', size: 103411745 },
        'win32-x64': { binary: 'claude.exe.zst', checksum: windowsChecksum, size: 106715810 },
      },
    },
  })
  const rootfs = `{name:"rootfs.vhdx",checksum:"${'c'.repeat(64)}",size:1309889215,progressStart:0,progressEnd:80,rawChecksum:"${'d'.repeat(64)}",rawSize:7826571264}`
  return `function M_(){return JSON.parse('${code}')}`
    + `var VG={versions:[{sha:"${workspaceSha}",publishedAt:"2026-10-22",files:{unix:{x64:[${rootfs}]},win32:{x64:[${rootfs}]}}}]};`
}

/** 照 Claude Desktop 的样子打一份真的 app.asar：`.vite/build/` 下的脚本里带着那两份清单。 */
async function createClaudeAsar(root: string): Promise<string> {
  const source = path.join(root, 'claude-source')
  fs.mkdirSync(path.join(source, '.vite', 'build'), { recursive: true })
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"claude-fixture"}\n')
  fs.writeFileSync(path.join(source, '.vite', 'build', 'index.chunk-2SHPxESV.js'), buildScript())
  const resources = path.join(root, 'Claude', 'app', 'resources')
  fs.mkdirSync(resources, { recursive: true })
  const archive = await createSettledPackage(source, path.join(resources, 'app.asar'))
  fs.rmSync(source, { recursive: true })
  return archive
}

interface ElectronReadResult {
  electron: string | null
  plainOpen: string
  plainStat: { directory: boolean, size: number }
  foreignStat: { file: boolean, size: number }
  pin: { version: string, checksum: string } | null
  manifest: { codeVersion: string | null, macBundle: string | null, vmSha: string | null }
}

/**
 * Runs the real readers inside the real Electron binary (as Node, so no display is needed):
 * only there does the asar layer exist that answers every path ending in `.asar` as the
 * archive's root folder. The sources are compiled as they are required, so what runs is this
 * directory's modules with their real imports. The plain fs calls first prove the fixture
 * reproduces what the customer's log showed, rather than passing because nothing was in the way.
 */
async function readInElectron(root: string, asar: string): Promise<ElectronReadResult> {
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
const { statForeignAsar } = require(process.argv[3])
const { readClaudeCodeBuildPin } = require(process.argv[4])
const { readClaudeDesktopComponentManifest } = require(process.argv[5])
const asar = process.argv[6]
async function main() {
  let plainOpen = 'opened'
  try { await (await fs.promises.open(asar, 'r')).close() } catch (error) { plainOpen = error.code ?? String(error) }
  const plain = await fs.promises.stat(asar)
  const foreign = await statForeignAsar(asar)
  const pin = await readClaudeCodeBuildPin(asar, 'win32-x64')
  const manifest = await readClaudeDesktopComponentManifest(asar)
  process.stdout.write(JSON.stringify({
    electron: process.versions.electron ?? null,
    plainOpen,
    plainStat: { directory: plain.isDirectory(), size: plain.size },
    foreignStat: { file: foreign.isFile(), size: foreign.size },
    pin: pin && { version: pin.version, checksum: pin.checksum },
    manifest: {
      codeVersion: manifest.code?.version ?? null,
      macBundle: manifest.code?.macBundles['darwin-arm64']?.checksum ?? null,
      vmSha: manifest.vm?.sha ?? null,
    },
  }))
}
main().catch((error) => {
  process.stderr.write(String(error && error.stack || error))
  process.exit(1)
})
`)
  const electronBinary = requireFromTest('electron') as string
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // The test runner's own loader flags mean nothing to Electron's Node.
  delete environment.NODE_OPTIONS
  const { stdout } = await execFileAsync(electronBinary, [
    runner,
    requireFromTest.resolve('typescript'),
    path.join(__dirname, 'foreign-asar.ts'),
    path.join(__dirname, 'claude-desktop-code-seed.ts'),
    path.join(__dirname, 'claude-desktop-component-manifest.ts'),
    asar,
  ], { env: environment, timeout: 25_000 })
  return JSON.parse(stdout) as ElectronReadResult
}

describe('foreign asar', () => {
  it('opens and stats an archive as a plain file outside Electron', async () => {
    const root = temporaryRoot()
    const asar = await createClaudeAsar(root)

    const stats = await statForeignAsar(asar)
    const handle = await openForeignAsar(asar)
    try {
      const prefix = Buffer.alloc(8)
      await handle.read(prefix, 0, 8, 0)
      expect(prefix.readUInt32LE(0)).toBe(4)
    } finally {
      await handle.close()
    }

    expect(stats.isFile()).toBe(true)
    expect(stats.size).toBe(fs.statSync(asar).size)
  })

  it('reads the Claude Code pin and the workspace manifest out of another app\'s app.asar inside Electron', async () => {
    const root = temporaryRoot()
    const asar = await createClaudeAsar(root)

    const result = await readInElectron(root, asar)

    expect(result.electron).toEqual(expect.any(String))
    // What 0.2.25 logged on the customer machine (claude-desktop.code-seed.skipped,
    // reason asar-unreadable): the main process fs refuses to open the archive itself.
    expect(result.plainOpen).toBe('EISDIR')
    // And it reports the archive as an empty folder, which would freeze the cache stamp.
    expect(result.plainStat).toEqual({ directory: true, size: 0 })
    expect(result.foreignStat).toEqual({ file: true, size: fs.statSync(asar).size })
    expect(result.pin).toEqual({ version: '2.1.309', checksum: windowsChecksum })
    expect(result.manifest).toEqual({ codeVersion: '2.1.309', macBundle: macBundleChecksum, vmSha: workspaceSha })
  })

  it('is what every Claude Desktop seeder opens and stats app.asar with', () => {
    for (const file of [
      'claude-desktop-code-seed.ts',
      'claude-desktop-component-manifest.ts',
      'claude-desktop-workspace-seed.ts',
      'claude-desktop-mac-code-seed.ts',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8')

      expect(source, file).toMatch(/\b(?:openForeignAsar|statForeignAsar)\(/)
      expect(source, file).not.toMatch(/\bfs\.(?:promises\.)?(?:open|stat|lstat|readFile|createReadStream)(?:Sync)?\(\s*(?:target\.)?asarPath\b/)
    }
  })
})
