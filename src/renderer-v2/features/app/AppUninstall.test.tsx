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
    expect(markup).toContain('打开 Windows「设置 → 应用」，找到「星芒AI管理工具」卸载；工具和它们的配置会保留')
    expect(markup).not.toContain('settings-app-uninstall-open')
    expect(markup).not.toContain('<button')
  })

  it('points Linux users at the system package manager instead of Windows settings', () => {
    const markup = renderToStaticMarkup(
      <AppUninstallRow api={{ uninstallApp: async () => ({ trashed: true, leftovers: [] }) }} isMac={false} isLinux />,
    )
    expect(markup).toContain('用系统的软件管理器卸载星芒；工具和它们的配置会保留')
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
    expect(markup).toContain('工具的配置会保留，Claude Code、Codex 这些工具也会留着，照样能用。卸完星芒会退出。')
    expect(markup).toContain('同时清除登录记录和聊天记录')
    expect(markup).toContain('连同星芒替你装的命令行工具一起删')
    expect(markup).not.toContain('卸载并退出')
    expect(markup).not.toMatch(/type="checkbox"[^>]*checked/)
    expect(markup).not.toContain('app-uninstall-remove-tools-warning')
  })

  it('shows what the user ticked', () => {
    const markup = dialog({ clearRecords: true, removeTools: true })
    expect(markup.match(/checked=""/g)).toHaveLength(2)
  })

  // 勾了「连同…一起删」才说会删掉哪些、删前先备份（macos-uninstall.ts 先跑 backupCliConfigs）。
  it('warns what the tool clean-up removes only once it is ticked', () => {
    const markup = dialog({ removeTools: true })
    expect(markup).toContain('data-testid="app-uninstall-remove-tools-warning"')
    expect(markup).toContain(appUninstallRemoveToolsWarning)
    expect(appUninstallRemoveToolsWarning).toContain('你自己装的不动')
  })
})

describe('appUninstallNotice', () => {
  it('says nothing once the app is in the Trash', () => {
    expect(appUninstallNotice({ trashed: true, leftovers: ['records'] })).toBe('')
  })

  it('tells the user to drag it themselves when the Trash step failed', () => {
    expect(appUninstallNotice({ trashed: false, leftovers: [] })).toBe(
      '没能把星芒移到废纸篓。请退出星芒，在访达的「应用程序」里把它拖进废纸篓。提醒设置已经收回了。',
    )
    expect(appUninstallNotice({ trashed: false, leftovers: ['cli-hooks', 'records'] })).toContain(
      '另外，有工具里的提醒设置没收回来、登录记录和聊天记录没有清除。',
    )
  })
})
