import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppUninstallDialog, AppUninstallRow, appUninstallNotice, appUninstallRowDescription, toolUninstallRowDescription } from './AppUninstall'

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
      <AppUninstallRow api={{ uninstallApp: async () => ({ trashed: true, leftovers: [] }) }} isMac openMaintenance={() => undefined} />,
    )
    expect(markup).toContain('settings-app-uninstall-open')
    expect(markup).toContain('卸载星芒')
    expect(markup).toContain(appUninstallRowDescription)
    expect(markup).toContain('data-anchor="uninstall-app"')
    expect(markup).not.toContain('去安装卸载')
  })

  it('keeps the tool uninstall page elsewhere and says where the app itself is removed on Windows', () => {
    const markup = renderToStaticMarkup(
      <AppUninstallRow api={{ uninstallApp: async () => ({ trashed: true, leftovers: [] }) }} isMac={false} openMaintenance={() => undefined} />,
    )
    expect(markup).toContain('卸载工具或星芒')
    expect(markup).toContain('去安装卸载')
    expect(markup).toContain('data-anchor="uninstall"')
    expect(markup).toContain('打开 Windows「设置 → 应用」，找到「星芒AI管理工具」卸载')
    expect(markup).not.toContain('settings-app-uninstall-open')
  })

  it('points Linux users at the system package manager instead of Windows settings', () => {
    const markup = renderToStaticMarkup(
      <AppUninstallRow api={{ uninstallApp: async () => ({ trashed: true, leftovers: [] }) }} isMac={false} isLinux openMaintenance={() => undefined} />,
    )
    expect(markup).toContain('要卸载星芒本身，用系统的软件管理器')
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
    expect(markup).toContain('卸载星芒AI管理工具')
    expect(markup).toContain('同时清除登录记录和聊天记录')
    expect(markup).toContain('连同星芒替你装的命令行工具一起删')
    expect(markup).toContain('卸载并退出')
    expect(markup).not.toMatch(/type="checkbox"[^>]*checked/)
  })

  it('shows what the user ticked', () => {
    const markup = dialog({ clearRecords: true, removeTools: true })
    expect(markup.match(/checked=""/g)).toHaveLength(2)
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
