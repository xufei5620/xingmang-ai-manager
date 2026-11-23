import { describe, expect, it } from 'vitest'
import { antigravityCloseFirstNotice, antigravityInstallNotice, antigravityJobKey, antigravityProgressLabel, presentAntigravity } from './antigravity'
import { jobToolName } from './tool-jobs'

const status = { supported: true, cliInstalled: true, desktopInstalled: false, configured: true }

describe('renderer-v2 Antigravity cards', () => {
  it('shows no cards before the first check comes back or on a computer that cannot run Antigravity', () => {
    expect(presentAntigravity(null)).toEqual([])
    expect(presentAntigravity({ ...status, supported: false })).toEqual([])
  })

  it('gives the command line and the desktop app one card each, each with its own installed flag', () => {
    const cards = presentAntigravity(status)
    expect(cards.map((card) => [card.id, card.target, card.installed, card.configured])).toEqual([
      ['antigravityCli', 'cli', true, true],
      ['antigravity', 'desktop', false, true],
    ])
  })

  it('keys each job by its card so progress lands on the card that was clicked', () => {
    expect(antigravityJobKey('cli')).toBe('antigravityCli')
    expect(antigravityJobKey('desktop')).toBe('antigravity')
    expect(jobToolName('antigravityCli')).toBe('Antigravity 命令行')
    expect(jobToolName('antigravity')).toBe('Antigravity')
  })

  it('reuses the command-line install wording and only adds the settings step', () => {
    expect(antigravityProgressLabel({ phase: 'downloading' })).toBe('正在下载，首次下载可能需要几分钟，请勿关闭窗口…')
    expect(antigravityProgressLabel({ phase: 'verifying' })).toBe('正在校验下载文件的完整性…')
    expect(antigravityProgressLabel({ phase: 'installing' })).toBe('正在装到电脑上…')
    expect(antigravityProgressLabel({ phase: 'configuring' })).toBe('正在写入当前账号的连接设置…')
  })

  it('says the program is installed even when the settings could not be written, and why', () => {
    expect(antigravityInstallNotice('cli', {})).toEqual({ text: 'Antigravity 命令行已安装，并已关联当前账号', tone: 'ok' })
    expect(antigravityInstallNotice('desktop', { configureError: '服务暂时不可用，请稍后重试' }))
      .toEqual({ text: 'Antigravity 已安装。服务暂时不可用，请稍后重试', tone: 'warn' })
  })

  it('never names an environment variable, a site or a key in what it shows', () => {
    const shown = [antigravityCloseFirstNotice, ...(['downloading', 'verifying', 'installing', 'configuring'] as const).map((phase) => antigravityProgressLabel({ phase })),
      antigravityInstallNotice('cli', {}).text]
    for (const text of shown) expect(text).not.toMatch(/环境变量|AGY_|solov|Key|密钥/)
  })
})
