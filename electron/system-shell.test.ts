import { describe, expect, it, vi } from 'vitest'
import {
  buildWindowsShellLaunchPlan,
  createExternalShellLauncher,
  resolveWindowsExplorerExecutable,
  type WindowsShellLaunchPlan,
} from './system-shell'

const machinePaths = {
  systemRoot: 'D:\\Windows',
  system32: 'D:\\Windows\\System32',
  programFiles: 'D:\\Program Files',
  programFilesX86: 'D:\\Program Files (x86)',
  programData: 'D:\\ProgramData',
}

describe('system shell launcher', () => {
  it('resolves only the canonical Explorer in the trusted SystemRoot', () => {
    const expected = 'D:\\Windows\\explorer.exe'
    expect(resolveWindowsExplorerExecutable({
      platform: 'win32',
      machinePaths,
      isFile: (candidate) => candidate === expected,
      realPath: (candidate) => candidate,
    })).toBe(expected)

    expect(() => resolveWindowsExplorerExecutable({
      platform: 'win32',
      machinePaths,
      isFile: () => true,
      realPath: () => 'D:\\Users\\tester\\explorer.exe',
    })).toThrow('符号链接或目录联接')
  })

  it('builds a shell-free plan with a trusted environment and exact target', () => {
    const url = 'https://xm.solov.cc/keys?from=manager'
    const plan = buildWindowsShellLaunchPlan(
      'url',
      url,
      'D:\\Windows\\explorer.exe',
      {
        PATH: 'D:\\Users\\tester\\bin',
        NODE_OPTIONS: '--require=D:\\Users\\tester\\payload.js',
      },
      machinePaths,
    )

    expect(plan).toMatchObject({
      executable: 'D:\\Windows\\explorer.exe',
      argv: [url],
      cwd: 'D:\\Windows',
      windowsHide: true,
    })
    expect(plan.env.PATH).not.toContain('D:\\Users\\tester')
    expect(plan.env.NODE_OPTIONS).toBeUndefined()
  })

  it('routes Windows HTTPS URLs and directories through Explorer', async () => {
    const plans: WindowsShellLaunchPlan[] = []
    const fallbackShell = {
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => ''),
    }
    const launcher = createExternalShellLauncher({
      platform: 'win32',
      machinePaths,
      isFile: () => true,
      realPath: (candidate) => candidate,
      fallbackShell,
      launchWindowsPlan: async (plan) => { plans.push(plan) },
    })

    await launcher.openExternal('https://xm.solov.cc')
    await launcher.openPath('D:\\ProgramData\\XingMangAI\\logs')

    expect(plans.map((plan) => plan.argv)).toEqual([
      ['https://xm.solov.cc'],
      ['D:\\ProgramData\\XingMangAI\\logs'],
    ])
    expect(fallbackShell.openExternal).not.toHaveBeenCalled()
    expect(fallbackShell.openPath).not.toHaveBeenCalled()
  })

  it('uses ShellExecute for a Microsoft Store URI because Explorer does not guarantee protocol activation', async () => {
    const plans: WindowsShellLaunchPlan[] = []
    const fallbackShell = {
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => ''),
    }
    const launcher = createExternalShellLauncher({
      platform: 'win32',
      machinePaths,
      isFile: () => true,
      realPath: (candidate) => candidate,
      fallbackShell,
      launchWindowsPlan: async (plan) => { plans.push(plan) },
    })
    const storeUri = 'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS'

    await launcher.openExternal(storeUri)

    expect(fallbackShell.openExternal).toHaveBeenCalledWith(storeUri)
    expect(plans).toEqual([])
  })

  it('keeps Electron shell fallback behavior on non-Windows systems', async () => {
    const fallbackShell = {
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => 'cannot open'),
    }
    const launcher = createExternalShellLauncher({ platform: 'linux', fallbackShell })

    await expect(launcher.openExternal('https://xm.solov.cc')).resolves.toBeUndefined()
    await expect(launcher.openPath('/tmp/logs')).rejects.toThrow('cannot open')
    expect(fallbackShell.openExternal).toHaveBeenCalledWith('https://xm.solov.cc')
    expect(fallbackShell.openPath).toHaveBeenCalledWith('/tmp/logs')
  })

  it('rejects relative paths and malformed URLs before launching Explorer', () => {
    expect(() => buildWindowsShellLaunchPlan(
      'path',
      'relative\\logs',
      'D:\\Windows\\explorer.exe',
      {},
      machinePaths,
    )).toThrow('绝对路径')
    expect(() => buildWindowsShellLaunchPlan(
      'url',
      'not-a-url',
      'D:\\Windows\\explorer.exe',
      {},
      machinePaths,
    )).toThrow('链接格式错误')
    expect(() => buildWindowsShellLaunchPlan(
      'url',
      'javascript:alert(1)',
      'D:\\Windows\\explorer.exe',
      {},
      machinePaths,
    )).toThrow('链接格式错误')
  })
})
