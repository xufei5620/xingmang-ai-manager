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
  readonly codexDesktop: Readonly<{
    install: InstallManagement
    launch: boolean
    uninstall: boolean
    windowsStore: boolean
  }>
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
    cliInstall: Object.freeze({
      claude: 'managed',
      codex: 'managed',
      gemini: 'managed',
      grok: windows || macos ? 'managed' : 'external',
    }),
    // Windows 版 Grok 是 xAI 签名的独立程序，装和跑都不经过 npm（system-service.ts 的
    // grokInstallStrategyFor → windows-native）；Mac 仍从 npm 包取，照旧要 Node.js。
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
    codexDesktop: Object.freeze({
      install: windows ? 'managed' : 'external',
      launch: windows || macos,
      uninstall: windows,
      windowsStore: windows,
    }),
  })
}
