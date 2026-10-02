import { describe, expect, it } from 'vitest'
import { linuxPythonInstallCommand, managedRuntimeNotice, runtimeButtonLabel, runtimeHomebrewCommand, runtimeInstallButtonShown, runtimeInstallGuide } from './runtime-install-guide'

describe('runtimeButtonLabel', () => {
  it('keeps the old wording where the app installs the runtime itself', () => {
    expect(runtimeButtonLabel('node', 'managed')).toBe('准备 Node.js')
    expect(runtimeButtonLabel('python', 'managed')).toBe('装 Python（可选环境）')
  })

  it('says the button opens a download page where the customer installs it', () => {
    expect(runtimeButtonLabel('node', 'external')).toBe('去官网下载 Node.js')
    expect(runtimeButtonLabel('python', 'external')).toBe('去官网下载 Python（可选环境）')
  })

  it('falls back to the managed wording before the snapshot arrives', () => {
    expect(runtimeButtonLabel('node', undefined)).toBe('准备 Node.js')
  })
})

describe('runtimeInstallGuide', () => {
  it('adds nothing on a platform where the app installs the runtime', () => {
    expect(runtimeInstallGuide('node', 'windows', 'managed')).toBeNull()
    expect(runtimeInstallGuide('python', 'windows', 'managed')).toBeNull()
    expect(runtimeInstallGuide('node', undefined, undefined)).toBeNull()
  })

  it('gives macOS both routes plus the copyable Homebrew command', () => {
    const guide = runtimeInstallGuide('node', 'macos', 'external')
    expect(guide?.command).toBe(runtimeHomebrewCommand('node'))
    expect(guide?.summary).toContain('这台 Mac 上没有找到 Node.js')
    expect(guide?.steps.length).toBe(3)
    expect(guide?.steps[0]).toContain('Homebrew')
    // 第二条要和按钮上写的字一模一样，否则用户照着找不到那颗按钮。
    expect(guide?.steps[1]).toContain(`「${runtimeButtonLabel('node', 'external')}」`)
    expect(guide?.steps[1]).toContain('.pkg')
  })

  it('always closes with where to come back and confirm it worked', () => {
    for (const runtime of ['node', 'python'] as const) {
      const guide = runtimeInstallGuide(runtime, 'macos', 'external')
      expect(guide?.steps.at(-1)).toContain('重新检测')
    }
  })

  it('says why Python is worth installing on a Mac that already ships one', () => {
    const guide = runtimeInstallGuide('python', 'macos', 'external')
    expect(guide?.summary).toContain('Gemini CLI')
    expect(guide?.summary).toContain('版本可能过旧')
    expect(guide?.command).toBe('brew install python')
  })

  it('drops the Homebrew line on other external platforms rather than suggesting a wrong command', () => {
    const guide = runtimeInstallGuide('node', 'linux', 'external')
    expect(guide?.command).toBeNull()
    expect(guide?.steps.join('')).not.toContain('brew')
  })
})

describe('Python on Linux', () => {
  it('says no CLI needs it and gives the apt command instead of a website or the Mac chapter', () => {
    const guide = runtimeInstallGuide('python', 'linux', 'external')
    expect(guide?.summary).toBe('这台电脑上没有找到 Python。四个命令行工具都用不到它，不装也没关系。')
    expect(guide?.command).toBe(linuxPythonInstallCommand)
    expect(guide?.command).toBe('sudo apt install python3')
    expect(guide?.noTutorial).toBe(true)
    const text = [guide?.summary, ...(guide?.steps ?? [])].join('')
    expect(text).not.toMatch(/官网|brew|macOS|Gemini|PATH|npm|环境变量/)
  })

  it('hides the python.org button on Linux only', () => {
    expect(runtimeInstallButtonShown('python', 'linux', 'external')).toBe(false)
    expect(runtimeInstallButtonShown('python', 'macos', 'external')).toBe(true)
    expect(runtimeInstallButtonShown('python', 'windows', 'managed')).toBe(true)
    expect(runtimeInstallButtonShown('node', 'linux', 'managed')).toBe(true)
    expect(runtimeInstallButtonShown('node', 'linux', 'external')).toBe(true)
  })

  it('leaves the Mac guide pointing at its tutorial chapter', () => {
    expect(runtimeInstallGuide('python', 'macos', 'external')?.noTutorial).toBeUndefined()
    expect(runtimeInstallGuide('node', 'macos', 'external')?.noTutorial).toBeUndefined()
  })
})

describe('managedRuntimeNotice', () => {
  it('keeps the macOS sentence exactly as it was', () => {
    expect(managedRuntimeNotice('node', 'macos', 'managed')).toBe('这台 Mac 上还没有 Node.js，四个命令行工具都靠它来安装和启动。点「准备 Node.js」，星芒会下载官方版本放在自己的文件夹里，不用输开机密码，也不影响电脑上别的软件。')
  })

  it('tells Linux customers the app prepares Node.js itself instead of sending them to a website', () => {
    const notice = managedRuntimeNotice('node', 'linux', 'managed')
    expect(notice).toBe('这台电脑上还没有能用的 Node.js，四个命令行工具都靠它来安装和启动。点「准备 Node.js」，星芒会下载官方版本放在自己的文件夹里，不用输开机密码，也不影响电脑上别的软件。')
    expect(notice).not.toContain('官网')
  })

  it('says nothing where Windows has its own elevation notice, or where the customer installs it', () => {
    expect(managedRuntimeNotice('node', 'windows', 'managed')).toBeNull()
    expect(managedRuntimeNotice('node', 'linux', 'external')).toBeNull()
    expect(managedRuntimeNotice('python', 'linux', 'managed')).toBeNull()
    expect(managedRuntimeNotice('node', undefined, undefined)).toBeNull()
  })
})
