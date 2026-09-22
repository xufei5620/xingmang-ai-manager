import { describe, expect, it } from 'vitest'
import {
  gitHostPlatform,
  gitInstallGuidance,
  gitMissingFirstRunHint,
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

  it('points Windows at the official download page and macOS at xcode-select / Homebrew', () => {
    expect(gitInstallGuidance('win32')).toContain(gitWindowsDownloadUrl)
    expect(gitInstallGuidance('darwin')).toContain('xcode-select --install')
    expect(gitInstallGuidance('darwin')).toContain('brew install git')
    expect(gitInstallGuidance('linux')).toContain('包管理器')
  })

  it('only claims the PowerShell fallback on Windows', () => {
    expect(gitMissingImpact('win32')).toContain('PowerShell')
    expect(gitMissingImpact('darwin')).not.toContain('PowerShell')
    expect(gitMissingImpact('linux')).not.toContain('PowerShell')
  })

  it('builds a full notice that names the impact and the fix', () => {
    const notice = gitMissingNotice('win32')
    expect(notice).toContain('没有找到 Git')
    expect(notice).toContain('PowerShell')
    expect(notice).toContain(gitWindowsDownloadUrl)
  })

  it('keeps the first-run hint short and actionable', () => {
    const hint = gitMissingFirstRunHint('win32')
    expect(hint).toContain('建议先装')
    expect(hint).toContain(gitWindowsDownloadUrl)
  })
})
