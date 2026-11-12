import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppUninstallRequest } from './ipc-contract'
import {
  removeMacLoginItem,
  removeMacManagedTools,
  resolveMacAppBundlePath,
  runMacUninstall,
  type MacUninstallDependencies,
} from './macos-uninstall'

const installedExecutable = '/Applications/星芒AI管理工具.app/Contents/MacOS/星芒AI管理工具'
const installedAppPath = '/Applications/星芒AI管理工具.app/Contents/Resources/app.asar'
const keepEverything: AppUninstallRequest = { clearLoginRecords: false, removeManagedTools: false }
const execFileAsync = promisify(execFile)
const requireFromTest = createRequire(__filename)
const { createSettledPackage } = requireFromTest('../scripts/asar-fixture.test-support.cjs') as {
  createSettledPackage(source: string, archive: string): Promise<string>
}

function fixture(overrides: Partial<MacUninstallDependencies> = {}) {
  const calls: string[] = []
  const dependencies: MacUninstallDependencies = {
    platform: 'darwin',
    packaged: true,
    appPath: installedAppPath,
    executablePath: installedExecutable,
    installationBusy: () => false,
    backupCliConfigs: async () => { calls.push('backup') },
    removeCliHooks: () => { calls.push('hooks'); return true },
    removeLoginItem: () => { calls.push('login-item'); return true },
    removeManagedTools: async () => { calls.push('tools'); return true },
    trashItem: async (target) => { calls.push(`trash:${target}`) },
    prepareQuit: async () => { calls.push('prepare-quit') },
    abortQuit: () => { calls.push('abort-quit') },
    removeUpdaterCache: async () => { calls.push('update-cache'); return true },
    clearLoginRecords: async () => { calls.push('records'); return true },
    quit: () => { calls.push('quit') },
    ...overrides,
  }
  return { calls, dependencies }
}

describe('resolveMacAppBundlePath', () => {
  it('walks from the executable up to the .app bundle', () => {
    expect(resolveMacAppBundlePath(installedExecutable)).toBe('/Applications/星芒AI管理工具.app')
    expect(resolveMacAppBundlePath('/Users/alex/Applications/X.app/Contents/MacOS/X')).toBe('/Users/alex/Applications/X.app')
  })

  it('refuses anything that is not shaped like a bundle executable', () => {
    expect(resolveMacAppBundlePath('/usr/local/bin/node')).toBeNull()
    expect(resolveMacAppBundlePath('/Applications/X/Contents/MacOS/X')).toBeNull()
    expect(resolveMacAppBundlePath('/Applications/X.app/Resources/MacOS/X')).toBeNull()
    expect(resolveMacAppBundlePath('relative/X.app/Contents/MacOS/X')).toBeNull()
    expect(resolveMacAppBundlePath('')).toBeNull()
  })
})

