export interface LayerPreviewTaskInput<T> {
  current(): boolean
  create(): T
  paint(value: T, signal: AbortSignal): Promise<void>
  /** Return true only when a completed value becomes the caller-owned cache. */
  publish(value: T): boolean
  dispose(value: T): void
  fail(cause: unknown): void
}
export interface LayerPreviewTask { cancel(): void; done: Promise<void> }

/** One active raster limits temporary 4MP warp textures across all visible
 * layers. Superseded queued previews never allocate or publish a surface.
 */
export function createLayerPreviewScheduler() {
  const queue: Array<() => Promise<void>> = []
  let running = false
  function pump() {
    if (running) return
    const run = queue.shift()
    if (!run) return
    running = true
    void run().finally(() => { running = false; pump() })
  }
  function schedule<T>(input: LayerPreviewTaskInput<T>): LayerPreviewTask {
    const controller = new AbortController()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    async function run() {
      let value: T | undefined, created = false, retained = false
      try {
        // Let a new React commit cancel this work before allocating surfaces.
        await Promise.resolve()
        if (controller.signal.aborted || !input.current()) return
        value = input.create(); created = true
        await input.paint(value, controller.signal)
        if (!controller.signal.aborted && input.current()) retained = input.publish(value)
      } catch (cause) {
        if (!controller.signal.aborted && input.current()) input.fail(cause)
      } finally {
        if (created && !retained) input.dispose(value as T)
        finish()
      }
    }
    queue.push(run); pump()
    return { done, cancel() {
      controller.abort()
      const index = queue.indexOf(run)
      if (index >= 0) { queue.splice(index, 1); finish() }
    } }
  }
  return { schedule }
}

export const layerPreviewScheduler = createLayerPreviewScheduler()
