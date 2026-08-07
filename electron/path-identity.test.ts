import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sameLocalPathIdentity } from './path-identity'

const temporaryDirectories: string[] = []
const hostPlatform = process.platform

function hasOnlyOrdinaryWindowsPathComponents(value: string): boolean {
  if (process.platform !== 'win32') return false
  const resolved = path.win32.resolve(value)
  const root = path.win32.parse(resolved).root
  const components = [root]
  let current = root
  for (const name of resolved.slice(root.length).split(path.win32.sep)) {
    if (!name) continue
    current = path.win32.join(current, name)
    components.push(current)
  }
  try {
    for (const component of components) {
      const before = fs.lstatSync(component, { bigint: true })
      if (before.isSymbolicLink()) return false
      const dereferenced = fs.statSync(component, { bigint: true })
      const after = fs.lstatSync(component, { bigint: true })
      if (
        after.isSymbolicLink()
        || before.dev !== dereferenced.dev
        || before.ino !== dereferenced.ino
        || before.mode !== dereferenced.mode
        || before.dev !== after.dev
        || before.ino !== after.ino
        || before.mode !== after.mode
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

const windowsTempHasNativeAlias = process.platform === 'win32'
  && hasOnlyOrdinaryWindowsPathComponents(os.tmpdir())
  && path.win32.resolve(os.tmpdir()).toLowerCase() !== fs.realpathSync.native(os.tmpdir()).toLowerCase()

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { value: hostPlatform })
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('sameLocalPathIdentity', () => {
  it.runIf(process.platform === 'darwin')('recognizes only the exact Darwin system aliases', () => {
    expect(sameLocalPathIdentity('/var/app/data.json', '/private/var/app/data.json')).toBe(true)
    expect(sameLocalPathIdentity('/tmp/app/data.json', '/private/tmp/app/data.json')).toBe(true)
    expect(sameLocalPathIdentity('/etc/hosts', '/private/etc/hosts')).toBe(true)
    expect(sameLocalPathIdentity('/variable/app', '/private/variable/app')).toBe(false)
  })

  it('does not equate an arbitrary symbolic link with its target', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-path-identity-'))
    temporaryDirectories.push(directory)
    const target = path.join(directory, 'target')
    const link = path.join(directory, 'link')
    fs.mkdirSync(target)
    fs.symlinkSync(target, link)

    expect(sameLocalPathIdentity(link, fs.realpathSync(link))).toBe(false)
  })

  it.runIf(windowsTempHasNativeAlias)(
    'recognizes an ordinary Windows temp child through its native path spelling',
    () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-path-identity-'))
      temporaryDirectories.push(directory)
      const child = path.join(directory, 'child')
      fs.mkdirSync(child)
      const canonicalChild = fs.realpathSync.native(child)

      expect(path.resolve(child).toLowerCase()).not.toBe(canonicalChild.toLowerCase())
      expect(sameLocalPathIdentity(child, canonicalChild)).toBe(true)
    },
  )

  it.runIf(process.platform === 'win32')('does not equate a Windows junction with its target', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-path-identity-'))
    temporaryDirectories.push(directory)
    const target = path.join(directory, 'target')
    const junction = path.join(directory, 'junction')
    fs.mkdirSync(target)
    fs.mkdirSync(path.join(target, 'child'))
    fs.symlinkSync(target, junction, 'junction')
    const childThroughJunction = path.join(junction, 'child')

    expect(
      sameLocalPathIdentity(childThroughJunction, fs.realpathSync.native(childThroughJunction)),
    ).toBe(false)
  })

  it('walks an extended UNC path from the share root', () => {
    const ordinaryPath = '\\\\server\\share\\directory'
    const extendedPath = '\\\\?\\UNC\\server\\share\\directory'
    const expectedComponents = [
      '\\\\server\\share\\',
      ordinaryPath,
      '\\\\?\\UNC\\server\\share\\',
      extendedPath,
    ]
    const visitedComponents: string[] = []
    const stats = fs.statSync(os.tmpdir(), { bigint: true })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.spyOn(fs, 'lstatSync').mockImplementation((component) => {
      visitedComponents.push(String(component))
      return stats as never
    })
    vi.spyOn(fs, 'statSync').mockReturnValue(stats as never)
    vi.spyOn(fs.realpathSync, 'native').mockReturnValue(ordinaryPath)

    expect(sameLocalPathIdentity(ordinaryPath, extendedPath)).toBe(true)
    expect([...new Set(visitedComponents)]).toEqual(expectedComponents)
  })

  it('does not treat a user-controlled drive mapping as an ordinary native alias', () => {
    const mappedPath = 'X:\\workspace\\child'
    const targetPath = 'C:\\users\\tester\\workspace\\child'
    const stats = fs.statSync(os.tmpdir(), { bigint: true })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.spyOn(fs, 'lstatSync').mockReturnValue(stats as never)
    vi.spyOn(fs, 'statSync').mockReturnValue(stats as never)
    vi.spyOn(fs.realpathSync, 'native').mockReturnValue(targetPath)

    expect(sameLocalPathIdentity(mappedPath, targetPath)).toBe(false)
  })

  it('rejects a mapped drive even when both inputs keep the same non-native spelling', () => {
    const mappedPath = 'X:\\workspace\\child'
    const nativeTarget = 'C:\\users\\tester\\workspace\\child'
    const stats = fs.statSync(os.tmpdir(), { bigint: true })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.spyOn(fs, 'lstatSync').mockReturnValue(stats as never)
    vi.spyOn(fs, 'statSync').mockReturnValue(stats as never)
    vi.spyOn(fs.realpathSync, 'native').mockReturnValue(nativeTarget)

    expect(sameLocalPathIdentity(mappedPath, mappedPath)).toBe(false)
  })

  it('distinguishes case-only Windows paths with different file identities', () => {
    const lowerPath = 'C:\\case-sensitive\\file'
    const upperPath = 'C:\\case-sensitive\\FILE'
    const ordinaryStats = {
      dev: 1n,
      ino: 100n,
      mode: 0o100644n,
      isSymbolicLink: () => false,
    }
    const distinctStats = { ...ordinaryStats, ino: 101n }
    const statsFor = (value: fs.PathLike) => (
      String(value) === upperPath ? distinctStats : ordinaryStats
    )
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.spyOn(fs, 'lstatSync').mockImplementation((value) => statsFor(value) as never)
    vi.spyOn(fs, 'statSync').mockImplementation((value) => statsFor(value) as never)
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((value) => String(value))

    expect(sameLocalPathIdentity(lowerPath, upperPath)).toBe(false)
  })
})
