import path from 'node:path'
import { runRegistryQuery, type RegistryQueryRunner } from './windows-live-path'
import { resolveWindowsSystemRoot } from './windows-system-root'

// Windows「设置 › 辅助功能 › 文本大小」那根滑块（Windows 10 1809 起有）。没动过时这一项不存在，
// reg.exe 以非零退出；动过就是 100～225 的百分比。Electron 的网页内容不吃这一项，系统弹框和托盘
// 菜单吃，所以老年客户调大以后只有星芒界面里的字没变（0.2.24 深查「高分屏窗口」W-11，D81）。

const ACCESSIBILITY_KEY = 'HKCU\\Software\\Microsoft\\Accessibility'
const MIN_TEXT_SCALE = 100
const MAX_TEXT_SCALE = 225

/** reg.exe query 的输出里取 TextScaleFactor；没有这一项或不在滑块范围里返回 null。 */
export function parseWindowsTextScaleFactor(output: string): number | null {
  const value = output.match(/^\s*TextScaleFactor\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im)?.[1]
  if (value === undefined) return null
  const factor = Number.parseInt(value, 16)
  return factor >= MIN_TEXT_SCALE && factor <= MAX_TEXT_SCALE ? factor : null
}

function defaultSystem32(): string {
  return path.win32.join(resolveWindowsSystemRoot(), 'System32')
}

/**
 * 读一次 Windows 文本大小，读不到一律 null（调用方就当没调过），从不抛错。照
 * windows-taskbar-theme.ts 的读法：reg.exe 用 System32 里那一份的绝对路径（I14），环境只给
 * 系统目录，异步起，不挡主线程。
 */
export async function readWindowsTextScaleFactor(
  resolveSystem32: () => string = defaultSystem32,
  run: RegistryQueryRunner = runRegistryQuery,
): Promise<number | null> {
  try {
    const system32 = resolveSystem32()
    const systemRoot = path.win32.dirname(system32)
    const output = await run(path.win32.join(system32, 'reg.exe'), ['query', ACCESSIBILITY_KEY, '/v', 'TextScaleFactor'], {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: system32,
    })
    return parseWindowsTextScaleFactor(output)
  } catch {
    return null
  }
}
