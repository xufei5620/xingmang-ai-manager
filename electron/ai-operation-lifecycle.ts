/** Observers capture request ownership synchronously and return a terminal
 * callback. They must never change the result of the observed AI operation. */
export type AiOperationStartedObserver = () => (() => void) | undefined

export function observeAiOperation(onStarted?: AiOperationStartedObserver): () => void {
  let onSettled: (() => void) | undefined
  try { onSettled = onStarted?.() } catch { /* observation is best effort */ }
  let settled = false
  return () => {
    if (settled) return
    settled = true
    try { onSettled?.() } catch { /* a closed window must not fail generation */ }
  }
}
