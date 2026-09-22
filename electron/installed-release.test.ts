import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compareReleaseVersions,
  createLastRunVersionStore,
  hasPriorRunRecord,
  parseBundledReleaseNotes,
  readBundledReleaseNotes,
  resolveInstalledRelease,
} from './installed-release'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-installed-release-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop() as string, { recursive: true, force: true })
})

describe('installed release', () => {
  it('compares x.y.z versions numerically and refuses anything else', () => {
    expect(compareReleaseVersions('0.2.10', '0.2.9')).toBeGreaterThan(0)
    expect(compareReleaseVersions('0.2.9', '0.2.9')).toBe(0)
    expect(compareReleaseVersions('0.2.8', '0.3.0')).toBeLessThan(0)
    expect(compareReleaseVersions('0.2.9-beta', '0.2.8')).toBeNull()
    expect(compareReleaseVersions('0.2.9', '')).toBeNull()
  })

  it('treats a higher version than last run as just updated and names the previous one', () => {
    expect(resolveInstalledRelease({ currentVersion: '0.2.9', recordedVersion: '0.2.8', hadPriorRun: true, notes: ['改动'] }))
      .toEqual({ justUpdated: true, previousVersion: '0.2.8', notes: ['改动'] })
  })

  it('says nothing on an ordinary restart or after going back to an older version', () => {
    // 装回旧版本不是更新，说「已更新到」是假话。
    expect(resolveInstalledRelease({ currentVersion: '0.2.9', recordedVersion: '0.2.9', hadPriorRun: true, notes: null }).justUpdated).toBe(false)
    expect(resolveInstalledRelease({ currentVersion: '0.2.7', recordedVersion: '0.2.9', hadPriorRun: true, notes: null }).justUpdated).toBe(false)
  })

  it('without a record, only a machine that ran the app before counts as updated', () => {
    // 第一个带这项功能的版本发出去时老用户都没有记录；新装的机器连运行日志都没有。
    expect(resolveInstalledRelease({ currentVersion: '0.2.9', recordedVersion: null, hadPriorRun: true, notes: null }))
      .toEqual({ justUpdated: true, previousVersion: null, notes: null })
    expect(resolveInstalledRelease({ currentVersion: '0.2.9', recordedVersion: null, hadPriorRun: false, notes: null }).justUpdated).toBe(false)
    expect(resolveInstalledRelease({ currentVersion: '0.2.9', recordedVersion: 'garbage', hadPriorRun: false, notes: null }))
      .toEqual({ justUpdated: false, previousVersion: null, notes: null })
  })

  it('only accepts bundled notes written for the running version', () => {
    const content = JSON.stringify({ version: '0.2.9', notes: [' 一条改动。 ', 42, '', '另一条。'] })
    expect(parseBundledReleaseNotes(content, '0.2.9')).toEqual(['一条改动。', '另一条。'])
    // 上一次构建残留、被替换过的产物：宁可不显示也不把别的版本的改动说成这一版。
    expect(parseBundledReleaseNotes(content, '0.3.0')).toBeNull()
    expect(parseBundledReleaseNotes(JSON.stringify({ version: '0.2.9', notes: null }), '0.2.9')).toBeNull()
    expect(parseBundledReleaseNotes(JSON.stringify({ version: '0.2.9', notes: [] }), '0.2.9')).toBeNull()
    expect(parseBundledReleaseNotes('{', '0.2.9')).toBeNull()
  })

  it('bounds how many bundled notes and how much of each are kept', () => {
    const notes = Array.from({ length: 80 }, (_, index) => `${index}${'字'.repeat(1200)}`)
    const parsed = parseBundledReleaseNotes(JSON.stringify({ version: '0.2.9', notes }), '0.2.9')
    expect(parsed).toHaveLength(60)
    expect(parsed?.every((note) => note.length <= 1000)).toBe(true)
  })

  it('reads the bundled notes next to the compiled main process and survives a missing file', () => {
    const appPath = temporaryDirectory()
    expect(readBundledReleaseNotes(appPath, '0.2.9')).toBeNull()
    fs.mkdirSync(path.join(appPath, 'dist-electron'))
    fs.writeFileSync(path.join(appPath, 'dist-electron', 'release-notes.json'), JSON.stringify({ version: '0.2.9', notes: ['改动'] }))
    expect(readBundledReleaseNotes(appPath, '0.2.9')).toEqual(['改动'])
    fs.writeFileSync(path.join(appPath, 'dist-electron', 'release-notes.json'), 'x'.repeat(200 * 1024))
    expect(readBundledReleaseNotes(appPath, '0.2.9')).toBeNull()
  })

  it('recognises a machine that ran the app before by its runtime log or settings file', () => {
    const fresh = temporaryDirectory()
    expect(hasPriorRunRecord(fresh)).toBe(false)
    const withLog = temporaryDirectory()
    fs.mkdirSync(path.join(withLog, 'logs'))
    fs.writeFileSync(path.join(withLog, 'logs', 'runtime.jsonl'), '{}\n')
    expect(hasPriorRunRecord(withLog)).toBe(true)
    const withSettings = temporaryDirectory()
    fs.writeFileSync(path.join(withSettings, 'settings.json'), '{}')
    expect(hasPriorRunRecord(withSettings)).toBe(true)
  })

  it('remembers the last run version and degrades a damaged record to none', async () => {
    const filePath = path.join(temporaryDirectory(), 'last-run-version.json')
    const store = createLastRunVersionStore({ filePath })
    expect(store.read()).toBeNull()
    await store.write('0.2.9')
    expect(createLastRunVersionStore({ filePath }).read()).toBe('0.2.9')
    fs.writeFileSync(filePath, '{"version":1,"lastRunVersion":"../../x"}')
    expect(store.read()).toBeNull()
    fs.writeFileSync(filePath, 'not json')
    expect(store.read()).toBeNull()
    await expect(store.write('latest')).rejects.toThrow('版本号格式无效')
    expect(() => createLastRunVersionStore({ filePath: 'relative.json' })).toThrow('绝对路径')
  })
})
