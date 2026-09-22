import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  describeInsufficientDiskSpace,
  formatFreeSpace,
  installMinimumFreeBytes,
  mergeSameDeviceReadings,
  readDiskSpace,
  tightestDiskSpace,
  type DiskSpaceReading,
} from './disk-space'

const gigabyte = 1024 ** 3

function reading(availableBytes: number, overrides: Partial<DiskSpaceReading> = {}): DiskSpaceReading {
  return {
    availableBytes,
    totalBytes: 256 * gigabyte,
    measuredPath: '/data',
    deviceId: 1,
    ...overrides,
  }
}

function missingPathError(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
}

describe('reading free disk space', () => {
  it('reports the space an unprivileged user can actually take', async () => {
    const statfs = vi.fn(async () => ({ bavail: 3_000_000, bsize: 1024, blocks: 100_000_000 }))
    const stat = vi.fn(async () => ({ dev: 42 }))
    // 路径先 resolve 再比：Windows 上 '/data' 会被补成 'D:\\data'，写死的字面量
    // 在那边永远对不上。
    const target = path.resolve(path.join('/data', 'xingmang'))

    const result = await readDiskSpace(target, { statfs, stat })

    expect(result).toMatchObject({
      availableBytes: 3_000_000 * 1024,
      totalBytes: 100_000_000 * 1024,
      measuredPath: target,
      deviceId: 42,
    })
  })

  it('walks up to the nearest existing directory, because a first install has no target yet', async () => {
    const existing = path.resolve('/data')
    const statfs = vi.fn(async (target: string) => {
      if (target !== existing) throw missingPathError()
      return { bavail: 1_000, bsize: 4096, blocks: 10_000 }
    })

    const result = await readDiskSpace(path.join(existing, 'xingmang', 'Cli', 'npm'), {
      statfs,
      stat: async () => ({ dev: 7 }),
    })

    expect(result?.measuredPath).toBe(existing)
    expect(statfs).toHaveBeenCalledTimes(4)
  })

  it('returns null when the filesystem refuses to answer, so nothing gets blocked over a missing number', async () => {
    const statfs = vi.fn(async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })

    expect(await readDiskSpace(path.resolve('/data'), {
      statfs,
      stat: async () => ({ dev: 1 }),
    })).toBeNull()
  })

  it('keeps the reading when only the device id is unavailable', async () => {
    const result = await readDiskSpace(path.resolve('/data'), {
      statfs: async () => ({ bavail: 10, bsize: 4096, blocks: 100 }),
      stat: async () => { throw missingPathError() },
    })

    expect(result).toMatchObject({ availableBytes: 40_960, deviceId: null })
  })
})

describe('presenting free disk space', () => {
  it('says GB above a gigabyte and MB below it', () => {
    expect(formatFreeSpace(12.34 * gigabyte)).toBe('12.3 GB')
    expect(formatFreeSpace(gigabyte)).toBe('1.0 GB')
    expect(formatFreeSpace(420 * 1024 ** 2)).toBe('420 MB')
    expect(formatFreeSpace(512)).toBe('不足 1 MB')
    expect(formatFreeSpace(-1)).toBe('不足 1 MB')
  })
})

describe('deciding whether an install may start', () => {
  it('lets a roomy disk through', () => {
    expect(describeInsufficientDiskSpace(reading(40 * gigabyte))).toBeNull()
    expect(describeInsufficientDiskSpace(reading(installMinimumFreeBytes))).toBeNull()
  })

  it('blocks a nearly full disk and names both the remaining and the required space', () => {
    const message = describeInsufficientDiskSpace(reading(420 * 1024 ** 2))

    expect(message).toContain('磁盘空间不足')
    expect(message).toContain('420 MB')
    expect(message).toContain('1.0 GB')
  })

  it('lets the install through when the space could not be read at all', () => {
    expect(describeInsufficientDiskSpace(null)).toBeNull()
  })

  it('judges by the tightest disk an install touches', () => {
    const tightest = tightestDiskSpace([reading(40 * gigabyte), null, reading(200 * 1024 ** 2)])

    expect(tightest?.availableBytes).toBe(200 * 1024 ** 2)
    expect(describeInsufficientDiskSpace(tightest)).toContain('磁盘空间不足')
    expect(tightestDiskSpace([null, null])).toBeNull()
  })
})

describe('merging readings that point at the same disk', () => {
  it('reports one line when both directories live on the same volume', () => {
    const merged = mergeSameDeviceReadings([
      reading(10 * gigabyte, { deviceId: 3, measuredPath: '/a' }),
      reading(10 * gigabyte, { deviceId: 3, measuredPath: '/b' }),
    ])

    expect(merged.map((entry) => entry.measuredPath)).toEqual(['/a'])
  })

  it('keeps separate volumes apart, and keeps unknown devices rather than guessing', () => {
    const merged = mergeSameDeviceReadings([
      reading(10 * gigabyte, { deviceId: 3 }),
      reading(2 * gigabyte, { deviceId: 4 }),
      reading(1 * gigabyte, { deviceId: null }),
      reading(1 * gigabyte, { deviceId: null }),
    ])

    expect(merged).toHaveLength(4)
  })
})
