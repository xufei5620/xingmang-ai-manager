import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acceptsWindowsRelocationTarget,
  activeRelocatedFolderPolicy,
  configureRelocatedFolderAccess,
  isWithinHomeLineage,
  resolveRelocatedPath,
  setRelocatedFolderPolicy,
  type RelocatedFolderPolicy,
} from './relocated-folders'
import { readBoundedUtf8FileSync } from './bounded-file'
import {
  assertNoReparseComponents,
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-relocated-')))
  temporaryDirectories.push(directory)
  return directory
}

// Junctions need no privilege on Windows; POSIX ignores the type argument.
function link(target: string, at: string): void {
  fs.symlinkSync(target, at, 'junction')
}

interface MovedProfile {
  root: string
  home: string
  movedAppData: string
  appData: string
}

/** A home whose AppData was moved to "another disk" and left a link behind. */
function movedProfile(): MovedProfile {
  const root = temporaryDirectory()
  const home = path.join(root, 'Users', 'alice')
  const movedAppData = path.join(root, 'D', 'alice-AppData')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(movedAppData, 'Roaming'), { recursive: true })
  const appData = path.join(home, 'AppData')
  link(movedAppData, appData)
  return { root, home, movedAppData, appData }
}

function policyFor(home: string, acceptsTarget: (target: string) => boolean = () => true): RelocatedFolderPolicy {
  return { homeDirectories: [home], acceptsTarget }
}

