import { describe, expect, it } from 'vitest'
import {
  buildMaintenanceStatus,
  maintenanceFailureNotice,
  readMaintenanceStatus,
  type MaintenanceStatus,
} from './maintenance-status'

type Snapshot = NonNullable<MaintenanceStatus['snapshot']>
type Capability = NonNullable<MaintenanceStatus['capability']>

const snapshot = { clis: {}, desktopApps: {}, runtime: {} } as unknown as Snapshot
const capability = { platform: 'win32', cliInstall: {} } as unknown as Capability

describe('buildMaintenanceStatus', () => {
  it('keeps both blocks when both reads succeed', () => {
    const status = buildMaintenanceStatus(
      { status: 'fulfilled', value: snapshot },
      { status: 'fulfilled', value: capability },
    )
    expect(status.snapshot).toBe(snapshot)
    expect(status.capability).toBe(capability)
    expect(status.failures).toEqual([])
  })

  it('keeps the platform capabilities when the system scan fails', () => {
    const status = buildMaintenanceStatus(
      { status: 'rejected', reason: new Error('探测没有完成') },
      { status: 'fulfilled', value: capability },
    )
    expect(status.snapshot).toBeNull()
    expect(status.capability).toBe(capability)
    expect(status.failures).toEqual([{ partition: 'system', message: '探测没有完成' }])
  })

  it('keeps the system snapshot when the platform capabilities fail', () => {
    const status = buildMaintenanceStatus(
      { status: 'fulfilled', value: snapshot },
      { status: 'rejected', reason: new Error('当前系统信息没有读到') },
    )
    expect(status.snapshot).toBe(snapshot)
    expect(status.capability).toBeNull()
    expect(status.failures).toEqual([{ partition: 'platform', message: '当前系统信息没有读到' }])
  })

  it('reports both partitions when neither read succeeds', () => {
    const status = buildMaintenanceStatus(
      { status: 'rejected', reason: new Error('探测没有完成') },
      { status: 'rejected', reason: new Error('当前系统信息没有读到') },
    )
    expect(status.snapshot).toBeNull()
    expect(status.capability).toBeNull()
    expect(status.failures.map((failure) => failure.partition)).toEqual(['system', 'platform'])
  })

  it('redacts an absolute home path out of the failure message', () => {
    const status = buildMaintenanceStatus(
      { status: 'rejected', reason: new Error('读取 C:\\Users\\zhangsan\\.claude\\settings.json 失败') },
      { status: 'fulfilled', value: capability },
    )
    expect(status.failures[0]?.message).toBe('读取 本地配置文件 失败')
    expect(status.failures[0]?.message).not.toContain('zhangsan')
  })

  it('falls back to a readable sentence when the rejection carries no Chinese reason', () => {
    const status = buildMaintenanceStatus(
      { status: 'rejected', reason: new Error('EPERM') },
      { status: 'rejected', reason: new Error('EPERM') },
    )
    expect(status.failures[0]?.message).toBe('工具状态没有读到，请重新检测。')
    expect(status.failures[1]?.message).toBe('当前系统支持的操作没有读到，请重新检测。')
  })
})

describe('readMaintenanceStatus', () => {
  it('does not let one rejected read cancel the other', async () => {
    let capabilityRead = false
    const status = await readMaintenanceStatus({
      scanSystem: async () => { throw new Error('探测没有完成') },
      getPlatformCapabilities: async () => { capabilityRead = true; return capability },
    } as never)
    expect(capabilityRead).toBe(true)
    expect(status.capability).toBe(capability)
    expect(status.failures).toHaveLength(1)
  })

  it('scans without forcing a refresh, so opening the page reuses the cached probe', async () => {
    const forced: unknown[] = []
    await readMaintenanceStatus({
      scanSystem: async (force: boolean) => { forced.push(force); return snapshot },
      getPlatformCapabilities: async () => capability,
    } as never)
    expect(forced).toEqual([false])
  })
})

describe('maintenanceFailureNotice', () => {
  it('tells the user the rows have no verdict yet when the system scan is missing', () => {
    const notice = maintenanceFailureNotice({ partition: 'system', message: '探测没有完成' })
    expect(notice.title).toBe('工具状态暂未读到')
    expect(notice.reason).toBe('探测没有完成')
    expect(notice.hint).toContain('重新检测')
  })

  it('says the states still hold when only the platform capabilities are missing', () => {
    const notice = maintenanceFailureNotice({ partition: 'platform', message: '当前系统信息没有读到' })
    expect(notice.title).toBe('当前系统支持的操作暂未读到')
    expect(notice.hint).toContain('照常显示')
  })

  it('never names a site or an internal code name', () => {
    for (const partition of ['system', 'platform'] as const) {
      const notice = maintenanceFailureNotice({ partition, message: '读取失败' })
      const text = `${notice.title}${notice.reason}${notice.hint}`
      expect(text).not.toMatch(/solov|Sub2API|new-api/i)
    }
  })
})
