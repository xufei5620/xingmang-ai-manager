import os from 'node:os'

export interface DeviceHardware {
  totalMemoryBytes: number
  logicalCpuCount: number
}

// 标称 8GB 的电脑，系统报上来的总内存常常只有 7.2~7.9GB（核显共享、固件保留）。
// 门槛取 7GB 才能把「标称不到 8GB」和「标称 8GB」分开；取 8GB 会把大半台 8GB 电脑误判成低配。
const lowEndMemoryBytes = 7 * 1024 ** 3
const lowEndCpuCount = 2

// Only used locally to pick lighter visuals. The verdict never leaves this
// machine: it is not logged, reported, or included in diagnostics exports.
export function isLowEndDevice(hardware: DeviceHardware) {
  const memoryKnown = Number.isFinite(hardware.totalMemoryBytes) && hardware.totalMemoryBytes > 0
  // os.cpus() can come back empty on some virtual machines; unknown is not "low end".
  const cpuKnown = Number.isInteger(hardware.logicalCpuCount) && hardware.logicalCpuCount > 0
  return (memoryKnown && hardware.totalMemoryBytes < lowEndMemoryBytes)
    || (cpuKnown && hardware.logicalCpuCount <= lowEndCpuCount)
}

export function inspectDeviceHardware(): DeviceHardware {
  return { totalMemoryBytes: os.totalmem(), logicalCpuCount: os.cpus().length }
}
