import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ManualUninstallDialog, manualShellLabel, manualUninstallState } from './ManualUninstall'

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

  it('offers to clean up when the main process recorded the files, ahead of copying the command', () => {
    const markup = renderToStaticMarkup(<ManualUninstallDialog platform="windows" onClose={() => undefined} cleanUp={async () => ({ remaining: 0 })}
      state={{ name: 'Claude Code', reason: '有 1 个旧版本程序文件没能自动删除', manualCommand: "Remove-Item -LiteralPath 'C:\\v\\2.1.3.exe' -Force", cleanUpTool: 'claude' }} />)
    expect(markup).toContain('Claude Code 还有文件没删干净')
    expect(markup).toContain('点「帮我清理」，星芒再核对一遍就替你删掉；也可以复制下面的命令，在普通 PowerShell里自己执行。')
    expect(markup).toContain('帮我清理')
    expect(markup.indexOf('manual-uninstall-cleanup')).toBeGreaterThan(-1)
    expect(markup.indexOf('manual-uninstall-cleanup')).toBeLessThan(markup.indexOf('manual-uninstall-copy'))
    expect(markup).not.toContain('需要手动清理')
  })

  it('keeps the copy-only wording when there is nothing to clean up for the user', () => {
    const state = { name: 'Grok CLI', reason: '以下 2 个文件未自动删除', manualCommand: "rm -f '/Users/f/.grok/bin/grok-1.0.46'" }
    for (const markup of [
      renderToStaticMarkup(<ManualUninstallDialog platform="macos" onClose={() => undefined} cleanUp={async () => ({ remaining: 0 })} state={state} />),
      renderToStaticMarkup(<ManualUninstallDialog platform="macos" onClose={() => undefined} state={{ ...state, cleanUpTool: 'grok' }} />),
    ]) {
      expect(markup).toContain('Grok CLI 需要手动清理')
      expect(markup).toContain('在终端里执行下面这条命令即可完成清理。')
      expect(markup).not.toContain('manual-uninstall-cleanup')
    }
  })

  it('names the tool to clean up only when the main process said it can', () => {
    const help = { reason: '有文件没删掉', manualCommand: "rm -f '/x'" }
    expect(manualUninstallState('Grok CLI', 'grok', { ...help, cleanUpAvailable: true }))
      .toEqual({ name: 'Grok CLI', reason: '有文件没删掉', manualCommand: "rm -f '/x'", cleanUpTool: 'grok' })
    expect(manualUninstallState('Grok CLI', 'grok', help)).toEqual({ name: 'Grok CLI', reason: '有文件没删掉', manualCommand: "rm -f '/x'" })
    expect(manualUninstallState('Grok CLI', 'grok', { ...help, manualCommand: null, cleanUpAvailable: true })).not.toHaveProperty('cleanUpTool')
    expect(manualUninstallState('Codex', 'codexDesktop', { ...help, cleanUpAvailable: true })).not.toHaveProperty('cleanUpTool')
  })

  it('names the shell the command was written for', () => {
    expect(manualShellLabel('macos')).toBe('终端')
    expect(manualShellLabel('linux')).toBe('终端')
    expect(manualShellLabel('windows')).toBe('普通 PowerShell')
    expect(manualShellLabel(undefined)).toBe('普通 PowerShell')
  })
})
