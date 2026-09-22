import { describe, expect, it } from 'vitest'
import { runtimeButtonLabel, runtimeHomebrewCommand, runtimeInstallGuide } from './runtime-install-guide'

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
