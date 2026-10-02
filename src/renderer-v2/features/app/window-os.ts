import type { PlatformCapabilities } from '../../../../electron/ipc-contract'

export type WindowOs = 'win' | 'mac' | 'linux'

export function windowOsFor(platform: PlatformCapabilities['platform']): WindowOs {
  return platform === 'macos' ? 'mac' : platform === 'linux' ? 'linux' : 'win'
}

/**
 * 主进程报来的平台能力要等启动那一轮 IPC 回来才有，可 Mac 顶栏给红黄绿按钮
 * 让位是第一帧就得对的事。在那之前先用根节点上已经写好的值（main.tsx 挂载前
 * 写的），没有就按 Chromium 自报的系统判断：它在 macOS 上一律报 `MacIntel`
 * （Apple 芯片也一样）。以前这段时间先按 Windows 排版，等外观同步重绘才挪
 * 过去，Mac 上欢迎页一出来顶栏就跳一下。
 */
export function initialWindowOs(root: string | undefined, navigatorPlatform: string | undefined): WindowOs {
  if (root === 'mac' || root === 'linux' || root === 'win') return root
  if (navigatorPlatform !== undefined && /mac/i.test(navigatorPlatform)) return 'mac'
  // Linux 上 Chromium 报「Linux x86_64」「Linux aarch64」。启动页、欢迎页在这之前就要分平台的文案。
  return navigatorPlatform !== undefined && /linux/i.test(navigatorPlatform) ? 'linux' : 'win'
}

export function currentWindowOs(): WindowOs {
  return initialWindowOs(typeof document === 'undefined' ? undefined : document.documentElement.dataset.os,
    typeof navigator === 'undefined' ? undefined : navigator.platform)
}
