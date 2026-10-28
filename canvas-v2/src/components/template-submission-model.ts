interface TemplateSubmissionCallbacks {
  onStart(): void
  onSuccess(): void
  onError(reason: unknown): void
  onFinish(): void
}

export interface TemplateSubmissionController {
  active(): boolean
  invalidate(): void
  submit(action: () => void | Promise<void>, callbacks: TemplateSubmissionCallbacks): Promise<boolean>
}

export function createTemplateSubmissionController(): TemplateSubmissionController {
  let epoch = 0
  let pending: number | null = null
  return {
    active() { return pending !== null },
    invalidate() { epoch += 1; pending = null },
    async submit(action, callbacks) {
      if (pending !== null) return false
      const ticket = ++epoch
      pending = ticket
      callbacks.onStart()
      let failed = false
      let failure: unknown
      try { await action() } catch (reason) { failed = true; failure = reason }
      // A completed creation belongs to the dialog that submitted it, never a
      // newer dialog opened after an external project/account transition.
      if (pending !== ticket || epoch !== ticket) return false
      pending = null
      callbacks.onFinish()
      if (failed) callbacks.onError(failure)
      else callbacks.onSuccess()
      return !failed
    },
  }
}
