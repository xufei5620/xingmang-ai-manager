import { describe, expect, it, vi } from 'vitest'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import {
  failClosedPlatformCapabilities,
  performCliInstallAction,
  performNodeRuntimeAction,
  platformPresentation,
} from './platform-presentation'

describe('platform presentation', () => {
  it('starts from a Linux-shaped fail-closed snapshot', () => {
    expect(failClosedPlatformCapabilities).toEqual({
      platform: 'linux',
      architecture: 'unknown',
      isMac: false,
      nodeRuntimeInstall: 'external',
      cliInstall: {
        claude: 'managed',
        codex: 'managed',
        gemini: 'managed',
        grok: 'external',
      },
      codexDesktop: {
        install: 'external',
        launch: false,
        uninstall: false,
        windowsStore: false,
      },
      nativeMenu: true,
      trafficLightInset: 0,
    })
  })

  it('keeps every Windows-specific label and managed action unchanged', () => {
    expect(platformPresentation(platformCapabilitiesFor('win32', 'x64'))).toMatchObject({
      codexDesktopCompany: 'OpenAI · Windows',
      codexDesktopClient: 'Windows 客户端',
      skillPathPlaceholder: 'C:\\path\\to\\skill',
      nodeAction: 'managed-install',
      grokAction: 'managed-install',
      codexDesktopAction: 'managed-install',
      showWindowsStore: true,
      showWindowsPackages: true,
      showDesktopMirror: true,
    })
  })

  it('uses macOS labels and a managed Grok installation action', () => {
    expect(platformPresentation(platformCapabilitiesFor('darwin', 'arm64'))).toEqual({
      codexDesktopCompany: 'OpenAI · macOS',
      codexDesktopClient: 'macOS 客户端',
      skillPathPlaceholder: '/Users/name/path/to/skill',
      nodeAction: 'open-website',
      nodeActionLabel: '打开 Node.js 官网',
      nodeGuideDescription: '打开 Node.js 官网，下载适用于 macOS 的安装包。',
      nodeGuideInstallDescription: '打开下载的 macOS 安装包，按安装器提示完成 Node.js 与 npm 安装。',
      nodeGuidePathTitle: '完成标准安装',
      nodeGuidePathDescription: '安装器会将 Node.js 与 npm 安装到标准位置，无需选择 Windows PATH 组件。',
      nodeGuidePathLabel: 'macOS 标准安装',
      nodeGuidePathDetail: 'Node.js 与 npm 命令由官方安装器配置',
      nodeGuideFinishDescription: '安装完成后返回这里重新检测。若仍未识别，请退出并重新打开星芒AI管理工具后再次检测。',
      grokAction: 'managed-install',
      grokActionLabel: '一键安装',
      grokGuidance: null,
      codexDesktopAction: 'launch',
      codexDesktopActionLabel: '打开 Codex App',
      codexDesktopMaintenanceSubtitle: '安装与更新由 Codex App 管理',
      showWindowsStore: false,
      showWindowsPackages: false,
      showDesktopMirror: false,
      allowDesktopUninstall: false,
    })
  })

  it('provides platform-correct Node.js installation tutorial steps', () => {
    expect(platformPresentation(platformCapabilitiesFor('darwin', 'arm64'))).toMatchObject({
      nodeGuideInstallDescription: '打开下载的 macOS 安装包，按安装器提示完成 Node.js 与 npm 安装。',
      nodeGuidePathTitle: '完成标准安装',
      nodeGuidePathDescription: '安装器会将 Node.js 与 npm 安装到标准位置，无需选择 Windows PATH 组件。',
      nodeGuidePathLabel: 'macOS 标准安装',
      nodeGuidePathDetail: 'Node.js 与 npm 命令由官方安装器配置',
      nodeGuideFinishDescription: '安装完成后返回这里重新检测。若仍未识别，请退出并重新打开星芒AI管理工具后再次检测。',
    })

    expect(platformPresentation(platformCapabilitiesFor('win32', 'x64'))).toMatchObject({
      nodeGuideInstallDescription: '运行安装包，进入 Custom Setup 页面后，确认下面两项都会安装。',
      nodeGuidePathTitle: '必须加入 PATH',
      nodeGuidePathDescription: '确认 Add to PATH 已启用。如果前面是红色 X，点击该项并选择安装到本地硬盘。',
      nodeGuidePathLabel: 'Add to PATH',
      nodeGuidePathDetail: 'Will be installed on local hard drive',
      nodeGuideFinishDescription: '安装完成后关闭已打开的终端，再返回这里重新检测。若仍未识别，请重启星芒AI管理工具，让新 PATH 生效。',
    })
  })

  it('opens only the allowlisted Node.js home page for an external runtime', async () => {
    const installNodeRuntime = vi.fn()
    const openExternal = vi.fn().mockResolvedValue(true)

    await expect(performNodeRuntimeAction(
      platformCapabilitiesFor('darwin', 'arm64'),
      { installNodeRuntime, openExternal },
    )).resolves.toEqual({ kind: 'external' })

    expect(openExternal).toHaveBeenCalledWith('https://nodejs.org/')
    expect(installNodeRuntime).not.toHaveBeenCalled()
  })

  it('installs Grok through the managed macOS action', async () => {
    const installCli = vi.fn().mockResolvedValue(undefined)

    await expect(performCliInstallAction(
      'grok',
      platformCapabilitiesFor('darwin', 'x64'),
      { installCli },
    )).resolves.toEqual({ kind: 'managed' })
    expect(installCli).toHaveBeenCalledWith('grok')
  })

  it('preserves managed Node.js and Grok installer calls on Windows', async () => {
    const installNodeRuntime = vi.fn().mockResolvedValue(undefined)
    const openExternal = vi.fn()
    const installCli = vi.fn().mockResolvedValue(undefined)
    const windows = platformCapabilitiesFor('win32', 'x64')

    await expect(performNodeRuntimeAction(windows, {
      installNodeRuntime,
      openExternal,
    })).resolves.toEqual({ kind: 'managed' })
    await expect(performCliInstallAction('grok', windows, {
      installCli,
    })).resolves.toEqual({ kind: 'managed' })

    expect(installNodeRuntime).toHaveBeenCalledOnce()
    expect(openExternal).not.toHaveBeenCalled()
    expect(installCli).toHaveBeenCalledWith('grok')
  })
})
