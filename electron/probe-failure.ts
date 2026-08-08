/**
 * A single probe (registry read, PowerShell spawn, network fetch) throwing
 * must not blank out every other card in the dashboard. `describeProbeFailure`
 * and the `build*FromSettled` helpers in system-service.ts and
 * codex-desktop-service.ts turn a rejected branch of `Promise.allSettled`
 * into a status explicitly marked as failed detection, never silently
 * reinterpreted as "not installed".
 *
 * Lives in its own leaf module so codex-desktop-service.ts never needs a
 * value-level import back into system-service.ts.
 */
export function describeProbeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
