import { resolveLayerGrabCutRuntime, runLayerGrabCutRuntime } from './layer-grabcut-runtime'
import { layerGrabCutIterations, type LayerGrabCutPreparedInput } from './layer-grabcut-selection'
import createLayerGrabCutRuntime from '../vendor/opencv-grabcut/runtime/opencv-grabcut-2b3586b4fe00ea68120073e8902655b27997b6a61951074fd78a2df1ff74d6a5.js'

interface GrabCutWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<unknown>) => void) | null
}

const scope = globalThis as unknown as GrabCutWorkerScope

async function initialize(): Promise<void> {
  // A static dependency keeps Vite's browser-only dynamic-import helpers out of this worker.
  // The worker is created on demand; its pinned, local runtime never enters the page bundle.
  const { cv } = await resolveLayerGrabCutRuntime(createLayerGrabCutRuntime())
  let accepted = false
  scope.onmessage = (event) => {
    if (accepted) return
    accepted = true
    const value = event.data
    if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'segment' || !('input' in value)) { reportFailure(); return }
    const input = value.input as LayerGrabCutPreparedInput
    void runLayerGrabCutRuntime(cv, input, (iteration) => scope.postMessage({ type: 'progress', iteration, total: layerGrabCutIterations }))
      .then((mask) => scope.postMessage({ type: 'complete', mask }, [mask.buffer]))
      .catch(reportFailure)
  }
  scope.postMessage({ type: 'ready' })
}

function reportFailure(): void { scope.postMessage({ type: 'error', message: '本地前景分割未能完成，原选区已保留；请调整处理框或前景、背景笔触后重试' }) }

void initialize().catch(reportFailure)
