import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LAUNCH_INSTALL_WINDOW_MS,
  createPendingUpdateStore,
  decideLaunchInstall,
  emptyPendingUpdateRecord,
  parsePendingUpdateRecord,
  resolveDownloadedVersionToRecord,
  type LaunchInstallInput,
} from './auto-update-install'
import type { UpdateSnapshot } from './updater'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function snapshot(patch: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'downloaded',
    currentVersion: '0.2.11',
    availableVersion: '0.2.12',
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    development: false,
    ...patch,
  }
}

function input(patch: Partial<LaunchInstallInput> = {}): LaunchInstallInput {
  return {
    autoUpdate: true,
    snapshot: snapshot(),
    recordAtLaunch: { downloadedVersion: '0.2.12', attemptedVersion: null },
    elapsedSinceLaunchMs: 5_000,
    busy: false,
    ...patch,
  }
}

describe('decideLaunchInstall', () => {
  it('installs a version that was already downloaded before this launch', () => {
    expect(decideLaunchInstall(input())).toBe('0.2.12')
  })

  it('leaves a version downloaded during this session for the quit path', () => {
    expect(decideLaunchInstall(input({ recordAtLaunch: { ...emptyPendingUpdateRecord } }))).toBeNull()
    expect(decideLaunchInstall(input({ recordAtLaunch: { downloadedVersion: '0.2.11', attemptedVersion: null } }))).toBeNull()
  })

  it('tries each version at launch only once so a broken installer cannot loop', () => {
    expect(decideLaunchInstall(input({ recordAtLaunch: { downloadedVersion: '0.2.12', attemptedVersion: '0.2.12' } }))).toBeNull()
  })

  it('does not interrupt someone who is already using the app', () => {
    expect(decideLaunchInstall(input({ elapsedSinceLaunchMs: LAUNCH_INSTALL_WINDOW_MS + 1 }))).toBeNull()
    expect(decideLaunchInstall(input({ busy: true }))).toBeNull()
  })

  it('stays out of the way when auto-update is off or the package is not ready', () => {
    expect(decideLaunchInstall(input({ autoUpdate: false }))).toBeNull()
    expect(decideLaunchInstall(input({ snapshot: snapshot({ phase: 'downloading' }) }))).toBeNull()
    expect(decideLaunchInstall(input({ snapshot: snapshot({ error: { code: 'X', message: '安装失败' } }) }))).toBeNull()
    expect(decideLaunchInstall(input({ snapshot: snapshot({ development: true }) }))).toBeNull()
  })
})

describe('resolveDownloadedVersionToRecord', () => {
  it('records a freshly downloaded version once', () => {
    expect(resolveDownloadedVersionToRecord(snapshot(), { ...emptyPendingUpdateRecord })).toBe('0.2.12')
    expect(resolveDownloadedVersionToRecord(snapshot(), { downloadedVersion: '0.2.12', attemptedVersion: null })).toBeNull()
    expect(resolveDownloadedVersionToRecord(snapshot({ phase: 'available' }), { ...emptyPendingUpdateRecord })).toBeNull()
  })
})

describe('pending update store', () => {
  function storePath(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-pending-update-'))
    directories.push(directory)
    return path.join(directory, 'pending-update.json')
  }

  it('round-trips the record and reads a missing file as empty', async () => {
    const filePath = storePath()
    const store = createPendingUpdateStore({ filePath })
    expect(store.read()).toEqual(emptyPendingUpdateRecord)
    await store.write({ downloadedVersion: '0.2.12', attemptedVersion: '0.2.12' })
    expect(store.read()).toEqual({ downloadedVersion: '0.2.12', attemptedVersion: '0.2.12' })
  })

  it('treats a damaged or foreign record as no record', () => {
    expect(parsePendingUpdateRecord('not json')).toEqual(emptyPendingUpdateRecord)
    expect(parsePendingUpdateRecord(JSON.stringify({ version: 2, downloadedVersion: '0.2.12' }))).toEqual(emptyPendingUpdateRecord)
    expect(parsePendingUpdateRecord(JSON.stringify({ version: 1, downloadedVersion: '../x', attemptedVersion: 3 })))
      .toEqual(emptyPendingUpdateRecord)
  })

  it('refuses a relative path', () => {
    expect(() => createPendingUpdateStore({ filePath: 'pending-update.json' })).toThrow()
  })
})
