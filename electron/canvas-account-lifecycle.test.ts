import { describe, expect, it, vi } from 'vitest'
import { createCanvasAccountLifecycle } from './canvas-account-lifecycle'

function services() {
  const initializeUser = vi.fn<(_: number) => Promise<unknown>>(async () => undefined)
  const reconcileAssets = vi.fn<(_: number) => Promise<unknown>>(async () => undefined)
  return {
    imageService: { cancelUser: vi.fn(() => 0) },
    canvasRuns: {
      initializeUser,
      reconcileAssets,
      cancelUser: vi.fn(() => 0),
    },
  }
}

describe('createCanvasAccountLifecycle', () => {
  it('initializes a restored session even when services bind later', async () => {
    const lifecycle = createCanvasAccountLifecycle()
    const runtime = services()
    lifecycle.update(42)
    lifecycle.bind(runtime)

    await vi.waitFor(() => expect(runtime.canvasRuns.reconcileAssets).toHaveBeenCalledWith(42))
    expect(runtime.canvasRuns.initializeUser).toHaveBeenCalledWith(42)
  })

  it('cancels image and canvas work for the previous user on logout and account switch', async () => {
    const lifecycle = createCanvasAccountLifecycle()
    const runtime = services()
    lifecycle.bind(runtime)
    lifecycle.update(42)
    await vi.waitFor(() => expect(runtime.canvasRuns.reconcileAssets).toHaveBeenCalledWith(42))

    lifecycle.update(99)
    expect(runtime.imageService.cancelUser).toHaveBeenCalledWith(42)
    expect(runtime.canvasRuns.cancelUser).toHaveBeenCalledWith(42)
    await vi.waitFor(() => expect(runtime.canvasRuns.reconcileAssets).toHaveBeenCalledWith(99))

    lifecycle.update(null)
    expect(runtime.imageService.cancelUser).toHaveBeenCalledWith(99)
    expect(runtime.canvasRuns.cancelUser).toHaveBeenCalledWith(99)
  })

  it('does not repeat recovery when access-token refresh reports the same user', async () => {
    const lifecycle = createCanvasAccountLifecycle()
    const runtime = services()
    lifecycle.bind(runtime)
    lifecycle.update(42)
    await vi.waitFor(() => expect(runtime.canvasRuns.reconcileAssets).toHaveBeenCalledOnce())

    lifecycle.update(42)
    await Promise.resolve()
    expect(runtime.canvasRuns.initializeUser).toHaveBeenCalledOnce()
    expect(runtime.imageService.cancelUser).not.toHaveBeenCalled()
  })

  it('does not reconcile a stale user after an account switch', async () => {
    let releaseFirst: (() => void) | undefined
    const runtime = services()
    runtime.canvasRuns.initializeUser
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve }))
      .mockResolvedValue(undefined)
    const lifecycle = createCanvasAccountLifecycle()
    lifecycle.bind(runtime)
    lifecycle.update(42)
    lifecycle.update(99)
    releaseFirst?.()

    await vi.waitFor(() => expect(runtime.canvasRuns.reconcileAssets).toHaveBeenCalledWith(99))
    expect(runtime.canvasRuns.reconcileAssets).not.toHaveBeenCalledWith(42)
  })

  it('reports initialization failures without rejecting the session transition', async () => {
    const onInitializationError = vi.fn()
    const runtime = services()
    runtime.canvasRuns.initializeUser.mockRejectedValue(new Error('disk failed'))
    const lifecycle = createCanvasAccountLifecycle({ onInitializationError })
    lifecycle.bind(runtime)

    expect(() => lifecycle.update(42)).not.toThrow()
    await vi.waitFor(() => expect(onInitializationError).toHaveBeenCalledWith(42, expect.any(Error)))
  })
})
