import fs from 'node:fs'
import path from 'node:path'

/**
 * Chromium picks the Linux safeStorage backend from the desktop name alone
 * (see getSelectedStorageBackend in electron.d.ts). On a desktop it does not
 * know -- i3, LXQt, a remote session, deepin's newer "DDE" name -- it falls
 * back to basic_text even when the system's Secret Service (gnome-keyring) is
 * installed, and every credential store then refuses to persist
 * (safe-storage-backend.ts), so the login is not remembered. Point it at
 * gnome-libsecret in exactly that case.
 *
 * Nothing is chosen when:
 * - the user already passed --password-store;
 * - Chromium recognises the desktop: changing its backend would make files it
 *   encrypted earlier unreadable;
 * - there is any KDE hint, for the same reason with KWallet;
 * - no Secret Service is declared: libsecret could only fail there too.
 *
 * "Declared" means a D-Bus activation file for org.freedesktop.secrets, which
 * is how gnome-keyring registers itself. It is a file check rather than a bus
 * call because the switch must be set synchronously before `ready`, and a
 * child process there would hold up every launch. A provider that runs without
 * an activation file (KeePassXC) is not detected; the result is session-only
 * login, the same as before this switch existed.
 */
export type LinuxPasswordStore = 'gnome-libsecret'

export interface LinuxPasswordStoreInput {
  env: Readonly<Record<string, string | undefined>>
  /** `--password-store` is already on the command line. */
  explicit: boolean
  /** Whether a regular file exists at this absolute path. */
  isFile(filePath: string): boolean
}

// The XDG_CURRENT_DESKTOP names Chromium maps to a keyring backend itself,
// compared case-sensitively as Chromium does. KDE is handled separately.
const recognizedCurrentDesktops = new Set(['X-Cinnamon', 'Deepin', 'GNOME', 'Pantheon', 'XFCE', 'UKUI', 'Unity'])

function desktopTokens(value: string | undefined): string[] {
  return (value ?? '').split(':').map((token) => token.trim()).filter(Boolean)
}

function chromiumRecognizesDesktop(env: LinuxPasswordStoreInput['env']): boolean {
  if (desktopTokens(env.XDG_CURRENT_DESKTOP).some((token) => recognizedCurrentDesktops.has(token))) return true
  // Chromium's older fallbacks when XDG_CURRENT_DESKTOP names nothing it knows.
  const session = env.DESKTOP_SESSION ?? ''
  if (['deepin', 'gnome', 'mate', 'ukui', 'xubuntu'].includes(session) || session.includes('xfce')) return true
  return env.GNOME_DESKTOP_SESSION_ID !== undefined
}

function hasKdeHint(env: LinuxPasswordStoreInput['env']): boolean {
  return desktopTokens(env.XDG_CURRENT_DESKTOP).some((token) => /kde|plasma/i.test(token))
    || /kde|plasma/i.test(env.DESKTOP_SESSION ?? '')
    || env.KDE_FULL_SESSION !== undefined
    || env.KDE_SESSION_VERSION !== undefined
}

/** The session bus searches these for activation files (D-Bus spec, standard_session_servicedirs). */
export function secretServiceActivationFiles(env: LinuxPasswordStoreInput['env']): string[] {
  const dataDirectories = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')
  const directories = [...dataDirectories, '/usr/share'].filter((directory) => path.isAbsolute(directory))
  return [...new Set(directories.map((directory) => path.join(directory, 'dbus-1', 'services', 'org.freedesktop.secrets.service')))]
}

export function resolveLinuxPasswordStore(input: LinuxPasswordStoreInput): LinuxPasswordStore | null {
  if (input.explicit || chromiumRecognizesDesktop(input.env) || hasKdeHint(input.env)) return null
  return secretServiceActivationFiles(input.env).some((filePath) => input.isFile(filePath)) ? 'gnome-libsecret' : null
}

export function isRegularFile(filePath: string): boolean {
  try { return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() === true } catch { return false }
}
