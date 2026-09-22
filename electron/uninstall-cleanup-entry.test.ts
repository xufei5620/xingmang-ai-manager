import { describe, expect, it } from 'vitest'
import { uninstallCleanupArgument, uninstallCleanupEntryMode } from './uninstall-cleanup-entry'

describe('uninstall cleanup entry', () => {
  it('opens the desktop unless the exact cleanup argument is present', () => {
    expect(uninstallCleanupEntryMode(['C:/App/xingmang.exe'], 'win32')).toBe('desktop')
    expect(uninstallCleanupEntryMode(['C:/App/xingmang.exe', `${uninstallCleanupArgument}=1`], 'win32')).toBe('desktop')
    expect(uninstallCleanupEntryMode(['C:/App/xingmang.exe', 'xingmang://open'], 'win32')).toBe('desktop')
  })

  it('runs the cleanup only on Windows and never opens the desktop for the switch elsewhere', () => {
    expect(uninstallCleanupEntryMode(['C:/App/xingmang.exe', uninstallCleanupArgument], 'win32')).toBe('cleanup')
    expect(uninstallCleanupEntryMode(['/Applications/x.app', uninstallCleanupArgument], 'darwin')).toBe('invalid')
    expect(uninstallCleanupEntryMode(['/opt/x', uninstallCleanupArgument], 'linux')).toBe('invalid')
  })
})
