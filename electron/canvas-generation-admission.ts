export interface CanvasGenerationAdmissionOptions {
  maxActive?: number
  maxStartsPerWindow?: number
  windowMs?: number
  now?: () => number
}

export class CanvasGenerationAdmission {
  private readonly maxActive: number
  private readonly maxStartsPerWindow: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly active = new Map<number, number>()
  private readonly starts = new Map<number, number[]>()

  constructor(options: CanvasGenerationAdmissionOptions = {}) {
    this.maxActive = options.maxActive ?? 20
    this.maxStartsPerWindow = options.maxStartsPerWindow ?? 80
    this.windowMs = options.windowMs ?? 60_000
    this.now = options.now ?? Date.now
    if (![this.maxActive, this.maxStartsPerWindow, this.windowMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('画布生成频率限制配置无效')
    }
  }

  async run<T>(ownerId: number, operation: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('画布窗口标识格式错误')
    if ((this.active.get(ownerId) ?? 0) >= this.maxActive) throw new Error('当前生成任务过多，请等待已有任务完成')
    const now = this.now()
    const recent = (this.starts.get(ownerId) ?? []).filter((startedAt) => now - startedAt < this.windowMs)
    if (recent.length >= this.maxStartsPerWindow) throw new Error('生成请求过于频繁，请稍后重试')
    recent.push(now)
    this.starts.set(ownerId, recent)
    this.active.set(ownerId, (this.active.get(ownerId) ?? 0) + 1)
    try {
      return await operation()
    } finally {
      const remaining = (this.active.get(ownerId) ?? 1) - 1
      if (remaining > 0) this.active.set(ownerId, remaining)
      else this.active.delete(ownerId)
    }
  }

  releaseOwner(ownerId: number): void {
    this.active.delete(ownerId)
    this.starts.delete(ownerId)
  }
}
