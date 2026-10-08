import type { ProviderId } from './catalog'

export type PlatformFamily = 'windows' | 'macos' | 'linux'
export type InstallManagement = 'managed' | 'external'

export interface PlatformCapabilities {
  readonly platform: PlatformFamily
  readonly architecture: string
  readonly isMac: boolean
  readonly nodeRuntimeInstall: InstallManagement
  readonly pythonRuntimeInstall: InstallManagement
  readonly cliInstall: Readonly<Record<ProviderId, InstallManagement>>
  /** 缺省 = 每家都要 Node.js（旧行为）。 */
  readonly cliNeedsNodeRuntime?: Readonly<Record<ProviderId, boolean>>
  /** 游戏加速（加速页、托盘那一行、兑换加速时长）。缺省 = 有（旧行为）。 */
  readonly acceleration?: boolean
  /** 缺省 = 按渲染层注册表的 requires 判断，Gemini 要 Python（旧行为）。 */
  readonly cliNeedsPythonRuntime?: Readonly<Record<ProviderId, boolean>>
  readonly codexDesktop: Readonly<{
    install: InstallManagement
    launch: boolean
    uninstall: boolean
    windowsStore: boolean
  }>
  /**
   * Windows 上这次本身就带着管理员权限在跑（自带 Administrator 没开管理员批准模式、关了 UAC、
   * 右键「以管理员身份运行」，见 windows-elevation.ts 的 highIntegrity）：装 Node.js、Codex
   * 桌面端、装更新时 Windows 不弹授权窗口，界面就不说会弹。这一项要启动时问过才知道，不在
   * platformCapabilitiesFor 里，由 platform:get-capabilities 叠上去。缺省 = 不是或没问出来（旧行为）。
   */
  readonly processElevated?: boolean
}

function platformFamily(platform: string): PlatformFamily {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return 'linux'
}

export function platformCapabilitiesFor(
  platform: string = process.platform,
  architecture: string = process.arch,
): PlatformCapabilities {
  const family = platformFamily(platform)
  const windows = family === 'windows'
  const macos = family === 'macos'
  return Object.freeze({
    platform: family,
    architecture,
    isMac: macos,
    // macOS 上 Node.js 也由本软件准备：官方压缩包解进自己的文件夹，不提权（第十六批 2）。
    // Linux 同理（Linux 版拆分 ②，linux-node-runtime.ts）：发行版自带的那份大多太旧，
    // 让客户自己装就是卡死。Python 仍归客户自己装。
    nodeRuntimeInstall: 'managed',
    pythonRuntimeInstall: windows ? 'managed' : 'external',
    // Linux 上 Grok 和 macOS 一样从 npm 包装（Linux 版拆分 ③，linux-grok.ts）。
    cliInstall: Object.freeze({
      claude: 'managed',
      codex: 'managed',
      gemini: 'managed',
      grok: 'managed',
    }),
    // Windows 版 Grok 是 xAI 签名的独立程序，装和跑都不经过 npm（system-service.ts 的
    // grokInstallStrategyFor → windows-native）；Mac 和 Linux 从 npm 包取，照旧要 Node.js。
    // 没有 Node.js 时只是少了做完提醒那几条钩子，配置照写（resolveCliHookInvocation）。
    cliNeedsNodeRuntime: Object.freeze({
      claude: true,
      codex: true,
      gemini: true,
      grok: !windows,
    }),
    // Linux 第一版不带加速：安装包里没有加速内核，页面开着只会一直「线路准备中」。
    // 等 Linux 加速（拆分 ⑫）落地再打开。
    acceleration: windows || macos,
    // Gemini 要 Python 只是为了在没有预编译包时现场编译一个可选组件，那一步还得有编译器；
    // 缺了它照样能装能用，不该拦着。Linux 先去掉（Linux 版拆分 ③）；它自带的现成包也覆盖
    // Windows 和 Mac，两边跟着去掉：Windows 不再顺带多装一个 Python，Mac 没装也不再拦着
    // （第二十八批 C）。表留着，哪天又有工具真要 Python 时改这一处就行。
    cliNeedsPythonRuntime: Object.freeze({
      claude: false,
      codex: false,
      gemini: false,
      grok: false,
    }),
    // Mac 上官方包由本软件下载、核签名、放进「应用程序」（macos-desktop-app-installer.ts），
    // 认不出的芯片才回到教程。
    codexDesktop: Object.freeze({
      install: windows || (macos && (architecture === 'arm64' || architecture === 'x64')) ? 'managed' : 'external',
      launch: windows || macos,
      uninstall: windows,
      windowsStore: windows,
    }),
  })
}
