import { describe, expect, it } from 'vitest'
import {
  buildCanvasProjectFileOpenFailurePrompt,
  createCanvasProjectFileInbox,
  resolveCanvasProjectFileArgument,
  withoutCanvasProjectFileArguments,
} from './canvas-project-file-launch'

describe('canvas project file launch arguments', () => {
  it('takes the absolute path a file manager hands over on each system', () => {
    expect(resolveCanvasProjectFileArgument('C:\\Users\\客户\\Desktop\\样稿.xingcanvas', 'win32')).toBe('C:\\Users\\客户\\Desktop\\样稿.xingcanvas')
    expect(resolveCanvasProjectFileArgument('\\\\nas\\共享\\样稿.XingCanvas', 'win32')).toBe('\\\\nas\\共享\\样稿.XingCanvas')
    expect(resolveCanvasProjectFileArgument('/Users/kehu/Downloads/样稿.xingcanvas', 'darwin')).toBe('/Users/kehu/Downloads/样稿.xingcanvas')
    expect(resolveCanvasProjectFileArgument('/home/kehu/样稿.xingcanvas', 'linux')).toBe('/home/kehu/样稿.xingcanvas')
  })

  it('turns the file: URL a Linux desktop entry with %U may pass into a path', () => {
    expect(resolveCanvasProjectFileArgument('file:///home/kehu/%E6%A0%B7%E7%A8%BF.xingcanvas', 'linux')).toBe('/home/kehu/样稿.xingcanvas')
    expect(resolveCanvasProjectFileArgument('file://localhost/home/kehu/a.xingcanvas', 'linux')).toBe('/home/kehu/a.xingcanvas')
    expect(resolveCanvasProjectFileArgument('file://nas/home/kehu/a.xingcanvas', 'linux')).toBeNull()
    expect(resolveCanvasProjectFileArgument('file:///home/kehu/a.xingcanvas?x=1', 'linux')).toBeNull()
    expect(resolveCanvasProjectFileArgument('file:///home/kehu/a%00.xingcanvas', 'linux')).toBeNull()
    expect(resolveCanvasProjectFileArgument('file:///C:/a.xingcanvas', 'win32')).toBeNull()
    expect(resolveCanvasProjectFileArgument('file:///Users/a.xingcanvas', 'darwin')).toBeNull()
  })

  it.each([
    ['a Chromium switch', '--load-extension=C:\\a.xingcanvas', 'win32'],
    ['a relative path', 'Desktop\\a.xingcanvas', 'win32'],
    ['a drive-relative path', 'C:a.xingcanvas', 'win32'],
    ['a device path', '\\\\?\\C:\\a.xingcanvas', 'win32'],
    ['a device namespace', '\\\\.\\pipe\\a.xingcanvas', 'win32'],
    ['another extension', 'C:\\a.xingcanvas.exe', 'win32'],
    ['a deep link', 'xingmang://invite?code=a.xingcanvas', 'win32'],
    ['a relative POSIX path', 'a.xingcanvas', 'darwin'],
    ['a NUL byte', '/tmp/a\0.xingcanvas', 'linux'],
    ['an overlong argument', `/${'a'.repeat(40_000)}.xingcanvas`, 'linux'],
    ['the app itself', 'C:\\Program Files\\星芒AI管理工具\\星芒AI管理工具.exe', 'win32'],
  ] as const)('ignores %s', (_label, argument, platform) => {
    expect(resolveCanvasProjectFileArgument(argument, platform)).toBeNull()
  })

  it('ignores anything that is not a string', () => {
    expect(resolveCanvasProjectFileArgument(undefined, 'win32')).toBeNull()
    expect(resolveCanvasProjectFileArgument(42, 'linux')).toBeNull()
  })

  it('drops the project file from the arguments a relaunch carries, and nothing else', () => {
    expect(withoutCanvasProjectFileArguments(['--updated', 'C:\\a.xingcanvas', 'xingmang://pay', '--login-launch'], 'win32'))
      .toEqual(['--updated', 'xingmang://pay', '--login-launch'])
    expect(withoutCanvasProjectFileArguments(['.', '/home/a.xingcanvas'], 'linux')).toEqual(['.'])
  })
})

describe('canvas project file inbox', () => {
  it('keeps the latest file until it is taken, once', () => {
    let time = 0
    const inbox = createCanvasProjectFileInbox('win32', () => time)
    expect(inbox.accept('--updated')).toBe(false)
    expect(inbox.hasPending()).toBe(false)
    expect(inbox.accept('C:\\a.xingcanvas')).toBe(true)
    time = 5_000
    expect(inbox.accept('C:\\b.xingcanvas')).toBe(true)
    expect(inbox.hasPending()).toBe(true)
    expect(inbox.take()).toBe('C:\\b.xingcanvas')
    expect(inbox.take()).toBeNull()
    expect(inbox.hasPending()).toBe(false)
  })

  it('takes the same double-click once when it arrives twice', () => {
    let time = 0
    const inbox = createCanvasProjectFileInbox('darwin', () => time)
    expect(inbox.accept('/Users/a/样稿.xingcanvas')).toBe(true)
    expect(inbox.take()).toBe('/Users/a/样稿.xingcanvas')
    time = 500
    expect(inbox.accept('/Users/a/样稿.xingcanvas')).toBe(false)
    expect(inbox.take()).toBeNull()
    // Opening the same file again later is a new double-click.
    time = 10_000
    expect(inbox.accept('/Users/a/样稿.xingcanvas')).toBe(true)
  })

  it('forgets a file that waited ten minutes, so the canvas does not pop up long after', () => {
    let time = 0
    const inbox = createCanvasProjectFileInbox('linux', () => time)
    inbox.accept('/home/a.xingcanvas')
    time = 10 * 60_000
    expect(inbox.hasPending()).toBe(false)
    expect(inbox.take()).toBeNull()
    inbox.accept('/home/b.xingcanvas')
    time += 10 * 60_000
    expect(inbox.take()).toBeNull()
  })
})

describe('canvas project file open failure prompt', () => {
  it('passes on the plain Chinese reason the checks give', () => {
    expect(buildCanvasProjectFileOpenFailurePrompt(new Error('画布项目版本不受支持'))).toEqual({
      title: '没能打开画布项目',
      message: '没能打开这个画布项目文件。',
      detail: '画布项目版本不受支持',
      buttons: ['知道了'],
    })
  })

  it('keeps a raw system error, with its English code and full path, out of the box', () => {
    const missing = Object.assign(new Error("ENOENT: no such file or directory, lstat 'C:\\Users\\客户\\a.xingcanvas'"), { code: 'ENOENT' })
    const prompt = buildCanvasProjectFileOpenFailurePrompt(missing)
    expect(prompt.detail).toBe('读不到这个文件，可能已经移走、删掉了，或者星芒没有权限读它。')
    expect(JSON.stringify(prompt)).not.toContain('ENOENT')
    expect(buildCanvasProjectFileOpenFailurePrompt('boom').detail).toBe(prompt.detail)
  })
})
