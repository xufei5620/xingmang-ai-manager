import { describe, expect, it } from 'vitest'
import { clientLaunchProgressLabel, clientLaunchWaitLabel, externalLaunchWarning, launchDeclined, launchWaitLabel, launchWarning, logoutJobsNote, resumeSessionNotice } from './launch-notice'
import type { DesktopAppStatus } from '../../../../electron/ipc-contract'

const status = { installed: true } as DesktopAppStatus

describe('launchWarning', () => {
  it('stays quiet when the launch reports nothing', () => {
    expect(launchWarning(undefined)).toBeNull()
    expect(launchWarning({})).toBeNull()
    expect(launchWarning({ restarted: false, status })).toBeNull()
    expect(launchWarning({ restarted: false, status, chineseLocale: { status: 'verified' } })).toBeNull()
  })

  it('surfaces an unconfirmed Codex Desktop Chinese locale', () => {
    expect(launchWarning({ restarted: false, status, chineseLocale: { status: 'failed', message: '中文界面没生效' } }))
      .toBe('中文界面没生效')
    expect(launchWarning({ restarted: false, status, chineseLocale: { status: 'restart-required' } }))
      .toBe('Codex 已打开，中文界面尚未确认生效，请在配置中再次启用。')
  })

  it('surfaces a workspace setting that overrides the current account', () => {
    expect(launchWarning({ configOverrideNotice: '这个项目文件夹里有自己的设置' })).toBe('这个项目文件夹里有自己的设置')
  })

  // D17：打开前试写不进去，照样打开，首页说这一句。
  it('says the folder can only be read when the launch found it refuses writes', () => {
    expect(launchWarning({ workspaceReadOnly: true })).toBe('该文件夹为只读，AI 无法修改其中的文件，建议更换文件夹。')
    expect(launchWarning({ workspaceReadOnly: false })).toBeNull()
  })

  it('says both when a read-only folder also carries settings that override the account', () => {
    expect(launchWarning({ workspaceReadOnly: true, configOverrideNotice: '这个项目文件夹里有自己的设置。' }))
      .toBe('该文件夹为只读，AI 无法修改其中的文件，建议更换文件夹。这个项目文件夹里有自己的设置。')
  })
})

describe('launchDeclined', () => {
  it('only treats an explicit decline as not opened', () => {
    expect(launchDeclined({ declined: true })).toBe(true)
    expect(launchDeclined(undefined)).toBe(false)
    expect(launchDeclined({})).toBe(false)
    expect(launchDeclined({ declined: false })).toBe(false)
    expect(launchDeclined({ restarted: false, status })).toBe(false)
  })
})

describe('resumeSessionNotice', () => {
  it('says nothing when the user chose not to open the folder', () => {
    expect(resumeSessionNotice({ declined: true }, 'Claude Code', 'C:\\work')).toBeNull()
  })

  it('confirms the resume, with the override reminder when there is one', () => {
    expect(resumeSessionNotice({}, 'Claude Code', 'C:\\work')).toBe('已打开Claude Code，在 C:\\work 中继续这次对话')
    expect(resumeSessionNotice(undefined, 'Codex', 'D:\\app')).toBe('已打开Codex，在 D:\\app 中继续这次对话')
    expect(resumeSessionNotice({ configOverrideNotice: '这个项目文件夹里有自己的设置' }, 'Codex', 'D:\\app'))
      .toBe('已打开Codex，在 D:\\app 中继续这次对话。这个项目文件夹里有自己的设置')
  })
})

describe('launchWaitLabel', () => {
  const names: Record<string, string> = { claude: 'Claude Code', workbuddy: 'WorkBuddy' }
  const nameOf = (key: string) => names[key]

  it('keeps the plain wording when nothing is queued ahead', () => {
    expect(launchWaitLabel({}, nameOf)).toBe('正在打开工具')
    expect(launchWaitLabel({ 'launch:codex': { label: '正在打开工具' } }, nameOf)).toBe('正在打开工具')
  })

  it('lets desktop clients keep their own wording when nothing is queued ahead', () => {
    expect(launchWaitLabel({}, nameOf, '正在打开客户端')).toBe('正在打开客户端')
    expect(launchWaitLabel({ 'launch:claude': { label: '正在打开工具' } }, nameOf, '正在打开客户端')).toBe('正在打开客户端')
  })

  it('names the install a desktop client launch is waiting behind', () => {
    expect(launchWaitLabel({ claude: { label: '正在安装' } }, nameOf, '正在打开客户端')).toBe('正在等待 Claude Code 安装完成，完成后将立即打开')
    expect(launchWaitLabel({ 'launch:opencode': { label: '正在打开客户端' }, workbuddy: { label: '正在安装' } }, nameOf, '正在打开客户端'))
      .toBe('正在等待 WorkBuddy 安装完成，完成后将立即打开')
  })

  it('does not claim to wait for account switches or reminder repairs, which never join the install queue', () => {
    expect(launchWaitLabel({ 'switch:claude': { label: '正在改用当前账号' } }, nameOf)).toBe('正在打开工具')
    expect(launchWaitLabel({ 'repair-hooks:codex': { label: '正在修提醒设置' } }, nameOf, '正在打开客户端')).toBe('正在打开客户端')
    expect(launchWaitLabel({ 'repair-config:codex': { label: 'Codex 无法读取此配置，打开时将报错。修复前将先备份，历史会话保留' } }, nameOf)).toBe('正在打开工具')
    expect(launchWaitLabel({ 'switch:claude': { label: '正在切回官方账号' }, workbuddy: { label: '正在安装' } }, nameOf))
      .toBe('正在等待 WorkBuddy 安装完成，完成后将立即打开')
  })

  it('names the install the launch is waiting behind', () => {
    expect(launchWaitLabel({ claude: { label: '正在安装' } }, nameOf)).toBe('正在等待 Claude Code 安装完成，完成后将立即打开')
    expect(launchWaitLabel({ workbuddy: { label: '正在安装' } }, nameOf)).toBe('正在等待 WorkBuddy 安装完成，完成后将立即打开')
    expect(launchWaitLabel({ gemini: { label: '正在安装' } }, nameOf)).toBe('正在等待 另一个工具 安装完成，完成后将立即打开')
  })

  it('says uninstall when an uninstall is ahead', () => {
    expect(launchWaitLabel({ claude: { label: '正在卸载' } }, nameOf)).toBe('正在等待 Claude Code 卸载完成，完成后将立即打开')
  })

  it('talks about the runtime rather than a tool while Node.js, Python or Git is being prepared', () => {
    expect(launchWaitLabel({ node: { label: '正在准备运行环境' } }, nameOf)).toBe('正在等待运行环境准备完成，完成后将立即打开')
    expect(launchWaitLabel({ python: { label: '正在准备运行环境' } }, nameOf, '正在打开客户端')).toBe('正在等待运行环境准备完成，完成后将立即打开')
    expect(launchWaitLabel({ git: { label: '正在准备安装 Git' } }, nameOf)).toBe('正在等待运行环境准备完成，完成后将立即打开')
  })
})

