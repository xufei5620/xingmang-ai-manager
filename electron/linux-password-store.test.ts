import { describe, expect, it } from 'vitest'
import { resolveLinuxPasswordStore, secretServiceActivationFiles, type LinuxPasswordStoreInput } from './linux-password-store'

const gnomeKeyringFile = '/usr/share/dbus-1/services/org.freedesktop.secrets.service'

function input(env: LinuxPasswordStoreInput['env'], files: readonly string[] = [gnomeKeyringFile], explicit = false): LinuxPasswordStoreInput {
  return { env, explicit, isFile: (filePath) => files.includes(filePath) }
}

describe('linux password store selection', () => {
  it('uses the installed Secret Service on desktops Chromium does not recognise', () => {
    for (const env of [{}, { XDG_CURRENT_DESKTOP: 'i3' }, { XDG_CURRENT_DESKTOP: 'DDE' }, { XDG_CURRENT_DESKTOP: 'LXQt' }, { DESKTOP_SESSION: 'openbox' }]) {
      expect(resolveLinuxPasswordStore(input(env))).toBe('gnome-libsecret')
    }
  })

  it('leaves desktops Chromium already maps to a keyring alone', () => {
    // Changing the backend there would make files it encrypted earlier unreadable.
    for (const env of [
      { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, { XDG_CURRENT_DESKTOP: 'Deepin' }, { XDG_CURRENT_DESKTOP: 'UKUI' },
      { XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, { XDG_CURRENT_DESKTOP: 'XFCE' }, { XDG_CURRENT_DESKTOP: 'Unity' },
      { XDG_CURRENT_DESKTOP: 'Pantheon' }, { XDG_CURRENT_DESKTOP: 'MATE', DESKTOP_SESSION: 'mate' },
      { DESKTOP_SESSION: 'xubuntu' }, { DESKTOP_SESSION: 'deepin' }, { GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' },
    ]) {
      expect(resolveLinuxPasswordStore(input(env))).toBeNull()
    }
  })

  it('never moves a KDE session off KWallet', () => {
    for (const env of [
      { XDG_CURRENT_DESKTOP: 'KDE' }, { XDG_CURRENT_DESKTOP: 'plasma' }, { DESKTOP_SESSION: 'plasmawayland' },
      { DESKTOP_SESSION: 'kde-plasma' }, { KDE_FULL_SESSION: 'true' }, { KDE_SESSION_VERSION: '6' },
    ]) {
      expect(resolveLinuxPasswordStore(input(env))).toBeNull()
    }
  })

  it('respects a --password-store the user passed themselves', () => {
    expect(resolveLinuxPasswordStore(input({ XDG_CURRENT_DESKTOP: 'i3' }, [gnomeKeyringFile], true))).toBeNull()
  })

  it('does nothing when no Secret Service is declared', () => {
    expect(resolveLinuxPasswordStore(input({ XDG_CURRENT_DESKTOP: 'i3' }, []))).toBeNull()
  })

  it('finds the activation file the way the session bus does', () => {
    expect(secretServiceActivationFiles({})).toEqual([
      '/usr/local/share/dbus-1/services/org.freedesktop.secrets.service',
      gnomeKeyringFile,
    ])
    // Relative entries are ignored, /usr/share is always searched.
    expect(secretServiceActivationFiles({ XDG_DATA_DIRS: '/opt/share:relative/share' })).toEqual([
      '/opt/share/dbus-1/services/org.freedesktop.secrets.service',
      gnomeKeyringFile,
    ])
    expect(resolveLinuxPasswordStore(input({ XDG_DATA_DIRS: '/opt/share' }, ['/opt/share/dbus-1/services/org.freedesktop.secrets.service']))).toBe('gnome-libsecret')
  })
})
