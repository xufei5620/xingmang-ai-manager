export interface ScanRequestTracker {
  begin(): number
  isCurrent(id: number): boolean
  finish(id: number): number
  invalidate(): void
  activeCount(): number
  isInvalidated(): boolean
}

export type ScanFailureTarget = 'system' | 'config'

export interface ScanFailure {
  target: ScanFailureTarget
  reason: unknown
}

export interface CoordinatedScanResult<Snapshot, Config> {
  snapshot: Snapshot | null
  config: Config | null
  current: boolean
}

export interface CoordinatedScanOptions<Snapshot, Config> {
  tracker: ScanRequestTracker
  scanSystem(): Promise<Snapshot>
  readConfig(): Promise<Config>
  onLoadingChange(loading: boolean): void
  onSnapshot(snapshot: Snapshot): void
  onConfig(config: Config): void
  onFailures(failures: ScanFailure[]): void
}

/** Tracks overlapping scans so late responses cannot commit over a newer request. */
export function createScanRequestTracker(): ScanRequestTracker {
  let sequence = 0
  const active = new Set<number>()
  let invalidated = false
  return {
    begin() {
      invalidated = false
      const id = ++sequence
      active.add(id)
      return id
    },
    isCurrent(id) {
      return id === sequence
    },
    finish(id) {
      active.delete(id)
      return active.size
    },
    invalidate() {
      invalidated = true
      sequence += 1
      active.clear()
    },
    activeCount() {
      return active.size
    },
    isInvalidated() {
      return invalidated
    },
  }
}

/** Commits only the latest scan while preserving either independently successful result. */
export async function runCoordinatedScan<Snapshot, Config>({
  tracker,
  scanSystem,
  readConfig,
  onLoadingChange,
  onSnapshot,
  onConfig,
  onFailures,
}: CoordinatedScanOptions<Snapshot, Config>): Promise<CoordinatedScanResult<Snapshot, Config>> {
  const requestId = tracker.begin()
  onLoadingChange(true)

  const [snapshotResult, configResult] = await Promise.allSettled([
    Promise.resolve().then(scanSystem),
    Promise.resolve().then(readConfig),
  ])

  let snapshot: Snapshot | null = null
  let config: Config | null = null
  const current = tracker.isCurrent(requestId)

  try {
    if (!current) return { snapshot, config, current: false }

    const failures: ScanFailure[] = []
    if (snapshotResult.status === 'fulfilled') {
      snapshot = snapshotResult.value
      onSnapshot(snapshotResult.value)
    } else {
      failures.push({ target: 'system', reason: snapshotResult.reason })
    }

    if (configResult.status === 'fulfilled') {
      config = configResult.value
      onConfig(configResult.value)
    } else {
      failures.push({ target: 'config', reason: configResult.reason })
    }

    if (failures.length > 0) onFailures(failures)
    return { snapshot, config, current: true }
  } finally {
    const remaining = tracker.finish(requestId)
    if (remaining === 0 && !tracker.isInvalidated()) onLoadingChange(false)
  }
}
