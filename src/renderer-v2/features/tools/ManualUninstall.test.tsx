import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ManualUninstallDialog, manualShellLabel } from './ManualUninstall'

describe('renderer-v2 manual uninstall help', () => {
  it('shows the cleanup command the backend text promises', () => {
    const markup = renderToStaticMarkup(<ManualUninstallDialog platform="macos" onClose={() => undefined}
      state={{ name: 'Grok CLI', reason: '以下 2 个文件未自动删除', manualCommand: "rm -f '/Users/f/.grok/bin/grok'" }} />)
    expect(markup).toContain('以下 2 个文件未自动删除')
    expect(markup).toContain('rm -f &#x27;/Users/f/.grok/bin/grok&#x27;')
    expect(markup).toContain('manual-uninstall-copy')
    expect(markup).toContain('终端')
  })

  it('says so plainly when no command could be produced, rather than showing an empty block', () => {
    const markup = renderToStaticMarkup(<ManualUninstallDialog platform="windows" onClose={() => undefined}
      state={{ name: 'Grok CLI', reason: '安全检查没有通过', manualCommand: null }} />)
    expect(markup).toContain('安全检查没有通过')
    expect(markup).not.toContain('manual-uninstall-command')
    expect(markup).toContain('请联系客服协助处理')
  })

  it('names the shell the command was written for', () => {
    expect(manualShellLabel('macos')).toBe('终端')
    expect(manualShellLabel('linux')).toBe('终端')
    expect(manualShellLabel('windows')).toBe('普通 PowerShell')
    expect(manualShellLabel(undefined)).toBe('普通 PowerShell')
  })
})
