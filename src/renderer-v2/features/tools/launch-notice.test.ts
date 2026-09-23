import { describe, expect, it } from 'vitest'
import { launchWaitLabel, launchWarning } from './launch-notice'
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
})

describe('launchWaitLabel', () => {
  const names: Record<string, string> = { claude: 'Claude Code', workbuddy: 'WorkBuddy' }
  const nameOf = (key: string) => names[key]

  it('keeps the plain wording when nothing is queued ahead', () => {
    expect(launchWaitLabel({}, nameOf)).toBe('正在打开工具')
    expect(launchWaitLabel({ 'launch:codex': { label: '正在打开工具' } }, nameOf)).toBe('正在打开工具')
  })

  it('names the install the launch is waiting behind', () => {
    expect(launchWaitLabel({ claude: { label: '正在安装' } }, nameOf)).toBe('正在等 Claude Code 安装完，安装完马上打开')
    expect(launchWaitLabel({ workbuddy: { label: '正在安装' } }, nameOf)).toBe('正在等 WorkBuddy 安装完，安装完马上打开')
    expect(launchWaitLabel({ gemini: { label: '正在安装' } }, nameOf)).toBe('正在等 另一个工具 安装完，安装完马上打开')
  })

  it('says uninstall when an uninstall is ahead', () => {
    expect(launchWaitLabel({ claude: { label: '正在卸载' } }, nameOf)).toBe('正在等 Claude Code 卸载完，卸载完马上打开')
  })

  it('talks about the runtime rather than a tool while Node.js or Python is being prepared', () => {
    expect(launchWaitLabel({ node: { label: '正在准备运行环境' } }, nameOf)).toBe('正在等运行环境准备好，好了马上打开')
  })
})
