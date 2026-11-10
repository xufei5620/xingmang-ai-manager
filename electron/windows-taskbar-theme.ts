import path from 'node:path'
import { runRegistryQuery, type RegistryQueryRunner } from './windows-live-path'
import { resolveWindowsSystemRoot } from './windows-system-root'

// 任务栏和托盘那一格的深浅跟的是「Windows 模式」，可以和「应用模式」不一样：Windows 10
// 默认就是任务栏深色、应用浅色。Electron 45 的 nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
// 在第一次 'updated' 之前答的是应用模式（electron_api_native_theme.cc 只在 'updated' 时才去读
// SystemUsesLightTheme），而 Chromium 盯注册表只看 AppsUseLightTheme，只换「Windows 模式」时
// 根本不发 'updated'。所以托盘换图（D94）自己读这一项，不靠它。

const PERSONALIZE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'

/** 换深浅（以及别的系统设置）时 Windows 给所有顶层窗口广播的消息，缩到托盘的隐藏窗口也收得到。 */
export const WINDOWS_SETTING_CHANGE_MESSAGE = 0x001a

/** reg.exe query 的输出里取 SystemUsesLightTheme：0 是任务栏深色；没有这一项返回 null。 */
export function parseWindowsTaskbarDark(output: string): boolean | null {
  const value = output.match(/^\s*SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im)?.[1]
  return value === undefined ? null : Number.parseInt(value, 16) === 0
}

function defaultSystem32(): string {
  return path.win32.join(resolveWindowsSystemRoot(), 'System32')
}

/**
 * 返回一个读「任务栏现在是不是深色」的函数，读不到一律 null（调用方就不换图），从不抛错。
 * reg.exe 用 System32 里那一份的绝对路径（I14），异步起，不挡主线程；System32 只在第一次读时
 * 定一次：系统目录从已加载的核心模块推，不碰注册表，但也不必每次都推。
 */
export function createWindowsTaskbarThemeReader(
  resolveSystem32: () => string = defaultSystem32,
  run: RegistryQueryRunner = runRegistryQuery,
): () => Promise<boolean | null> {
  let system32: string | null = null
  return async () => {
    try {
      system32 ??= resolveSystem32()
      const systemRoot = path.win32.dirname(system32)
      const output = await run(path.win32.join(system32, 'reg.exe'), ['query', PERSONALIZE_KEY, '/v', 'SystemUsesLightTheme'], {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATH: system32,
      })
      return parseWindowsTaskbarDark(output)
    } catch {
      return null
    }
  }
}
