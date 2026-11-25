import { describe, expect, it } from 'vitest'
import { antigravityCloseFirstNotice, antigravityInstallNotice, antigravityJobKey, antigravityProgressLabel, antigravityWorkspaceGoneNotice, openAntigravityCliIn, presentAntigravity, type AntigravityCliOpenSteps } from './antigravity'
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
    const shown = [antigravityCloseFirstNotice, antigravityWorkspaceGoneNotice, ...(['downloading', 'verifying', 'installing', 'configuring'] as const).map((phase) => antigravityProgressLabel({ phase })),
      antigravityInstallNotice('cli', {}).text]
    for (const text of shown) expect(text).not.toMatch(/环境变量|AGY_|solov|Key|密钥/)
  })
})

// 记住的项目文件夹被删掉、改了名，主进程打开前报的那一句（antigravity-service.ts 的 openCli）。
const gone = new Error('项目文件夹不存在，请重新选择')

function recordingSteps(options: { missing?: readonly string[]; choice?: string | null; current?: () => boolean } = {}) {
  const events: string[] = []
  const steps: AntigravityCliOpenSteps = {
    async choose() { events.push('choose'); return options.choice === undefined ? 'C:\\Selected Project' : options.choice },
    async open(workspace) {
      events.push(`open ${workspace}`)
      if (options.missing?.includes(workspace)) throw gone
      return true
    },
    current: options.current ?? (() => true),
    missing() { events.push('missing') },
    chosen(workspace) { events.push(`chosen ${workspace}`) },
  }
  return { events, steps }
}

describe('renderer-v2 Antigravity command line folder', () => {
  it('opens straight in the remembered folder without asking', async () => {
    const { events, steps } = recordingSteps()
    await expect(openAntigravityCliIn('C:\\work\\app', steps)).resolves.toBe(true)
    expect(events).toEqual(['open C:\\work\\app'])
  })

  it('asks for a folder when none is remembered or another one was asked for', async () => {
    const { events, steps } = recordingSteps()
    await expect(openAntigravityCliIn(undefined, steps)).resolves.toBe(true)
    expect(events).toEqual(['choose', 'chosen C:\\Selected Project', 'open C:\\Selected Project'])
  })

  it('says the remembered folder is gone and opens in the one picked instead of failing', async () => {
    const { events, steps } = recordingSteps({ missing: ['C:\\work\\deleted'] })
    await expect(openAntigravityCliIn('C:\\work\\deleted', steps)).resolves.toBe(true)
    expect(events).toEqual(['open C:\\work\\deleted', 'missing', 'choose', 'chosen C:\\Selected Project', 'open C:\\Selected Project'])
  })

  it('also recognises the older wording for a missing folder', async () => {
    const { events, steps } = recordingSteps()
    steps.open = async (workspace) => {
      events.push(`open ${workspace}`)
      if (workspace === 'C:\\old') throw new Error('工作目录不存在，请重新选择')
      return true
    }
    await expect(openAntigravityCliIn('C:\\old', steps)).resolves.toBe(true)
    expect(events).toContain('missing')
  })

  it('stops quietly when the picker is closed after the remembered folder turned out to be gone', async () => {
    const { events, steps } = recordingSteps({ missing: ['C:\\work\\deleted'], choice: null })
    await expect(openAntigravityCliIn('C:\\work\\deleted', steps)).resolves.toBe(false)
    expect(events).toEqual(['open C:\\work\\deleted', 'missing', 'choose'])
  })

  it('passes any other failure through to the error dialog', async () => {
    const { events, steps } = recordingSteps()
    const refused = new Error('已安装的 Antigravity 命令行不是 Google 官方签名版本，星芒不会打开它')
    steps.open = async (workspace) => { events.push(`open ${workspace}`); throw refused }
    await expect(openAntigravityCliIn('C:\\work\\app', steps)).rejects.toBe(refused)
    expect(events).toEqual(['open C:\\work\\app'])
  })

  it('does not pop up a picker for a click that no longer counts', async () => {
    const { events, steps } = recordingSteps({ missing: ['C:\\work\\deleted'], current: () => false })
    await expect(openAntigravityCliIn('C:\\work\\deleted', steps)).rejects.toBe(gone)
    expect(events).toEqual(['open C:\\work\\deleted'])
  })

  it('does not open in the picked folder once the account changed while the picker was up', async () => {
    let live = true
    const { events, steps } = recordingSteps({ current: () => live })
    steps.choose = async () => { events.push('choose'); live = false; return 'C:\\Selected Project' }
    await expect(openAntigravityCliIn(undefined, steps)).resolves.toBe(false)
    expect(events).toEqual(['choose'])
  })
})