describe('runMacUninstall', () => {
  it('takes the hooks back and restores the network before moving the app to the Trash and quitting', async () => {
    const { calls, dependencies } = fixture()
    const result = await runMacUninstall(dependencies, keepEverything)
    expect(result).toEqual({ trashed: true, leftovers: [] })
    expect(calls).toEqual([
      'backup',
      'hooks',
      'login-item',
      'prepare-quit',
      'trash:/Applications/星芒AI管理工具.app',
      'update-cache',
      'quit',
    ])
  })

  it('removes managed tools and clears records only when asked, records after quit preparation', async () => {
    const { calls, dependencies } = fixture()
    await runMacUninstall(dependencies, { clearLoginRecords: true, removeManagedTools: true })
    expect(calls).toEqual([
      'backup',
      'hooks',
      'login-item',
      'tools',
      'prepare-quit',
      'trash:/Applications/星芒AI管理工具.app',
      'update-cache',
      'records',
      'quit',
    ])
  })

  it('refuses on other platforms, in development and while an installation runs, without touching anything', async () => {
    for (const overrides of [{ platform: 'win32' as const }, { packaged: false }, { installationBusy: () => true }]) {
      const { calls, dependencies } = fixture(overrides)
      await expect(runMacUninstall(dependencies, keepEverything)).rejects.toThrow()
      expect(calls).toEqual([])
    }
  })

  it('keeps going when the backup or a step fails and reports what is left', async () => {
    const lines: string[] = []
    const { calls, dependencies } = fixture({
      backupCliConfigs: async () => { throw new Error('disk full') },
      removeCliHooks: () => { throw new Error('locked') },
      removeLoginItem: () => false,
      removeManagedTools: async () => false,
      clearLoginRecords: async () => false,
      report: (line) => { lines.push(line) },
    })
    const result = await runMacUninstall(dependencies, { clearLoginRecords: true, removeManagedTools: true })
    expect(result).toEqual({ trashed: true, leftovers: ['cli-hooks', 'login-item', 'tools', 'records'] })
    expect(calls).toContain('quit')
    expect(lines).toEqual(['backup: disk full', 'cli hooks: locked'])
  })

  it('waits for the hook removal that also writes the reinstall record', async () => {
    const { calls, dependencies } = fixture({
      removeCliHooks: async () => { calls.push('hooks'); return false },
    })
    const result = await runMacUninstall(dependencies, keepEverything)
    expect(result).toEqual({ trashed: true, leftovers: ['cli-hooks'] })
    expect(calls.indexOf('hooks')).toBeLessThan(calls.indexOf('login-item'))
  })

  it('stays open and leaves the login alone when the app runs from a disk image or a translocated copy', async () => {
    for (const executablePath of [
      '/Volumes/星芒AI管理工具/星芒AI管理工具.app/Contents/MacOS/星芒AI管理工具',
      '/private/var/folders/xy/T/AppTranslocation/1234/d/星芒AI管理工具.app/Contents/MacOS/星芒AI管理工具',
    ]) {
      const { calls, dependencies } = fixture({ executablePath, appPath: path.posix.join(path.posix.dirname(path.posix.dirname(executablePath)), 'Resources', 'app.asar') })
      const result = await runMacUninstall(dependencies, { clearLoginRecords: true, removeManagedTools: false })
      expect(result).toEqual({ trashed: false, leftovers: ['records'] })
      expect(calls).toEqual(['backup', 'hooks', 'login-item'])
    }
  })

  it('only logs an update cache it could not remove, without counting it as left over', async () => {
    for (const [removeUpdaterCache, logged] of [
      [async () => false, []],
      [async () => { throw new Error('busy') }, ['update cache: busy']],
    ] as const) {
      const lines: string[] = []
      const { calls, dependencies } = fixture({ removeUpdaterCache, report: (line) => { lines.push(line) } })
      const result = await runMacUninstall(dependencies, { clearLoginRecords: true, removeManagedTools: false })
      expect(result).toEqual({ trashed: true, leftovers: [] })
      expect(calls.slice(-2)).toEqual(['records', 'quit'])
      expect(lines).toEqual(logged)
    }
  })

  it('stays open when the Trash refuses the app', async () => {
    const lines: string[] = []
    const { calls, dependencies } = fixture({
      trashItem: async () => { throw new Error('permission denied') },
      report: (line) => { lines.push(line) },
    })
    const result = await runMacUninstall(dependencies, keepEverything)
    expect(result).toEqual({ trashed: false, leftovers: [] })
    expect(calls).toEqual(['backup', 'hooks', 'login-item', 'prepare-quit', 'abort-quit'])
    expect(lines).toEqual(['trash: permission denied'])
  })
})

describe('removeMacLoginItem', () => {
  it('switches the login item off and reports whether it stuck', () => {
    let openAtLogin = true
    const app = {
      setLoginItemSettings: (settings: { openAtLogin?: boolean }) => { openAtLogin = settings.openAtLogin ?? openAtLogin },
      getLoginItemSettings: () => ({ openAtLogin }) as ReturnType<Electron.App['getLoginItemSettings']>,
    }
    expect(removeMacLoginItem(app)).toBe(true)
    expect(openAtLogin).toBe(false)
  })
})

