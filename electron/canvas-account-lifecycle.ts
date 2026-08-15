export interface CanvasAccountImageService {
  cancelUser(userId: number): number
}

export interface CanvasAccountRunService {
  initializeUser(userId: number): Promise<unknown>
  reconcileAssets(userId: number): Promise<unknown>
  cancelUser(userId: number): number
}

export interface CanvasAccountLifecycleServices {
  imageService: CanvasAccountImageService
  videoService: CanvasAccountImageService & { resumeUser(userId: number): Promise<unknown> }
  canvasRuns: CanvasAccountRunService
}

export interface CanvasAccountLifecycleOptions {
  onInitializationError?: (userId: number, error: unknown) => void
}

function validUserId(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0
}

export function createCanvasAccountLifecycle(options: CanvasAccountLifecycleOptions = {}) {
  let services: CanvasAccountLifecycleServices | null = null
  let activeUserId: number | null = null
  let revision = 0

  function initializeCurrent(userId: number, expectedRevision: number): void {
    if (!services) return
    const currentServices = services
    void currentServices.videoService.resumeUser(userId)
      .catch((error) => options.onInitializationError?.(userId, error))
    void currentServices.canvasRuns.initializeUser(userId)
      .then(async () => {
        if (revision !== expectedRevision || activeUserId !== userId || services !== currentServices) return
        await currentServices.canvasRuns.reconcileAssets(userId)
      })
      .catch((error) => options.onInitializationError?.(userId, error))
  }

  function update(nextUserId: number | null): void {
    if (nextUserId !== null && !validUserId(nextUserId)) throw new Error('画布账号标识格式错误')
    if (nextUserId === activeUserId) return
    const previousUserId = activeUserId
    activeUserId = nextUserId
    revision += 1
    if (services && previousUserId !== null) {
      services.imageService.cancelUser(previousUserId)
      services.videoService.cancelUser(previousUserId)
      services.canvasRuns.cancelUser(previousUserId)
    }
    if (nextUserId !== null) initializeCurrent(nextUserId, revision)
  }

  function bind(nextServices: CanvasAccountLifecycleServices): void {
    if (services) throw new Error('画布账号生命周期服务已绑定')
    services = nextServices
    if (activeUserId !== null) initializeCurrent(activeUserId, revision)
  }

  return { update, bind }
}

export type CanvasAccountLifecycle = ReturnType<typeof createCanvasAccountLifecycle>
