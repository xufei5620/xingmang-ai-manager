import { describe, expect, it, vi } from 'vitest'
import { describeLinuxDesktopSession, linuxSystemName, parseOsRelease, readLinuxSystemName } from './linux-os-release'

// Copied from the systems the deb targets (os-release files as shipped).
const ubuntu = [
  'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
  'NAME="Ubuntu"',
  'VERSION_ID="24.04"',
  'VERSION="24.04.1 LTS (Noble Numbat)"',
  'ID=ubuntu',
  'ID_LIKE=debian',
].join('\n')
const debian = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n'
const uos = 'PRETTY_NAME=UnionTech OS Desktop 20 Pro\nNAME=uos\nVERSION_ID=20\nVERSION=20\nID=uos\n'
const kylin = 'NAME="Kylin"\nVERSION="银河麒麟桌面操作系统V10 (SP1)"\nVERSION_ID="v10"\nID=kylin\n'

describe('parseOsRelease', () => {
  it('reads quoted, single-quoted and bare values, skipping comments', () => {
    const fields = parseOsRelease('# comment\nA="x \\"y\\" \\$z"\nB=\'plain $v\'\nC=bare\nlowercase=no\n\nA=second')
    expect(fields.get('A')).toBe('x "y" $z')
    expect(fields.get('B')).toBe('plain $v')
    expect(fields.get('C')).toBe('bare')
    expect(fields.has('lowercase')).toBe(false)
  })
})

describe('linuxSystemName', () => {
  it('names each system the way its own settings page does', () => {
    expect(linuxSystemName(parseOsRelease(ubuntu))).toBe('Ubuntu 24.04.1 LTS')
    expect(linuxSystemName(parseOsRelease(debian))).toBe('Debian GNU/Linux 12 (bookworm)')
    expect(linuxSystemName(parseOsRelease(uos))).toBe('UnionTech OS Desktop 20 Pro')
    expect(linuxSystemName(parseOsRelease(kylin))).toBe('Kylin 银河麒麟桌面操作系统V10 (SP1)')
  })

  it('keeps only a short, plain name from what is still untrusted text', () => {
    expect(linuxSystemName(parseOsRelease('PRETTY_NAME="Evil <script>alert(1)</script>\\nline"'))).toBe('Evil script alert(1) /script nline')
    expect(linuxSystemName(parseOsRelease(`PRETTY_NAME="${'A'.repeat(200)}"`))).toHaveLength(48)
    expect(linuxSystemName(parseOsRelease('PRETTY_NAME="@@@"\nNAME=Fallback\nVERSION_ID=1'))).toBe('Fallback 1')
    expect(linuxSystemName(parseOsRelease('ID=nothing'))).toBeNull()
  })
})

describe('readLinuxSystemName', () => {
  it('resolves the /etc symlink first, because the bounded read refuses to follow links', async () => {
    const read = vi.fn(async () => ubuntu)
    const resolve = vi.fn(async () => '/usr/lib/os-release')
    await expect(readLinuxSystemName(read, resolve)).resolves.toBe('Ubuntu 24.04.1 LTS')
    expect(resolve).toHaveBeenCalledWith('/etc/os-release')
    expect(read).toHaveBeenCalledWith('/usr/lib/os-release', 8 * 1024, '系统版本信息')
  })

  it('falls back to /usr/lib/os-release when /etc/os-release is missing or names nothing', async () => {
    const missing = vi.fn(async (filePath: string) => {
      if (filePath === '/etc/os-release') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return filePath
    })
    await expect(readLinuxSystemName(async () => debian, missing)).resolves.toBe('Debian GNU/Linux 12 (bookworm)')
    const empty = vi.fn(async (filePath: string) => filePath === '/etc/os-release' ? 'ID=nothing' : uos)
    await expect(readLinuxSystemName(empty, async (filePath) => filePath)).resolves.toBe('UnionTech OS Desktop 20 Pro')
  })

  it('answers null instead of throwing when nothing can be read', async () => {
    await expect(readLinuxSystemName(async () => { throw new Error('EACCES') }, async (filePath) => filePath)).resolves.toBeNull()
    await expect(readLinuxSystemName(async () => ubuntu, async () => { throw new Error('ELOOP') })).resolves.toBeNull()
  })

  it.runIf(process.platform === 'linux')('reads this machine without throwing', async () => {
    const name = await readLinuxSystemName()
    expect(name === null || typeof name === 'string').toBe(true)
  })
})

describe('describeLinuxDesktopSession', () => {
  it('reports the desktop and display type by name only', () => {
    expect(describeLinuxDesktopSession({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', XDG_SESSION_TYPE: 'wayland' })).toEqual({ desktop: 'ubuntu:GNOME', sessionType: 'wayland' })
    expect(describeLinuxDesktopSession({ DESKTOP_SESSION: 'deepin', DISPLAY: ':0' })).toEqual({ desktop: 'deepin', sessionType: 'x11' })
    expect(describeLinuxDesktopSession({ WAYLAND_DISPLAY: 'wayland-0' })).toEqual({ desktop: null, sessionType: 'wayland' })
    expect(describeLinuxDesktopSession({})).toEqual({ desktop: null, sessionType: null })
    expect(describeLinuxDesktopSession({ XDG_CURRENT_DESKTOP: '/home/alice/$(rm -rf)' }).desktop).toBe('homealicerm-rf')
  })
})
