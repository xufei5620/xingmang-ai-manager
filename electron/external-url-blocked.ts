// Zero-dependency on purpose: the v2 renderer imports this module to recognise
// the rejection, so it must never pull in Node or Electron.

/**
 * Electron hands an `ipcMain.handle` rejection to the renderer as
 * `error.toString()`, i.e. `${name}: ${message}`, and drops every other
 * property. The error name is therefore the only field that survives the
 * bridge unchanged, so it doubles as the stable code the renderer branches on
 * instead of matching the Chinese sentence.
 */
export const externalUrlBlockedErrorName = 'ExternalUrlBlockedError'

export class ExternalUrlBlockedError extends Error {
  constructor() {
    super('不允许打开该链接')
    this.name = externalUrlBlockedErrorName
  }
}

const bridgedNamePattern = new RegExp(`(?:^|:\\s*)${externalUrlBlockedErrorName}:`)

export function isExternalUrlBlockedError(error: unknown): boolean {
  if (error instanceof Error && error.name === externalUrlBlockedErrorName) return true
  const message = error instanceof Error
    ? error.message
    : (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '')
  return bridgedNamePattern.test(message)
}
