import { describe, expect, it, vi } from 'vitest'
import { parseNameHasOwnerReply, probeLinuxTrayHost, statusNotifierWatcherName, trayHostProbeCommands } from './linux-tray-host'

describe('parseNameHasOwnerReply', () => {
  it('reads the dbus-send literal reply and the gdbus tuple', () => {
    expect(parseNameHasOwnerReply('   boolean true\n')).toBe(true)
    expect(parseNameHasOwnerReply('   boolean false\n')).toBe(false)
    expect(parseNameHasOwnerReply('(true,)\n')).toBe(true)
    expect(parseNameHasOwnerReply('(false,)')).toBe(false)
  })

  it('treats anything else as no answer', () => {
    for (const output of ['', 'true', 'boolean maybe', '(true)', 'Error org.freedesktop.DBus.Error.ServiceUnknown', 'boolean true\nboolean false']) {
      expect(parseNameHasOwnerReply(output)).toBeNull()
    }
  })
})

describe('probeLinuxTrayHost', () => {
  it('asks only fixed absolute programs a fixed question about the StatusNotifier watcher', () => {
    for (const command of trayHostProbeCommands) {
      expect(command.executable.startsWith('/usr/bin/')).toBe(true)
      expect(command.argv).toContain(command.executable.endsWith('dbus-send') ? `string:${statusNotifierWatcherName}` : statusNotifierWatcherName)
      expect(command.argv).toContain('--session')
    }
  })

  it('says there is a tray when the watcher has an owner', async () => {
    const execFile = vi.fn(async () => '   boolean true\n')
    await expect(probeLinuxTrayHost({ env: {}, isTrustedExecutable: () => true, execFile })).resolves.toBe(true)
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile).toHaveBeenCalledWith('/usr/bin/dbus-send', trayHostProbeCommands[0].argv, {})
  })

  it('says there is no tray on stock GNOME, where nobody owns the watcher', async () => {
    await expect(probeLinuxTrayHost({ env: {}, isTrustedExecutable: () => true, execFile: async () => '   boolean false' })).resolves.toBe(false)
  })

  it('falls back to gdbus when dbus-send is missing or untrusted', async () => {
    const execFile = vi.fn(async (executable: string) => {
      if (executable === '/usr/bin/dbus-send') throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      return '(true,)\n'
    })
    await expect(probeLinuxTrayHost({ env: {}, isTrustedExecutable: () => true, execFile })).resolves.toBe(true)
    expect(execFile).toHaveBeenCalledTimes(2)

    const untrusted = vi.fn(async () => '(true,)')
    await expect(probeLinuxTrayHost({ env: {}, isTrustedExecutable: (executable) => executable === '/usr/bin/gdbus', execFile: untrusted })).resolves.toBe(true)
    expect(untrusted).toHaveBeenCalledTimes(1)
    expect(untrusted).toHaveBeenCalledWith('/usr/bin/gdbus', trayHostProbeCommands[1].argv, {})
  })

  it('never runs a program it cannot trust and answers no when it cannot ask', async () => {
    const execFile = vi.fn(async () => '   boolean true')
    await expect(probeLinuxTrayHost({ env: {}, isTrustedExecutable: () => false, execFile })).resolves.toBe(false)
    await expect(probeLinuxTrayHost({ env: {}, isTrustedExecutable: () => { throw new Error('lstat failed') }, execFile })).resolves.toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('answers no without throwing when there is no session bus at all', async () => {
    await expect(probeLinuxTrayHost({ env: {}, isTrustedExecutable: () => true, execFile: async () => { throw new Error('Failed to open connection to session bus') } })).resolves.toBe(false)
    await expect(probeLinuxTrayHost({ env: {}, isTrustedExecutable: () => true, execFile: async () => 'unexpected' })).resolves.toBe(false)
  })
})