afterEach(() => {
  setRelocatedFolderPolicy(null)
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('relocated folders', () => {
  it('matches a component at, above or inside the home directory only', () => {
    const platform = process.platform
    const home = path.resolve('/Users/alice')
    expect(isWithinHomeLineage(home, home, platform)).toBe(true)
    expect(isWithinHomeLineage(path.resolve('/Users'), home, platform)).toBe(true)
    expect(isWithinHomeLineage(path.join(home, 'AppData', 'Roaming'), home, platform)).toBe(true)
    expect(isWithinHomeLineage(path.resolve('/Users/Public'), home, platform)).toBe(false)
    expect(isWithinHomeLineage(path.resolve('/Users/alice-old'), home, platform)).toBe(false)
    expect(isWithinHomeLineage(path.resolve('/ProgramData/xingmang'), home, platform)).toBe(false)
  })

  it('compares Windows components without regard to case', () => {
    expect(isWithinHomeLineage('C:\\users\\ALICE\\AppData', 'C:\\Users\\alice', 'win32')).toBe(true)
    expect(isWithinHomeLineage('C:\\ProgramData', 'C:\\Users\\alice', 'win32')).toBe(false)
  })

  it('leaves every path untouched while no policy is active', () => {
    const profile = movedProfile()
    const settings = path.join(profile.appData, 'Roaming', 'xingmang', 'settings.json')
    expect(activeRelocatedFolderPolicy()).toBeNull()
    expect(resolveRelocatedPath(settings)).toBe(settings)
    expect(() => assertNoReparseComponents(settings, '应用设置目录')).toThrow('不能经过符号链接或目录联接')
  })

  it('follows an accepted link inside the home directory and keeps the missing tail', () => {
    const profile = movedProfile()
    const settings = path.join(profile.appData, 'Roaming', 'xingmang', 'settings.json')
    expect(resolveRelocatedPath(settings, policyFor(profile.home)))
      .toBe(path.join(profile.movedAppData, 'Roaming', 'xingmang', 'settings.json'))
  })

  it('follows a link that replaces the home directory itself', () => {
    const root = temporaryDirectory()
    const movedHome = path.join(root, 'D', 'alice')
    fs.mkdirSync(path.join(movedHome, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(root, 'Users'))
    const home = path.join(root, 'Users', 'alice')
    link(movedHome, home)
    expect(resolveRelocatedPath(path.join(home, '.claude', 'settings.json'), policyFor(home)))
      .toBe(path.join(movedHome, '.claude', 'settings.json'))
  })

  it('keeps rejecting a link outside the home directory', () => {
    const root = temporaryDirectory()
    const home = path.join(root, 'Users', 'alice')
    fs.mkdirSync(home, { recursive: true })
    const shared = path.join(root, 'ProgramData')
    fs.mkdirSync(path.join(root, 'elsewhere'))
    link(path.join(root, 'elsewhere'), shared)
    const target = path.join(shared, 'xingmang', 'state.json')
    expect(resolveRelocatedPath(target, policyFor(home))).toBe(target)
  })

  it('keeps rejecting a link whose target the policy does not accept', () => {
    const profile = movedProfile()
    const settings = path.join(profile.appData, 'Roaming', 'settings.json')
    expect(resolveRelocatedPath(settings, policyFor(profile.home, () => false))).toBe(settings)
  })

  it('judges a second link below a relocated folder on its own', () => {
    const profile = movedProfile()
    const outside = path.join(profile.root, 'outside')
    fs.mkdirSync(outside)
    link(outside, path.join(profile.movedAppData, 'Roaming', 'xingmang'))
    const settings = path.join(profile.appData, 'Roaming', 'xingmang', 'settings.json')
    const accepted = new Set([profile.movedAppData])
    const resolved = resolveRelocatedPath(settings, policyFor(profile.home, (target) => accepted.has(target)))
    expect(resolved).toBe(settings)
    expect(() => assertNoReparseComponents(resolved, '应用设置目录')).toThrow('不能经过符号链接或目录联接')
  })

  it('does not treat a link to a file as a relocated folder', () => {
    const profile = movedProfile()
    const real = path.join(profile.root, 'secret.txt')
    fs.writeFileSync(real, 'x')
    const planted = path.join(profile.movedAppData, 'Roaming', 'settings.json')
    fs.symlinkSync(real, planted)
    setRelocatedFolderPolicy(policyFor(profile.home))
    expect(() => readSafeUtf8FileSync(path.join(profile.appData, 'Roaming', 'settings.json'), '应用设置'))
      .toThrow('单链接普通文件')
  })

  it('lets the safe data helpers write and read through an accepted relocation', async () => {
    const profile = movedProfile()
    setRelocatedFolderPolicy(policyFor(profile.home))
    const directory = path.join(profile.appData, 'Roaming', 'xingmang')
    const settings = path.join(directory, 'settings.json')
    ensureSafeDataDirectory(directory, '应用设置目录')
    await writeAtomicSafeUtf8File(settings, '{"theme":"dark"}', '应用设置')
    expect(fs.readFileSync(path.join(profile.movedAppData, 'Roaming', 'xingmang', 'settings.json'), 'utf8'))
      .toBe('{"theme":"dark"}')
    expect(readSafeUtf8FileSync(settings, '应用设置')).toBe('{"theme":"dark"}')
    expect(readBoundedUtf8FileSync(settings, 1024, '应用设置')).toBe('{"theme":"dark"}')
  })

  it('refuses to follow anything unless the process runs unelevated', () => {
    const home = temporaryDirectory()
    expect(configureRelocatedFolderAccess('trusted-only', { platform: 'win32', homeDirectory: home })).toBeNull()
    expect(activeRelocatedFolderPolicy()).toBeNull()
    expect(configureRelocatedFolderAccess('same-user', { platform: 'darwin', homeDirectory: home, geteuid: () => 0 }))
      .toBeNull()
    const policy = configureRelocatedFolderAccess('same-user', { platform: 'win32', homeDirectory: home })
    expect(policy?.homeDirectories).toEqual([home])
    expect(activeRelocatedFolderPolicy()).toBe(policy)
    configureRelocatedFolderAccess('trusted-only', { platform: 'win32', homeDirectory: home })
    expect(activeRelocatedFolderPolicy()).toBeNull()
  })

  it('accepts only local drive letters as Windows targets', () => {
    expect(acceptsWindowsRelocationTarget('\\\\fileserver\\share\\alice')).toBe(false)
    expect(acceptsWindowsRelocationTarget('\\\\?\\UNC\\fileserver\\share\\alice')).toBe(false)
    expect(acceptsWindowsRelocationTarget('\\\\?\\Volume{0b1c2d3e-0000-0000-0000-000000000000}\\alice')).toBe(false)
    expect(acceptsWindowsRelocationTarget('/Users/alice')).toBe(false)
  })

  it.runIf(process.platform === 'win32')('writes settings through a real junction on a local drive', async () => {
    const profile = movedProfile()
    configureRelocatedFolderAccess('same-user', { homeDirectory: profile.home })
    const settings = path.join(profile.appData, 'Roaming', 'xingmang', 'settings.json')
    ensureSafeDataDirectory(path.dirname(settings), '应用设置目录')
    await writeAtomicSafeUtf8File(settings, 'ok', '应用设置')
    expect(readSafeUtf8FileSync(settings, '应用设置')).toBe('ok')
  })
})
