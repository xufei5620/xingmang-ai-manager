import type { PlatformCapabilities } from '../../../../electron/ipc-contract'

// 渲染层只许经 ipc-contract 取主进程类型（verify-renderer-boundary 的允许清单），
// 所以这两个名字从能力对象上取，不直接引 platform-capabilities。
type InstallManagement = PlatformCapabilities['nodeRuntimeInstall']
type PlatformFamily = PlatformCapabilities['platform']

/**
 * Windows 上 Node.js 和 Python 由应用代装（platform-capabilities 的 'managed'），
 * macOS 上是 'external'：本程序从不提权、也不代跑终端命令，只能把装法讲清楚。
 * 原来那颗按钮在 Mac 上直接把人丢到 nodejs.org 的英文首页——客户既不知道该下哪个
 * 包，也不知道装完要回哪儿点一下，卡在这一步就退款了。
 *
 * 这份文案是首页运行环境卡与教程页共用的唯一来源，口径与 git-runtime.ts 一致：
 * 只给步骤和可复制的命令，不代装、不代跑、不提权。
 */

export type ManagedRuntimeId = 'node' | 'python'

export interface RuntimeInstallGuide {
  /** 缺的是什么、为什么要装，一句话。 */
  readonly summary: string
  /** 三步：装法 A、装法 B、回来验证。 */
  readonly steps: readonly string[]
  /** 可复制的一条命令；没有推荐命令的平台是 null。 */
  readonly command: string | null
}

export function runtimeDisplayName(runtime: ManagedRuntimeId): string {
  return runtime === 'node' ? 'Node.js' : 'Python'
}

/** Homebrew 那一条命令，教程页与首页必须是同一个字符串，测试据此钉住。 */
export function runtimeHomebrewCommand(runtime: ManagedRuntimeId): string {
  return runtime === 'node' ? 'brew install node' : 'brew install python'
}

/**
 * 按钮文案分平台。代装的平台保持原样（点了就开始装），外部安装的平台必须
 * 说清点下去只是开网页，否则用户以为应用在替他装、等半天没反应。
 */
export function runtimeButtonLabel(runtime: ManagedRuntimeId, management: InstallManagement | undefined): string {
  const optional = runtime === 'python' ? '（可选环境）' : ''
  if (management === 'external') return `去官网下载 ${runtimeDisplayName(runtime)}${optional}`
  return runtime === 'node' ? '准备 Node.js' : '装 Python（可选环境）'
}

function whyNeeded(runtime: ManagedRuntimeId): string {
  return runtime === 'node'
    ? '四个命令行工具都靠它来安装和启动'
    : 'Gemini CLI 需要它；macOS 自带的那份版本可能过旧，建议另装一份'
}

function verifyStep(runtime: ManagedRuntimeId): string {
  return `装完回到首页点右上角「重新检测」，这张卡的 ${runtimeDisplayName(runtime)} 一行显示出版本号就算好了。`
}

/**
 * 缺这个运行环境时给的中文步骤。返回 null = 这个平台由应用代装，按钮自己够用，
 * 不要再叠一段说明。
 */
export function runtimeInstallGuide(
  runtime: ManagedRuntimeId,
  platform: PlatformFamily | undefined,
  management: InstallManagement | undefined,
): RuntimeInstallGuide | null {
  if (management !== 'external') return null
  const name = runtimeDisplayName(runtime)
  if (platform === 'macos') {
    return {
      summary: `这台 Mac 上没有找到 ${name}（${whyNeeded(runtime)}）。星芒不会替你装它，下面两种装法选一种就行。`,
      steps: [
        '装过 Homebrew 的：打开「终端」，粘贴下面这条命令回车，等它跑完。',
        `没装过 Homebrew 的：点下面的「${runtimeButtonLabel(runtime, 'external')}」，在网页上选 macOS 的安装包（.pkg），下载后双击一路下一步。`,
        verifyStep(runtime),
      ],
      command: runtimeHomebrewCommand(runtime),
    }
  }
  return {
    summary: `这台电脑上没有找到 ${name}（${whyNeeded(runtime)}）。星芒不会替你装它，请自己装上。`,
    steps: [
      `用系统自带的包管理器装上 ${name}，或者点下面的「${runtimeButtonLabel(runtime, 'external')}」。`,
      verifyStep(runtime),
    ],
    command: null,
  }
}