describe('removeMacManagedTools', () => {
  const temporary: string[] = []
  afterEach(() => {
    for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  })
  function sandbox(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-mac-uninstall-'))
    temporary.push(directory)
    return directory
  }

  it('removes the whole managed product directory', async () => {
    const root = path.join(sandbox(), 'XingMangAI')
    fs.mkdirSync(path.join(root, 'Cli', 'npm', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Cli', 'npm', 'bin', 'claude'), '#!/bin/sh\n')
    expect(await removeMacManagedTools(root)).toBe(true)
    expect(fs.existsSync(root)).toBe(false)
  })

  it('treats a missing directory as already clean', async () => {
    expect(await removeMacManagedTools(path.join(sandbox(), 'XingMangAI'))).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('refuses a root that was swapped for a link and leaves the target alone', async () => {
    const base = sandbox()
    const target = path.join(base, 'elsewhere')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep')
    const root = path.join(base, 'XingMangAI')
    fs.symlinkSync(target, root)
    const lines: string[] = []
    expect(await removeMacManagedTools(root, (line) => { lines.push(line) })).toBe(false)
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep')
    expect(lines).toHaveLength(1)
  })

  it.runIf(process.platform !== 'win32')('removes links inside the tree without following them', async () => {
    const base = sandbox()
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    const root = path.join(base, 'XingMangAI')
    fs.mkdirSync(path.join(root, 'Cli'), { recursive: true })
    fs.symlinkSync(outside, path.join(root, 'Cli', 'link'))
    expect(await removeMacManagedTools(root)).toBe(true)
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  /**
   * Runs the real removeMacManagedTools inside the real Electron binary (as Node, so no display
   * is needed): only there does the asar layer exist that takes app.asar for a folder and leaves
   * Contents/Resources behind (remove-tree.ts). The sources are compiled as they are required,
   * so what runs is this directory's module with its real imports, not a copy.
   */
  async function removeManagedToolsInElectron(base: string, root: string): Promise<{ electron: string | null, outcome: string }> {
    const runner = path.join(base, 'runner.js')
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
const { removeMacManagedTools } = require(process.argv[3])
removeMacManagedTools(process.argv[4]).then(
  (removed) => removed ? 'removed' : 'left in place',
  (error) => error.code ?? String(error),
).then((outcome) => {
  process.stdout.write(JSON.stringify({ electron: process.versions.electron ?? null, outcome }))
})
`)
    const electronBinary = requireFromTest('electron') as string
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    // The test runner's own loader flags mean nothing to Electron's Node.
    delete environment.NODE_OPTIONS
    const { stdout } = await execFileAsync(
      electronBinary,
      [runner, requireFromTest.resolve('typescript'), path.join(__dirname, 'macos-uninstall.ts'), root],
      { env: environment, timeout: 20_000 },
    )
    return JSON.parse(stdout) as { electron: string | null, outcome: string }
  }

  it('removes a desktop app an interrupted install left unpacked, which the main process fs cannot delete', async () => {
    const base = sandbox()
    const root = path.join(base, 'XingMangAI')
    fs.mkdirSync(path.join(root, 'Cli', 'npm', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Cli', 'npm', 'bin', 'claude'), '#!/bin/sh\n')
    // What a shutdown in the middle of a desktop app install leaves behind until the next
    // install (createStagingDirectory in macos-desktop-app-installer.ts): an unpacked
    // Electron app whose Contents/Resources holds a real app.asar.
    const resources = path.join(root, 'DesktopApps', 'staging-a1b2c3', 'extract', 'ChatGPT.app', 'Contents', 'Resources')
    fs.mkdirSync(resources, { recursive: true })
    const source = path.join(base, 'app-source')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"fixture"}\n')
    await createSettledPackage(source, path.join(resources, 'app.asar'))

    const result = await removeManagedToolsInElectron(base, root)

    expect(result.electron).toEqual(expect.any(String))
    expect(result.outcome).toBe('removed')
    expect(fs.existsSync(root)).toBe(false)
  })
})
