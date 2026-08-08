/**
 * Resolving the Codex CLI (mcp:list / plugins:list / models:list) does real
 * filesystem and subprocess work in the main process. The dashboard becomes
 * navigable as soon as the cheap, config-only Codex readiness check resolves
 * -- well before the heavier initial environment scan settles. A fast
 * navigation to the MCP/Plugins page, or an early "detect models" click, can
 * therefore race ahead of that scan and hit a spuriously cold resolution
 * even though the CLI is genuinely installed (the same command resolves
 * cleanly a moment later, once the scan has run).
 *
 * A `StartupGate` lets those specific requests wait for the first scan to
 * settle without polling: `settle()` is called exactly once real work has
 * been attempted (success or failure -- a failed scan still means the
 * environment was probed), and every `ready()` caller -- however many, and
 * whether they started waiting before or after `settle()` -- resolves off
 * the same underlying promise.
 */
export interface StartupGate {
  /** Resolves once `settle()` has been called; never rejects. */
  ready(): Promise<void>
  /** Idempotent: only the first call has any effect. */
  settle(): void
}

export function createStartupGate(): StartupGate {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    ready: () => gate,
    settle: () => release(),
  }
}
