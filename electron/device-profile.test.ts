import { describe, expect, it } from 'vitest'
import { inspectDeviceHardware, isLowEndDevice } from './device-profile'

const gib = 1024 ** 3

describe('isLowEndDevice', () => {
  it('treats machines sold as under 8GB as low end', () => {
    expect(isLowEndDevice({ totalMemoryBytes: 3.8 * gib, logicalCpuCount: 8 })).toBe(true)
    expect(isLowEndDevice({ totalMemoryBytes: 5.9 * gib, logicalCpuCount: 8 })).toBe(true)
  })

  it('keeps nominal 8GB machines whose OS reports slightly less than 8GB on the normal path', () => {
    expect(isLowEndDevice({ totalMemoryBytes: 7.2 * gib, logicalCpuCount: 4 })).toBe(false)
    expect(isLowEndDevice({ totalMemoryBytes: 7.9 * gib, logicalCpuCount: 4 })).toBe(false)
    expect(isLowEndDevice({ totalMemoryBytes: 16 * gib, logicalCpuCount: 8 })).toBe(false)
  })

  it('treats two or fewer logical processors as low end regardless of memory', () => {
    expect(isLowEndDevice({ totalMemoryBytes: 16 * gib, logicalCpuCount: 2 })).toBe(true)
    expect(isLowEndDevice({ totalMemoryBytes: 16 * gib, logicalCpuCount: 1 })).toBe(true)
    expect(isLowEndDevice({ totalMemoryBytes: 16 * gib, logicalCpuCount: 3 })).toBe(false)
  })

  it('does not call a machine low end because a reading is missing', () => {
    expect(isLowEndDevice({ totalMemoryBytes: 16 * gib, logicalCpuCount: 0 })).toBe(false)
    expect(isLowEndDevice({ totalMemoryBytes: 0, logicalCpuCount: 8 })).toBe(false)
    expect(isLowEndDevice({ totalMemoryBytes: Number.NaN, logicalCpuCount: 8 })).toBe(false)
  })
})

describe('inspectDeviceHardware', () => {
  it('reads the local machine without throwing', () => {
    const hardware = inspectDeviceHardware()
    expect(hardware.totalMemoryBytes).toBeGreaterThan(0)
    expect(Number.isInteger(hardware.logicalCpuCount)).toBe(true)
  })
})
