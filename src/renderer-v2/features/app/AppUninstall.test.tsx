import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppUninstallDialog, AppUninstallRow, appUninstallNotice, appUninstallRemoveToolsWarning, appUninstallRowDescription, toolUninstallRowDescription } from './AppUninstall'

function dialog(overrides: Partial<Parameters<typeof AppUninstallDialog>[0]> = {}) {
  return renderToStaticMarkup(
    <AppUninstallDialog
      open
      clearRecords={false}
      removeTools={false}
      busy={false}
      error=""
      message=""
      onClearRecords={() => undefined}
      onRemoveTools={() => undefined}
      onConfirm={() => undefined}
      onClose={() => undefined}
      {...overrides}
    />,
  )
}

describe('app uninstall row', () => {
  it('offers a real uninstall on the Mac', () => {
    const markup = renderToStaticMarkup(
      <AppUninstallRow api={{ uninstallApp: async () => ({ trashed: true, leftovers: [] }) }} isMac />,
    )
    expect(markup).toContain('settings-app-uninstall-open')
    expect(markup).toContain('卸载星芒')
    expect(markup).toContain(appUninstallRowDescription)
    expect(markup).toContain('data-anchor="uninstall-app"')
    expect(markup).not.toContain('去安装卸载')
  })

  // 工具的卸载在首页卡片的「…」里，这一行只说星芒本身去哪儿卸（v4 批09），不再给「去安装卸载」。
  it('says where the app itself is removed on Windows without a button', () => {
    const markup = renderToStaticMarkup(
      <AppUninstallRow api={{ uninstallApp: async () => ({ trashed: true, leftovers: [] }) }} isMac={false} />,
    )
    expect(markup).toContain('卸载星芒')
    expect(markup).not.toContain('去安装卸载')
    expect(markup).toContain('data-anchor="uninstall"')
    expect(markup).toContain('请打开 Windows「设置 → 应用」，找到「星芒AI管理工具」并卸载，工具及其配置将保留')
    expect(markup).not.toContain('settings-app-uninstall-open')
    expect(markup).not.toContain('<button')
  })

  it('points Linux users at the system package manager instead of Windows settings', () => {
    const markup = renderToStaticMarkup(
      <AppUninstallRow api={{ uninstallApp: async () => ({ trashed: true, leftovers: [] }) }} isMac={false} isLinux />,
    )
    expect(markup).toContain('请使用系统软件管理器卸载星芒，工具及其配置将保留')
    expect(markup).not.toContain('Windows')
  })

  it('never names a site or technical term in the row text', () => {
    for (const text of [appUninstallRowDescription, toolUninstallRowDescription(false), toolUninstallRowDescription(true)])
      expect(text).not.toMatch(/solov|PATH|npm|钩子|hook/i)
  })
})

describe('app uninstall dialog', () => {
  it('leaves both extra clean-ups unticked by default', () => {
    const markup = dialog()
    expect(markup).toContain('卸载星芒')
    expect(markup).toContain('工具配置及 Claude Code、Codex 等工具均保留，可继续使用。卸载完成后星芒将退出。')
    expect(markup).toContain('同时清除登录记录和聊天记录')
    expect(markup).toContain('同时删除星芒安装的命令行工具')
    expect(markup).not.toContain('卸载并退出')
    expect(markup).not.toMatch(/type="checkbox"[^>]*checked/)
    expect(markup).not.toContain('app-uninstall-remove-tools-warning')
  })

  it('shows what the user ticked', () => {
    const markup = dialog({ clearRecords: true, removeTools: true })
    expect(markup.match(/checked=""/g)).toHaveLength(2)
  })

  // 勾了「同时删除…」才说会删掉哪些、删前先备份（macos-uninstall.ts 先跑 backupCliConfigs）。
  it('warns what the tool clean-up removes only once it is ticked', () => {
    const markup = dialog({ removeTools: true })
    expect(markup).toContain('data-testid="app-uninstall-remove-tools-warning"')
    expect(markup).toContain(appUninstallRemoveToolsWarning)
    expect(appUninstallRemoveToolsWarning).toContain('自行安装的不受影响')
  })

  // Mac 上 Grok 在 ~/.grok，removeMacManagedTools 不删它（0.2.24 深查 Mac M2 / 决定单 D8）：
  // 提醒不能再把 Grok 算进「会删掉」里，要说清楚这里不删、去哪儿删。
  it('does not promise to remove Grok and points to its own uninstall', () => {
    expect(appUninstallRemoveToolsWarning).toBe(
      '将删除由星芒安装的 Claude Code、Codex CLI，自行安装的不受影响。Grok CLI 位于个人文件夹，此处不删除；如需删除，请先在首页 Grok 卡片上点击「卸载工具」。删除前将自动备份配置。',
    )
    expect(appUninstallRemoveToolsWarning).not.toContain('Codex CLI、Grok CLI')
  })
})

describe('appUninstallNotice', () => {
  it('says nothing once the app is in the Trash', () => {
    expect(appUninstallNotice({ trashed: true, leftovers: ['records'] })).toBe('')
  })

  it('tells the user to drag it themselves when the Trash step failed', () => {
    expect(appUninstallNotice({ trashed: false, leftovers: [] })).toBe(
      '无法将星芒移至废纸篓。请退出星芒，在访达「应用程序」中将其拖入废纸篓。通知设置已移除。',
    )
    expect(appUninstallNotice({ trashed: false, leftovers: ['cli-hooks', 'records'] })).toContain(
      '另外，部分工具的通知设置未能移除、登录记录和聊天记录未清除。',
    )
  })
})