describe('clientLaunchWaitLabel', () => {
  const names: Record<string, string> = { claude: 'Claude Code', claudeDesktop: 'Claude Desktop', workbuddy: 'WorkBuddy' }
  const nameOf = (key: string) => names[key]

  it('does not claim to wait for another tool being installed, since a desktop client no longer queues behind it', () => {
    expect(clientLaunchWaitLabel({ claude: { label: '正在安装' } }, 'claudeDesktop', nameOf)).toBe('正在打开客户端')
    expect(clientLaunchWaitLabel({ git: { label: '正在准备安装 Git' }, workbuddy: { label: '正在安装' } }, 'claudeDesktop', nameOf)).toBe('正在打开客户端')
    expect(clientLaunchWaitLabel({}, 'opencode', nameOf)).toBe('正在打开客户端')
  })

  it('names the client\'s own install when that is what the launch waits for', () => {
    expect(clientLaunchWaitLabel({ claude: { label: '正在安装' }, workbuddy: { label: '正在下载' } }, 'workbuddy', nameOf))
      .toBe('正在等待 WorkBuddy 安装完成，完成后将立即打开')
  })
})

describe('logoutJobsNote', () => {
  const names: Record<string, string> = { claude: 'Claude Code', workbuddy: 'WorkBuddy' }
  const nameOf = (key: string) => names[key]

  it('stays empty when nothing is installing, so the logout prompt keeps its single sentence', () => {
    expect(logoutJobsNote({}, nameOf)).toBe('')
    expect(logoutJobsNote({ 'launch:claude': {}, 'switch:workbuddy': {}, 'repair-hooks:codex': {}, 'repair-config:claude': {} }, nameOf)).toBe('')
  })

  it('names what keeps installing, runtimes included, joined with the Chinese list comma', () => {
    expect(logoutJobsNote({ claude: {} }, nameOf)).toBe('正在安装的 Claude Code 将继续完成安装。')
    expect(logoutJobsNote({ claude: {}, node: {} }, nameOf)).toBe('正在安装的 Claude Code、Node.js 将继续完成安装。')
    expect(logoutJobsNote({ codexDesktop: {} }, (key) => key === 'codexDesktop' ? 'Codex 桌面端' : undefined)).toBe('正在安装的 Codex 桌面端将继续完成安装。')
  })

  it('says uninstalls finish separately and skips keys it cannot name', () => {
    expect(logoutJobsNote({ claude: {}, workbuddy: { kind: 'uninstall' }, mystery: {} }, nameOf))
      .toBe('正在安装的 Claude Code 将继续完成安装。正在卸载的 WorkBuddy 将继续完成卸载。')
  })
})

describe('clientLaunchProgressLabel', () => {
  it('says Claude Desktop is getting its program, with the percent while it is known', () => {
    expect(clientLaunchProgressLabel({ tool: 'claudeDesktop', phase: 'downloading', percent: 35 }))
      .toBe('正在为 Claude Desktop 准备聊天所需程序（35%），完成后将立即打开')
    expect(clientLaunchProgressLabel({ tool: 'claudeDesktop', phase: 'downloading', percent: null }))
      .toBe('正在为 Claude Desktop 准备聊天所需程序，完成后将立即打开')
    expect(clientLaunchProgressLabel({ tool: 'claudeDesktop', phase: 'placing', percent: null }))
      .toBe('正在为 Claude Desktop 准备聊天所需程序，完成后将立即打开')
  })
})

describe('externalLaunchWarning', () => {
  it('tells an elevated 星芒 how to let Claude Desktop get its program, and says nothing otherwise', () => {
    expect(externalLaunchWarning({ preparationSkipped: 'elevated' }))
      .toBe('星芒当前以管理员身份运行，无法为 Claude Desktop 准备程序。请关闭星芒后直接双击打开，再点击「打开」。')
    expect(externalLaunchWarning({})).toBeNull()
    expect(externalLaunchWarning(undefined)).toBeNull()
  })
})
