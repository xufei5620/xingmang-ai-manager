import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree } from './remove-tree'

const execFileAsync = promisify(execFile)
const requireFromTest = createRequire(__filename)
const { createSettledPackage } = requireFromTest('../scripts/asar-fixture.test-support.cjs') as {
  createSettledPackage(source: string, archive: string): Promise<string>
}
const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-remove-tree-'))
  temporaryRoots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

/** 照 ChatGPT.app 的样子摆一份：Contents/Resources 下有真正的 app.asar，旁边还有别的文件。 */
async function createElectronAppCopy(root: string, name: string): Promise<string> {
  const bundle = path.join(root, name)
  const resources = path.join(bundle, 'Contents', 'Resources')
  fs.mkdirSync(path.join(resources, 'zh_CN.lproj'), { recursive: true })
  fs.writeFileSync(path.join(resources, 'zh_CN.lproj', 'InfoPlist.strings'), '"CFBundleName" = "ChatGPT";\n')
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'))
  fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'ChatGPT'), '#!/bin/sh\n')
  const source = path.join(root, `${name}-source`)
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"fixture"}\n')
  await createSettledPackage(source, path.join(resources, 'app.asar'))
  fs.rmSync(source, { recursive: true })
  return bundle
}

/**
 * Runs the real removeTree inside the real Electron binary (as Node, so no display is
 * needed): only there does the asar layer that broke the customer's update exist. The
 * same script first tries the plain fs.promises.rm, which proves the fixture really
 * reproduces the failure rather than passing because nothing was in the way.
 */
async function removeInElectron(root: string, plainTarget: string, target: string): Promise<{ electron: string | null, plain: string, ours: string }> {
  const compiled = path.join(root, 'remove-tree.js')
  const sourceText = fs.readFileSync(path.join(__dirname, 'remove-tree.ts'), 'utf8')
  fs.writeFileSync(compiled, ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText)
  const runner = path.join(root, 'runner.js')
  fs.writeFileSync(runner, `
const fs = require('node:fs')
const { removeTree } = require(process.argv[2])
async function attempt(remove) {
  try {
    await remove()
    return 'removed'
  } catch (error) {
    return error.code ?? String(error)
  }
}
async function main() {
  const plain = await attempt(() => fs.promises.rm(process.argv[3], { recursive: true, force: true }))
  const ours = await attempt(() => removeTree(process.argv[4]))
  process.stdout.write(JSON.stringify({ electron: process.versions.electron ?? null, plain, ours }))
}
main()
`)
  const electronBinary = requireFromTest('electron') as string
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // The test runner's own loader flags mean nothing to Electron's Node.
  delete environment.NODE_OPTIONS
  const { stdout } = await execFileAsync(electronBinary, [runner, compiled, plainTarget, target], { env: environment, timeout: 20_000 })
  return JSON.parse(stdout) as { electron: string | null, plain: string, ours: string }
}

describe('removeTree', () => {
  it('removes a whole tree and treats a missing one as already removed', async () => {
    const root = temporaryRoot()
    const bundle = await createElectronAppCopy(root, '.ChatGPT.app.xingmang-0123456789ab')

    await removeTree(bundle)
    await removeTree(bundle)

    expect(fs.existsSync(bundle)).toBe(false)
  })

  it('removes a copy of an Electron app that the main process fs leaves half deleted', async () => {
    const root = temporaryRoot()
    const plainCopy = await createElectronAppCopy(root, '.ChatGPT.app.xingmang-aaaaaaaaaaaa')
    const copy = await createElectronAppCopy(root, '.ChatGPT.app.xingmang-bbbbbbbbbbbb')

    const result = await removeInElectron(root, plainCopy, copy)

    expect(result.electron).toEqual(expect.any(String))
    // What the customer's Mac log showed: app.asar is taken for a folder and skipped, so
    // Contents/Resources is never empty. Windows trips over the same misreading one step
    // earlier: the asar layer holds the archive open, and rm's rmdir on it is refused as busy.
    expect(result.plain).toBe(process.platform === 'win32' ? 'EBUSY' : 'ENOTEMPTY')
    expect(fs.readdirSync(path.join(plainCopy, 'Contents', 'Resources'))).toContain('app.asar')
    expect(result.ours).toBe('removed')
    expect(fs.existsSync(copy)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('removes a link inside the copy without touching what it points at', async () => {
    const root = temporaryRoot()
    const plainCopy = await createElectronAppCopy(root, '.ChatGPT.app.xingmang-cccccccccccc')
    const copy = await createElectronAppCopy(root, '.ChatGPT.app.xingmang-dddddddddddd')
    const outside = path.join(root, 'customer-files')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep\n')
    fs.symlinkSync(outside, path.join(copy, 'Contents', 'Resources', 'linked'))

    const result = await removeInElectron(root, plainCopy, copy)

    expect(result.ours).toBe('removed')
    expect(fs.existsSync(copy)).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep\n')
  })

  it('is what the Mac desktop installer removes app copies and staging with', () => {
    const installer = fs.readFileSync(path.join(__dirname, 'macos-desktop-app-installer.ts'), 'utf8')

    expect(installer).toContain('removeTree(')
    expect(installer).not.toMatch(/\bfs\.(?:promises\.)?rm(?:Sync)?\(/)
  })
})
