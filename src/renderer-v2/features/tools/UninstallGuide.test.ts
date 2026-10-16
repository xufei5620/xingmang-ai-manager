import { describe, expect, it } from 'vitest'
import { buildUninstallGuide } from './UninstallGuide'

describe('buildUninstallGuide', () => {
  it('sends a Windows customer to the installed apps list under the name Windows shows', () => {
    expect(buildUninstallGuide('claudeDesktop', 'Claude Desktop', 'win')).toEqual({
      title: '怎么卸载 Claude Desktop',
      lead: 'Claude Desktop 要在系统里卸载：',
      steps: [
        '打开 Windows「设置 → 应用 → 已安装的应用」（Windows 10 上叫「应用和功能」）。',
        '找到 Claude，点右边的「…」→「卸载」（Windows 10 上先点它，再点「卸载」）。',
      ],
      after: '卸完回到星芒，点首页的「重新检测」。',
    })
    expect(buildUninstallGuide('opencode', 'OpenCode', 'win')?.steps[1]).toContain('找到 OpenCode，')
    expect(buildUninstallGuide('workbuddy', 'WorkBuddy', 'win')?.steps[1]).toContain('找到 WorkBuddy，')
  })

  it('has the Mac customer quit the app first and drag it to the Trash from Applications', () => {
    expect(buildUninstallGuide('opencode', 'OpenCode', 'mac')).toEqual({
      title: '怎么卸载 OpenCode',
      lead: 'OpenCode 要在系统里卸载：',
      steps: [
        '先退出 OpenCode（在它的窗口里按 ⌘Q）。',
        '打开访达，点左边的「应用程序」。',
        '找到 OpenCode，把它拖进废纸篓。',
      ],
      after: '删完回到星芒，点首页的「重新检测」。',
    })
  })

  it('names the Mac Codex desktop app ChatGPT, the name Finder shows', () => {
    const guide = buildUninstallGuide('codexDesktop', 'Codex 桌面端', 'mac')
    expect(guide?.title).toBe('怎么卸载 Codex 桌面端')
    expect(guide?.lead).toBe('Codex 桌面端要在系统里卸载：')
    expect(guide?.steps).toEqual([
      '先退出 ChatGPT（在它的窗口里按 ⌘Q）。',
      '打开访达，点左边的「应用程序」。',
      '找到 ChatGPT（Codex 桌面端在 Mac 上叫这个名字），把它拖进废纸篓。',
    ])
  })

  it('gives no guide where the app uninstalls it itself or does not list the card', () => {
    // Windows 上的 Codex 桌面端星芒自己卸；Linux 上这几张卡片都不列。
    expect(buildUninstallGuide('codexDesktop', 'Codex 桌面端', 'win')).toBeNull()
    expect(buildUninstallGuide('claudeDesktop', 'Claude Desktop', 'linux')).toBeNull()
    expect(buildUninstallGuide('codexDesktop', 'Codex 桌面端', 'linux')).toBeNull()
  })
})
