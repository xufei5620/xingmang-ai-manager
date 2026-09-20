/**
 * A CLI install runs for minutes behind npm resolution, a package download and
 * a signed binary fetch, and until now the only way out of a wrong click or a
 * dead mirror was to kill the app.
 *
 * Cancellation cannot be a bare AbortController handed to every call site. An
 * install crosses stretches where aborting would leave a machine-wide managed
 * directory half replaced -- the atomic promote in particular. Those stretches
 * seal the handle, and a request arriving while sealed is refused with a reason
 * the renderer can put in front of the user rather than silently ignored.
 */

/** 用户主动取消时抛出的错误；与真正的失败区分开，不进异常日志。 */
export class InstallCancelledError extends Error {
  readonly installCancelled = true

  constructor(message = '安装已取消') {
    super(message)
    this.name = 'InstallCancelledError'
  }
}

export function isInstallCancelledError(error: unknown): boolean {
  if (error instanceof InstallCancelledError) return true
  return typeof error === 'object'
    && error !== null
    && (error as { installCancelled?: unknown }).installCancelled === true
}

export interface InstallCancellationOutcome {
  /** 取消请求是否被接受。 */
  cancelled: boolean
  /** 没能取消时给用户看的中文原因；取消成功为 null。 */
  reason: string | null
}

export interface InstallCancellationHandle {
  /** 传给 executeCommand 和下载实现，用来中止正在跑的子进程与请求。 */
  readonly signal: AbortSignal
  readonly cancelled: boolean
  /** 进入不可中断的阶段；此后取消请求一律被拒绝并附上这条中文原因。 */
  seal(reason: string): void
  /** 离开不可中断的阶段，重新接受取消。 */
  unseal(): void
  /** 已取消时抛出 InstallCancelledError，用来在两个阶段之间打断。 */
  throwIfCancelled(): void
  /** 安装结束后登记表里注销；重复调用无副作用。 */
  release(): void
}

const noActiveInstallReason = '这个工具当前没有正在进行的安装。'

class RegisteredCancellation implements InstallCancellationHandle {
  private readonly controller = new AbortController()
  private sealReason: string | null = null
  private released = false

  constructor(
    private readonly key: string,
    private readonly registry: Map<string, RegisteredCancellation>,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted
  }

  seal(reason: string): void {
    if (!reason.trim()) throw new TypeError('封存安装取消必须给出原因')
    this.sealReason = reason
  }

  unseal(): void {
    this.sealReason = null
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new InstallCancelledError()
  }

  release(): void {
    if (this.released) return
    this.released = true
    if (this.registry.get(this.key) === this) this.registry.delete(this.key)
  }

  requestCancel(): InstallCancellationOutcome {
    // 已经取消过的再点一次仍然算取消成功：用户看到的是同一个「取消中」。
    if (this.cancelled) return { cancelled: true, reason: null }
    if (this.sealReason) return { cancelled: false, reason: this.sealReason }
    this.controller.abort(new InstallCancelledError())
    return { cancelled: true, reason: null }
  }
}

/**
 * 按操作名登记正在进行的安装，供取消通道查找。
 * 同一个 key 同时只允许一次安装，这与 InstallationQueue 的去重键一致（I11）。
 */
export class InstallCancellationRegistry {
  private readonly handles = new Map<string, RegisteredCancellation>()

  begin(key: string): InstallCancellationHandle {
    if (!key.trim()) throw new TypeError('安装取消登记名不能为空')
    if (this.handles.has(key)) throw new Error('该操作已有正在进行的安装')
    const handle = new RegisteredCancellation(key, this.handles)
    this.handles.set(key, handle)
    return handle
  }

  has(key: string): boolean {
    return this.handles.has(key)
  }

  cancel(key: string): InstallCancellationOutcome {
    const handle = this.handles.get(key)
    if (!handle) return { cancelled: false, reason: noActiveInstallReason }
    return handle.requestCancel()
  }

  /** 仅用于测试与诊断：当前登记的操作名。 */
  activeKeys(): string[] {
    return [...this.handles.keys()]
  }
}
