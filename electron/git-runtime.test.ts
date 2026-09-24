import { describe, expect, it } from 'vitest'
import {
  gitHostPlatform,
  gitInstallGuidance,
  gitMissingFirstRunHint,
  gitMissingHomeNotice,
  gitMissingImpact,
  gitMissingNotice,
  gitWindowsDownloadUrl,
} from './git-runtime'

describe('git-runtime shared copy', () => {
  it('maps both process and capability platform spellings to three hosts', () => {
    expect(gitHostPlatform('win32')).toBe('windows')
    expect(gitHostPlatform('windows')).toBe('windows')
    expect(gitHostPlatform('darwin')).toBe('macos')
    expect(gitHostPlatform('macos')).toBe('macos')
    expect(gitHostPlatform('linux')).toBe('other')
  })

  it('points Windows at the in-app installer and macOS at xcode-select / Homebrew', () => {
    expect(gitInstallGuidance('win32')).toContain('「安装 Git」')
    expect(gitInstallGuidance('win32')).not.toContain(gitWindowsDownloadUrl)
    expect(gitInstallGuidance('darwin')).toContain('xcode-select --install')
    expect(gitInstallGuidance('darwin')).toContain('brew install git')
    expect(gitInstallGuidance('linux')).toContain('包管理器')
  })

  it('keeps shell jargon out of the customer-facing copy', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(gitMissingNotice(platform)).not.toMatch(/PowerShell|bash|PATH/)
    }
    expect(gitMissingImpact('win32')).toContain('Claude Code')
    expect(gitMissingImpact('darwin')).not.toContain('Claude Code')
  })

  it('builds a full notice that names the impact and the fix', () => {
    const notice = gitMissingNotice('win32')
    expect(notice).toContain('没有找到 Git')
    expect(notice).toContain('安装 Git')
    expect(notice).toContain('不用管理员权限')
  })

  it('keeps the first-run hint short and actionable', () => {
    const hint = gitMissingFirstRunHint('win32')
    expect(hint).toContain('建议先装')
    expect(hint).toContain('安装 Git')
  })

  it('tells Windows home-card readers to press the button right below', () => {
    expect(gitMissingHomeNotice('win32')).toContain('点下面的「安装 Git」')
    expect(gitMissingHomeNotice('win32')).not.toMatch(/PowerShell|bash|PATH|git-scm/)
    expect(gitMissingHomeNotice('darwin')).toBe(gitMissingNotice('darwin'))
  })
})
