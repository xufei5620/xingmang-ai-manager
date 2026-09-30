import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppUninstallDialog, AppUninstallRow, appUninstallNotice, appUninstallRowDescription } from './AppUninstall'

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
    expect(markup).not.toContain('查看安装卸载')
  })

  it('keeps the tool uninstall page elsewhere', () => {
    const markup = renderToStaticMarkup(
      <AppUninstallRow api={{ uninstallApp: async () => ({ trashed: true, leftovers: [] }) }} isMac={false} openMaintenance={() => undefined} />,
    )
    expect(markup).toContain('查看安装卸载')
    expect(markup).not.toContain('settings-app-uninstall-open')
  })

  it('never names a site or technical term in the row text', () => {
    expect(appUninstallRowDescription).not.toMatch(/solov|PATH|npm|钩子|hook/i)
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
