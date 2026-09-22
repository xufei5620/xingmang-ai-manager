export interface TtlCacheOptions<T> {
  /** 真正去取数的那一步。只有缓存不新鲜、且没有同一趟请求在跑时才会被调用。 */
  load(): Promise<T>
  /** 缓存有效期（毫秒）。 */
  ttlMs: number
  /** 取当前时间。留给测试注入假时钟，缺省用 Date.now。 */
  now?(): number
}

export interface TtlCache<T> {
  read(): Promise<T>
  /** 丢掉缓存，并让此刻还在飞的那一趟作废（它的结果不再写回缓存）。 */
  invalidate(): void
}

/**
 * 按时间复用上一次结果的读缓存，外加「只认最后一次请求」的守卫。
 *
 * 两件事一起做才有意义：
 * 1. 新鲜期内直接复用，同一份数据不重复读盘；
 * 2. 期间来了 invalidate（用户主动刷新、装卸工具、换账号），那一趟已经在飞的请求
 *    读到的是作废前的世界，它晚回来时必须既不写回缓存、也不挡住下一趟——否则
 *    用户点了刷新，看到的还是旧结果。
 *
 * 并发的 read 共用同一个 Promise：首页快速切来切去时只会落到一次真实读取。
 */
export function createTtlCache<T>(options: TtlCacheOptions<T>): TtlCache<T> {
  const now = options.now ?? Date.now
  let generation = 0
  let entry: { value: T; at: number } | null = null
  let inFlight: { promise: Promise<T>; generation: number } | null = null

  function read(): Promise<T> {
    if (entry && now() - entry.at < options.ttlMs) return Promise.resolve(entry.value)
    if (inFlight && inFlight.generation === generation) return inFlight.promise
    const started = generation
    const promise = options.load().then((value) => {
      if (started === generation) {
        entry = { value, at: now() }
        inFlight = null
      }
      return value
    }, (cause) => {
      // 失败不缓存：下一次 read 要能重试。
      if (started === generation) inFlight = null
      throw cause
    })
    inFlight = { promise, generation: started }
    return promise
  }

  function invalidate() {
    generation += 1
    entry = null
    inFlight = null
  }

  return { read, invalidate }
}
