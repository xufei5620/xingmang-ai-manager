import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildLinuxAutostartEntry,
  createLinuxAutostart,
  inspectLinuxAutostartEntry,
  linuxAutostartDirectory,
  linuxAutostartFileName,
  quoteDesktopExecArgument,
} from './linux-autostart'

const executable = '/opt/xingmang-ai-manager/xingmang-ai-manager'
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function temporaryHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-autostart-'))
  temporaryRoots.push(root)
  return root
}

describe('linuxAutostartDirectory', () => {
  it('follows an absolute XDG_CONFIG_HOME and ignores a relative one, as the spec says', () => {
    expect(linuxAutostartDirectory({}, '/home/alice')).toBe('/home/alice/.config/autostart')
    expect(linuxAutostartDirectory({ XDG_CONFIG_HOME: '/data/conf' }, '/home/alice')).toBe('/data/conf/autostart')
    expect(linuxAutostartDirectory({ XDG_CONFIG_HOME: 'conf' }, '/home/alice')).toBe('/home/alice/.config/autostart')
    expect(linuxAutostartDirectory({ XDG_CONFIG_HOME: '  ' }, '/home/alice')).toBe('/home/alice/.config/autostart')
  })
})

describe('quoteDesktopExecArgument', () => {
  it('quotes the path and escapes what the Desktop Entry spec reserves', () => {
    expect(quoteDesktopExecArgument(executable)).toBe(`"${executable}"`)
    expect(quoteDesktopExecArgument('/opt/星芒 AI/run')).toBe('"/opt/星芒 AI/run"')
    // " ` $ \\ get a backslash, the general string escaping then doubles every backslash, % becomes %%.
    expect(quoteDesktopExecArgument('/a"b')).toBe('"/a\\\\"b"')
    expect(quoteDesktopExecArgument('/a$b`c')).toBe('"/a\\\\$b\\\\`c"')
    expect(quoteDesktopExecArgument('/a\\b')).toBe('"/a\\\\\\\\b"')
    expect(quoteDesktopExecArgument('/100%/run')).toBe('"/100%%/run"')
  })

  it('refuses a path with a line break or control character instead of encoding it', () => {
    expect(() => quoteDesktopExecArgument('/opt/a\nExec=/bin/evil')).toThrow('不能写进启动文件')
    expect(() => quoteDesktopExecArgument('/opt/a\u0007')).toThrow('不能写进启动文件')
  })
})

describe('buildLinuxAutostartEntry', () => {
  it('writes one launcher that starts this executable as a login launch', () => {
    const entry = buildLinuxAutostartEntry(executable)
    expect(entry.split('\n')).toEqual([
      '[Desktop Entry]',
      'Type=Application',
      'Version=1.0',
      'Name=星芒AI管理工具',
      'Comment=开机后自动打开星芒AI管理工具',
      `Exec="${executable}" --launched-at-login`,
      'Icon=xingmang-ai-manager',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ])
  })

  it('refuses a relative executable path', () => {
    expect(() => buildLinuxAutostartEntry('xingmang-ai-manager')).toThrow('绝对路径')
  })
})

describe('inspectLinuxAutostartEntry', () => {
  const entry = buildLinuxAutostartEntry(executable)

  it('reads a missing file as not requested', () => {
    expect(inspectLinuxAutostartEntry(null, executable)).toEqual({ requested: false, enabled: false })
  })

  it('reads its own file as requested and enabled', () => {
    expect(inspectLinuxAutostartEntry(entry, executable)).toEqual({ requested: true, enabled: true })
    expect(inspectLinuxAutostartEntry(entry.replace(/\n/g, '\r\n'), executable)).toEqual({ requested: true, enabled: true })
  })

  it('reports a file the desktop switched off, or that points at another install, as requested but not enabled', () => {
    expect(inspectLinuxAutostartEntry(`${entry}Hidden=true\n`, executable)).toEqual({ requested: true, enabled: false })
    expect(inspectLinuxAutostartEntry(entry.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'), executable)).toEqual({ requested: true, enabled: false })
    expect(inspectLinuxAutostartEntry(entry, '/home/alice/old/xingmang-ai-manager')).toEqual({ requested: true, enabled: false })
    expect(inspectLinuxAutostartEntry('[Desktop Entry]\nExec=/usr/bin/evil\n', executable)).toEqual({ requested: true, enabled: false })
  })

  it('only reads keys from the Desktop Entry group', () => {
    expect(inspectLinuxAutostartEntry(`${entry}[Desktop Action other]\nHidden=true\n`, executable)).toEqual({ requested: true, enabled: true })
  })
})

describe.runIf(process.platform === 'linux')('createLinuxAutostart', () => {
  it('writes, reads back and removes the launcher under XDG_CONFIG_HOME', async () => {
    const home = temporaryHome()
    const autostart = createLinuxAutostart({ env: {}, executablePath: executable, homeDirectory: home })
    const filePath = path.join(home, '.config', 'autostart', linuxAutostartFileName)
    expect(autostart.inspect()).toEqual({ requested: false, enabled: false })

    await autostart.set(true)
    expect(fs.readFileSync(filePath, 'utf8')).toBe(buildLinuxAutostartEntry(executable))
    expect(autostart.inspect()).toEqual({ requested: true, enabled: true })

    await autostart.set(false)
    expect(fs.existsSync(filePath)).toBe(false)
    expect(autostart.inspect()).toEqual({ requested: false, enabled: false })
    // Turning it off twice is not an error.
    await autostart.set(false)
  })

  it('repairs a launcher the desktop switched off when the switch is turned on again', async () => {
    const home = temporaryHome()
    const autostart = createLinuxAutostart({ env: {}, executablePath: executable, homeDirectory: home })
    await autostart.set(true)
    const filePath = path.join(home, '.config', 'autostart', linuxAutostartFileName)
    fs.appendFileSync(filePath, 'Hidden=true\n')
    expect(autostart.inspect()).toEqual({ requested: true, enabled: false })
    await autostart.set(true)
    expect(autostart.inspect()).toEqual({ requested: true, enabled: true })
  })

  it('will not follow a symbolic link planted where the launcher goes (I8)', async () => {
    const home = temporaryHome()
    const directory = path.join(home, '.config', 'autostart')
    fs.mkdirSync(directory, { recursive: true })
    const victim = path.join(home, 'victim.txt')
    fs.writeFileSync(victim, 'keep me')
    fs.symlinkSync(victim, path.join(directory, linuxAutostartFileName))
    const autostart = createLinuxAutostart({ env: {}, executablePath: executable, homeDirectory: home })

    expect(autostart.inspect()).toEqual({ requested: false, enabled: false })
    await expect(autostart.set(true)).rejects.toThrow()
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me')
  })

  it('will not write through a symbolic-linked autostart directory', async () => {
    const home = temporaryHome()
    const elsewhere = path.join(home, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.mkdirSync(path.join(home, '.config'))
    fs.symlinkSync(elsewhere, path.join(home, '.config', 'autostart'))
    const autostart = createLinuxAutostart({ env: {}, executablePath: executable, homeDirectory: home })

    await expect(autostart.set(true)).rejects.toThrow()
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })
})
