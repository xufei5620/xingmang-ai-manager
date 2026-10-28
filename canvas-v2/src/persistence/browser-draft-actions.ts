import type { CanvasBrowserDraft } from './browser-draft'

export interface CanvasDraftActionScope {
  ownerId: number | null
  projectId: string | null
  projectEpoch: number
  dialogEpoch: number
}

export interface CanvasDraftConfirmation {
  scope: Readonly<CanvasDraftActionScope>
  draft: Readonly<CanvasBrowserDraft>
}

export interface CanvasDraftActionToken {
  scope: Readonly<CanvasDraftActionScope>
  sequence: number
}

export function reserveCanvasDraftRevision(writerId: string, previousSequence: number): { revision: string; revisionSequence: number } {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(writerId) || !Number.isSafeInteger(previousSequence) || previousSequence < 0 || previousSequence >= Number.MAX_SAFE_INTEGER) throw new Error('本地草稿修订标识无法继续分配，请先导出当前工作流后重新进入工程')
  const revisionSequence = previousSequence + 1
  return { revision: `${writerId}-${revisionSequence}`, revisionSequence }
}

export function resolveCanvasDraftProtectionAfterWriteFailure(candidate: CanvasBrowserDraft, previous: CanvasBrowserDraft | null, assertStored: (draft: CanvasBrowserDraft) => void): CanvasBrowserDraft | null {
  // Holding a verified new copy protects it from manual cleanup, but does not
  // acknowledge the failed write operation or hide its original error.
  try { assertStored(candidate); return candidate }
  catch { return previous }
}

export function focusCanvasDraftReturnControl(controls: Array<{ isConnected: boolean; disabled?: boolean; getClientRects(): { length: number }; focus(): void } | null>): void {
  controls.find((control) => control?.isConnected && !control.disabled && control.getClientRects().length > 0)?.focus()
}

export function isSameCanvasDraftActionScope(left: CanvasDraftActionScope, right: CanvasDraftActionScope): boolean {
  return left.ownerId === right.ownerId && left.projectId === right.projectId
    && left.projectEpoch === right.projectEpoch && left.dialogEpoch === right.dialogEpoch
}

export function buildCanvasDraftConfirmation(scope: CanvasDraftActionScope, draft: CanvasBrowserDraft): CanvasDraftConfirmation {
  if (!scope.ownerId || !scope.projectId || scope.ownerId !== draft.ownerId || scope.projectId !== draft.projectId) throw new Error('草稿归属已经变化，请重新打开本地草稿管理')
  // Keep the exact content shown at confirmation, independently of a refreshed
  // list or a writer advancing its revision in another tab.
  return Object.freeze({ scope: Object.freeze({ ...scope }), draft: Object.freeze({ ...draft }) })
}

export function canvasDraftConfirmationCurrent(confirmation: CanvasDraftConfirmation, scope: CanvasDraftActionScope, enabled: boolean): boolean {
  return enabled && isSameCanvasDraftActionScope(confirmation.scope, scope)
    && confirmation.draft.ownerId === scope.ownerId && confirmation.draft.projectId === scope.projectId
}

export function confirmCanvasDraftActionRemoval(confirmation: CanvasDraftConfirmation, scope: CanvasDraftActionScope, enabled: boolean, remove: (draft: CanvasBrowserDraft) => boolean): 'inactive' | 'removed' | 'unconfirmed' {
  if (!canvasDraftConfirmationCurrent(confirmation, scope, enabled)) return 'inactive'
  return remove(confirmation.draft) ? 'removed' : 'unconfirmed'
}

/** A modal reopening in the same project is a new action context, just as a
 * same-id project reload is. Finishing an older operation cannot unlock it. */
export function createCanvasDraftActionGuard() {
  let active = true
  let sequence = 0
  let pending: CanvasDraftActionToken | null = null
  return {
    activate() { active = true },
    begin(scope: CanvasDraftActionScope): CanvasDraftActionToken | null {
      if (!active || pending || !scope.ownerId || !scope.projectId) return null
      pending = Object.freeze({ scope: Object.freeze({ ...scope }), sequence: ++sequence })
      return pending
    },
    current(token: CanvasDraftActionToken | null, scope: CanvasDraftActionScope, enabled = true): boolean {
      return Boolean(token && enabled && active && pending === token && token.sequence === sequence && isSameCanvasDraftActionScope(token.scope, scope))
    },
    invalidate() { sequence += 1; pending = null },
    finish(token: CanvasDraftActionToken) { if (pending === token) pending = null },
    busy() { return pending !== null },
    scope(): Readonly<CanvasDraftActionScope> | null { return pending?.scope ?? null },
    dispose() { active = false; sequence += 1; pending = null },
  }
}
