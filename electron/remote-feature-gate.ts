import { RemoteFeatureOffError, type RemoteFeatureId } from './remote-features'

/**
 * 主进程这一头的远程开关（remote-features.ts）：手上这份关掉了哪几样，各处做事之前问一声。
 *
 * 关掉了哪几样照更新快照里的 featuresOff（updater.ts），只认最近一次读成功的那份状态文件：一次没读到
 * 就放出来，坏掉的那条路又开了。从没读成功过（刚打开、连不上更新目录）就什么都不关，跟没有这项的旧版一样。
 *
 * 点了才做的事（装工具、打开、出视频）用 assertOn：刚打开星芒、状态文件第一次还没读完的那一会儿，等它读完
 * （最多 firstReadWaitMs）再看，免得开机就点的那一下溜过去。读完以后当场判断、不再等：之后每隔一阵重读的
 * 那一次不等，打开工具是客户最常点的一下，不能每次都可能卡上几秒。后台自己会做的事（闲时装、托盘省内存）用 isOff。
 */
export interface RemoteFeatureGate {
  isOff(feature: RemoteFeatureId): boolean
  /**
   * 关着就抛 RemoteFeatureOffError（带着这句话），开着返回 undefined；状态文件第一次还没读完时返回一个
   * Promise，读完再照这个办。同步的处理器用 runWhenOn，开着时照原来同步往下走。
   */
  assertOn(feature: RemoteFeatureId, message: string): Promise<void> | undefined
  /** 换上新读到的那份（这一版、这种安装包要关的，版本和平台已经筛过）。 */
  update(features: readonly RemoteFeatureId[]): void
  /** 关掉的那几样变了才通知；返回取消订阅。 */
  subscribe(listener: (features: readonly RemoteFeatureId[]) => void): () => void
}

export interface RemoteFeatureGateOptions {
  /** 状态文件正在读就等这一次读完（service-status.ts 的 settled）；没有状态文件的不等。 */
  settled?: () => Promise<unknown>
  /** 第一次最多等多久，缺省两秒：等不来就按手上这份算，开关管不到总比把客户挡在门外强。 */
  firstReadWaitMs?: number
}

const defaultFirstReadWaitMs = 2_000

export function createRemoteFeatureGate(options: RemoteFeatureGateOptions = {}): RemoteFeatureGate {
  let off: readonly RemoteFeatureId[] = []
  let firstReadDone = !options.settled
  let firstRead: Promise<void> | null = null
  const listeners = new Set<(features: readonly RemoteFeatureId[]) => void>()

  function waitFirstRead(settled: () => Promise<unknown>): Promise<void> {
    firstRead ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.firstReadWaitMs ?? defaultFirstReadWaitMs)
      timer.unref?.()
      // 读的那一下自己出错也算读完：同上，按手上这份算。当场去要，不隔一拍：这一拍里读可能刚好结束。
      void new Promise((resolveRead) => { resolveRead(settled()) }).catch(() => undefined).finally(() => {
        clearTimeout(timer)
        firstReadDone = true
        resolve()
      })
    })
    return firstRead
  }

  function assertNow(feature: RemoteFeatureId, message: string): void {
    if (off.includes(feature)) throw new RemoteFeatureOffError(message)
  }

  return {
    isOff(feature) {
      return off.includes(feature)
    },
    assertOn(feature, message) {
      if (!firstReadDone && options.settled) return waitFirstRead(options.settled).then(() => assertNow(feature, message))
      assertNow(feature, message)
      return undefined
    },
    update(features) {
      if (features.length === off.length && features.every((feature, index) => feature === off[index])) return
      off = [...features]
      for (const listener of [...listeners]) {
        // 一处收不到通知不能挡住别处：各处照样在做事之前再问一次 isOff。
        try { listener(off) } catch { /* 见上。 */ }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * 同步的 IPC 处理器过这一道：开着、状态文件也读过了，就照原来同步往下走（入参格式错的照旧当场抛），跟没有
 * 这道一样；还在等状态文件第一次读完才变成 Promise。没接开关（测试、旧的组装）当作开着。
 */
export function runWhenOn<T>(gate: Pick<RemoteFeatureGate, 'assertOn'> | undefined, feature: RemoteFeatureId, message: string, run: () => T): T | Promise<T> {
  const waiting = gate?.assertOn(feature, message)
  return waiting ? waiting.then(run) : run()
}
