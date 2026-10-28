// 宿主类型开关（#3）：宿主构建时用 define 把 __XINGMANG_CANVAS_HOST__ 换成 'web'、'desktop' 或 'embed'。
// 它只用来隐藏只属于某个宿主的界面入口、选默认值，不承担任何安全判断：一件事能不能做，由宿主提供不提供对应方法、
// 服务端按空间拒绝来决定，改这个开关绕不过它们（#1 内核规矩第 3 条）。内核里只有这个文件读它。
// 桌面按源码同步内核、用自己的构建配置，现在还没定义它；没定义时按桌面处理，桌面的云端功能全关。

declare const __XINGMANG_CANVAS_HOST__: unknown

export type CanvasHostKind = 'web' | 'desktop' | 'embed'

export function isCanvasHostKind(value: unknown): value is CanvasHostKind {
  return value === 'web' || value === 'desktop' || value === 'embed'
}

export function resolveCanvasHostKind(value: unknown): CanvasHostKind {
  if (value === undefined) return 'desktop'
  if (isCanvasHostKind(value)) return value
  throw new Error(`画布宿主类型不正确：${String(value)}`)
}

export const canvasHostKind: CanvasHostKind = resolveCanvasHostKind(typeof __XINGMANG_CANVAS_HOST__ === 'undefined' ? undefined : __XINGMANG_CANVAS_HOST__)
