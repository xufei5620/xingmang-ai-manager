import type { NetworkLocationStatus } from './system-service'

interface NetworkLocationCacheOptions {
  probe: (forceRefresh: boolean) => Promise<NetworkLocationStatus>
  ttlMs: number
  now?: () => number
}

/** Coalesce regular scans, but let an explicit refresh replace an older probe. */
export function createNetworkLocationCache(options: NetworkLocationCacheOptions) {
  const now = options.now ?? Date.now
  let generation = 0
  let cached: { expiresAt: number; value: NetworkLocationStatus } | null = null
  let inFlight: { generation: number; promise: Promise<NetworkLocationStatus> } | null = null

  function read(forceRefresh = false): Promise<NetworkLocationStatus> {
    if (forceRefresh) {
      generation += 1
      cached = null
      inFlight = null
    }
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value)
    if (inFlight) return inFlight.promise
    const expectedGeneration = generation
    const promise = Promise.resolve().then(() => options.probe(forceRefresh)).then(
      (value) => {
        // An older full scan must follow the new network result as well; merely
        // guarding the cache write would still return stale location to its UI.
        if (expectedGeneration !== generation) return read()
        cached = { expiresAt: now() + options.ttlMs, value }
        return value
      },
      (error: unknown) => {
        if (expectedGeneration !== generation) return read()
        throw error
      },
    ).finally(() => {
      if (inFlight?.promise === promise) inFlight = null
    })
    inFlight = { generation: expectedGeneration, promise }
    return promise
  }

  return { read }
}

/** A Chromium proxy reload has no AbortSignal parameter; bound the waiting side. */
export async function reloadNetworkProxyConfiguration(reload: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(reload),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('刷新网络代理配置超时，请稍后重试。')), 2_500)
        timer.unref?.()
      }),
    ])
  } catch {
    throw new Error('无法刷新当前网络代理配置，请稍后重试。')
  } finally {
    clearTimeout(timer)
  }
}
