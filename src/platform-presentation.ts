import type { PlatformCapabilities, ProviderId } from './types'

/**
 * Only ever reaches the screen when the capability probe failed outright: the
 * startup sequence awaits the real capabilities before leaving the loading
 * view, and a rejection skips the commit entirely (see App.test.tsx, "propagates
 * capability failures without committing the fallback as a real platform").
 *
 * So this is the value the dashboard renders when the main process could not
 * say what it supports. Claiming three of the four CLIs are managed there
 * offered the user a one-click install that has no verified platform behind it.
 * Every entry now declines, which is what fail-closed has to mean; the happy
 * path never sees these values, so nothing flashes.
 */
export const failClosedPlatformCapabilities: PlatformCapabilities = Object.freeze({
  platform: 'linux',
  architecture: 'unknown',
  isMac: false,
  nodeRuntimeInstall: 'external',
  pythonRuntimeInstall: 'external',
  cliInstall: Object.freeze({
    claude: 'external',
    codex: 'external',
    gemini: 'external',
    grok: 'external',
  }),
  codexDesktop: Object.freeze({
    install: 'external',
    launch: false,
    uninstall: false,
    windowsStore: false,
  }),
})

export type PlatformPresentation = ReturnType<typeof platformPresentation>

export function platformPresentation(capabilities: PlatformCapabilities) {
  if (capabilities.platform === 'windows') {
    return {
      codexDesktopCompany: 'OpenAI · Windows',
      codexDesktopClient: 'Windows 客户端',
      skillPathPlaceholder: 'C:\\path\\to\\skill',
      nodeAction: 'managed-install' as const,
      nodeActionLabel: '一键安装 Node.js LTS',
      nodeGuideDescription: '打开 Node.js 官网，下载 Windows Installer (.msi) 安装包。',
      nodeGuideInstallDescription: '运行安装包，进入 Custom Setup 页面后，确认下面两项都会安装。',
      nodeGuidePathTitle: '必须加入 PATH',
      nodeGuidePathDescription: '确认 Add to PATH 已启用。如果前面是红色 X，点击该项并选择安装到本地硬盘。',
      nodeGuidePathLabel: 'Add to PATH',
      nodeGuidePathDetail: 'Will be installed on local hard drive',
      nodeGuideFinishDescription: '安装完成后关闭已打开的终端，再返回这里重新检测。若仍未识别，请重启星芒AI管理工具，让新 PATH 生效。',
      grokAction: 'managed-install' as const,
      grokActionLabel: '一键安装',
      grokGuidance: null,
      codexDesktopAction: 'managed-install' as const,
      codexDesktopActionLabel: '一键安装',
      codexDesktopMaintenanceSubtitle: 'Appx 本机版本 · Codex 官方更新清单',
      showWindowsStore: true,
      showWindowsPackages: true,
      showDesktopMirror: true,
      allowDesktopUninstall: true,
    }
  }

  const macos = capabilities.platform === 'macos'
  const grokManaged = capabilities.cliInstall.grok === 'managed'
  return {
    codexDesktopCompany: macos ? 'OpenAI · macOS' : 'OpenAI · Desktop',
    codexDesktopClient: macos ? 'macOS 客户端' : '桌面客户端',
    skillPathPlaceholder: macos ? '/Users/name/path/to/skill' : '/home/name/path/to/skill',
    nodeAction: 'open-website' as const,
    nodeActionLabel: '打开 Node.js 官网',
    nodeGuideDescription: macos
      ? '打开 Node.js 官网，下载适用于 macOS 的安装包。'
      : '打开 Node.js 官网，下载适用于当前平台的安装包。',
    nodeGuideInstallDescription: macos
      ? '打开下载的 macOS 安装包，按安装器提示完成 Node.js 与 npm 安装。'
      : '打开下载的安装包，按安装器提示完成 Node.js 与 npm 安装。',
    nodeGuidePathTitle: macos ? '完成标准安装' : '完成安装',
    nodeGuidePathDescription: macos
      ? '安装器会将 Node.js 与 npm 安装到标准位置，无需选择 Windows PATH 组件。'
      : '按照当前平台安装器的提示完成安装。',
    nodeGuidePathLabel: macos ? 'macOS 标准安装' : '标准安装',
    nodeGuidePathDetail: macos
      ? 'Node.js 与 npm 命令由官方安装器配置'
      : 'Node.js 与 npm 由安装器配置',
    nodeGuideFinishDescription: macos
      ? '安装完成后返回这里重新检测。若仍未识别，请退出并重新打开星芒AI管理工具后再次检测。'
      : '安装完成后返回这里重新检测。若仍未识别，请重启星芒AI管理工具后再次检测。',
    grokAction: grokManaged ? 'managed-install' as const : 'external-guidance' as const,
    grokActionLabel: grokManaged ? '一键安装' : '外部管理',
    grokGuidance: grokManaged
      ? null
      : macos
        ? 'macOS 上 Grok CLI 的安装由外部管理，请按照 xAI 官方说明完成安装后重新检测。'
        : 'Grok CLI 的安装由外部管理，请按照 xAI 官方说明完成安装后重新检测。',
    codexDesktopAction: capabilities.codexDesktop.launch ? 'launch' as const : 'unsupported' as const,
    codexDesktopActionLabel: capabilities.codexDesktop.launch ? '打开 Codex App' : '当前平台不可用',
    codexDesktopMaintenanceSubtitle: macos ? '安装与更新由 Codex App 管理' : '当前平台不支持 Codex App',
    showWindowsStore: false,
    showWindowsPackages: false,
    showDesktopMirror: false,
    allowDesktopUninstall: false,
  }
}

export async function performNodeRuntimeAction(
  capabilities: PlatformCapabilities,
  api: {
    installNodeRuntime(): Promise<unknown>
    openExternal(url: string): Promise<unknown>
  },
): Promise<{ kind: 'managed' | 'external' }> {
  if (capabilities.nodeRuntimeInstall === 'external') {
    await api.openExternal('https://nodejs.org/')
    return { kind: 'external' }
  }
  await api.installNodeRuntime()
  return { kind: 'managed' }
}

export async function performCliInstallAction(
  provider: ProviderId,
  capabilities: PlatformCapabilities,
  api: { installCli(provider: ProviderId): Promise<unknown> },
): Promise<
  | { kind: 'managed' }
  | { kind: 'external'; guidance: string }
> {
  if (capabilities.cliInstall[provider] === 'external') {
    // grokGuidance names Grok and points at xAI's instructions, so it may only
    // be used for Grok. Handing it to any external provider meant the first
    // platform to mark claude/codex/gemini external would tell those users to
    // go read the Grok documentation.
    const grokGuidance = provider === 'grok'
      ? platformPresentation(capabilities).grokGuidance
      : null
    return {
      kind: 'external',
      guidance: grokGuidance
        ?? '该 CLI 的安装由外部管理，请按照其官方说明完成安装后重新检测。',
    }
  }
  await api.installCli(provider)
  return { kind: 'managed' }
}
