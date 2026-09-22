import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  accelerationStartRequest,
  createAccelerationPreferenceStore,
  defaultAccelerationPreference,
} from './acceleration-preference-store'

const scope = 'xm-account:7'
const other = 'xm-account:8'
const directories: string[] = []

function temporaryFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-acceleration-preferences-'))
  directories.push(directory)
  return path.join(directory, 'acceleration-preferences.json')
}

function store(filePath = temporaryFile()) {
  return { filePath, store: createAccelerationPreferenceStore({ filePath }) }
}

afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop() as string, { recursive: true, force: true })
})

describe('acceleration preference store', () => {
  it('reads the default preference when nothing was ever chosen', async () => {
    const { store: preferences } = store()
    await expect(preferences.getAccelerationPreference(scope)).resolves.toEqual(defaultAccelerationPreference)
  })

  it('persists a chosen line and reads it back from a fresh store', async () => {
    const { filePath, store: preferences } = store()
    await preferences.saveAccelerationPreference(scope, { lineId: 'hk-02' })
    const reopened = createAccelerationPreferenceStore({ filePath })
    await expect(reopened.getAccelerationPreference(scope)).resolves.toEqual({ lineId: 'hk-02', mode: 'system-proxy' })
  })

  it('merges field-wise so the line picker and the mode switch cannot erase each other', async () => {
    const { store: preferences } = store()
    await preferences.saveAccelerationPreference(scope, { lineId: 'hk-02' })
    await preferences.saveAccelerationPreference(scope, { mode: 'tun' })
    await expect(preferences.getAccelerationPreference(scope)).resolves.toEqual({ lineId: 'hk-02', mode: 'tun' })
    await preferences.saveAccelerationPreference(scope, { lineId: null })
    await expect(preferences.getAccelerationPreference(scope)).resolves.toEqual({ lineId: null, mode: 'tun' })
  })

  it('keeps every account separate', async () => {
    const { store: preferences } = store()
    await preferences.saveAccelerationPreference(scope, { lineId: 'hk-02' })
    await preferences.saveAccelerationPreference(other, { lineId: 'jp-01', mode: 'tun' })
    await expect(preferences.getAccelerationPreference(scope)).resolves.toEqual({ lineId: 'hk-02', mode: 'system-proxy' })
    await expect(preferences.getAccelerationPreference(other)).resolves.toEqual({ lineId: 'jp-01', mode: 'tun' })
  })

  it('drops the accounts that went longest without a change once the file is full', async () => {
    const { filePath, store: preferences } = store()
    for (let index = 1; index <= 70; index++) {
      await preferences.saveAccelerationPreference(`xm-account:${index}`, { lineId: `line-${index}` })
    }
    const reopened = createAccelerationPreferenceStore({ filePath })
    await expect(reopened.getAccelerationPreference('xm-account:1')).resolves.toEqual(defaultAccelerationPreference)
    await expect(reopened.getAccelerationPreference('xm-account:70')).resolves.toEqual({ lineId: 'line-70', mode: 'system-proxy' })
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { accounts: Record<string, unknown> }
    expect(Object.keys(stored.accounts)).toHaveLength(64)
  })

  it('re-saving an account keeps it from being dropped as the oldest', async () => {
    const { store: preferences } = store()
    for (let index = 1; index <= 64; index++) {
      await preferences.saveAccelerationPreference(`xm-account:${index}`, { lineId: `line-${index}` })
    }
    await preferences.saveAccelerationPreference('xm-account:1', { lineId: 'line-1' })
    await preferences.saveAccelerationPreference('xm-account:65', { lineId: 'line-65' })
    await expect(preferences.getAccelerationPreference('xm-account:1')).resolves.toEqual({ lineId: 'line-1', mode: 'system-proxy' })
    await expect(preferences.getAccelerationPreference('xm-account:2')).resolves.toEqual(defaultAccelerationPreference)
  })

  // 这份数据丢了最多是少记一次偏好，所以读坏了一律降级，绝不把加速页挡住。
  it('degrades a damaged or foreign file to "never chose anything"', async () => {
    const damaged = temporaryFile()
    fs.writeFileSync(damaged, '{ not json', 'utf8')
    await expect(createAccelerationPreferenceStore({ filePath: damaged }).getAccelerationPreference(scope))
      .resolves.toEqual(defaultAccelerationPreference)
    const newerVersion = temporaryFile()
    fs.writeFileSync(newerVersion, '{"version":9,"accounts":{"xm-account:7":{"lineId":"hk-02","mode":"tun"}}}', 'utf8')
    await expect(createAccelerationPreferenceStore({ filePath: newerVersion }).getAccelerationPreference(scope))
      .resolves.toEqual(defaultAccelerationPreference)
  })

  it('drops a stored line id that is not a line id at all', async () => {
    const { filePath } = store()
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      accounts: { [scope]: { lineId: '../../etc/passwd', mode: 'tun' }, [other]: { mode: 'nope' } },
    }), 'utf8')
    const preferences = createAccelerationPreferenceStore({ filePath })
    await expect(preferences.getAccelerationPreference(scope)).resolves.toEqual({ lineId: null, mode: 'tun' })
    await expect(preferences.getAccelerationPreference(other)).resolves.toEqual(defaultAccelerationPreference)
  })

  it('refuses a relative path', () => {
    expect(() => createAccelerationPreferenceStore({ filePath: 'acceleration-preferences.json' })).toThrow('绝对路径')
  })
})

describe('acceleration start request', () => {
  it('uses the remembered line and mode when the state supports that mode', () => {
    expect(accelerationStartRequest({ lineId: 'hk-02', mode: 'tun' }, ['system-proxy', 'tun']))
      .toEqual({ mode: 'tun', lineId: 'hk-02' })
  })

  it('falls back to the standard mode when the state does not offer the remembered one', () => {
    expect(accelerationStartRequest({ lineId: 'hk-02', mode: 'tun' }, ['system-proxy']))
      .toEqual({ mode: 'system-proxy', lineId: 'hk-02' })
  })

  // 托盘与自动连接都是静默发起的：状态没说支持什么，就不替用户改系统网络设置。
  it('falls back to the standard mode when the state reports no modes at all', () => {
    expect(accelerationStartRequest({ lineId: null, mode: 'tun' }, undefined)).toEqual({ mode: 'system-proxy' })
  })

  it('omits the line entirely when the user chose 智能分配', () => {
    expect(accelerationStartRequest(defaultAccelerationPreference, ['system-proxy'])).toEqual({ mode: 'system-proxy' })
  })
})
