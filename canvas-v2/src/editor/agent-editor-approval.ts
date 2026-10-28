/** A manual edit cancels dispatch synchronously, before React publishes its revision. */
export function createCanvasAgentEditorApproval() {
  let revision = 0, committing = 0
  const signals = new WeakMap<AbortSignal, AbortSignal>(), active = new Set<AbortController>()
  function changed(): number {
    if (committing) return revision
    revision++
    for (const controller of active) controller.abort(new Error('画布已手动修改，自动执行已暂停，请核对原消息'))
    active.clear()
    return revision
  }
  function signal(parent: AbortSignal): AbortSignal {
    if (parent.aborted) return parent
    const existing = signals.get(parent)
    if (existing) return existing
    const controller = new AbortController()
    function abort() { controller.abort(parent.reason) }
    function cleanup() { active.delete(controller); parent.removeEventListener('abort', abort) }
    parent.addEventListener('abort', abort, { once: true })
    controller.signal.addEventListener('abort', cleanup, { once: true })
    active.add(controller); signals.set(parent, controller.signal)
    return controller.signal
  }
  function commit<T>(action: () => T): T {
    committing++
    try { return action() } finally { committing-- }
  }
  return { revision: () => revision, changed, signal, commit }
}
