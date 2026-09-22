// build/installer.nsh 的 customUnInstall 在删文件之前，用这个参数把本程序再拉起
// 一次（XINGMANG_UNINSTALL_CLEANUP_ARGUMENT，两边由 scripts 测试钉成同一个值）。
// 本文件不 import 任何东西：platform/entry.ts 每次启动都先读它，再决定加载哪一支。
export const uninstallCleanupArgument = '--xingmang-uninstall-cleanup'

export function uninstallCleanupEntryMode(
  argv: readonly string[],
  platform: string,
): 'desktop' | 'cleanup' | 'invalid' {
  if (!argv.includes(uninstallCleanupArgument)) return 'desktop'
  // Only the Windows uninstaller has a hook to call this. macOS apps are
  // uninstalled by dragging the bundle to the Trash, which runs nothing.
  return platform === 'win32' ? 'cleanup' : 'invalid'
}
